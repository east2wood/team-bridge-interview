import { net } from 'electron'
import type {
  AnswerRequest,
  AssistSession,
  CreateSessionInput,
  DetectedQuestion,
  Interview,
  QuestionSource,
  SegmentUpload,
} from '@shared/api-types'
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
  async uploadSegments(
    sessionId: number,
    segments: SegmentUpload[],
  ): Promise<DetectedQuestion | null> {
    const body = await this.json<{ question?: RawDetectedQuestion }>(
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

    const question = body.question
    if (!question?.detected || !question.text) return null
    return { text: question.text, confidence: question.confidence ?? null }
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
    const body = (await response.json().catch(() => null)) as
      | { code?: string; message?: string; error?: string }
      | null

    // 409 means this exact request is already being answered — retrying
    // immediately would only be refused again.
    const retryable = response.status !== 401 && response.status !== 404 && response.status !== 409
    return {
      code: body?.code ?? defaultCode(response.status),
      message: body?.message ?? body?.error ?? `TeamBridge returned ${response.status}.`,
      retryable,
    }
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
      const problem = (await response.json().catch(() => null)) as
        | { error?: string; message?: string; code?: string }
        | null
      throw new TeamBridgeError(
        problem?.code ?? defaultCode(response.status),
        problem?.error ?? problem?.message ?? `TeamBridge returned ${response.status}.`,
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

interface RawTurn {
  from_sequence: number
  through_sequence: number
  text?: string
}

interface RawDetectedQuestion {
  detected?: boolean
  text?: string
  confidence?: number
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
