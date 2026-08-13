/**
 * Incremental Server-Sent Events parser.
 *
 * A network chunk is not an SSE record. A single read can split a record
 * anywhere — mid-field, mid-JSON, even between the \r and the \n — so the
 * parser buffers whatever is incomplete and only dispatches on a blank line.
 * Anything that assumes chunk == event will work in development and corrupt
 * answers under load.
 */
export interface SseEvent {
  /** Defaults to "message" when the stream omits an event: line, per spec. */
  event: string
  data: string
}

export class SseParser {
  private buffer = ''
  private eventName: string | null = null
  private dataLines: string[] = []

  /** Feeds a decoded chunk and returns whatever records completed within it. */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk
    const events: SseEvent[] = []

    // Split on line boundaries only where a full line is present; a trailing
    // fragment stays in the buffer for the next chunk.
    let index: number
    while ((index = this.buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buffer.slice(0, index)
      const match = /^\r\n|^\n|^\r/.exec(this.buffer.slice(index))
      this.buffer = this.buffer.slice(index + (match?.[0].length ?? 1))

      const completed = this.handleLine(line)
      if (completed) events.push(completed)
    }

    return events
  }

  private handleLine(line: string): SseEvent | null {
    // Blank line: dispatch whatever has accumulated.
    if (line === '') {
      if (this.dataLines.length === 0 && this.eventName === null) return null
      const event: SseEvent = {
        event: this.eventName ?? 'message',
        data: this.dataLines.join('\n'),
      }
      this.eventName = null
      this.dataLines = []
      return event
    }

    // Comment. The server sends ": open" to flush headers early, so this is a
    // normal occurrence rather than a malformed line.
    if (line.startsWith(':')) return null

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // Exactly one leading space after the colon is part of the syntax.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') this.eventName = value
    else if (field === 'data') this.dataLines.push(value)
    // id and retry are valid fields we have no use for; ignoring them is
    // correct, not an oversight.

    return null
  }

  /**
   * Anything still buffered when the stream ends. A well-behaved stream ends
   * on a blank line and this returns nothing; a truncated one may hold a
   * final record the server wrote but never terminated.
   */
  flush(): SseEvent[] {
    const trailing = this.buffer
    this.buffer = ''
    const events: SseEvent[] = []
    if (trailing) {
      const completed = this.handleLine(trailing)
      if (completed) events.push(completed)
    }
    const final = this.handleLine('')
    if (final) events.push(final)
    return events
  }
}
