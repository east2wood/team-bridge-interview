import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { RealtimeEvent, RealtimeStatus } from '@shared/api-types'
import { child } from '../logger'

const log = child('realtime')

/**
 * Reconnect backoff with jitter, capped.
 *
 * Jittered because every Assist in an outage would otherwise reconnect on the
 * same schedule and arrive together.
 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000]

/** Server pings every few seconds; silence for this long means a dead socket. */
const STALE_AFTER_MS = 25_000

/**
 * The live half of the TeamBridge connection.
 *
 * Receive-only by design, matching the server: writes go over HTTP where they
 * are persisted and answered for, and this only says that something happened.
 * A dropped socket therefore loses notifications, never data — the catch-up is
 * an ordinary API call for everything after what was last seen.
 *
 * Speaks the Action Cable wire protocol directly rather than through
 * @rails/actioncable, which expects browser globals that do not exist in the
 * main process.
 */
export class RealtimeClient extends EventEmitter {
  private socket: WebSocket | null = null
  private status: RealtimeStatus = 'disconnected'
  private sessionId: number | null = null
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private staleTimer: NodeJS.Timeout | null = null
  private closing = false

  constructor(
    private readonly config: () => { baseUrl: string; token: string } | null,
  ) {
    super()
  }

  getStatus(): RealtimeStatus {
    return this.status
  }

  /** Opens the socket and subscribes to one session. */
  connect(sessionId: number): void {
    if (this.sessionId === sessionId && this.socket) return
    this.disconnect()

    this.sessionId = sessionId
    this.closing = false
    this.attempt = 0
    this.open()
  }

  disconnect(): void {
    this.closing = true
    this.clearTimers()
    this.sessionId = null

    if (this.socket) {
      // Unsubscribe first so the server stops streaming before the socket
      // goes; closing alone leaves it to notice.
      this.send({ command: 'unsubscribe', identifier: this.identifier() })
      this.socket.removeAllListeners()
      this.socket.close()
      this.socket = null
    }

    this.setStatus('disconnected')
  }

  private open(): void {
    const config = this.config()
    const sessionId = this.sessionId
    if (!config || sessionId === null) {
      this.setStatus('disconnected')
      return
    }

    const url = cableUrl(config.baseUrl)
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')

    let socket: WebSocket
    try {
      // The key goes in a header where it can: a query string ends up in
      // proxy logs, and this one is a password.
      //
      // Origin is the server's own: Action Cable checks it for forgery and
      // answers a mismatch with a bare 404, which reads as "no such endpoint"
      // rather than "you were turned away". A desktop app has no browser
      // origin to send, and the server's default rule is that Origin equals
      // its own host, so that is what it gets.
      socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${config.token}` },
        origin: originOf(config.baseUrl),
        handshakeTimeout: 10_000,
      })
    } catch (err) {
      log.warn({ err: (err as Error).message, url }, 'could not open the realtime socket')
      this.scheduleReconnect()
      return
    }

    this.socket = socket

    socket.on('open', () => {
      log.info({ url, sessionId }, 'realtime socket open')
      this.send({ command: 'subscribe', identifier: this.identifier() })
      this.touch()
    })

    socket.on('message', (raw: WebSocket.RawData) => {
      this.touch()
      this.handleFrame(raw.toString())
    })

    socket.on('close', (code, reason) => {
      if (this.closing) return
      log.warn({ code, reason: reason.toString() }, 'realtime socket closed')
      this.scheduleReconnect()
    })

    socket.on('error', (err) => {
      // 'close' always follows, so reconnection is handled there.
      if (err.message.includes('404')) {
        // Action Cable answers a rejected Origin with 404, which sends people
        // looking for a missing route instead of a forgery check. Rails in
        // development only accepts `localhost`, so an app pointed at
        // 127.0.0.1 is turned away by the loopback address it asked for.
        log.warn(
          { url },
          'realtime handshake refused (404): the server did not accept this origin. ' +
            'In development Action Cable allows only http://localhost:<port>, so use that as ' +
            'the server URL, or set config.action_cable.disable_request_forgery_protection.',
        )
        return
      }
      log.warn({ err: err.message }, 'realtime socket error')
    })
  }

  private handleFrame(raw: string): void {
    let frame: {
      type?: string
      identifier?: string
      message?: { type?: string; session_id?: number; data?: unknown }
    }
    try {
      frame = JSON.parse(raw) as typeof frame
    } catch {
      return
    }

    switch (frame.type) {
      case 'welcome':
        return
      case 'ping':
        // Liveness only; `touch` already ran.
        return
      case 'confirm_subscription':
        this.attempt = 0
        this.setStatus('connected')
        log.info({ sessionId: this.sessionId }, 'subscribed to the session')
        // Whatever happened while disconnected was missed: the catch-up is an
        // ordinary API call, which the listener owns.
        this.emit('resync')
        return
      case 'reject_subscription':
        // The session is not readable by this key. Retrying cannot fix that.
        log.error({ sessionId: this.sessionId }, 'subscription rejected')
        this.closing = true
        this.setStatus('disconnected')
        this.emit('rejected')
        return
      case 'disconnect':
        this.scheduleReconnect()
        return
    }

    const message = frame.message
    if (!message?.type) return

    this.emit('event', {
      type: message.type,
      sessionId: message.session_id ?? this.sessionId ?? 0,
      data: message.data,
    } satisfies RealtimeEvent)
  }

  private identifier(): string {
    return JSON.stringify({ channel: 'AssistSessionChannel', session_id: this.sessionId })
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(payload))
  }

  /** Resets the staleness deadline; the server pings regularly. */
  private touch(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => {
      log.warn('no realtime traffic; treating the socket as dead')
      this.socket?.terminate()
    }, STALE_AFTER_MS)
  }

  private scheduleReconnect(): void {
    if (this.closing || this.sessionId === null) return
    this.clearTimers()

    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket = null
    }

    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    const wait = base + Math.floor(Math.random() * 500)
    this.attempt += 1
    this.setStatus('reconnecting')
    log.info({ attempt: this.attempt, wait }, 'reconnecting to realtime')
    this.reconnectTimer = setTimeout(() => this.open(), wait)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.staleTimer) clearTimeout(this.staleTimer)
    this.reconnectTimer = null
    this.staleTimer = null
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }
}

/** Scheme and host only, which is what an Origin header may carry. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.replace(/\/+$/, '')
  }
}

/** http(s) → ws(s), with Action Cable's default mount point. */
export function cableUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed.replace(/^http/i, 'ws')}/cable`
}
