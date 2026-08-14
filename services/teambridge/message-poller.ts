import { EventEmitter } from 'node:events'
import type { TeamBridgeClient } from './teambridge-client'
import { child } from '../logger'

const log = child('messages')

/**
 * How often to ask. Someone typing a steer mid-question expects it to land
 * within a breath, and the request is a keyset lookup returning almost always
 * nothing.
 */
const INTERVAL_MS = 3000

/**
 * Interval once the socket is up.
 *
 * The socket delivers messages the moment they are sent, so polling stops
 * being the delivery mechanism and becomes a safety net against a broadcast
 * that never arrived. Rare, but the transcript is durable and the notification
 * is not, so it is worth still asking occasionally.
 */
const SAFETY_NET_MS = 30_000

/** Backoff while the server is unreachable, so a outage is not hammered. */
const FAILURE_BACKOFF_MS = 15_000

/**
 * Polls for messages people send from the web during a round.
 *
 * Incremental by id: every request asks only for what came after the last
 * message seen, so a long interview does not re-download its own history and
 * the app cannot show the same note twice.
 */
export class MessagePoller extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private interviewId: number | null = null
  private lastId = 0
  private inFlight = false
  private failing = false
  private mode: 'fast' | 'slow' = 'fast'

  constructor(private readonly clientFor: () => TeamBridgeClient | null) {
    super()
  }

  start(interviewId: number): void {
    if (this.interviewId === interviewId && this.timer) return
    this.stop()
    this.interviewId = interviewId
    this.lastId = 0
    this.failing = false
    // Ask immediately: anything sent before the app opened the round is
    // waiting, and a first tick three seconds late looks broken.
    void this.tick()
    this.schedule(this.delay())
  }

  /** Polls quickly when the socket is down, rarely when it is carrying events. */
  setInterval(mode: 'fast' | 'slow'): void {
    if (this.mode === mode) return
    this.mode = mode
    if (this.timer) this.schedule(this.delay())
  }

  /** An immediate ask, used to catch up after a reconnect. */
  pollNow(): void {
    if (this.interviewId === null) return
    void this.tick()
  }

  private delay(): number {
    return this.mode === 'slow' ? SAFETY_NET_MS : INTERVAL_MS
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.interviewId = null
    this.lastId = 0
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), delay)
  }

  private async tick(): Promise<void> {
    const interviewId = this.interviewId
    const client = this.clientFor()

    if (interviewId === null || !client) {
      this.schedule(this.delay())
      return
    }
    // A slow response must not stack requests behind it.
    if (this.inFlight) {
      this.schedule(this.delay())
      return
    }

    this.inFlight = true
    try {
      const messages = await client.messages(interviewId, this.lastId || undefined)
      if (messages.length > 0) {
        this.lastId = Math.max(this.lastId, ...messages.map((m) => m.id))
        log.info({ count: messages.length, lastId: this.lastId }, 'messages received')
        this.emit('messages', messages)
      }
      this.failing = false
      this.schedule(this.delay())
    } catch (err) {
      if (!this.failing) {
        this.failing = true
        log.warn({ err: (err as Error).message }, 'could not fetch messages; backing off')
      }
      this.schedule(FAILURE_BACKOFF_MS)
    } finally {
      this.inFlight = false
    }
  }
}
