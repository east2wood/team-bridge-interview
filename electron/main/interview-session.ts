import { EventEmitter } from 'node:events'
import type {
  AssistMessage,
  RealtimeEvent,
  RealtimeStatus,
  Interview,
  LiveSessionState,
  LiveStatus,
  WatchedRun,
} from '@shared/api-types'
import {
  TeamBridgeError,
  toMessage,
  type RawMessage,
  type TeamBridgeClient,
} from '@services/teambridge/teambridge-client'
import { isMine } from '@shared/chat'
import { child } from '@services/logger'
import type { MessagePoller } from '@services/teambridge/message-poller'
import type { RealtimeClient } from '@services/teambridge/realtime-client'
import { openLiveCaptions } from '@services/live-captions'

const log = child('interview')

const NOT_INTERVIEWER = 'Only the interviewer can start listening to this round.'

/**
 * How often an assistant asks whether the interviewer is listening. The
 * socket carries everything once they are; this is how a run is found to
 * subscribe to, and the fallback for captions while the socket is down.
 */
const WATCH_POLL_MS = 4000

/**
 * The listening store on the server forgets after two minutes, so captions
 * that have not changed are sent again this often: an assistant joining
 * during a long silence still sees what was last said.
 */
const CAPTIONS_KEEPALIVE_MS = 60_000

/** The server keeps up to 2,000 characters; the latest are the ones that matter. */
const CAPTIONS_SHARED_CHARS = 1800

/**
 * Orchestrates one interview: the TeamBridge run, and the chat with the people
 * watching it on the web.
 *
 * Two ways to be in a round. Its interviewer listens: Start Listening opens
 * Windows Live Captions and a run on TeamBridge, which tells the web the round
 * is live, carries messages here the moment they are sent, and carries what
 * Live Captions shows to everybody watching. Anybody else on the team joins as
 * an assistant: they chat as the support team, and once the interviewer is
 * listening they subscribe to that run and watch its captions as they change.
 */
export class InterviewSession extends EventEmitter {
  private status: LiveStatus = 'idle'
  private interview: Interview | null = null
  private serverSessionId: number | null = null
  private error: string | undefined
  private sessionStartedAt: number | null = null
  private messages: AssistMessage[] = []
  private realtime: RealtimeStatus = 'disconnected'

  private role: 'interviewer' | 'assistant' = 'interviewer'
  private meId: number | null = null
  /** As an assistant: the interviewer's open run, whether or not it has been joined. */
  private liveRun: WatchedRun | null = null
  /** As an assistant: Join Listening was pressed, and Leave has not been. */
  private joined = false
  /** As an assistant: the run subscribed to — the live run, once joined. */
  private watching: WatchedRun | null = null
  private remoteCaptions: string | null = null
  private watchTimer: NodeJS.Timeout | null = null
  /** As the interviewer: the captions last shared, and one waiting behind a send. */
  private shared: { text: string; at: number } | null = null
  private sharing = false
  private pendingShare: string | null = null

  constructor(
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
    live.on('resync', () => void this.poller.pollNow())

    live.on('event', (event: RealtimeEvent) => this.applyRealtimeEvent(event))

    poller.on('messages', (incoming: AssistMessage[]) => this.addMessages(incoming))
  }

  snapshot(): LiveSessionState {
    return {
      status: this.status,
      interview: this.interview,
      serverSessionId: this.serverSessionId,
      sessionStartedAt: this.sessionStartedAt,
      messages: this.messages,
      realtime: this.realtime,
      role: this.role,
      meId: this.meId,
      liveRun: this.liveRun,
      joined: this.joined,
      watching: this.watching,
      ...(this.error ? { error: this.error } : {}),
    }
  }

  /** As an assistant: what the interviewer's Live Captions show, or null when not watching. */
  watchedCaptions(): string | null {
    return this.remoteCaptions
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
    this.stopWatching()
    this.interview = interview
    this.messages = []
    this.role = interview && !interview.canListen ? 'assistant' : 'interviewer'

    // Polled for as long as the round is open, not only while listening: the
    // chat is there before the interview starts and after it ends.
    if (interview) this.poller.start(interview.id)
    else this.poller.stop()

    if (interview) void this.loadMe()
    if (interview && this.role === 'assistant') this.startWatching()

    this.publish()
  }

