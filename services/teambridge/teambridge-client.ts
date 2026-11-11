import { net } from 'electron'
import type {
  AssistMessage,
  AssistSession,
  CreateSessionInput,
  Interview,
  LiveRound,
  Recruitment,
} from '@shared/api-types'
import type { Identity } from '@shared/types'

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
    const body = await this.json<{ data: Identity }>('GET', '/api/v1/interview/me')
    return body.data
  }

  async interviews(): Promise<Interview[]> {
    const body = await this.json<{ data: RawInterview[] }>('GET', '/api/v1/interview/interviews')
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
      `/api/v1/interview/interviews/${interviewId}/messages${query}`,
    )
    return body.messages.map(toMessage).filter((m): m is AssistMessage => m !== null)
  }

  /**
   * Sends a chat message to the people watching the round on the web: a typed
   * note, or with kind 'caption', text sent on from Live Captions.
   */
  async sendMessage(
    interviewId: number,
    content: string,
    kind: 'note' | 'caption' = 'note',
  ): Promise<AssistMessage> {
    const body = await this.json<{ message: RawMessage }>(
      'POST',
      `/api/v1/interview/interviews/${interviewId}/messages`,
      { content, kind },
    )
    const message = toMessage(body.message)
    if (!message) throw new TeamBridgeError('bad_response', 'TeamBridge did not return the message.', 200, false)
    return message
  }

  /**
   * Who a round is with and what they are being seen about.
   *
   * Asked for once, when somebody opens the panel: it carries a resume, and
   * the picker that lists forty rounds has no business loading forty of them.
   */
  async recruitment(id: number): Promise<Recruitment> {
    const body = await this.json<{ data: RawRecruitment }>(
      'GET',
      `/api/v1/interview/recruitments/${id}`,
    )
    const raw = body.data
    return {
      id: raw.id,
      jobTitle: raw.job_title ?? null,
      companyName: raw.company_name ?? null,
      candidate: raw.candidate
        ? {
            id: raw.candidate.id,
            name: raw.candidate.name,
            headline: raw.candidate.headline ?? null,
            email: raw.candidate.email ?? null,
            phone: raw.candidate.phone ?? null,
            location: raw.candidate.location ?? null,
          }
        : null,
      resume: raw.resume
        ? {
            kind: raw.resume.kind,
            title: raw.resume.title ?? null,
            text: raw.resume.text ?? null,
            url: raw.resume.url ?? null,
          }
        : null,
      job: raw.job
        ? {
            id: raw.job.id ?? null,
            title: raw.job.title ?? null,
            description: raw.job.description ?? null,
            postingUrl: raw.job.posting_url ?? null,
          }
        : null,
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<AssistSession> {
    const raw = await this.json<RawSession>('POST', '/api/v1/interview/sessions', {
      interview_id: input.interviewId ?? null,
      audio_source: input.audioSource,
      device_label: input.deviceLabel,
      transcriber: input.transcriber,
      language: input.language,
    })
    return toSession(raw)
  }

  /**
   * The round's live run and what its interviewer's Live Captions show, for
   * somebody joining as its assistant.
   */
  async liveRound(interviewId: number): Promise<LiveRound> {
    const body = await this.json<RawLiveRound>('GET', `/api/v1/interview/interviews/${interviewId}/live`)
    const session = body.session
    return {
      session: session
        ? {
            sessionId: session.id,
            startedAt: session.started_at ? Date.parse(session.started_at) || null : null,
            interviewer: {
              id: session.interviewer?.id ?? null,
              name: session.interviewer?.name ?? null,
            },
          }
        : null,
      captions: body.captions?.text ?? null,
    }
  }

  /**
   * Puts what Live Captions shows in front of everybody watching the run.
   * The whole text each time, not a change: one that is lost is corrected by
   * the next.
   */
  async sendListening(sessionId: number, text: string): Promise<void> {
    await this.json('PATCH', `/api/v1/interview/sessions/${sessionId}/listening`, {
      stream_id: 'live-captions',
      text,
    })
  }

  /** Marks the run finished. Statuses are live / ended / failed. */
  async endSession(sessionId: number, status: 'ended' | 'failed' = 'ended'): Promise<void> {
    await this.json('PATCH', `/api/v1/interview/sessions/${sessionId}`, { status })
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
  recruitment_id?: number | null
  starts_at: string | null
  ends_at: string | null
  time_zone: string
  status: string
  /** Sent by servers that know; older ones do not, and nothing is live. */
  live?: boolean
  /** Whether the key's holder is the round's interviewer. Older servers do not say. */
  can_listen?: boolean
  position: { title: string | null }
  company: { name: string | null }
  candidate?: { id: number; name: string } | null
}

interface RawRecruitment {
  id: number
  job_title?: string | null
  company_name?: string | null
  candidate?: {
    id: number
    name: string
    headline?: string | null
    email?: string | null
    phone?: string | null
    location?: string | null
  } | null
  resume?: {
    kind: 'record' | 'written' | 'link'
    title?: string | null
    text?: string | null
    url?: string | null
  } | null
  job?: {
    id?: number | null
    title?: string | null
    description?: string | null
    posting_url?: string | null
  } | null
}

interface RawLiveRound {
  session: {
    id: number
    started_at?: string | null
    interviewer?: { id?: number | null; name?: string | null } | null
  } | null
  captions?: { text?: string | null } | null
}

export interface RawMessage {
  id: number
  question_id?: number | null
  question?: string | null
  type?: string
  source?: string
  content?: string
  sender?: { id?: number | null; name?: string | null }
  created_at?: string
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
    recruitmentId: raw.recruitment_id ?? null,
    startsAt: raw.starts_at,
    endsAt: raw.ends_at,
    timeZone: raw.time_zone,
    status: raw.status,
    live: raw.live === true,
    // A server that does not say also does not refuse, so silence is a yes.
    canListen: raw.can_listen !== false,
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

/**
 * A message as the app holds it, from the shape the API and the realtime
 * broadcast both send. Anything malformed is dropped rather than shown.
 */
export function toMessage(raw: RawMessage | null | undefined): AssistMessage | null {
  if (!raw || typeof raw.id !== 'number' || !raw.content) return null
  return {
    id: raw.id,
    type: raw.type === 'answer' ? 'answer' : raw.type === 'caption' ? 'caption' : 'note',
    source: raw.source === 'desktop' ? 'desktop' : 'web',
    content: raw.content,
    question: raw.question ?? null,
    sender: { id: raw.sender?.id ?? null, name: raw.sender?.name ?? null },
    createdAt: raw.created_at ?? new Date().toISOString(),
  }
}
