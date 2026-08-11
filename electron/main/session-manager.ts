import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  AudioChannel,
  Segment,
  SessionState,
  SessionStatePayload,
} from '@shared/types'
import { child } from '@services/logger'
import { settings } from '@services/settings/settings'
import * as repo from '@services/history/session-repo'
import type { WhisperService, WorkerSegment } from '@services/transcription/whisper-service'

const log = child('session')

export type StartResult =
  | { ok: true; channels: AudioChannel[] }
  | { ok: false; reason: string }

/**
 * Owns the recording lifecycle: idle → starting → recording → stopping →
 * finalising → idle, or → failed. Nothing else may mutate session state.
 */
export class SessionManager extends EventEmitter {
  private state: SessionState = 'idle'
  private sessionId: string | null = null
  private startedAt: number | null = null
  private language: string | null = null
  private failureReason: string | undefined

  constructor(private whisper: WhisperService) {
    super()
    whisper.on('segment', (seg: WorkerSegment) => this.onSegment(seg))
    whisper.on('partial', (p: { channel: AudioChannel; text: string }) => {
      if (this.state === 'recording') this.emit('partial', p)
    })
    whisper.on('fatal', (reason: string) => {
      if (this.state === 'recording' || this.state === 'starting') this.fail(reason)
    })
  }

  snapshot(): SessionStatePayload {
    return {
      state: this.state,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      ...(this.failureReason ? { reason: this.failureReason } : {}),
    }
  }

  isRecording(): boolean {
    return this.state === 'recording' || this.state === 'starting'
  }

  private setState(state: SessionState, reason?: string): void {
    this.state = state
    this.failureReason = reason
    log.info({ state, sessionId: this.sessionId, reason }, 'session state')
    this.emit('state', this.snapshot())
  }

  start(): StartResult {
    if (this.state !== 'idle' && this.state !== 'failed') {
      log.warn({ state: this.state }, 'start ignored: a session is already active')
      return { ok: false, reason: 'A recording is already in progress.' }
    }

    const engine = this.whisper.getStatus()
    if (engine.state === 'failed') {
      this.fail(engine.reason ?? 'the transcription engine is unavailable')
      return { ok: false, reason: engine.reason ?? 'The transcription engine is unavailable.' }
    }

    // Refuse rather than record into a void: until the worker is ready,
    // pushed audio is discarded, so the user would get "Listening" followed
    // by an empty transcript and no explanation.
    if (engine.state !== 'ready') {
      return {
        ok: false,
        reason:
          engine.state === 'loading'
            ? `The ${engine.model ?? 'speech'} model is still loading. Large models download on first use; this can take several minutes.`
            : 'The transcription engine is not running yet.',
      }
    }

    const cfg = settings().all()
    const channels: AudioChannel[] = cfg.microphoneEnabled
      ? ['system', 'microphone']
      : ['system']

    this.startedAt = Date.now()
    this.language = cfg.language === 'auto' ? null : cfg.language
    this.whisper.reset()

    this.sessionId = cfg.autoSave
      ? repo.createSession({
          source: channels.join('+'),
          startedAt: this.startedAt,
        })
      : `ephemeral-${randomUUID()}`

    this.setState('starting')
    return { ok: true, channels }
  }

  /** The renderer reports that devices are open and audio is flowing. */
  captureStarted(): void {
    if (this.state !== 'starting') return
    this.setState('recording')
  }

  captureFailed(reason: string): void {
    if (this.state === 'idle') return
    this.fail(reason)
  }

  pushAudio(channel: AudioChannel, pcm: Int16Array): void {
    if (this.state !== 'recording') return
    this.whisper.push(channel, pcm)
  }

  private onSegment(seg: WorkerSegment): void {
    // Segments can still arrive while stopping — that is the queue draining,
    // and dropping them would lose the end of the recording.
    if (!this.sessionId || (this.state !== 'recording' && this.state !== 'finalising')) return

    const segment: Segment = {
      id: randomUUID(),
      sessionId: this.sessionId,
      channel: seg.channel,
      text: seg.text,
      startMs: seg.startMs,
      endMs: seg.endMs,
      confidence: seg.confidence,
      language: seg.language,
    }
    this.language ??= seg.language

    if (settings().get('autoSave')) {
      try {
        repo.insertSegment(segment)
      } catch (err) {
        log.error({ err }, 'failed to persist segment')
      }
    }
    this.emit('segment', segment)
  }

  async stop(): Promise<{ sessionId: string; empty: boolean } | null> {
    if (this.state !== 'recording' && this.state !== 'starting') return null
    const sessionId = this.sessionId
    if (!sessionId) return null

    this.setState('stopping')
    this.emit('capture-stop')

    // Drain before finalising: audio captured in the last seconds has not been
    // transcribed yet, and finishing early would silently truncate the transcript.
    this.setState('finalising')
    await this.whisper.flush()

    const endedAt = Date.now()
    let empty = true

    if (settings().get('autoSave')) {
      repo.finaliseSession(sessionId, {
        endedAt,
        language: this.language,
        incomplete: false,
      })
      empty = repo.deleteIfEmpty(sessionId)
    }

    this.sessionId = null
    this.startedAt = null
    this.language = null
    this.setState('idle')

    return { sessionId, empty }
  }

  private fail(reason: string): void {
    log.error({ reason }, 'session failed')
    if (this.sessionId && settings().get('autoSave')) {
      // Do not leave a half-written session in history with nothing in it.
      repo.deleteIfEmpty(this.sessionId)
    }
    this.sessionId = null
    this.startedAt = null
    this.setState('failed', reason)
  }
}
