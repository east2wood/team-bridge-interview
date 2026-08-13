import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  AnswerEvent,
  CaptureTurn,
  DetectedQuestion,
  Interview,
  LiveSessionState,
  LiveStatus,
} from '@shared/api-types'
import type { Segment } from '@shared/types'
import type { TeamBridgeClient } from '@services/teambridge/teambridge-client'
import { child } from '@services/logger'
import { extractQuestion } from '@services/interview/question-extractor'
import type { TranscriptUploader } from '@services/teambridge/transcript-uploader'
import type { SessionManager } from './session-manager'
import type { AnswerManager } from './answer-manager'

const log = child('interview')

/** Below this, the turn caught noise rather than a question worth sending. */
const MIN_QUESTION_CHARS = 12

/**
 * How long Answer waits for the turn's transcript to reach TeamBridge.
 *
 * The prompt is built from the session's completed segments, so answering
 * before they land answers without the question's own words. Bounded because
 * an answer with slightly less context beats a button that hangs.
 */
const UPLOAD_GRACE_MS = 4000

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
  private error: string | undefined
  private sessionStartedAt: number | null = null
  private sequence = 0
  private detectedQuestion: DetectedQuestion | null = null
  private sending = false
  private upload = { pending: 0, failing: false } as {
    pending: number
    failing: boolean
    reason?: string
  }

  constructor(
    private readonly sessions: SessionManager,
    private readonly answers: AnswerManager,
    private readonly uploader: TranscriptUploader,
    private readonly clientFor: () => TeamBridgeClient | null,
  ) {
    super()

    uploader.on('status', (status: typeof this.upload) => {
      this.upload = status
      this.publish()
    })

    // TeamBridge sees the whole session and strips the run-up better than a
    // local rule can, so its reading wins when it has one.
    uploader.on('question', (question: DetectedQuestion) => {
      this.detectedQuestion = question
      this.publish()
    })

    // Interviewer speech belongs to the turn in progress. Attribution is
    // structural — the system channel is the other party — so no guessing.
    sessions.on('segment', (segment: Segment) => {
      // TeamBridge gets the whole conversation; the question is built from the
      // interviewer's half only.
      this.uploader.enqueue({
        sequence: (this.sequence += 1),
        text: segment.text,
        startedAt: new Date(this.startedAtEpoch(segment.startMs)).toISOString(),
        endedAt: new Date(this.startedAtEpoch(segment.endMs)).toISOString(),
        confidence: segment.confidence,
        speaker: segment.channel === 'system' ? 'interviewer' : 'candidate',
      })

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
      upload: this.upload,
      detectedQuestion: this.detectedQuestion,
      sending: this.sending,
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
        this.sequence = 0
        this.detectedQuestion = null
        this.uploader.open(created.id)
        log.info({ serverSessionId: created.id }, 'opened TeamBridge session')
      } catch (err) {
        // Local capture is still worth having, so this is a warning rather
        // than a refusal — but answers will be unavailable and the UI says so.
        log.warn({ err }, 'could not open a TeamBridge session')
      }
    }

    this.sessionStartedAt = Date.now()
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
   * Pushes what has been heard so far to TeamBridge, without asking anything.
   *
   * Uploads already happen as segments commit; this forces the tail through —
   * draining the worker so the last phrase is transcribed, then waiting for
   * the queue. Its value is question detection: the server reads the
   * transcript and says what it thinks is being asked, so the user can see
   * that before deciding to press Answer. The turn stays open.
   */
  async sendTranscript(): Promise<void> {
    if (this.status !== 'recording' || this.sending) return

    this.sending = true
    this.publish()
    try {
      await this.sessions.flushPending()
      await this.uploader.flush(UPLOAD_GRACE_MS)
    } finally {
      this.sending = false
      this.publish()
    }
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

    // Drain the worker without closing the devices. Capture continues
    // throughout, so nothing is missed while the tail of the question is
    // transcribed and there is no gap to restart from.
    await this.sessions.flushPending()

    // Then get those segments to TeamBridge before asking it anything. The
    // prompt is built from the session's completed transcript, so answering
    // first would answer without the question's own words. Bounded: a slower
    // answer beats none if the server is struggling.
    await this.uploader.flush(UPLOAD_GRACE_MS)

    // TeamBridge's detection wins when it has one; the local extractor covers
    // the case where nothing has been detected yet.
    const detected = this.detectedQuestion
    const extracted = extractQuestion(turn.transcript)
    const question = detected?.text ?? extracted.question
    turn.question = question
    turn.questionConfident = detected ? true : extracted.confident

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
      // The detected question has been taken; the next one belongs to the
      // next turn, and leaving it set would offer a stale question.
      this.detectedQuestion = null
      // Not awaited: the interview carries on while the answer streams.
      void this.answers.ask({
        turnId: turn.id,
        sessionId: this.serverSessionId,
        question,
        context: this.contextFor(turn),
      })
    }

    // Straight into the next turn: listening never stopped.
    this.beginTurn()
    this.setStatus('recording')
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
    this.answers.cancel()
    if (this.activeTurn) {
      this.activeTurn.endedAt = Date.now()
      this.activeTurn.status = 'completed'
      this.activeTurn = null
    }
    await this.sessions.stop()

    // Flush before completing: the last question must not disappear because
    // the session was marked ended while its transcript was still in flight.
    await this.uploader.flush()
    const client = this.clientFor()
    if (client && this.serverSessionId !== null) {
      try {
        await client.endSession(this.serverSessionId)
      } catch (err) {
        log.warn({ err }, 'could not mark the TeamBridge session ended')
      }
    }
    this.uploader.close()

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

  /** Segment offsets are session-relative; TeamBridge stores wall-clock times. */
  private startedAtEpoch(offsetMs: number): number {
    return (this.sessionStartedAt ?? Date.now()) + offsetMs
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
