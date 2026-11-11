import { EventEmitter } from 'node:events'
import type {
  AssistMessage,
  RealtimeEvent,
  RealtimeStatus,
  Interview,
  LiveSessionState,
  LiveStatus,
} from '@shared/api-types'
import {
  TeamBridgeError,
  toMessage,
  type RawMessage,
  type TeamBridgeClient,
} from '@services/teambridge/teambridge-client'
import { child } from '@services/logger'
import type { MessagePoller } from '@services/teambridge/message-poller'
import type { RealtimeClient } from '@services/teambridge/realtime-client'
import { openLiveCaptions } from '@services/live-captions'

const log = child('interview')

/**
 * Orchestrates one interview: the TeamBridge run, and the chat with the people
 * watching it on the web.
 *
 * Listening is done by Windows Live Captions, which Start Listening opens.
 * The run it also opens on TeamBridge is what tells the web the round is live,
 * and what carries their messages here the moment they are sent.
 */
export class InterviewSession extends EventEmitter {
  private status: LiveStatus = 'idle'
  private interview: Interview | null = null
  private serverSessionId: number | null = null
  private error: string | undefined
  private sessionStartedAt: number | null = null
  private messages: AssistMessage[] = []
  private realtime: RealtimeStatus = 'disconnected'

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

    // Polled for as long as the round is open, not only while listening: the
    // chat is there before the interview starts and after it ends.
    if (interview) this.poller.start(interview.id)
    else this.poller.stop()

    this.publish()
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

    this.setStatus('starting')

    const captions = await openLiveCaptions()
    if (!captions.ok) {
      this.setStatus('error', captions.reason)
      return captions
    }

    await this.openServerSession()

    this.sessionStartedAt = Date.now()
    this.setStatus('recording')
    return { ok: true }
  }

  async stopListening(): Promise<void> {
    await this.endServerSession('ended')
    this.sessionStartedAt = null
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
   * warning rather than a refusal; the chat still works, by polling.
   */
  private async openServerSession(): Promise<void> {
    const client = this.clientFor()
    if (!client || this.serverSessionId !== null) return

    try {
      const created = await client.createSession({
        interviewId: this.interview?.id ?? null,
        audioSource: 'system',
      })
      this.serverSessionId = created.id
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
    this.poller.stop()
    this.messages = []
    this.interview = null
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
      if (message.source === 'web') this.emit('web-message', message)
    }
  }

  /**
   * Applies a live notification.
   *
   * Only `assist_message.created` and `session.completed` matter here; the
   * rest describe things this app no longer does and are acknowledged only.
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
        const message = toMessage(event.data as RawMessage | null)
        if (message) this.addMessages([message], true)
        return
      }

      case 'session.completed': {
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
