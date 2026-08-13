import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  AnswerEvent,
  CaptureTurn,
  Interview,
  LiveSessionState,
  LiveStatus,
} from '@shared/api-types'
import type { Segment } from '@shared/types'
import type { TeamBridgeClient } from '@services/teambridge/teambridge-client'
import { child } from '@services/logger'
import type { SessionManager } from './session-manager'
import type { AnswerManager } from './answer-manager'

const log = child('interview')

/**
 * How long to wait before listening again after Answer.
 *
 * Long enough to miss the click and the shuffle around it, short enough that
 * the next question is not lost. Deliberately not a user setting: it is a
 * detail of the interaction, not a preference.
 */
const RESTART_DELAY_MS = 1500

/** Below this, the turn caught noise rather than a question worth sending. */
const MIN_QUESTION_CHARS = 12

/**
 * Orchestrates one interview: capture, turns, and answers.
 *
 * The Answer button is a capture boundary. Pressing it means "everything the
 * interviewer has said since the last turn is the question", which removes the
 * hardest part of automatic detection — deciding when a question has ended.
 *
 * Capture and answer generation are independent: the stream keeps running
 * while listening resumes, because an interview does not pause for DeepSeek.
 */
export class InterviewSession extends EventEmitter {
  private status: LiveStatus = 'idle'
  private interview: Interview | null = null
  private serverSessionId: number | null = null
  private turns: CaptureTurn[] = []
  private activeTurn: CaptureTurn | null = null
  private turnStartedAt: number | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private restartAt = 0
  private error: string | undefined

  constructor(
    private readonly sessions: SessionManager,
    private readonly answers: AnswerManager,
    private readonly clientFor: () => TeamBridgeClient | null,
  ) {
    super()

    // Interviewer speech belongs to the turn in progress. Attribution is
    // structural — the system channel is the other party — so no guessing.
    sessions.on('segment', (segment: Segment) => {
      if (!this.activeTurn || segment.channel !== 'system') return
      this.activeTurn.transcript = `${this.activeTurn.transcript} ${segment.text}`.trim()
      this.publish()
    })

    answers.on('event', (event: AnswerEvent) => this.applyAnswerEvent(event))
  }