  /** Who this key belongs to, asked once: how one's own messages are told apart. */
  private async loadMe(): Promise<void> {
    if (this.meId !== null) return
    const client = this.clientFor()
    if (!client) return
    try {
      const me = await client.me()
      const id = Number(me.id)
      if (Number.isFinite(id)) {
        this.meId = id
        this.publish()
      }
    } catch (err) {
      log.warn({ err }, 'could not ask who this key belongs to')
    }
  }

  /* ------------------------------ assistant ----------------------------- */

  /**
   * Joins the interviewer's listening: their captions beside the chat, as
   * they change. Pressed before they have started, it waits and joins the run
   * as soon as there is one.
   */
  joinListening(): { ok: boolean; reason?: string } {
    if (this.role !== 'assistant' || !this.interview) {
      return { ok: false, reason: 'Only somebody assisting a round joins its listening.' }
    }
    this.joined = true
    this.syncSubscription()
    this.publish()
    // Ask now rather than at the next tick, so the captions come up at once.
    void this.checkLiveRound()
    return { ok: true }
  }

  /** Stops watching the interviewer's captions. The chat stays. */
  leaveListening(): void {
    if (!this.joined) return
    this.joined = false
    this.syncSubscription()
    this.publish()
  }

  /**
   * Subscribes to the run there should be one to — the live run, once
   * joined — and lets go of any other. True when it changed.
   */
  private syncSubscription(captions?: string | null): boolean {
    const want = this.joined ? this.liveRun : null
    if (want?.sessionId === this.watching?.sessionId) return false

    if (this.watching) this.live.disconnect()
    this.watching = want
    if (want) {
      log.info({ sessionId: want.sessionId }, 'joining the interviewer’s run')
      this.live.connect(want.sessionId)
      this.setRemoteCaptions(captions ?? '')
    } else {
      this.setRemoteCaptions(null)
    }
    return true
  }

  /**
   * Keeps an eye on whether the interviewer is listening, for as long as the
   * round is open: what the Join Listening bar says, and the run to join.
   */
  private startWatching(): void {
    this.stopWatching()
    const tick = async () => {
      await this.checkLiveRound()
      if (this.role === 'assistant' && this.interview) {
        this.watchTimer = setTimeout(() => void tick(), WATCH_POLL_MS)
      }
    }
    void tick()
  }

