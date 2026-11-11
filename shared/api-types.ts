/**
 * The TeamBridge API as this app uses it.
 *
 * The server speaks snake_case; these are the camelCase shapes the client maps
 * onto, so the convention change happens in exactly one place.
 */

export interface Interview {
  id: number
  /**
   * What to ask for when this round is opened, and the only thing in a row
   * that is not for reading. Null where the round has no recruitment behind
   * it — still sittable, it just has nothing more to say about itself.
   */
  recruitmentId: number | null
  /** ISO 8601 in the interview's own zone, not UTC — the app prints it verbatim. */
  startsAt: string | null
  endsAt: string | null
  /** IANA name, e.g. "America/Chicago". */
  timeZone: string
  status: string
  /** Somebody is listening to this round now, from any machine. */
  live: boolean
  /** Whether you may start and stop listening: only the round's interviewer may. */
  canListen: boolean
  position: { title: string | null }
  company: { name: string | null }
  /** Absent when the caller may not see whose round it is. */
  candidate?: { id: number; name: string } | null
}

/**
 * Who a round is with and what they are being seen about.
 *
 * Read once, after a round has been chosen, because it carries a resume. A
 * projection of the server's record rather than the record: no outcome, no
 * compensation, no lifecycle — none of which belongs on a laptop in a coffee
 * shop, and all of which the server leaves out.
 */
/** One value of the candidate's profile, as JSON carries it. */
export type FaceValue = string | number | boolean | null | string[]

export interface Recruitment {
  id: number
  jobTitle: string | null
  companyName: string | null
  /** Absent where the caller may not be told whose round it is. */
  candidate: {
    id: number
    name: string
    headline?: string | null
    /** Contact details follow a stricter rule than the name, and are often absent. */
    email?: string | null
    phone?: string | null
    location?: string | null
    /**
     * Every field of the candidate's profile, by the server's name for it
     * (first_name, skills, work_authorization_country, …). Absent from
     * servers that do not send it.
     */
    fields?: Record<string, FaceValue>
  } | null
  /**
   * Markdown, or an address where somebody kept one instead of writing it.
   * There is no file: a resume here is text.
   */
  resume: {
    kind: 'record' | 'written' | 'link'
    title?: string | null
    text?: string | null
    url?: string | null
  } | null
  job: {
    id: number | null
    title: string | null
    description: string | null
    postingUrl: string | null
  } | null
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
  /** How often the server wants a heartbeat while the run is live, in seconds. */
  heartbeatSeconds: number
}

export interface CreateSessionInput {
  interviewId?: number | null
  audioSource?: string
  deviceLabel?: string | null
  transcriber?: string | null
  language?: string | null
}

/**
 * One message in the chat between the round and the people watching it.
 *
 * From the web it is a colleague's note, or a whole suggested answer to read
 * out; from the desktop it is the person in the round writing back.
 */
export interface AssistMessage {
  id: number
  /**
   * 'answer' is a whole reply to read out; 'note' is a steer or a chat line;
   * 'caption' is what the interviewer said, sent on from Live Captions.
   */
  type: 'answer' | 'note' | 'caption'
  /** Who wrote it: somebody watching on the web, or this app. */
  source: 'web' | 'desktop'
  content: string
  /** The question it was sent about, when it was sent about one. */
  question: string | null
  /** The id is null from servers that do not send it. */
  sender: { id: number | null; name: string | null }
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

/**
 * The live session's state.
 *
 * Explicit rather than a handful of booleans: isRecording && isAnswering &&
 * isRestarting has states that cannot be reasoned about, and the restart is
 * exactly where they would go wrong.
 */
export type LiveStatus = 'idle' | 'starting' | 'recording' | 'error'

/**
 * The interviewer's run, as somebody who joined the round as its assistant
 * sees it.
 */
export interface WatchedRun {
  sessionId: number
  startedAt: number | null
  interviewer: { id: number | null; name: string | null }
}

/** What the server says about a round right now: its live run, and its captions. */
export interface LiveRound {
  session: WatchedRun | null
  captions: string | null
}

export interface LiveSessionState {
  status: LiveStatus
  interview: Interview | null
  /**
   * How this app is in the round: as its interviewer, who listens, or as an
   * assistant — anybody else on the team — who watches and chats as support.
   */
  role: 'interviewer' | 'assistant'
  /** Who this app's key belongs to, once known: to tell one's own messages apart. */
  meId: number | null
  /** As an assistant: the interviewer's open run, or null while they are not listening. */
  liveRun: WatchedRun | null
  /** As an assistant: Join Listening was pressed (and Leave has not been). */
  joined: boolean
  /** As an assistant: the run being watched — the live run, once joined. */
  watching: WatchedRun | null
  /** The TeamBridge run opened by Start Listening. */
  serverSessionId: number | null
  /** When this run of listening began. */
  sessionStartedAt: number | null
  /** The chat with the people watching this round, oldest first. */
  messages: AssistMessage[]
  /** Live connection state. Kept apart from listening: audio may be fine. */
  realtime: RealtimeStatus
  error?: string
}