  snapshot(): LiveSessionState {
    return {
      status: this.status,
      interview: this.interview,
      serverSessionId: this.serverSessionId,
      turnStartedAt: this.turnStartedAt,
      activeTurn: this.activeTurn,
      turns: this.turns,
      restartInMs: this.restartAt ? Math.max(0, this.restartAt - Date.now()) : 0,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  private setStatus(status: LiveStatus, error?: string): void {
    this.status = status
    this.error = error
    log.info({ status, error }, 'live status')
    this.publish()
  }

  private publish(): void {
    this.emit('state', this.snapshot())
  }

  selectInterview(interview: Interview | null): void {
    if (this.status !== 'idle') return
    this.interview = interview
    this.publish()
  }

  /**
   * Opens the TeamBridge session and starts listening.
   *
   * Selecting an interview deliberately does not start capture: the user may
   * open it minutes early, and recording a corridor conversation is worse
   * than one extra click.
   */
  async startListening(): Promise<{ ok: boolean; reason?: string }> {
    if (this.status !== 'idle' && this.status !== 'error') {
      return { ok: false, reason: 'Already listening.' }
    }

    this.setStatus('starting')

    // The session must exist server side before any answer can be asked;
    // answers are nested under it.
    const client = this.clientFor()
    if (client && this.serverSessionId === null) {
      try {
        const created = await client.createSession({
          interviewId: this.interview?.id ?? null,
          audioSource: 'system',
          transcriber: 'faster-whisper',
        })
        this.serverSessionId = created.id
        log.info({ serverSessionId: created.id }, 'opened TeamBridge session')
      } catch (err) {
        // Local capture is still worth having, so this is a warning rather
        // than a refusal — but answers will be unavailable and the UI says so.
        log.warn({ err }, 'could not open a TeamBridge session')
      }
    }

    const started = this.sessions.start()
    if (!started.ok) {
      this.setStatus('error', started.reason)
      return started
    }

    this.emit('capture-start', started.channels)
    this.beginTurn()
    this.setStatus('recording')
    return { ok: true }
  }

  /**
   * The capture boundary.
   *
   * Stops capture, drains transcription, sends whatever the interviewer said,
   * then resumes listening — without waiting for the answer, which streams in
   * parallel.
   */
  async answer(): Promise<void> {
    if (this.status !== 'recording' || !this.activeTurn) return

    const turn = this.activeTurn
    this.setStatus('finalizing')
    turn.status = 'transcribing'
    turn.endedAt = Date.now()

    // Pause rather than stop: the local and server sessions span the whole
    // interview, and only the turn ends here.
    await this.sessions.pauseForTurn()

    const question = turn.transcript.trim()
    turn.question = question

    if (question.length < MIN_QUESTION_CHARS) {
      // Nothing worth asking. Skipping the call keeps a stray click from
      // spending a model request.
      turn.status = 'empty'
      log.info({ turnId: turn.id, chars: question.length }, 'turn had no question; skipping')
    } else if (this.serverSessionId === null) {
      turn.status = 'failed'
      turn.error = {
        code: 'no_session',
        message: 'No TeamBridge session: answers are unavailable. Check Settings.',
        retryable: false,
      }
    } else {
      turn.status = 'generating'
      // Not awaited: listening resumes while the answer streams.
      void this.answers.ask({
        turnId: turn.id,
        sessionId: this.serverSessionId,
        question,
        context: this.contextFor(turn),
      })
    }

    this.activeTurn = null
    this.scheduleRestart()
  }

  /** Asks a question the user typed, on the same path as a captured one. */
  async askManually(question: string): Promise<void> {
    const text = question.trim()
    if (!text || this.serverSessionId === null) return

    const turn = this.newTurn()
    turn.question = text
    turn.transcript = text
    turn.endedAt = Date.now()
    turn.status = 'generating'
    this.turns = [...this.turns, turn]
    this.publish()

    await this.answers.ask({
      turnId: turn.id,
      sessionId: this.serverSessionId,
      question: text,
      context: this.contextFor(turn),
    })
  }

  /** Re-asks a corrected question as a new attempt on a new turn. */
  async regenerate(turnId: string, question?: string): Promise<void> {
    const turn = this.turns.find((t) => t.id === turnId)
    if (!turn || this.serverSessionId === null) return

    const text = (question ?? turn.question ?? '').trim()
    if (!text) return

    turn.question = text
    turn.answer = ''
    turn.status = 'generating'
    delete turn.error
    this.publish()

    await this.answers.ask({
      turnId: turn.id,
      sessionId: this.serverSessionId,
      question: text,
      context: this.contextFor(turn),
      // A corrected question is a different question, so it gets a new id.
      // Retrying the same one keeps its id; that is the difference.
      requestId: question ? undefined : turn.requestId,
    })
  }

  async retry(turnId: string): Promise<void> {
    const turn = this.turns.find((t) => t.id === turnId)
    if (!turn) return
    await this.regenerate(turnId)
  }

  async stopListening(): Promise<void> {
    this.clearRestart()
    this.answers.cancel()
    if (this.activeTurn) {
      this.activeTurn.endedAt = Date.now()
      this.activeTurn.status = 'completed'
      this.activeTurn = null
    }
    await this.sessions.stop()
    this.turnStartedAt = null
    this.setStatus('idle')
  }

  /** Leaves the interview entirely, discarding turn history. */
  async close(): Promise<void> {
    await this.stopListening()
    this.interview = null
    this.serverSessionId = null
    this.turns = []
    this.publish()
  }

  /* ------------------------------ internals ----------------------------- */

  private scheduleRestart(): void {
    this.clearRestart()
    this.restartAt = Date.now() + RESTART_DELAY_MS
    this.setStatus('restart_pending')

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.restartAt = 0
      const channels = this.sessions.resumeCapture()
      if (!channels) {
        this.setStatus('error', 'Could not resume listening.')
        return
      }
      this.emit('capture-start', channels)
      this.beginTurn()
      this.setStatus('recording')
    }, RESTART_DELAY_MS)
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.restartAt = 0
  }

  private beginTurn(): void {
    const turn = this.newTurn()
    this.activeTurn = turn
    this.turnStartedAt = turn.startedAt
    this.turns = [...this.turns, turn]
    this.publish()
  }

  private newTurn(): CaptureTurn {
    return {
      id: randomUUID(),
      index: this.turns.length + 1,
      startedAt: Date.now(),
      transcript: '',
      answer: '',
      status: 'recording',
    }
  }

  /**
   * Immediate conversational context only.
   *
   * The candidate's resume, the job description and the earlier rounds all
   * live on the server, which loads them when an answer is asked for. Sending
   * them from here would be slower and would hand a laptop the whole
   * recruitment to carry.
   */
  private contextFor(turn: CaptureTurn): string | undefined {
    const previous = this.turns
      .filter((t) => t.id !== turn.id && t.question)
      .slice(-2)
      .map((t) => t.question)
      .join(' ')
    return previous ? `Earlier in this interview: ${previous}` : undefined
  }

  private applyAnswerEvent(event: AnswerEvent): void {
    const turn = this.turns.find((t) => t.id === event.turnId)
    // A late event from a superseded turn must not touch a newer one.
    if (!turn) return

    switch (event.type) {
      case 'start':
        turn.requestId = event.requestId
        turn.questionId = event.questionId
        turn.answer = ''
        turn.status = 'generating'
        break
      case 'delta':
        turn.answer += event.text
        break
      case 'done':
        turn.questionId = event.questionId ?? turn.questionId
        turn.status = 'completed'
        break
      case 'error':
        // The partial answer stays: it is often most of a usable one, and
        // erasing it on failure is the worst possible moment to lose it.
        turn.status = 'failed'
        turn.error = { code: event.code, message: event.message, retryable: event.retryable }
        break
      case 'cancelled':
        if (turn.status === 'generating') turn.status = 'completed'
        break
    }

    this.publish()
  }
}
