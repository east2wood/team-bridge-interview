import { net } from 'electron'
import type {
  AnswerRequest,
  AssistMessage,
  AssistSession,
  CreateSessionInput,
  Interview,
  QuestionSource,
  SegmentUpload,
} from '@shared/api-types'
import type { StoredAnswer, StoredSegment } from '@shared/api-types'
import type { Identity } from '@shared/types'
import { child } from '../logger'
import { SseParser } from './sse-parser'

const log = child('teambridge-client')

export interface AnswerStreamHandlers {
  onStart(data: {
    questionId?: number
    /** The server's normalisation of the question; authoritative over ours. */
    question?: string
    source?: QuestionSource
    /** The transcript the answer is based on, read from the segments. */
    turn?: { fromSequence: number; throughSequence: number; text: string }
  }): void
  onDelta(data: { text: string }): void
  onDone(data: { questionId?: number }): void
  onError(error: { code: string; message: string; retryable: boolean }): void
}

export class TeamBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'TeamBridgeError'
  }
}

/**
 * The TeamBridge API client. Lives in main so the integration key never
 * reaches a renderer.
 *
 * Uses Electron's `net` rather than global fetch so requests follow the system
 * proxy and certificate store — what a corporate network will expect.
 */
export class TeamBridgeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async me(): Promise<Identity> {
    const body = await this.json<{ data: Identity }>('GET', '/api/v1/assist/me')
    return body.data
  }

  async interviews(): Promise<Interview[]> {
    const body = await this.json<{ data: RawInterview[] }>('GET', '/api/v1/assist/interviews')
    return body.data.map(toInterview)
  }

  /**
   * Messages sent from the web for this round, newest last.
   *
   * Asked for by id rather than by time: the id is something the app already
   * has, and a clock it does not share is a clock it cannot compare against.
   */
  async messages(interviewId: number, after?: number): Promise<AssistMessage[]> {
    const query = after ? `?after=${after}` : ''
    const body = await this.json<{ messages: RawMessage[] }>(
      'GET',
      `/api/v1/assist/interviews/${interviewId}/messages${query}`,
    )
    return body.messages.map((m) => ({
      id: m.id,
      type: m.type === 'answer' ? 'answer' : 'note',
      source: m.source ?? 'web',
      content: m.content ?? '',
      question: m.question ?? null,
      questionId: m.question_id ?? null,
      sender: { name: m.sender?.name ?? null },
      createdAt: m.created_at ?? new Date().toISOString(),
      // Only if the server marks where in the transcript it was written. It
      // does not today, and the app places the message itself when it does not.
      afterPosition: m.after_transcript_sequence ?? null,
    }))
  }

  /**
   * Recent runs belonging to this user, latest first.
   *
   * Unfiltered by round because the server does not offer that; the caller
   * keeps the ones it wants. Asked in bulk for the same reason.
   */
  async sessions(limit = 100): Promise<AssistSession[]> {
    const body = await this.json<{ sessions: RawSession[] }>(
      'GET',
      `/api/v1/assist/sessions?limit=${limit}`,
    )
    return body.sessions.map(toSession)
  }

  /** Everything one run heard, in order. */
  async sessionSegments(sessionId: number): Promise<StoredSegment[]> {
    const body = await this.json<{ segments?: RawStoredSegment[] }>(
      'GET',
      `/api/v1/assist/sessions/${sessionId}`,
    )
    return (body.segments ?? [])
      .filter((segment) => segment.status === 'completed' && segment.text)
      .map((segment) => ({
        sequence: segment.sequence,
        text: segment.text ?? '',
        startedAt: segment.started_at ?? null,
        speaker: segment.speaker === 'candidate' ? 'candidate' : 'interviewer',
      }))
  }

  /** What was asked in one run and what was written for it. */
  async answers(sessionId: number): Promise<StoredAnswer[]> {
    const body = await this.json<{ answers?: RawAnswer[] }>(
      'GET',
      `/api/v1/assist/sessions/${sessionId}/answers`,
    )
    return (body.answers ?? []).map((answer) => ({
      id: answer.id,
      status: answer.status ?? 'completed',
      question: answer.question ?? '',
      answer: answer.answer ?? '',
      source: answer.source,
      turn: answer.turn
        ? {
            fromSequence: answer.turn.from_sequence,
            throughSequence: answer.turn.through_sequence,
            text: answer.turn.text ?? '',
          }
        : null,
      askedAt: answer.asked_at ?? null,
      completedAt: answer.completed_at ?? null,
      error: answer.error ?? null,
    }))
  }

  async createSession(input: CreateSessionInput = {}): Promise<AssistSession> {
    const raw = await this.json<RawSession>('POST', '/api/v1/assist/sessions', {
      interview_id: input.interviewId ?? null,
      audio_source: input.audioSource,
      device_label: input.deviceLabel,
      transcriber: input.transcriber,
      language: input.language,
    })
    return toSession(raw)
  }

  /**
   * Sends committed transcript segments. Accepts a batch; `sequence` is the
   * identity of each, so re-sending one corrects it rather than duplicating.
   */
  async uploadSegments(sessionId: number, segments: SegmentUpload[]): Promise<void> {
    await this.json<unknown>(
      'POST',
      `/api/v1/assist/sessions/${sessionId}/segments`,
      {
        segments: segments.map((segment) => ({
          sequence: segment.sequence,
          // Transcription already happened here, so the segment arrives
          // finished. Without this it is stored as `queued`, and the server
          // reads neither the prompt's transcript nor question detection from
          // anything but `completed` — the text would be kept and ignored.
          status: 'completed',
          text: segment.text,
          started_at: segment.startedAt,
          ended_at: segment.endedAt,
          confidence: segment.confidence,
          speaker: segment.speaker,
        })),
      },
    )
  }

  /**
   * Hands over the sentence in progress, so anybody watching the round on the
   * web sees it too. Written nowhere: the segment that follows is the record.
   *
   * Blank text is how a client says the speaker stopped, without a second call.
   */
  async updateListening(sessionId: number, streamId: string, text: string): Promise<void> {
    await this.json('PATCH', `/api/v1/assist/sessions/${sessionId}/listening`, {
      stream_id: streamId,
      text,
    })
  }

  /** Takes the live text down now, rather than leaving it to expire. */
  async clearListening(sessionId: number): Promise<void> {
    await this.json('DELETE', `/api/v1/assist/sessions/${sessionId}/listening`)
  }

  /** Marks the run finished. Statuses are live / ended / failed. */
  async endSession(sessionId: number, status: 'ended' | 'failed' = 'ended'): Promise<void> {
    await this.json('PATCH', `/api/v1/assist/sessions/${sessionId}`, { status })
  }

  /**
   * Streams an answer for one question.
   *
   * Resolves when the stream ends for any reason; failures are reported
   * through `onError` rather than thrown, because a partial answer already on
   * screen is worth keeping and a throw would discard the context needed to
   * decide that.
   */
  async streamAnswer(
    sessionId: number,
    request: AnswerRequest,
    handlers: AnswerStreamHandlers,
    signal: AbortSignal,
  ): Promise<void> {
    const url = this.url(`/api/v1/assist/sessions/${sessionId}/answers/stream`)

    let response: Response
    try {
      response = await net.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          question: request.question,
          context: request.context,
          client_request_id: request.clientRequestId,
        }),
        signal,
      })
    } catch (err) {
      if (signal.aborted) return
      const error = err as Error
      handlers.onError({
        code: 'network_error',
        message: `Could not reach TeamBridge: ${error.message}`,
        retryable: true,
      })
      return
    }

    // The server turns a request away before the connection becomes a stream,
    // so a rejection arrives as ordinary JSON we can read.
    if (!response.ok) {
      handlers.onError(await this.streamError(response))
      return
    }

    const body = response.body
    if (!body) {
      handlers.onError({
        code: 'empty_response',
        message: 'TeamBridge returned no stream.',
        retryable: true,
      })
      return
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        // stream: true keeps a multi-byte character split across chunks intact.
        for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
          this.dispatch(event.event, event.data, handlers)
        }
      }
      for (const event of parser.flush()) this.dispatch(event.event, event.data, handlers)
    } catch (err) {
      if (signal.aborted) return
      const error = err as Error
      handlers.onError({
        code: 'stream_interrupted',
        message: `The answer stream ended early: ${error.message}`,
        retryable: true,
      })
    } finally {
      reader.releaseLock()
    }
  }

  private dispatch(name: string, data: string, handlers: AnswerStreamHandlers): void {
    let payload: Record<string, unknown> = {}
    if (data) {
      try {
        payload = JSON.parse(data) as Record<string, unknown>
      } catch {
        log.warn({ name, data }, 'unparseable SSE payload')
        return
      }
    }

    switch (name) {
      case 'start': {
        const turn = payload['turn'] as RawTurn | undefined
        handlers.onStart({
          questionId: payload['question_id'] as number | undefined,
          question: payload['question'] as string | undefined,
          source: payload['source'] as QuestionSource | undefined,
          turn: turn
            ? {
                fromSequence: turn.from_sequence,
                throughSequence: turn.through_sequence,
                text: turn.text ?? '',
              }
            : undefined,
        })
        break
      }
      case 'delta':
        // An empty delta is legitimate and simply adds nothing.
        handlers.onDelta({ text: String(payload['text'] ?? '') })
        break
      case 'done':
        handlers.onDone({ questionId: payload['question_id'] as number | undefined })
        break
      case 'error':
        handlers.onError({
          code: String(payload['code'] ?? 'server_error'),
          message: String(payload['message'] ?? 'TeamBridge could not finish the answer.'),
          retryable: true,
        })
        break
      default:
        log.debug({ name }, 'ignoring unknown SSE event')
    }
  }

  private async streamError(
    response: Response,
  ): Promise<{ code: string; message: string; retryable: boolean }> {
    const problem = readProblem(await response.json().catch(() => null), response.status)

    // 409 means this exact request is already being answered — retrying
    // immediately would only be refused again.
    const retryable = response.status !== 401 && response.status !== 404 && response.status !== 409
    return { ...problem, retryable }
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await net.fetch(this.url(path), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (!response.ok) {
      const problem = readProblem(await response.json().catch(() => null), response.status)
      throw new TeamBridgeError(
        problem.code,
        problem.message,
        response.status,
        response.status >= 500,
      )
    }

    return (await response.json()) as T
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, '')}${path}`
  }
}

/**
 * Reads whichever error shape came back.
 *
 * TeamBridge says the same thing four ways depending on which controller
 * refused: `{code, message}`, `{error: {code, message}}`, `{error: "text"}`,
 * and `{errors: [...]}`. Guessing one and reading a nested object as a string
 * puts "[object Object]" in front of the user at the moment they most need to
 * know what went wrong.
 */
function readProblem(body: unknown, status: number): { code: string; message: string } {
  const fallback = { code: defaultCode(status), message: `TeamBridge returned ${status}.` }
  if (!body || typeof body !== 'object') return fallback

  const raw = body as Record<string, unknown>
  const nested = raw['error']
  const problem =
    nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : raw

  const errors = raw['errors']
  const message =
    typeof problem['message'] === 'string'
      ? problem['message']
      : typeof nested === 'string'
        ? nested
        : Array.isArray(errors) && errors.length > 0
          ? errors.join('. ')
          : fallback.message

  return {
    code: typeof problem['code'] === 'string' ? problem['code'] : fallback.code,
    message,
  }
}

function defaultCode(status: number): string {
  if (status === 401) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409) return 'answer_in_progress'
  if (status === 503) return 'server_busy'
  return status >= 500 ? 'server_error' : 'request_rejected'
}

/* ------------------------- wire → domain mapping ------------------------- */

interface RawInterview {
  id: number
  starts_at: string | null
  ends_at: string | null
  time_zone: string
  status: string
  position: { title: string | null }
  company: { name: string | null }
  candidate?: { id: number; name: string } | null
}

interface RawStoredSegment {
  sequence: number
  status?: string
  text?: string
  speaker?: string
  started_at?: string | null
}

interface RawAnswer {
  id: number
  status?: string
  question?: string | null
  answer?: string | null
  source?: QuestionSource
  turn?: RawTurn | null
  asked_at?: string | null
  completed_at?: string | null
  error?: string | null
}

interface RawMessage {
  id: number
  question_id?: number | null
  question?: string | null
  type?: string
  source?: string
  content?: string
  sender?: { name?: string | null }
  created_at?: string
  /** Not sent today; read so that adding it server-side needs no client change. */
  after_transcript_sequence?: number | null
}

interface RawTurn {
  from_sequence: number
  through_sequence: number
  text?: string
}

interface RawSession {
  id: number
  status: string
  audio_source: string | null
  device_label: string | null
  transcriber: string | null
  language: string | null
  interview_id: number | null
  started_at: string | null
  ended_at: string | null
  segment_count: number
}

function toInterview(raw: RawInterview): Interview {
  return {
    id: raw.id,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    timeZone: raw.time_zone,
    status: raw.status,
    position: raw.position,
    company: raw.company,
    candidate: raw.candidate ?? null,
  }
}

function toSession(raw: RawSession): AssistSession {
  return {
    id: raw.id,
    status: raw.status,
    audioSource: raw.audio_source,
    deviceLabel: raw.device_label,
    transcriber: raw.transcriber,
    language: raw.language,
    interviewId: raw.interview_id,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    segmentCount: raw.segment_count,
  }
}
