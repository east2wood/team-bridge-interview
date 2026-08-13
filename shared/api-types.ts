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

export interface AnswerRequest {
  question: string
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
  | { type: 'start'; turnId: string; requestId: string; questionId?: number }
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
  question?: string
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
export type LiveStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'finalizing'
  | 'restart_pending'
  | 'error'

export interface LiveSessionState {
  status: LiveStatus
  interview: Interview | null
  /** The TeamBridge session id; answers are nested under it. */
  serverSessionId: number | null
  turnStartedAt: number | null
  activeTurn: CaptureTurn | null
  turns: CaptureTurn[]
  /** Seconds until capture resumes, while restart_pending. */
  restartInMs: number
  error?: string
}
