import type { AssistMessage, CaptureTurn, LiveSessionState, TranscriptItem } from '@shared/api-types'

/**
 * The interview as one chronological record.
 *
 * Everything that happened is an event of the same kind: speech, a colleague's
 * message, and the checkpoint where an answer was asked for. They are not
 * separate sections that happen to be stacked — a message sent while segment 18
 * was arriving belongs between 18 and 19, because that is where it was sent and
 * because it is the only way to see what its sender could have been reading.
 */
export type TimelineItem =
  | { kind: 'segment'; id: string; segment: TranscriptItem }
  | { kind: 'message'; id: string; message: AssistMessage }
  | { kind: 'checkpoint'; id: string; turn: CaptureTurn }

/**
 * Where two events at the same point in the transcript sit relative to each
 * other. A message anchored to segment 18 comes after 18; a checkpoint that
 * answered through 18 comes after the message, because the message was written
 * while the transcript still ended there and the checkpoint closed it.
 */
const TIER = { segment: 0, message: 1, checkpoint: 2 } as const

interface Placed {
  item: TimelineItem
  /** Place in the record: the ordering everything is hung off. */
  seq: number
  tier: number
  /** Only a tie-breaker. Two clocks are being compared here, so it is last. */
  at: number
}

/**
 * Orders by place in the transcript rather than by time.
 *
 * Position is assigned here, in the order things actually happened, and never
 * restarts — not even when a new context opens a new server session, where the
 * upload sequence begins again at one. Timestamps could not do this job:
 * speech is timed locally and a message is stamped by the server, so within
 * the same second they disagree, which is exactly the case that matters when
 * somebody types while the interviewer is still talking.
 */
export function buildTimeline(live: LiveSessionState): TimelineItem[] {
  const segments = live.segments

  // The transcript as it stood at a given moment. Used only for events with no
  // sequence of their own — a typed question, mostly.
  const positionAt = (time: number): number => {
    let at = 0
    for (const segment of segments) {
      if (segment.startedAt <= time && segment.position > at) at = segment.position
    }
    return at
  }

  const placed: Placed[] = [
    ...segments.map((segment) => ({
      item: { kind: 'segment' as const, id: `s${segment.position}`, segment },
      seq: segment.position,
      tier: TIER.segment,
      at: segment.startedAt,
    })),

    ...live.messages.map((message) => ({
      item: { kind: 'message' as const, id: `m${message.id}`, message },
      // Unanchored means it predates this run's transcript, so it belongs
      // above all of it rather than at an arbitrary point inside it.
      seq: message.afterPosition ?? 0,
      tier: TIER.message,
      at: Date.parse(message.createdAt) || 0,
    })),

    ...live.turns
      // Everything except the turn still being captured, which the live tail
      // draws. Not "has a question": the question comes back with the answer,
      // so waiting for it would hide the turn until the stream starts — and
      // hide it for good if the request is refused before that.
      .filter((turn) => turn.status !== 'recording')
      .map((turn) => ({
        item: { kind: 'checkpoint' as const, id: turn.id, turn },
        seq: turn.throughPosition ?? positionAt(turn.endedAt ?? turn.startedAt),
        tier: TIER.checkpoint,
        at: turn.endedAt ?? turn.startedAt,
      })),
  ]

  placed.sort(
    (a, b) => a.seq - b.seq || a.tier - b.tier || a.at - b.at || a.item.id.localeCompare(b.item.id),
  )

  return placed.map((p) => p.item)
}

/** How the server joins segments, so a copy reads the same as what it answered. */
const SEPARATOR = '\n\n'

/**
 * The stretch of transcript no turn has closed yet.
 *
 * What the next answer will be built from, and so what starting a new turn
 * leaves behind.
 */
export function currentContext(live: LiveSessionState): string {
  const closed = live.turns.reduce((last, turn) => Math.max(last, turn.throughPosition ?? 0), 0)
  return live.segments
    .filter((segment) => segment.position > closed)
    .map((segment) => segment.text)
    .join(SEPARATOR)
    .trim()
}

/**
 * The turn as text, for pasting somewhere else.
 *
 * Labelled, because in a ticket or a message the parts have to stay
 * distinguishable. The open turn where there is one — that is the turn the
 * button sits next to — and otherwise the one just finished, which is what
 * "this turn" means in the seconds after an answer lands and before anybody
 * has said anything new.
 */
export function turnText(live: LiveSessionState): string {
  const context = currentContext(live)
  if (context) return ['Context:', context].join('\n')

  const answered = [...live.turns]
    .reverse()
    .find((turn) => turn.status !== 'boundary' && (turn.question || turn.answer))
  if (!answered) return ''

  const labelled = (label: string, text?: string) =>
    text?.trim() ? [label, text.trim()].join('\n') : null

  return [
    labelled('Context:', answered.context?.text),
    labelled('Question:', answered.question),
    labelled('Answer:', answered.answer),
  ]
    .filter(Boolean)
    .join(SEPARATOR)
}
