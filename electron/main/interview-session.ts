import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  AnswerEvent,
  AssistMessage,
  CaptureTurn,
  RealtimeEvent,
  RealtimeStatus,
  TranscriptItem,
  Interview,
  LiveSessionState,
  LiveStatus,
} from '@shared/api-types'
import type { Segment } from '@shared/types'
import type { TeamBridgeClient } from '@services/teambridge/teambridge-client'
import { child } from '@services/logger'
import type { TranscriptUploader } from '@services/teambridge/transcript-uploader'
import type { MessagePoller } from '@services/teambridge/message-poller'
import type { RealtimeClient } from '@services/teambridge/realtime-client'
import type { SessionManager } from './session-manager'
import type { AnswerManager } from './answer-manager'

const log = child('interview')

/** Below this, the turn caught noise rather than speech worth answering. */
const MIN_TURN_CHARS = 12

/** A committed segment that ends like this finished a thought. */
const SENTENCE_END = /[.!?]["')\]]?\s*$/

/**
 * Coalescing window for automatic sends.
 *
 * Speech arrives as several segments in quick succession, and each one that
 * happens to end in a full stop would otherwise trigger its own flush. Waiting
 * a moment lets a burst settle into one.
 */
const AUTO_SEND_DEBOUNCE_MS = 400

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
  private autoSendTimer: NodeJS.Timeout | null = null
  private autoSending = false
  private messages: AssistMessage[] = []
  private segments: TranscriptItem[] = []
  /** Monotonic across the interview, unlike `sequence`, which is per session. */
  private position = 0
  private sentPosition = 0
  private realtime: RealtimeStatus = 'disconnected'
  private upload = { pending: 0, failing: false } as {
    pending: number
    failing: boolean
    reason?: string
  }

  constructor(
    private readonly sessions: SessionManager,
    private readonly answers: AnswerManager,
    private readonly uploader: TranscriptUploader,
    private readonly poller: MessagePoller,
    private readonly live: RealtimeClient,
    private readonly clientFor: () => TeamBridgeClient | null,
  ) {
    super()

    live.on('status', (status: RealtimeStatus) => {
      this.realtime = status
      // The socket carries messages faster than polling can; when it is up the
      // poll becomes a safety net rather than the delivery mechanism.
      this.poller.setInterval(status === 'connected' ? 'slow' : 'fast')
      this.publish()
    })

    // A socket that just came up missed whatever happened while it was down.
    // Catching up is an ordinary API call, which is exactly what the poller is.
    live.on('resync', () => this.poller.pollNow())

    live.on('event', (event: RealtimeEvent) => this.applyRealtimeEvent(event))

    // Append-only, and by id: the poller never returns one twice, so nothing
    // above the newest message can move and the reader's place is kept.
    poller.on('messages', (incoming: AssistMessage[]) => {
      const known = new Set(this.messages.map((m) => m.id))
      const fresh = incoming.filter((m) => !known.has(m.id)).map((m) => this.anchor(m))
      if (fresh.length === 0) return
      this.messages = [...this.messages, ...fresh]
      this.publish()
    })

    uploader.on('status', (status: typeof this.upload) => {
      this.upload = status
      // An empty queue means every sequence handed out so far is on the
      // server. Taken from here rather than from Send, so the transcript stops
      // looking unsent the moment it is not — the queue drains on its own
      // between checkpoints.
      if (status.pending === 0) this.sentPosition = this.position
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

      // Both halves go on the timeline. The server answers from both, so a
      // record showing only one would not be the conversation it answered.
      this.segments = [
        ...this.segments,
        {
          position: (this.position += 1),
          sequence: this.sequence,
          text: segment.text,
          startedAt: this.startedAtEpoch(segment.startMs),
          speaker: segment.channel === 'system' ? 'interviewer' : 'candidate',
        },
      ]

      if (!this.activeTurn || segment.channel !== 'system') return
      // One block per segment, separated the way the server separates them in
      // `text_between`. It is easier to read than a paragraph that grows a
      // sentence at a time, and TeamBridge's copy of the turn replaces this one
      // as soon as an answer starts — joined differently, the context would
      // visibly reflow at that moment.
      this.activeTurn.transcript = `${this.activeTurn.transcript}\n\n${segment.text}`.trim()
      this.publish()

      // A finished sentence is the natural moment to hand over: the server
      // works from whole thoughts, and sending mid-phrase would leave it
      // holding fragments. It also means Answer has almost nothing left to
      // flush, which is where the wait before an answer used to come from.
      if (SENTENCE_END.test(segment.text)) this.scheduleAutoSend()
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
      segments: this.segments,
      sentThroughPosition: this.sentPosition,
      upload: this.upload,
      messages: this.messages,
      realtime: this.realtime,
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
    this.messages = []

    // Polled for as long as the round is open, not only while listening: a
    // colleague may send a steer before capture starts.
    if (interview) this.poller.start(interview.id)
    else this.poller.stop()

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
    await this.openServerSession()

    this.sessionStartedAt = Date.now()
    const started = this.sessions.start()
    if (!started.ok) {
      // The run was opened a moment ago and will never record: close it as
      // failed rather than leaving a live session that nothing will finish.
      await this.endServerSession('failed')
      this.setStatus('error', started.reason)
      return started
    }

    this.emit('capture-start', started.channels)
    this.beginTurn()
    this.setStatus('recording')
    return { ok: true }
  }

  /**
   * Sends at a sentence boundary, quietly.
   *
   * Same work as the Send button, without the button's visible state: this
   * happens on its own several times a minute, and announcing each one would
   * be noise. Send remains for forcing a send mid-sentence, when the
   * interviewer trails off without finishing.
   */
  private scheduleAutoSend(): void {
    if (this.autoSendTimer) clearTimeout(this.autoSendTimer)
    this.autoSendTimer = setTimeout(() => {
      this.autoSendTimer = null
      void this.autoSend()
    }, AUTO_SEND_DEBOUNCE_MS)
  }

  private async autoSend(): Promise<void> {
    // A manual send already in flight is doing the same work; a second one
    // would only queue behind it.
    if (this.status !== 'recording' || this.autoSending) return
    this.autoSending = true
    try {
      await this.sessions.flushPending()
      await this.uploader.flush(UPLOAD_GRACE_MS)
      this.markSent()
    } catch (err) {
      log.warn({ err }, 'automatic send failed; the queue will retry')
    } finally {
      this.autoSending = false
    }
  }

  /**
   * Draws a line under the conversation so far and starts a new one.
   *
   * A boundary in the record, not on the server: the transcript stays, and
   * what an answer is built from is still the server's own read-mark, which
   * only answering moves. This is for when the round changes subject and the
   * page should say so.
   */
  newConversation(): void {
    if (this.status !== 'recording') return

    const turn = this.activeTurn
    if (turn) {
      turn.status = 'boundary'
      turn.endedAt = Date.now()
      turn.throughPosition = this.position
      turn.context = {
        fromSequence: turn.fromSequence ?? 1,
        throughSequence: this.sequence,
        text: turn.transcript,
      }
    }

    this.beginTurn()
    this.publish()
    log.info({ position: this.position }, 'started a new conversation')
  }

  /**
   * Marks the end of a conversation that was answered.
   *
   * An answer is where one exchange finishes: the server has moved its
   * read-mark past everything it covered, so whatever is said next is a new
   * conversation whether or not anybody says so.
   */
  private closeConversation(answered: CaptureTurn): void {
    const at = answered.throughPosition ?? this.position
    // Regenerating finishes the same turn again, and one exchange gets one
    // line under it.
    if (this.turns.some((t) => t.status === 'boundary' && t.throughPosition === at)) return

    const marker = this.newTurn()
    marker.status = 'boundary'
    marker.endedAt = Date.now()
    marker.throughPosition = at
    this.turns = [...this.turns, marker]
  }

  /**
   * Records that everything transcribed so far has reached TeamBridge.
   *
   * Taken after the queue drains rather than when the send starts: until then
   * the server does not have it, and showing it as sent would be a promise the
   * app cannot keep if the upload is still retrying.
   */
  private markSent(): void {
    if (!this.activeTurn) return
    this.activeTurn.sentTranscript = this.activeTurn.transcript
    // Everything queued has drained, so all of it is on the server. This is
    // what a message arriving now was written against.
    this.sentPosition = this.position
    this.publish()
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

    // Freeze what this answer is based on before anything else can change it.
    // The next turn starts collecting immediately afterwards, so this is the
    // only moment the window is unambiguous.
    turn.throughPosition = this.position
    turn.context = {
      fromSequence: turn.fromSequence ?? 1,
      throughSequence: this.sequence,
      text: turn.transcript,
    }

    // No question is named. The server reads one out of the transcript it
    // already holds — it sees the whole session where this sees one turn, and
    // it is the party that has to stand behind the answer. What it decided
    // arrives on the `start` event and is displayed from there.
    if (turn.transcript.length < MIN_TURN_CHARS) {
      // Nothing was said. Skipping the call keeps a stray click from spending
      // a model request.
      turn.status = 'empty'
      log.info({ turnId: turn.id, chars: turn.transcript.length }, 'empty turn; skipping')
    } else if (this.serverSessionId === null) {
      turn.status = 'failed'
      turn.error = {
        code: 'no_session',
        message: 'No TeamBridge session: answers are unavailable. Check Settings.',
        retryable: false,
      }
    } else {
      turn.status = 'generating'
      // Not awaited: the interview carries on while the answer streams.
      void this.answers.ask({
        turnId: turn.id,
        sessionId: this.serverSessionId,
        context: this.instructionFor(turn),
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
    // Typed, so it belongs wherever the transcript had got to.
    turn.throughPosition = this.position
    turn.status = 'generating'
    this.turns = [...this.turns, turn]
    this.publish()

    await this.answers.ask({
      turnId: turn.id,
      sessionId: this.serverSessionId,
      question: text,
      context: this.instructionFor(turn),
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
      context: this.instructionFor(turn),
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
    if (this.autoSendTimer) clearTimeout(this.autoSendTimer)
    this.autoSendTimer = null
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
    await this.endServerSession('ended')

    this.turnStartedAt = null
    this.setStatus('idle')
  }

  /**
   * Opens a run on the server, if there is a server and no run already.
   *
   * Local capture is still worth having without one, so a failure here is a
   * warning rather than a refusal — but answers will be unavailable, and the
   * UI says so.
   */
  private async openServerSession(): Promise<void> {
    const client = this.clientFor()
    if (!client || this.serverSessionId !== null) return

    try {
      const created = await client.createSession({
        interviewId: this.interview?.id ?? null,
        audioSource: 'system',
        transcriber: 'faster-whisper',
      })
      this.serverSessionId = created.id
      this.sequence = 0
      this.sentPosition = this.position
      this.uploader.open(created.id)
      this.live.connect(created.id)
      log.info({ serverSessionId: created.id }, 'opened TeamBridge session')
    } catch (err) {
      log.warn({ err }, 'could not open a TeamBridge session')
    }
  }

  /**
   * Marks the run finished on the server and forgets it.
   *
   * Clearing the id is the point: startListening only opens a session when it
   * has none, so a session left set here would be reused by the next Start —
   * posting segments and answers into a run the server has already closed.
   */
  private async endServerSession(status: 'ended' | 'failed'): Promise<void> {
    const client = this.clientFor()
    const sessionId = this.serverSessionId

    // Unsubscribed first, and deliberately: finishing a session broadcasts
    // that it was completed, and a completed session is the app's signal to
    // stop listening. Told about a closure it performed itself, it would stop
    // capture in the middle of starting a new context.
    this.live.disconnect()

    if (client && sessionId !== null) {
      try {
        await client.endSession(sessionId, status)
        log.info({ sessionId, status }, 'marked the TeamBridge session finished')
      } catch (err) {
        // Worth saying out loud: the transcript is safe, but the run stays
        // open on the server and somebody has to know that.
        log.warn({ err, sessionId }, 'could not mark the TeamBridge session finished')
        this.emit('notice', {
          level: 'warn',
          message: 'The interview was not marked finished on TeamBridge. Its transcript is saved.',
        })
      }
    }

    this.uploader.close()
    this.serverSessionId = null
    this.sequence = 0
  }

  /** Leaves the interview entirely, discarding turn history. */
  async close(): Promise<void> {
    await this.stopListening()
    this.poller.stop()
    this.messages = []
    this.segments = []
    this.interview = null
    this.turns = []
    this.publish()
  }

  /* ------------------------------ internals ----------------------------- */

  /**
   * Places a message in the transcript.
   *
   * The server's own mark is used when it sends one. Otherwise the message is
   * pinned to the last sequence known to have reached TeamBridge, because that
   * is the most the sender could have been looking at when they wrote it —
   * which is both the honest answer and one that needs no clock shared with a
   * machine somewhere else. Messages that predate this run get nothing: they
   * have no position in a transcript that did not exist yet.
   */
  private anchor(message: AssistMessage): AssistMessage {
    if (message.afterPosition !== null) {
      // A server mark is a sequence inside the current session; the record is
      // ordered by position, so it is read through the segment that carries it.
      const at = this.segments.find((segment) => segment.sequence === message.afterPosition)
      return { ...message, afterPosition: at?.position ?? this.sentPosition }
    }
    return { ...message, afterPosition: this.sentPosition > 0 ? this.sentPosition : null }
  }

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
      // The next segment uploaded belongs to this turn.
      fromSequence: this.sequence + 1,
      answer: '',
      status: 'recording',
    }
  }

  /**
   * An instruction for how to answer, not conversation history.
   *
   * `context` on the request is the asker's own steer — "shorter", "more
   * technical". Earlier questions used to be sent here, which put transcript
   * into an instruction field; the server now reads the conversation from the
   * session's segments itself, so there is nothing for a captured turn to add.
   */
  private instructionFor(_turn: CaptureTurn): string | undefined {
    return undefined
  }

  /**
   * Applies a live notification.
   *
   * Only `assist_message.created` is genuinely new here — everything else
   * describes something this app just wrote and already has on screen, so it
   * is reconciliation at most. Treating those as new items would duplicate the
   * timeline against itself.
   */
  private applyRealtimeEvent(event: RealtimeEvent): void {
    // A subscription that has moved on can still deliver one more frame from
    // where it was. Nothing about a finished session should touch this one.
    if (this.serverSessionId !== null && event.sessionId !== this.serverSessionId) {
      log.debug({ type: event.type, sessionId: event.sessionId }, 'ignoring a stale event')
      return
    }

    switch (event.type) {
      case 'assist_message.created': {
        const message = toMessage(event.data)
        if (!message) return
        if (this.messages.some((m) => m.id === message.id)) return
        this.messages = [...this.messages, this.anchor(message)]
        this.publish()
        this.emit('web-message', message)
        return
      }

      case 'session.completed': {
        // The run was finished elsewhere. Stop listening rather than carrying
        // on writing into something the server considers closed.
        if (this.status === 'recording' || this.status === 'finalizing') {
          log.warn('the session was completed elsewhere; stopping')
          void this.stopListening()
        }
        return
      }

      case 'transcript.created':
      case 'question_answer.created':
      case 'question_answer.updated':
      case 'session.started':
      case 'session.updated':
        // Ours, and already displayed. Kept as acknowledgements only.
        log.debug({ type: event.type }, 'realtime acknowledgement')
        return

      default:
        log.debug({ type: event.type }, 'ignoring unknown realtime event')
    }
  }

  private applyAnswerEvent(event: AnswerEvent): void {
    const turn = this.turns.find((t) => t.id === event.turnId)
    // A late event from a superseded turn must not touch a newer one.
    if (!turn) return

    switch (event.type) {
      case 'start':
        turn.requestId = event.requestId
        turn.questionId = event.questionId
        // The server is authoritative for both: its question is the one it
        // actually answered, and its transcript is read from the segments at
        // render time, so a segment corrected after the fact is reflected
        // here rather than frozen at the moment the button was pressed.
        if (event.question) turn.question = event.question
        if (event.source) turn.questionSource = event.source
        if (event.context) turn.context = event.context
        turn.answer = ''
        turn.status = 'generating'
        break
      case 'delta':
        turn.answer += event.text
        break
      case 'done':
        turn.questionId = event.questionId ?? turn.questionId
        turn.status = 'completed'
        this.closeConversation(turn)
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

/** Narrows a broadcast payload; anything malformed is dropped rather than shown. */
function toMessage(data: unknown): AssistMessage | null {
  const raw = data as {
    id?: number
    question_id?: number | null
    question?: string | null
    type?: string
    source?: string
    content?: string
    sender?: { name?: string | null }
    created_at?: string
    after_transcript_sequence?: number | null
  } | null

  if (!raw || typeof raw.id !== 'number' || !raw.content) return null

  return {
    id: raw.id,
    type: raw.type === 'answer' ? 'answer' : 'note',
    source: raw.source ?? 'web',
    content: raw.content,
    question: raw.question ?? null,
    questionId: raw.question_id ?? null,
    sender: { name: raw.sender?.name ?? null },
    createdAt: raw.created_at ?? new Date().toISOString(),
    afterPosition: raw.after_transcript_sequence ?? null,
  }
}
