import type { TeamBridgeClient } from './teambridge-client'
import { TeamBridgeError } from './teambridge-client'
import { child } from '../logger'

const log = child('listening')

/**
 * Shortest gap between updates.
 *
 * Recognition revises itself several times a second and every revision carries
 * the whole sentence, so sending each one would spend a request to replace a
 * string that is about to be replaced again. Six or seven a second still reads
 * as live to somebody watching.
 */
const INTERVAL_MS = 150

/**
 * Tells TeamBridge what the room is saying, while it is still being said.
 *
 * Nobody waits for this. The app draws its own partial the moment it has one —
 * it did the listening, it knew first — and this exists only so a colleague
 * watching the round on the web sees the same words at the same time. Which is
 * why nothing here is retried, queued, or reported: a partial that failed to
 * send is already wrong, and the next one is a fraction of a second away
 * carrying the whole sentence again.
 *
 * One stream at a time, named. A stream ends when the sentence closes into a
 * segment — the server pairs the two and retires the partial itself, since
 * only it knows which segment replaced which guess.
 */
export class ListeningPublisher {
  private sessionId: number | null = null
  private streamId: string | null = null
  private streams = 0
  /** The newest text not yet sent; only ever the latest, never a queue. */
  private pending: string | null = null
  private sent = ''
  private timer: NodeJS.Timeout | null = null
  private inFlight = false
  /** Set by a 409: the run has stopped and will not take partials again. */
  private refused = false
  private failing = false

  constructor(private readonly clientFor: () => TeamBridgeClient | null) {}

  /** Binds to a run. Anything from the previous one is forgotten, not flushed. */
  open(sessionId: number): void {
    this.reset()
    this.sessionId = sessionId
    this.refused = false
  }

  /** Stops publishing and takes down whatever was left on screen elsewhere. */
  close(): void {
    const client = this.clientFor()
    const sessionId = this.sessionId
    this.reset()
    this.sessionId = null

    // Said out loud rather than left to expire, so a page watching this round
    // stops showing a sentence nobody is going to finish.
    if (client && sessionId !== null && !this.refused) {
      void client.clearListening(sessionId).catch((err: unknown) => {
        log.debug({ err, sessionId }, 'could not clear the live text')
      })
    }
  }

  /** The current guess at the sentence in progress. */
  update(text: string): void {
    if (this.sessionId === null || this.refused) return

    const next = text.trim()
    // An unchanged guess is not news, and a blank one would clear the line
    // that the segment about to arrive is going to replace properly.
    if (!next || next === this.sent) return

    this.pending = next
    // Leading edge: the first words of a sentence go out immediately, and the
    // revisions behind them wait their turn.
    if (!this.timer) this.tick()
  }

  /**
   * The sentence closed. The next partial starts a new stream.
   *
   * Nothing is sent: the segment is posted the ordinary way, and the server
   * retires the partial when it lands, naming both. It is the only party that
   * knows the pairing, and a client guessing at it draws the sentence twice.
   */
  finalize(): void {
    this.pending = null
    this.sent = ''
    this.streamId = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private tick(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.pending !== null) this.tick()
    }, INTERVAL_MS)

    const text = this.pending
    if (text === null) return
    this.pending = null
    void this.send(text)
  }

  private async send(text: string): Promise<void> {
    const client = this.clientFor()
    const sessionId = this.sessionId
    if (!client || sessionId === null) return
    // Never two at once: they would arrive in either order, and the loser
    // would put an older guess on the page.
    if (this.inFlight) {
      this.pending = text
      return
    }

    this.streamId ??= `live-${(this.streams += 1)}`
    this.inFlight = true
    try {
      await client.updateListening(sessionId, this.streamId, text)
      this.sent = text
      this.failing = false
    } catch (err) {
      if (err instanceof TeamBridgeError && err.status === 409) {
        // The run has stopped. Partials after that would sit on a page under a
        // header saying the microphone is off.
        this.refused = true
        this.pending = null
        log.info({ sessionId }, 'the run is no longer live; stopped sending live text')
        return
      }
      // Ephemeral by definition: no retry, and one line about it rather than
      // one per revision.
      if (!this.failing) {
        this.failing = true
        log.warn({ err: (err as Error).message }, 'could not send the live text')
      }
    } finally {
      this.inFlight = false
    }
  }

  private reset(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
    this.sent = ''
    this.streamId = null
    this.failing = false
  }
}
