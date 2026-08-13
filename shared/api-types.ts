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
 * What the renderer sees. Every variant carries requestId: a late delta from a
 * cancelled request must be discardable, or it gets appended to its successor.
 */
export type AnswerEvent =
  | { type: 'start'; requestId: string; questionId?: number }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string; questionId?: number }
  | { type: 'error'; requestId: string; code: string; message: string; retryable: boolean }
  | { type: 'cancelled'; requestId: string }

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

/** A question the detector believes was actually asked. */
export interface DetectedQuestion {
  id: string
  text: string
  context?: string
  detectedAt: number
  /** True when the user typed or corrected it rather than the detector finding it. */
  manual: boolean
}
