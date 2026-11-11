import type { CaptionsView, CaptionTarget } from '@shared/types'

/**
 * What an ask takes from Live Captions: the text that has appeared since the
 * last ask, up to the last completed sentence. A sentence still being spoken
 * is left for the next ask rather than sent half-finished.
 *
 * Live Captions shows a rolling window, so there is no stable offset to count
 * from — old text falls off the front as new text arrives at the end, and the
 * last few words of what was showing may have been revised since. The place
 * the last ask ended is found instead, by looking for its tail in what is
 * showing now.
 */
export class CaptionCapture {
  /** The caption text up to the end of what was last asked. */
  private consumed = ''
  /** The last question taken, and where it has been sent. */
  private last: { question: string; sentTo: Set<CaptionTarget> } | null = null

  /** Starts counting from what is showing now, so older captions are not taken. */
  reset(showing: string): void {
    this.consumed = normalise(showing)
    this.last = null
  }

  /** Where the collected text starts and where its last complete sentence ends. */
  view(showing: string): Omit<CaptionsView, 'status'> {
    const text = normalise(showing)
    const collectedFrom = collectedStart(this.consumed, text)
    return { text, collectedFrom, completeUntil: lastSentenceEnd(text, collectedFrom) }
  }

  /**
   * The text to send to one target. The complete sentences collected since
   * the last ask, which then become asked — the next collection starts just
   * after the last of them. With nothing new, the last question, if this
   * target has not been sent it: so one question can go to the support chat
   * and to ChatGPT, but never twice to the same one. Null otherwise.
   */
  take(showing: string, to: CaptionTarget): string | null {
    const { text, collectedFrom, completeUntil } = this.view(showing)
    const question = text.slice(collectedFrom, completeUntil).trim()
    if (question) {
      this.consumed = text.slice(0, completeUntil)
      this.last = { question, sentTo: new Set([to]) }
      return question
    }
    if (this.last && !this.last.sentTo.has(to)) {
      this.last.sentTo.add(to)
      return this.last.question
    }
    return null
  }
}

/** How many trailing words of the last ask may have been revised since. */
const REVISABLE_WORDS = 3
/** Tail lengths to look for, longest (least ambiguous) first. */
const ANCHOR_LENGTHS = [120, 60, 30, 15]

/** Where the text that is new since `before` starts in `now`. */
export function collectedStart(before: string, now: string): number {
  if (!before) return 0

  const words = before.split(' ')
  for (let dropped = 0; dropped <= REVISABLE_WORDS && dropped < words.length; dropped++) {
    const settled = words.slice(0, words.length - dropped).join(' ')
    for (const length of ANCHOR_LENGTHS) {
      // Shorter than this is too common a phrase to place anything by.
      if (settled.length < Math.min(length, 15)) continue
      const end = endOf(now, settled.slice(-length))
      if (end !== null) return skipSpace(now, end)
    }
  }

  // Nothing of the last ask is still showing: everything on screen is new.
  return 0
}

/**
 * A sentence is complete at closing punctuation (optionally followed by a
 * quote or bracket) before a space, a line break, or the end — or at a line
 * break, which is where Live Captions ends an utterance.
 */
const SENTENCE_END = /[.!?]["')\]]?(?=\s|$)|\n/g

function lastSentenceEnd(text: string, from: number): number {
  let end = from
  SENTENCE_END.lastIndex = from
  for (let match = SENTENCE_END.exec(text); match; match = SENTENCE_END.exec(text)) {
    end = match.index + match[0].length
  }
  return end
}

/**
 * Where the last occurrence of the anchor ends, if it ends on a word boundary.
 * A word still being recognised ("dead") must not match the start of the word
 * it became ("deadline"), or the capture would begin in the middle of it.
 */
function endOf(text: string, anchor: string): number | null {
  for (let at = text.lastIndexOf(anchor); at >= 0; at = text.lastIndexOf(anchor, at - 1)) {
    const end = at + anchor.length
    if (end === text.length || /\s/.test(text[end] ?? '')) return end
    if (at === 0) break
  }
  return null
}

function skipSpace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at] ?? '')) at++
  return at
}

/** Spaces collapsed, line breaks kept: they are where one utterance ends. */
function normalise(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n+/g, '\n')
    .trim()
}
