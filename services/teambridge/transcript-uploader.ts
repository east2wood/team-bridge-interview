import { EventEmitter } from 'node:events'
import type { TeamBridgeClient } from './teambridge-client'
import type { SegmentUpload } from '@shared/api-types'
import { child } from '../logger'

const log = child('uploader')

/** Retry backoff, capped. A server that is down stays down for a while. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000]

/**
 * Stop buffering at some point. Holding an unbounded queue for an offline
 * server turns a network problem into a memory problem, and nobody wants the
 * transcript from two hours ago anyway.
 */
const MAX_QUEUE = 300

export interface UploaderStatus {
  pending: number
  failing: boolean
  /** Set while retrying, so the UI can say why nothing is moving. */
  reason?: string
}

/**
 * Sends committed transcript segments to TeamBridge, in order.
 *
 * Strictly sequential and blocking: if segment 25 fails, 26 waits. Question
 * detection and the conversation record both depend on transcript order, so
 * firing concurrently to drain faster would trade correctness for a latency
 * nobody is watching.
 *
 * `sequence` is the identity of a segment, not a counter — re-sending one is
 * a correction rather than a duplicate, which is exactly what makes retrying
 * safe.
 */
export class TranscriptUploader extends EventEmitter {
  private queue: SegmentUpload[] = []
  private sessionId: number | null = null
  private draining = false
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(private readonly clientFor: () => TeamBridgeClient | null) {
    super()
  }

  open(sessionId: number): void {
    this.sessionId = sessionId
    this.stopped = false
    this.queue = []
    this.attempt = 0
    this.publish()
  }

  enqueue(segment: SegmentUpload): void {
    if (this.sessionId === null || this.stopped) return

    if (this.queue.length >= MAX_QUEUE) {
      // Drop the oldest rather than the newest: the recent transcript is what
      // the next answer needs.
      this.queue.shift()
      log.warn({ pending: this.queue.length }, 'upload queue full; dropped the oldest segment')
      this.emit('overflow')
    }

    this.queue.push(segment)
    this.publish()
    void this.drain()
  }

  /** Resolves once the queue is empty or has given up. Used before ending a session. */
  async flush(timeoutMs = 15_000): Promise<void> {
    if (this.queue.length === 0) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.off('drained', done)
        resolve()
      }
      const timer = setTimeout(() => {
        log.warn({ pending: this.queue.length }, 'flush timed out with segments still queued')
        done()
      }, timeoutMs)
      this.once('drained', done)
      void this.drain()
    })
  }

  close(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
    this.sessionId = null
    this.publish()
  }

  status(): UploaderStatus {
    return {
      pending: this.queue.length,
      failing: this.attempt > 0,
      ...(this.attempt > 0 ? { reason: 'TeamBridge is not responding' } : {}),
    }
  }

  private publish(): void {
    this.emit('status', this.status())
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return
    const sessionId = this.sessionId
    if (sessionId === null) return

    this.draining = true
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const client = this.clientFor()
        if (!client) return

        const next = this.queue[0]!
        try {
          const question = await client.uploadSegments(sessionId, [next])
          if (question) this.emit('question', question)
          this.queue.shift()
          this.attempt = 0
          this.publish()
        } catch (err) {
          // Hold the line: everything after this segment waits for it.
          this.attempt += 1
          const wait = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)]!
          log.warn(
            { err: (err as Error).message, sequence: next.sequence, attempt: this.attempt, wait },
            'segment upload failed; retrying',
          )
          this.publish()
          this.timer = setTimeout(() => void this.drain(), wait)
          return
        }
      }
    } finally {
      this.draining = false
    }

    if (this.queue.length === 0) this.emit('drained')
  }
}
