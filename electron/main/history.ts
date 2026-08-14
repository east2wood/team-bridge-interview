import type { CaptureTurn, TranscriptItem } from '@shared/api-types'
import type { TeamBridgeClient } from '@services/teambridge/teambridge-client'
import { child } from '@services/logger'

const log = child('history')

/** Recent runs to look through. Beyond this, a round is old enough to scroll. */
const SESSION_LIMIT = 100

export interface History {
  segments: TranscriptItem[]
  turns: CaptureTurn[]
  /** Where the record ends: what live capture carries on from. */
  position: number
}

const EMPTY: History = { segments: [], turns: [], position: 0 }

/**
 * Rebuilds the record of a round from what the server kept.
 *
 * The point is that opening a round shows the interview rather than a blank
 * page waiting to be started: earlier runs, what was asked in them, and what
 * was written back. Start Listening then opens a new session and carries on
 * below it, which is why positions are assigned here and handed back — the
 * live half continues the same numbering rather than starting again over it.
 *
 * Read-only and best-effort. A round with no history, a server that will not
 * answer, one run that fails to load: all of them leave a shorter record, none
 * of them stop the interview from being taken.
 */
export async function loadHistory(
  client: TeamBridgeClient,
  interviewId: number,
): Promise<History> {
  let sessions
  try {
    sessions = await client.sessions(SESSION_LIMIT)
  } catch (err) {
    log.warn({ err, interviewId }, 'could not list earlier runs')
    return EMPTY
  }

  // Oldest first: the record reads forwards, and positions have to be handed
  // out in the order things were said.
  const mine = sessions
    .filter((session) => session.interviewId === interviewId)
    .sort((a, b) => stamp(a.startedAt) - stamp(b.startedAt))

  if (mine.length === 0) return EMPTY

  const segments: TranscriptItem[] = []
  const turns: CaptureTurn[] = []
  let position = 0

  for (const session of mine) {
    const [stored, answers] = await Promise.all([
      client.sessionSegments(session.id).catch((err: unknown) => {
        log.warn({ err, sessionId: session.id }, 'could not read a run’s transcript')
        return []
      }),
      client.answers(session.id).catch((err: unknown) => {
        log.warn({ err, sessionId: session.id }, 'could not read a run’s answers')
        return []
      }),
    ])

    // Sequences are per run and start again at one inside each, so the record
    // is ordered by position and the mapping back is kept per run.
    const positionOf = new Map<number, number>()
    const opened = stamp(session.startedAt)

    for (const segment of [...stored].sort((a, b) => a.sequence - b.sequence)) {
      position += 1
      positionOf.set(segment.sequence, position)
      segments.push({
        position,
        sequence: segment.sequence,
        text: segment.text,
        startedAt: stamp(segment.startedAt) || opened,
        speaker: segment.speaker,
      })
    }

    for (const answer of answers) {
      // Where the answer's transcript stops. Falling back to the end of the run
      // rather than to nothing: an answer belongs after the words it used.
      const through = answer.turn ? positionOf.get(answer.turn.throughSequence) : undefined
      const askedAt = stamp(answer.askedAt) || opened

      turns.push({
        // Stable across reloads, and distinct from the ids a live turn makes
        // up, so a live turn is never mistaken for a stored one.
        id: `stored-${answer.id}`,
        index: turns.length + 1,
        startedAt: askedAt,
        endedAt: stamp(answer.completedAt) || askedAt,
        transcript: answer.turn?.text ?? '',
        questionId: answer.id,
        question: answer.question,
        answer: answer.answer,
        status: statusOf(answer.status),
        throughPosition: through ?? position,
        ...(answer.source ? { questionSource: answer.source } : {}),
        ...(answer.turn
          ? {
              context: {
                fromSequence: answer.turn.fromSequence,
                throughSequence: answer.turn.throughSequence,
                text: answer.turn.text,
              },
            }
          : {}),
        ...(answer.error
          ? { error: { code: 'stored', message: answer.error, retryable: false } }
          : {}),
      })

      // Every answered exchange is closed the same way a live one is, so the
      // record reads the same whether it is being written or read back.
      turns.push({
        id: `stored-${answer.id}-end`,
        index: turns.length + 1,
        startedAt: stamp(answer.completedAt) || askedAt,
        endedAt: stamp(answer.completedAt) || askedAt,
        transcript: '',
        answer: '',
        status: 'boundary',
        throughPosition: through ?? position,
      })
    }
  }

  log.info(
    { interviewId, runs: mine.length, segments: segments.length, turns: turns.length },
    'loaded the record of earlier runs',
  )
  return { segments, turns, position }
}

/** A stored answer's status, in the terms a turn is drawn in. */
function statusOf(status: string): CaptureTurn['status'] {
  if (status === 'failed' || status === 'abandoned') return 'failed'
  // Anything still in flight was left that way by an app that went away; it is
  // not being written now, so it is shown as it stands.
  return 'completed'
}

function stamp(at: string | null | undefined): number {
  return at ? Date.parse(at) || 0 : 0
}
