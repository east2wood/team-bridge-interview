import { useEffect, useState } from 'react'
import type { CaptureTurn, LiveSessionState } from '@shared/api-types'
import { formatTime } from './InterviewList'

/**
 * The live screen for one interview.
 *
 * Answer is a capture boundary, not an API button: it says "everything the
 * interviewer has said since the last turn is the question". Capture resumes
 * on its own shortly afterwards, while the answer is still streaming.
 */
export function InterviewDetail({ live, level }: { live: LiveSessionState; level: number }) {
  const interview = live.interview
  if (!interview) return null

  // The turn worth showing is the most recent one that has a question; the
  // one being recorded has nothing to say yet.
  const answered = [...live.turns].reverse().find((t) => t.question)
  const previous = live.turns.filter((t) => t.question && t.id !== answered?.id).reverse()

  return (
    <div className="detail">
      <header className="detail__head">
        <button className="back" onClick={() => void window.tb.closeInterview()}>
          ← Interviews
        </button>
        <span className="grow" />
        <StatusPill live={live} level={level} />
      </header>

      <section className="detail__meta">
        <h1>{interview.position.title ?? 'Untitled round'}</h1>
        <p className="muted">{interview.company.name ?? 'No company'}</p>
        <p className="muted small">
          {formatTime(interview)}
          {interview.candidate ? ` · Candidate: ${interview.candidate.name}` : ''}
        </p>
      </section>

      <section className="panel">
        <h2>Live Transcript</h2>
        <div className="panel__body transcript">
          {live.activeTurn?.transcript ? (
            <p>{live.activeTurn.transcript}</p>
          ) : (
            <p className="muted">
              {live.status === 'recording'
                ? 'Listening…'
                : 'Start listening, then press Answer when the question has been asked.'}
            </p>
          )}
        </div>
      </section>

      <section className="panel panel--answer">
        <div className="panel__head">
          <h2>Answer</h2>
          <span className="grow" />
          {answered && <AnswerActions turn={answered} />}
        </div>
        <div className="panel__body">
          <AnswerBody turn={answered} status={live.status} />
        </div>
      </section>

      <ManualAsk disabled={live.serverSessionId === null} />

      {previous.length > 0 && <PreviousTurns turns={previous} />}

      <footer className="detail__foot">
        <PrimaryAction live={live} />
      </footer>
    </div>
  )
}

/* ------------------------------ status ------------------------------- */

function StatusPill({ live, level }: { live: LiveSessionState; level: number }) {
  const listening = live.status === 'recording'
  return (
    <span className="statuspill">
      <span className={`dot ${listening ? 'dot--live' : ''}`} aria-hidden />
      {listening ? 'Listening' : live.status === 'idle' ? 'Audio ready' : label(live.status)}
      {listening && live.turnStartedAt && <Elapsed since={live.turnStartedAt} />}
      {listening && (
        <span className="minimeter" aria-hidden>
          <span style={{ width: `${Math.min(100, Math.sqrt(level) * 160)}%` }} />
        </span>
      )}
    </span>
  )
}

