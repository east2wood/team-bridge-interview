/**
 * The TeamBridge API as this app uses it.
 *
 * The server speaks snake_case; these are the camelCase shapes the client maps
 * onto, so the convention change happens in exactly one place.
 */

export interface Interview {
  id: number
  /** ISO 8601 in the interview's own zone, not UTC — the app prints it verbatim. */
  startsAt: string | null
  endsAt: string | null
  /** IANA name, e.g. "America/Chicago". */
  timeZone: string
  status: string
  position: { title: string | null }
  company: { name: string | null }
  /** Absent when the caller may not see whose round it is. */
  candidate?: { id: number; name: string } | null
}

export interface AssistSession {
  id: number
  status: string
  audioSource: string | null
  deviceLabel: string | null
  transcriber: string | null
  language: string | null
  interviewId: number | null
  startedAt: string | null
  endedAt: string | null
  segmentCount: number
}

export interface CreateSessionInput {
  interviewId?: number | null
  audioSource?: string
  deviceLabel?: string | null
  transcriber?: string | null
  language?: string | null
}

/** One committed segment, as TeamBridge stores it. */
export interface SegmentUpload {
  /** Identity, not a counter: re-sending a sequence is a correction. */
  sequence: number
  text: string
  startedAt: string
  endedAt: string
  confidence?: number
  speaker?: 'interviewer' | 'candidate'
}

/**
 * Something a colleague watching the round sent to the assistant.
 *
 * The other half of what the app shows, and deliberately not mixed in with
 * generated answers: one is what a model wrote and one is what a person wrote,
 * and knowing which is most of knowing whether to trust it.
 */
export interface AssistMessage {
  id: number
  /** 'answer' is a whole reply to read out; 'note' is a steer to work in. */
  type: 'answer' | 'note'
  source: string
  content: string
  /** The question it was sent about, when it was sent about one. */
  question: string | null
  questionId: number | null
  sender: { name: string | null }
  createdAt: string
}

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

/**
 * One notification from the live socket.
 *
 * The envelope the server sends: what happened, which run, and the thing
 * itself. Deliberately loose about `data` — it is narrowed per event type at
 * the point it is handled, not here.
 */
export interface RealtimeEvent {
  type: string
  sessionId: number
  data: unknown
}

/** How the question was arrived at, according to the server. */
export type QuestionSource = 'detected' | 'manual' | 'derived'

export interface AnswerRequest {
  /**
   * What to answer, when the asker names it themselves.
   *
   * Omitted for a captured turn: the server reads the question out of the
   * transcript it already holds, and it is the only party that sees all of it.
   */
  question?: string
  context?: string
  /**
   * The app's own name for this request. Kept identical across retries: that
   * is what makes the server treat a retry as the same question rather than a
   * second one, and what makes a dropped stream recoverable.
   */
  clientRequestId: string
}

/**
 * What the renderer sees.
 *
 * Every variant carries both ids. requestId discards a late delta from a
 * cancelled request; turnId stops one turn's answer being written into the
 * next one, which is the failure mode when the user presses Answer again
 * while the previous stream is still running.
 */
export type AnswerEvent =
  | {
      type: 'start'
      turnId: string
      requestId: string
      questionId?: number
      /** The server's question and the transcript behind it, both authoritative. */
      question?: string
      source?: QuestionSource
      context?: { fromSequence: number; throughSequence: number; text: string }
    }
  | { type: 'delta'; turnId: string; requestId: string; text: string }
  | { type: 'done'; turnId: string; requestId: string; questionId?: number }
  | {
      type: 'error'
      turnId: string
      requestId: string
      code: string
      message: string
      retryable: boolean
    }
  | { type: 'cancelled'; turnId: string; requestId: string }

export type AnswerStatus =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface StreamingAnswer {
  requestId: string
  questionId?: number
  question: string
  text: string
  status: AnswerStatus
  error?: { code: string; message: string; retryable: boolean }
}

/**
 * One press of Answer to the next.
 *
 * The button is the capture boundary: everything the interviewer said since
 * the turn began is the question. That removes the hardest part of automatic
 * detection — deciding whether a question has finished — because the user has
 * just said so.
 */
export interface CaptureTurn {
  id: string
  index: number
  startedAt: number
  endedAt?: number
  /** Interviewer speech captured during the turn, as transcribed. */
  transcript: string
  /**
   * What the answer was based on, frozen when Answer was pressed.
   *
   * Kept as evidence: the question is a normalisation of this, and without it
   * a surprising question or answer has nothing to check against. The range is
   * the segment window uploaded during the turn, so it can be reconciled with
   * what the server stored.
   */
  context?: {
    fromSequence: number
    throughSequence: number
    text: string
  }
  /** Where this turn's segment window opened; closed into `context` on Answer. */
  fromSequence?: number
  /**
   * The part of the transcript already sent to TeamBridge.
   *
   * Always a prefix of `transcript`, so what is still only heard locally is
   * the remainder. The distinction is the point: the context box shows what
   * the server has, and Listening shows what it does not have yet.
   */
  sentTranscript?: string
  /** What the server says it answered. Absent until the stream starts. */
  question?: string
  /** Set once the server says how it arrived at the question. */
  questionSource?: QuestionSource
  requestId?: string
  questionId?: number
  answer: string
  status: TurnStatus
  error?: { code: string; message: string; retryable: boolean }
}

export type TurnStatus =
  | 'recording'
  | 'transcribing'
  | 'generating'
  | 'completed'
  | 'empty'
  | 'failed'

/**
 * The live session's state.
 *
 * Explicit rather than a handful of booleans: isRecording && isAnswering &&
 * isRestarting has states that cannot be reasoned about, and the restart is
 * exactly where they would go wrong.
 */
export type LiveStatus = 'idle' | 'starting' | 'recording' | 'finalizing' | 'error'

export interface LiveSessionState {
  status: LiveStatus
  interview: Interview | null
  /** The TeamBridge session id; answers are nested under it. */
  serverSessionId: number | null
  turnStartedAt: number | null
  activeTurn: CaptureTurn | null
  turns: CaptureTurn[]
  /** Transcript sync, so an unreachable server is visible rather than silent. */
  upload: { pending: number; failing: boolean; reason?: string }
  /** True while a manual Send is draining transcription and uploading. */
  sending: boolean
  /** Messages sent from the web by people watching this round. */
  messages: AssistMessage[]
  /** Live connection state. Kept apart from listening: audio may be fine. */
  realtime: RealtimeStatus
  error?: string
}
