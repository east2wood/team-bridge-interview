/**
 * Pulls the question out of everything the interviewer said during a turn.
 *
 * The Answer button already tells us the question has finished, which is the
 * hard half. What is left is that people do not start talking at the question:
 * they finish the previous thought, acknowledge the last answer, then ask.
 * Sending all of that dilutes the prompt with material the model has to
 * ignore, and puts a wall of filler at the top of the conversation.
 *
 * Deliberately rules rather than a model call: it runs on every turn, has to
 * be instant, and a wrong guess here is visible and correctable by the user.
 */

/** Openings that mark the start of an ask, even without a question mark. */
const QUESTION_OPENERS = [
  'tell me',
  'can you',
  'could you',
  'would you',
  'walk me through',
  'give me an example',
  'describe',
  'explain',
  'what',
  'why',
  'how',
  'when',
  'where',
  'which',
  'who',
  'have you',
  'has there',
  'did you',
  'do you',
  'are you',
  'were you',
  'is there',
  'talk to me about',
  'tell us',
  'share',
]

/** Conversational throat-clearing at the very start of a sentence. */
const LEADING_FILLER =
  /^(?:(?:so|and|ok|okay|right|well|um+|uh+|erm+|yeah|yes|alright|now|but|anyway|great|perfect|thanks|thank you|cool|nice)[\s,.]+)+/i

export interface ExtractedQuestion {
  /** What to send. Falls back to the whole transcript when nothing looks like a question. */
  question: string
  /** True when a question was actually identified rather than guessed at. */
  confident: boolean
}

export function extractQuestion(transcript: string): ExtractedQuestion {
  const text = transcript.replace(/\s+/g, ' ').trim()
  if (!text) return { question: '', confident: false }

  const sentences = splitSentences(text)
  if (sentences.length === 0) return { question: '', confident: false }

  // Search from the end: when someone asks two things, the last one is what
  // they are waiting on, and anything before it is context we keep anyway.
  let start = -1
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (isQuestionLike(sentences[i]!)) {
      start = i
      break
    }
  }

  if (start === -1) {
    // No question found. The tail is still a better prompt than a minute of
    // preamble, but say it was a guess so the UI can offer a correction.
    const tail = sentences.slice(-2).join(' ')
    return { question: stripFiller(tail), confident: false }
  }

  const runUp = start > 0 && needsRunUp(sentences[start - 1]!, sentences[start]!) ? start - 1 : start
  const question = sentences.slice(runUp).join(' ')
  return { question: stripFiller(question), confident: true }
}

/**
 * Words that point at something said earlier. "How did you scale it?" is
 * unanswerable without the sentence before it; "What was the other change you
 * made?" is not. First and second person are excluded — "you" refers to the
 * candidate, not to anything in the transcript.
 */
const ANAPHORA = /\b(it|its|that|this|these|those|they|them|their|there|then)\b/i

/**
 * Whether the sentence before the question should be sent with it.
 *
 * Two reasons to keep it: the question refers back to it, or it is itself
 * part of a multi-part ask. Otherwise it is throat-clearing, and length is a
 * poor proxy — an acknowledgement is short too.
 */
function needsRunUp(previous: string, question: string): boolean {
  if (isQuestionLike(previous)) return true
  return ANAPHORA.test(question) && previous.length <= 160
}

function splitSentences(text: string): string[] {
  // Keeps terminators with their sentence; the '?' is the strongest signal we
  // have and must survive the split.
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function isQuestionLike(sentence: string): boolean {
  if (sentence.endsWith('?')) return true
  const opening = stripFiller(sentence).toLowerCase()
  return QUESTION_OPENERS.some(
    (opener) => opening.startsWith(`${opener} `) || opening === opener,
  )
}

function stripFiller(sentence: string): string {
  const stripped = sentence.replace(LEADING_FILLER, '').trim()
  // Never strip a sentence out of existence.
  if (!stripped) return sentence.trim()
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}
