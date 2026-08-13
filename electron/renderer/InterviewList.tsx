import { useEffect, useState } from 'react'
import type { Interview } from '@shared/api-types'

/**
 * The picker the app opens with.
 *
 * Rows rather than a dropdown: before an interview starts the user is
 * recognising the right round at a glance, and a collapsed control hides
 * exactly the fields — time, company, candidate — that tell them apart.
 */
export function InterviewList({ onOpen }: { onOpen: (interview: Interview) => void }) {
  const [state, setState] = useState<{
    loading: boolean
    interviews: Interview[]
    reason?: string
    message?: string
  }>({ loading: true, interviews: [] })

  const load = () => {
    setState((prev) => ({ ...prev, loading: true }))
    void window.tb.listInterviews().then((result) =>
      setState({
        loading: false,
        interviews: result.interviews,
        reason: result.reason,
        message: result.message,
      }),
    )
  }

  useEffect(load, [])

  return (
    <div className="list">
      <header className="list__head">
        <h1>Interviews</h1>
        <span className="grow" />
        <button onClick={load} disabled={state.loading}>
          {state.loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button onClick={() => window.tb.openSettings()}>⚙ Settings</button>
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
          action={{ label: 'Try again', onClick: load }}
        />
      )}

      {!state.loading && !state.reason && state.interviews.length === 0 && (
        <Empty
          title="No interviews scheduled"
          // The window is the server's, and saying it plainly saves the user
          // wondering whether the app is broken.
          body="TeamBridge lists rounds you are working from two hours ago to seven days ahead. Nothing falls in that window yet."
          action={{ label: 'Refresh', onClick: load }}
        />
      )}

      {groupByDay(state.interviews).map(([day, interviews]) => (
        <section key={day} className="group">
          <h2>{day}</h2>
          {interviews.map((interview) => (
            <button key={interview.id} className="row" onClick={() => onOpen(interview)}>
              <span className="row__time">{formatTime(interview)}</span>
              <span className="row__main">
                <strong>{interview.position.title ?? 'Untitled round'}</strong>
                <span className="muted">{interview.company.name ?? 'No company'}</span>
                {interview.candidate && <span>{interview.candidate.name}</span>}
              </span>
              <span className="row__status muted">{interview.status}</span>
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
