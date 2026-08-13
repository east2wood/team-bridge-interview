import { useEffect, useRef, useState } from 'react'
import type { CaptureTurn, LiveSessionState } from '@shared/api-types'
import { formatTime } from './InterviewList'

/**
 * One interview as a single continuous conversation.
 *
 * Not a transcript panel beside an answer panel: the interview *is* a
 * sequence of questions and answers, and showing it as one timeline means
 * nothing has to be visually reset between turns. Capture happens at the
 * bottom, becomes a question in place, and the answer streams directly
 * beneath it.
 */
export function InterviewDetail({
  live,
  level,
  partial,
}: {
  live: LiveSessionState
  level: number
  /** Provisional interviewer speech: displayed, never part of the question. */
  partial: string
}) {
  const interview = live.interview
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [unread, setUnread] = useState(false)

  // Anything that lengthens the conversation should follow it down — but only
  // if the reader is already at the bottom. Yanking them away from an answer
  // they are re-reading is worse than a missed scroll.
  const tail = live.turns.map((t) => `${t.question ?? ''}${t.answer.length}${t.status}`).join('|')
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (pinned) el.scrollTop = el.scrollHeight
    else setUnread(true)
  }, [tail, partial, live.status, pinned])

  if (!interview) return null

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setPinned(atBottom)
    if (atBottom) setUnread(false)
  }

  const jump = () => {
    const el = scroller.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setPinned(true)
    setUnread(false)
  }

  const asked = live.turns.filter((t) => t.question || t.status === 'empty')
  const started = live.status !== 'idle'

  return (
    <div className="chat">
      <header className="chat__head">
        <button className="back" onClick={() => void window.tb.closeInterview()}>
          ← Interviews
        </button>
        <div className="chat__title">
          <strong>{interview.position.title ?? 'Untitled round'}</strong>
          <span className="muted small">
            {[interview.company.name, interview.candidate?.name, formatTime(interview)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <span className="grow" />
        {live.upload.pending > 0 && (
          <span className={`sync ${live.upload.failing ? 'sync--failing' : ''}`}>
            {live.upload.failing
              ? `${live.upload.reason ?? 'Sync failing'} · ${live.upload.pending} waiting`
              : `Syncing ${live.upload.pending}`}
          </span>
        )}
        <StatusPill live={live} level={level} />
      </header>

      <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
        <div className="thread">
          {asked.length === 0 && !started && (
            <div className="ready">
              <strong>Ready for the interview</strong>
              <p className="muted">
                Start listening, then press Answer once the interviewer has finished asking.
              </p>
            </div>
          )}

          {asked.map((turn) => (
            <Turn key={turn.id} turn={turn} />
          ))}

          <Tail live={live} partial={partial} />
        </div>
      </div>

      {unread && (
        <button className="jump" onClick={jump}>
          ↓ Newest
        </button>
      )}

      <Composer live={live} />
    </div>
  )
}

/* ------------------------------ one turn ------------------------------- */

function Turn({ turn }: { turn: CaptureTurn }) {
  const [showRaw, setShowRaw] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.question ?? '')

  if (turn.status === 'empty') {
    return (
      <div className="msg msg--system">
        <p className="muted">
          Nothing was asked in that stretch of audio, so nothing was sent. Listening resumed.
        </p>
      </div>
    )
  }

  // Worth offering only when the two actually differ.
  const differs = turn.transcript.trim() && turn.transcript.trim() !== turn.question?.trim()

  return (
    <>
      <article className="msg">
        <header className="msg__who">
          <span>Interviewer</span>
          <span className="muted small">{clock(turn.startedAt)}</span>
          {turn.questionConfident === false && (
            <span className="tagline" title="No clear question was found; this is the tail of what was said.">
              unclear
            </span>
          )}
        </header>

        {editing ? (
          <div className="row">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
            <button
              className="primary"
              onClick={() => {
                setEditing(false)
                void window.tb.regenerate(turn.id, draft)
              }}
            >
              Regenerate
            </button>
            <button onClick={() => setEditing(false)}>Cancel</button>
          </div>
        ) : (
          <p className="msg__text">{turn.question}</p>
        )}

        <div className="msg__tools">
          {!editing && (
            <button
              className="link"
              onClick={() => {
                setDraft(turn.question ?? '')
                setEditing(true)
              }}
            >
              Edit
            </button>
          )}
          {differs && (
            <button className="link" onClick={() => setShowRaw(!showRaw)}>
              {showRaw ? 'Hide transcript' : 'View transcript'}
            </button>
          )}
        </div>

        {showRaw && <p className="raw">{turn.transcript}</p>}
      </article>

      <article className="msg msg--assist">
        <header className="msg__who">
          <span>TeamBridge Assist</span>
        </header>

        {turn.status === 'generating' && !turn.answer && <p className="muted">Thinking…</p>}

        {turn.answer && (
          <p className="msg__text answer">
            {turn.answer}
            {turn.status === 'generating' && <span className="caret" aria-hidden />}
          </p>
        )}

        {turn.status === 'failed' && turn.error && (
          <p className="failed">
            {turn.error.message}
            {turn.answer ? ' The partial answer above was kept.' : ''}
          </p>
        )}

        <div className="msg__tools">
          {turn.answer && turn.status !== 'generating' && (
            <button className="link" onClick={() => void navigator.clipboard.writeText(turn.answer)}>
              Copy
            </button>
          )}
          {turn.status === 'failed' && turn.error?.retryable && (
            <button className="link" onClick={() => void window.tb.regenerate(turn.id)}>
              Retry
            </button>
          )}
        </div>
      </article>
    </>
  )
}

