import { useEffect, useState } from 'react'
import type { Interview } from '@shared/api-types'

/**
 * The picker the app opens with.
 *
 * Rows rather than a dropdown: before an interview starts the user is
 * recognising the right round at a glance, and a collapsed control hides
 * exactly the fields — time, company, candidate — that tell them apart.
 */
/**
 * How often the list reloads itself, for the Live badges. The server drops a
 * badge after three missed 5-second heartbeats; reloading at about that pace
 * shows it within seconds rather than half a minute later.
 */
const LIST_REFRESH_MS = 10_000

export function InterviewList({
  onOpen,
  refreshKey,
  onLoading,
}: {
  onOpen: (interview: Interview) => void
  /** Bumped by the header's Refresh button to load the list again. */
  refreshKey: number
  onLoading: (loading: boolean) => void
}) {
  const [state, setState] = useState<{
    loading: boolean
    interviews: Interview[]
    reason?: string
    message?: string
  }>({ loading: true, interviews: [] })

  /** Quietly, the list is updated in place rather than blanked while it loads. */
  const load = (quiet = false) => {
    if (!quiet) setState((prev) => ({ ...prev, loading: true }))
    void window.tb.listInterviews().then((result) =>
      setState((prev) =>
        // A quiet reload that failed keeps what is on screen: a list a minute
        // old beats an error for a hiccup nobody asked about.
        quiet && result.reason && prev.interviews.length > 0
          ? prev
          : {
              loading: false,
              interviews: result.interviews,
              reason: result.reason,
              message: result.message,
            },
      ),
    )
  }

  useEffect(() => load(), [refreshKey])

  // The Live badges are only worth showing if they are current: somebody can
  // start or stop listening on another machine at any moment.
  useEffect(() => {
    const timer = setInterval(() => load(true), LIST_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => onLoading(state.loading), [state.loading, onLoading])

  return (
    <div className="list">
      <header className="list__head">
        <h1>Interviews</h1>
      </header>

      {state.loading && <p className="muted">Loading…</p>}

      {!state.loading && state.reason === 'not_configured' && (
        <Empty
          title="No TeamBridge server configured"
          body="Add the server URL and an API token in Settings, then refresh."
          action={{ label: 'Open Settings', onClick: () => window.tb.openSettings() }}
        />
      )}

      {!state.loading && state.reason && state.reason !== 'not_configured' && (
        <Empty
          title="Could not load interviews"
          body={state.message ?? 'TeamBridge did not answer.'}
          action={{ label: 'Try again', onClick: () => load() }}
        />
      )}

      {!state.loading && !state.reason && state.interviews.length === 0 && (
        <Empty
          title="No interviews scheduled"
          // The window is the server's, and saying it plainly saves the user
          // wondering whether the app is broken.
          body="TeamBridge lists rounds you are working from two hours ago to seven days ahead. Nothing falls in that window yet."
          action={{ label: 'Refresh', onClick: () => load() }}
        />
      )}

      {groupByDay(state.interviews).map(([day, interviews]) => (
        <section key={day} className="group">
          <h2>{day}</h2>
          {interviews.map((interview) => (
            <button
              key={interview.id}
              className={`row ${interview.live ? 'row--live' : ''}`}
              onClick={() => onOpen(interview)}
            >
              <span className="row__time">{formatTime(interview)}</span>
              <span className="row__main">
                <strong>{interview.position.title ?? 'Untitled round'}</strong>
                <span className="muted">{interview.company.name ?? 'No company'}</span>
                {interview.candidate && <span>{interview.candidate.name}</span>}
              </span>
              {interview.live && (
                <span
                  className="livebadge"
                  title={
                    interview.canListen
                      ? 'Somebody is listening to this round now'
                      : 'The interviewer is listening now — open it to join as assistant'
                  }
                >
                  <span className="dot dot--live" aria-hidden /> Live
                </span>
              )}
              <span className={`row__status muted ${interview.live ? 'row__status--after-badge' : ''}`}>
                {interview.status}
              </span>
              <span className="row__chevron" aria-hidden>
                ›
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}

function Empty({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action: { label: string; onClick: () => void }
}) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p className="muted">{body}</p>
      <button onClick={action.onClick}>{action.label}</button>
    </div>
  )
}

/** Times are printed in the round's own zone: which 10:30 must not be guessed. */
export function formatTime(interview: Interview): string {
  if (!interview.startsAt) return '—'
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: interview.timeZone,
    }).format(new Date(interview.startsAt))
  } catch {
    return new Date(interview.startsAt).toLocaleTimeString()
  }
}

function groupByDay(interviews: Interview[]): [string, Interview[]][] {
  const groups = new Map<string, Interview[]>()
  for (const interview of interviews) {
    const label = dayLabel(interview)
    groups.set(label, [...(groups.get(label) ?? []), interview])
  }
  return [...groups.entries()]
}

function dayLabel(interview: Interview): string {
  if (!interview.startsAt) return 'Unscheduled'
  const date = new Date(interview.startsAt)
  const today = new Date()
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()

  if (sameDay(date, today)) return 'Today'
  if (sameDay(date, tomorrow)) return 'Tomorrow'
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date)
}