  private stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    this.joined = false
    this.liveRun = null
    this.syncSubscription()
  }

  /**
   * Asks whether the interviewer is listening. Once joined, a new run is
   * subscribed to and a run that has gone is let go. While the socket is down
   * the answer's captions stand in for the ones it would have carried.
   */
  private async checkLiveRound(): Promise<void> {
    const client = this.clientFor()
    const interview = this.interview
    if (!client || !interview) return

    let round
    try {
      round = await client.liveRound(interview.id)
    } catch (err) {
      log.debug({ err }, 'could not ask whether the round is live')
      return
    }
    // The round may have been closed or changed while the answer was coming.
    if (this.interview?.id !== interview.id || this.role !== 'assistant') return

    const run = round.session
    const changed = run?.sessionId !== this.liveRun?.sessionId
    this.liveRun = run
    if (this.syncSubscription(round.captions) || changed) {
      this.publish()
      return
    }

    if (this.watching && this.realtime !== 'connected') this.setRemoteCaptions(round.captions ?? '')
  }

  private setRemoteCaptions(text: string | null): void {
    if (text === this.remoteCaptions) return
    this.remoteCaptions = text
    this.emit('remote-captions', text)
  }

  /* ----------------------------- interviewer ---------------------------- */

  /**
   * Shares what Live Captions shows with everybody watching the run. Called
   * every time the captions are read; sends when they changed, or when the
   * server would otherwise have forgotten them. One request at a time, the
   * latest text waiting behind it.
   */
  shareCaptions(showing: string): void {
    const sessionId = this.serverSessionId
    if (this.status !== 'recording' || sessionId === null) return

    const text = tail(showing, CAPTIONS_SHARED_CHARS)
    const fresh =
      !this.shared ||
      this.shared.text !== text ||
      Date.now() - this.shared.at > CAPTIONS_KEEPALIVE_MS
    if (!fresh) return

    if (this.sharing) {
      this.pendingShare = text
      return
    }

    const client = this.clientFor()
    if (!client) return
    this.sharing = true
    this.shared = { text, at: Date.now() }
    void client
      .sendListening(sessionId, text)
      .catch((err) => {
        log.debug({ err }, 'could not share the captions')
        // Not shared after all: the next read tries again.
        this.shared = null
      })
      .finally(() => {
        this.sharing = false
        const next = this.pendingShare
        this.pendingShare = null
        if (next !== null) this.shareCaptions(next)
      })
  }

  /**
   * Opens Windows Live Captions and the TeamBridge session.
   *
   * Selecting an interview deliberately does not start a run: the user may
   * open it minutes early, and a run opened then would time the interview
   * from the wrong moment.
   */
  async startListening(): Promise<{ ok: boolean; reason?: string }> {
    if (this.status !== 'idle' && this.status !== 'error') {
      return { ok: false, reason: 'Already listening.' }
    }

    // Before anything else: this is the only thing that opens Live Captions,
    // and an assistant watches the interviewer's captions instead.
    if (this.role === 'assistant' || (this.interview && !this.interview.canListen)) {
      return { ok: false, reason: NOT_INTERVIEWER }
    }

    this.setStatus('starting')

    // The run first: the server is what decides whether this person may
    // listen, and a refusal should not leave Live Captions open behind it.
    const opened = await this.openServerSession()
    if (!opened.ok) {
      this.setStatus('error', opened.reason)
      return opened
    }

    const captions = await openLiveCaptions()
    if (!captions.ok) {
      // Otherwise the round would show Live on every picker with nobody
      // listening.
      await this.endServerSession('failed')
      this.setStatus('error', captions.reason)
      return captions
    }

    this.sessionStartedAt = Date.now()
    this.setStatus('recording')
    return { ok: true }
  }

  async stopListening(): Promise<void> {
    // An assistant has nothing of its own to stop: the run is the interviewer's.
    if (this.role === 'assistant') return
    await this.endServerSession('ended')
    this.sessionStartedAt = null
    this.shared = null
    this.pendingShare = null
    this.setStatus('idle')
  }

  /**
   * Sends a chat message to the people watching the round. Works whether or
   * not listening has started: the chat belongs to the round, not to a run.
   */
  async sendMessage(
    text: string,
    kind: 'note' | 'caption' = 'note',
  ): Promise<{ ok: boolean; reason?: string }> {
    const content = text.trim()
    if (!content) return { ok: false, reason: 'Write something to send first.' }
    if (!this.interview) return { ok: false, reason: 'Open an interview first.' }

    const client = this.clientFor()
    if (!client) return { ok: false, reason: 'No TeamBridge server is configured. Add it in Settings.' }

    try {
      const sent = await client.sendMessage(this.interview.id, content, kind)
      this.addMessages([sent])
      return { ok: true }
    } catch (err) {
      log.warn({ err }, 'could not send a chat message')
      // A server from before the chat has no route to send to, and answers 404
      // for the path itself — not "Interview not found", which is a real round
      // the key cannot see.
      if (err instanceof TeamBridgeError && err.status === 404 && !/interview/i.test(err.message)) {
        return {
          ok: false,
          reason: 'The message was not sent: this TeamBridge server cannot receive messages from the app yet. It needs the latest server update.',
        }
      }
      return { ok: false, reason: `The message was not sent: ${(err as Error).message}` }
    }
  }

  /** Fetches any messages not yet shown, now rather than at the next poll. */
  refreshMessages(): Promise<void> {
    return this.poller.pollNow()
  }

  /**
   * Opens a run on the server, if there is a server and no run already.
   *
   * Live Captions is still worth having without one, so a failure here is a
   * warning rather than a refusal; the chat still works, by polling. The one
   * exception is the server saying no: only the round's interviewer listens.
   */
  private async openServerSession(): Promise<{ ok: boolean; reason?: string }> {
    const client = this.clientFor()
    if (!client || this.serverSessionId !== null) return { ok: true }

    try {
      const created = await client.createSession({
        interviewId: this.interview?.id ?? null,
        audioSource: 'system',
      })
      this.serverSessionId = created.id
      this.live.connect(created.id)
      log.info({ serverSessionId: created.id }, 'opened TeamBridge session')
    } catch (err) {
      if (err instanceof TeamBridgeError && err.status === 403) {
        log.info({ err }, 'not the interviewer; not listening')
        return { ok: false, reason: NOT_INTERVIEWER }
      }
      log.warn({ err }, 'could not open a TeamBridge session')
    }
    return { ok: true }
  }

  /**
   * Marks the run finished on the server and forgets it.
   *
   * Clearing the id is the point: startListening only opens a session when it
   * has none, so a session left set here would be reused by the next Start.
   */
  private async endServerSession(status: 'ended' | 'failed'): Promise<void> {
    const client = this.clientFor()
    const sessionId = this.serverSessionId

    // Unsubscribed first, and deliberately: finishing a session broadcasts
    // that it was completed, and a completed session is the app's signal to
    // stop listening. Told about a closure it performed itself, it would stop
    // in the middle of starting a new run.
    this.live.disconnect()

    if (client && sessionId !== null) {
      try {
        await client.endSession(sessionId, status)
        log.info({ sessionId, status }, 'marked the TeamBridge session finished')
      } catch (err) {
        // Worth saying out loud: the run stays open on the server and
        // somebody has to know that.
        log.warn({ err, sessionId }, 'could not mark the TeamBridge session finished')
        this.emit('notice', {
          level: 'warn',
          message: 'The interview was not marked finished on TeamBridge.',
        })
      }
    }

    this.serverSessionId = null
  }

  /** Leaves the interview entirely. */
  async close(): Promise<void> {
    await this.stopListening()
    this.stopWatching()
    this.poller.stop()
    this.messages = []
    this.interview = null
    this.role = 'interviewer'
    this.publish()
  }

  /* ------------------------------ internals ----------------------------- */

  /**
   * Appends messages not already held, in id order. The same message can
   * arrive three ways — the reply to sending it, the socket, and the poll —
   * and is shown once.
   *
   * Only the socket announces: a poll also returns what was sent before the
   * round was opened, and a notification for each of those would be noise.
   */
  private addMessages(incoming: AssistMessage[], announce = false): void {
    const known = new Set(this.messages.map((m) => m.id))
    const fresh = incoming.filter((m) => !known.has(m.id))
    if (fresh.length === 0) return

    this.messages = [...this.messages, ...fresh].sort((a, b) => a.id - b.id)
    this.publish()
    if (!announce) return
    for (const message of fresh) {
      if (!isMine(message, this.role, this.meId)) this.emit('incoming-message', message)
    }
  }

  /**
   * Applies a live notification.
   *
   * Messages and the run ending matter to both roles; the captions only to an
   * assistant, who is watching them. The rest describe things this app no
   * longer does and are acknowledged only.
   */
  private applyRealtimeEvent(event: RealtimeEvent): void {
    // A subscription that has moved on can still deliver one more frame from
    // where it was. Nothing about a finished session should touch this one.
    const current = this.serverSessionId ?? this.watching?.sessionId ?? null
    if (current !== null && event.sessionId !== current) {
      log.debug({ type: event.type, sessionId: event.sessionId }, 'ignoring a stale event')
      return
    }

    switch (event.type) {
      case 'assist_message.created': {
        const message = toMessage(event.data as RawMessage | null)
        if (message) this.addMessages([message], true)
        return
      }

      case 'listening.updated': {
        if (this.role !== 'assistant') return
        const text = (event.data as { text?: unknown } | null)?.text
        this.setRemoteCaptions(typeof text === 'string' ? text : '')
        return
      }

      case 'listening.cleared': {
        if (this.role === 'assistant' && this.watching) this.setRemoteCaptions('')
        return
      }

      case 'session.completed': {
        if (this.role === 'assistant') {
          // The interviewer stopped. Let the run go but stay joined: the next
          // check finds the next run if they start again.
          if (this.liveRun) {
            log.info('the interviewer stopped listening')
            this.liveRun = null
            this.syncSubscription()
            this.publish()
          }
          return
        }
        // The run was finished elsewhere. Stop rather than carrying on in
        // something the server considers closed.
        if (this.status === 'recording') {
          log.warn('the session was completed elsewhere; stopping')
          void this.stopListening()
        }
        return
      }

      default:
        log.debug({ type: event.type }, 'ignoring realtime event')
    }
  }
}

/** The last `max` characters, starting on a word. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(-max)
  const space = cut.search(/\s/)
  return space >= 0 ? cut.slice(space + 1) : cut
}