function label(status: LiveSessionState['status']): string {
  switch (status) {
    case 'starting':
      return 'Starting…'
    case 'finalizing':
      return 'Processing question…'
    case 'restart_pending':
      return 'Resuming…'
    case 'error':
      return 'Problem'
    default:
      return 'Idle'
  }
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

/* ------------------------------ answer -------------------------------- */

function AnswerBody({
  turn,
  status,
}: {
  turn: CaptureTurn | undefined
  status: LiveSessionState['status']
}) {
  if (!turn) {
    return <p className="muted">Your generated answer will appear here.</p>
  }

  if (turn.status === 'empty') {
    return (
      <p className="muted">
        No question was detected in that stretch of audio, so nothing was sent. Listening resumed
        automatically.
      </p>
    )
  }

  return (
    <>
      <p className="question">{turn.question}</p>

      {/* There is a real gap between the request and the first words — a
          distinct waiting state beats an empty box. */}
      {turn.status === 'generating' && !turn.answer && (
        <p className="muted">Generating answer…</p>
      )}

      {turn.answer && (
        <p className="answer">
          {turn.answer}
          {turn.status === 'generating' && <span className="caret" aria-hidden />}
        </p>
      )}

      {turn.status === 'failed' && turn.error && (
        <p className="callout callout--error">
          {turn.error.message}
          {turn.answer ? ' The partial answer above was kept.' : ''}
        </p>
      )}

      {turn.status === 'completed' && status === 'recording' && (
        <p className="muted small">✓ Complete · listening for the next question</p>
      )}
    </>
  )
}

function AnswerActions({ turn }: { turn: CaptureTurn }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(turn.question ?? '')

  if (editing) {
    return (
      <span className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <button
          className="primary"
          onClick={() => {
            setEditing(false)
            void window.tb.regenerate(turn.id, text)
          }}
        >
          Regenerate
        </button>
        <button onClick={() => setEditing(false)}>Cancel</button>
      </span>
    )
  }

  return (
    <span className="row">
      {turn.answer && (
        <button onClick={() => void navigator.clipboard.writeText(turn.answer)}>Copy</button>
      )}
      {turn.question && (
        <button
          onClick={() => {
            setText(turn.question ?? '')
            setEditing(true)
          }}
        >
          Edit
        </button>
      )}
      {turn.status === 'failed' && turn.error?.retryable && (
        <button className="primary" onClick={() => void window.tb.regenerate(turn.id)}>
          Retry
        </button>
      )}
    </span>
  )
}

function ManualAsk({ disabled }: { disabled: boolean }) {
  const [text, setText] = useState('')
  const submit = () => {
    if (!text.trim()) return
    void window.tb.askManually(text)
    setText('')
  }

  return (
    <div className="ask">
      <input
        value={text}
        placeholder={disabled ? 'Connect TeamBridge to ask questions' : 'Ask manually…'}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button onClick={submit} disabled={disabled || !text.trim()}>
        Ask
      </button>
    </div>
  )
}

function PreviousTurns({ turns }: { turns: CaptureTurn[] }) {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <section className="panel">
      <h2>Previous</h2>
      <div className="panel__body">
        {turns.map((turn) => (
          <div key={turn.id} className="prev">
            <button className="prev__q" onClick={() => setOpenId(openId === turn.id ? null : turn.id)}>
              <span className="muted small">{new Date(turn.startedAt).toLocaleTimeString()}</span>
              <span>{turn.question}</span>
            </button>
            {openId === turn.id && <p className="answer small">{turn.answer || '—'}</p>}
          </div>
        ))}
      </div>
    </section>
  )
}

/* --------------------------- primary action --------------------------- */

function PrimaryAction({ live }: { live: LiveSessionState }) {
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    if (live.status !== 'restart_pending') return
    setCountdown(Math.ceil(live.restartInMs / 1000))
    const t = setInterval(() => setCountdown((n) => Math.max(0, n - 1)), 1000)
    return () => clearInterval(t)
  }, [live.status, live.restartInMs])

  switch (live.status) {
    case 'recording':
      return (
        <div className="actions">
          {/* Guarded by status alone: a second press cannot land because the
              status leaves 'recording' the instant the first one does. */}
          <button className="primary big" onClick={() => void window.tb.answerNow()}>
            Answer
          </button>
          <button onClick={() => void window.tb.stopListening()}>Stop</button>
        </div>
      )
    case 'finalizing':
      return (
        <div className="actions">
          <button className="big" disabled>
            Processing question…
          </button>
        </div>
      )
    case 'restart_pending':
      return (
        <div className="actions">
          <button className="big" disabled>
            {countdown > 0 ? `Listening again in ${countdown}s…` : 'Listening again…'}
          </button>
        </div>
      )
    case 'starting':
      return (
        <div className="actions">
          <button className="big" disabled>
            Starting…
          </button>
        </div>
      )
    default:
      return (
        <div className="actions">
          <button className="primary big" onClick={() => void window.tb.startListening()}>
            Start Listening
          </button>
          {live.error && <span className="muted small">{live.error}</span>}
        </div>
      )
  }
}
