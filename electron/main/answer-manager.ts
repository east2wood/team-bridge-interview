import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { AnswerEvent } from '@shared/api-types'
import type { TeamBridgeClient } from '@services/teambridge/teambridge-client'
import { child } from '@services/logger'

const log = child('answers')

interface AskInput {
  turnId: string
  sessionId: number
  /** Omitted for a captured turn: the server works out what was asked. */
  question?: string
  context?: string
  /** Reused on retry: that is what makes the server treat it as the same question. */
  requestId?: string
}

/**
 * Owns answer generation so no UI code has to.
 *
 * Responsibilities: assign a request id, cancel a superseded stream, keep the
 * in-flight turn identified, and turn transport failures into events the
 * renderer can act on. Nothing here knows what a question is or where it came
 * from — a typed question and a transcribed one take the same path.
 */
export class AnswerManager extends EventEmitter {
  private controller: AbortController | null = null
  private activeTurnId: string | null = null
  private lastAsk: AskInput | null = null

  constructor(private readonly clientFor: () => TeamBridgeClient | null) {
    super()
  }

  get busy(): boolean {
    return this.controller !== null
  }

  /** Starts a stream, cancelling any still running. */
  async ask(input: AskInput): Promise<void> {
    const client = this.clientFor()
    if (!client) {
      this.emitEvent({
        type: 'error',
        turnId: input.turnId,
        requestId: input.requestId ?? 'none',
        code: 'not_configured',
        message: 'No TeamBridge server is configured. Add its URL and API token in Settings.',
        retryable: false,
      })
      return
    }

    // A new question supersedes the old one; two streams writing at once is
    // the bug this prevents.
    this.cancel()

    const requestId = input.requestId ?? randomUUID()
    const ask: AskInput = { ...input, requestId }
    this.lastAsk = ask
    this.activeTurnId = input.turnId

    const controller = new AbortController()
    this.controller = controller

    const ids = { turnId: input.turnId, requestId }
    log.info({ ...ids, sessionId: input.sessionId }, 'asking TeamBridge')

    try {
      await client.streamAnswer(
        input.sessionId,
        { question: input.question, context: input.context, clientRequestId: requestId },
        {
          onStart: ({ questionId, question, source, turn }) =>
            this.emitEvent({
              type: 'start',
              ...ids,
              questionId,
              question,
              source,
              context: turn,
            }),
          onDelta: ({ text }) => this.emitEvent({ type: 'delta', ...ids, text }),
          onDone: ({ questionId }) => this.emitEvent({ type: 'done', ...ids, questionId }),
          onError: (error) => this.emitEvent({ type: 'error', ...ids, ...error }),
        },
        controller.signal,
      )
    } finally {
      if (this.controller === controller) {
        this.controller = null
        this.activeTurnId = null
      }
    }
  }

  /** Re-asks the last question under its original request id, so the server resumes it. */
  async retry(): Promise<void> {
    if (!this.lastAsk) return
    await this.ask(this.lastAsk)
  }

  cancel(): void {
    if (!this.controller) return
    const turnId = this.activeTurnId
    const requestId = this.lastAsk?.requestId
    this.controller.abort()
    this.controller = null
    this.activeTurnId = null
    if (turnId && requestId) this.emitEvent({ type: 'cancelled', turnId, requestId })
  }

  private emitEvent(event: AnswerEvent): void {
    this.emit('event', event)
  }
}