/* --------------------------- live tail ---------------------------- */

/** The current activity, always last, so the page never visually resets. */
function Tail({ live, partial }: { live: LiveSessionState; partial: string }) {
  const heard = [live.activeTurn?.transcript, partial].filter(Boolean).join(' ')

  if (live.status === 'recording') {
    const detected = live.detectedQuestion
    return (
      <div className="tail">
        <span className="tail__label">
          <span className="dot dot--live" aria-hidden /> Listening
        </span>

        {/* What TeamBridge believes is being asked. Shown before Answer so the
            question is never a surprise — it is live state, not history, and
            only becomes part of the conversation once Answer is pressed. */}
        {detected ? (
          <div className="detected">
            <span className="detected__label">Question detected</span>
            <p className="detected__text">{detected.text}</p>
          </div>
        ) : (
          <p className="muted tail__text">{heard || 'Building context…'}</p>
        )}

        {detected && heard && <p className="muted tail__text">{heard}</p>}
      </div>
    )
  }

  if (live.status === 'finalizing') {
    return (
      <div className="tail">
        <span className="tail__label">Processing question…</span>
        {heard && <p className="muted tail__text">{heard}</p>}
      </div>
    )
  }

  return null
}

/* ------------------------------ composer ------------------------------- */

/**
 * One persistent bottom area. Start Listening is only ever the initial state:
 * once running, the primary action is Answer and the big call to action goes
 * away rather than the controls swapping around.
 */
function Composer({ live }: { live: LiveSessionState }) {
  const [text, setText] = useState('')

  const send = () => {
    if (!text.trim()) return
    void window.tb.askManually(text)
    setText('')
  }

  if (live.status === 'idle' || live.status === 'error') {
    return (
      <footer className="composer composer--start">
        <button className="primary big" onClick={() => void window.tb.startListening()}>
          Start Listening
        </button>
        {live.error && <span className="muted small">{live.error}</span>}
      </footer>
    )
  }

  const answering = live.status === 'recording'
  return (
    <footer className="composer">
      <div className="composer__row">
        <input
          value={text}
          placeholder="Ask manually…"
          disabled={live.serverSessionId === null}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send()
          }}
        />
        <button onClick={send} disabled={!text.trim() || live.serverSessionId === null}>
          Ask
        </button>
      </div>

      <div className="composer__row">
        {live.turnStartedAt && answering && <Elapsed since={live.turnStartedAt} />}
        <span className="grow" />
        <button onClick={() => void window.tb.stopListening()}>Stop</button>
        <button
          className="primary answerbtn"
          disabled={!answering}
          onClick={() => void window.tb.answerNow()}
        >
          {live.status === 'finalizing'
            ? 'Processing question…'
            : live.status === 'starting'
              ? 'Starting…'
              : 'Answer'}
        </button>
      </div>
    </footer>
  )
}

/* ------------------------------- bits ---------------------------------- */

function StatusPill({ live, level }: { live: LiveSessionState; level: number }) {
  const listening = live.status === 'recording'
  return (
    <span className="statuspill">
      <span className={`dot ${listening ? 'dot--live' : ''}`} aria-hidden />
      {listening ? 'Listening' : live.status === 'idle' ? 'Audio ready' : 'Working…'}
      {listening && (
        <span className="minimeter" aria-hidden>
          <span style={{ width: `${Math.min(100, Math.sqrt(level) * 160)}%` }} />
        </span>
      )}
    </span>
  )
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return <span className="elapsed">{`${m}:${s}`}</span>
}

function clock(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms),
  )
}
