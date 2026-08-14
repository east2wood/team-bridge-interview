import { useEffect, useRef, useState } from 'react'
import type { AssistMessage, CaptureTurn, LiveSessionState } from '@shared/api-types'
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
  const tail = [
    ...live.turns.map((t) => `${t.question ?? ''}${t.answer.length}${t.status}`),
    ...live.messages.map((m) => `m${m.id}`),
  ].join('|')
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

  const started = live.status !== 'idle'

  // Turns and messages share one timeline, ordered by when they happened —
  // a colleague's steer belongs where it was sent, not in a sidebar.
  const items: TimelineItem[] = [
    ...live.turns
      // Everything except the turn still being captured, which Tail draws.
      // Not "has a question": the question is the server's answer to what was
      // asked, so waiting for it would hide the turn until the stream starts —
      // and hide it forever if the request is refused before that.
      .filter((t) => t.status !== 'recording')
      .map((turn) => ({ kind: 'turn' as const, at: turn.startedAt, id: turn.id, turn })),
    ...live.messages.map((message) => ({
      kind: 'message' as const,
      at: Date.parse(message.createdAt) || Date.now(),
      id: `m${message.id}`,
      message,
    })),
  ].sort((a, b) => a.at - b.at)

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
        {live.realtime === 'reconnecting' && (
          <span className="sync" title="Messages from the web may be delayed">
            ◌ Web sync reconnecting
          </span>
        )}
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
          {items.length === 0 && !started && (
            <div className="ready">
              <strong>Ready for the interview</strong>
              <p className="muted">
                Start listening, then press Answer once the interviewer has finished asking.
              </p>
            </div>
          )}

          {items.map((item) =>
            item.kind === 'turn' ? (
              <Turn key={item.id} turn={item.turn} />
            ) : (
              <Message key={item.id} message={item.message} />
            ),
          )}

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

/**
 * One answered turn: what TeamBridge received, then what it generated.
 *
 * Context and question share a single box because they are one thing — the
 * captured turn as the server understood it. The answer sits outside it, open,
 * so the page does not become a stack of cards.
 */
function Turn({ turn }: { turn: CaptureTurn }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.question ?? '')
  const [copied, setCopied] = useState<'source' | 'answer' | null>(null)

  if (turn.status === 'empty') {
    return (
      <div className="msg msg--system">
        <p className="muted">
          Nothing was asked in that stretch of audio, so nothing was sent. Listening resumed.
        </p>
      </div>
    )
  }

  const context = turn.context?.text?.trim()
  // When TeamBridge finds no question it answers the turn as a whole, and says
  // so by returning the context back as the question. Printing it twice under
  // two headings would suggest it isolated something when it did not.
  const question = turn.question?.trim()
  const asked = question && question !== context ? question : null

  const flash = (which: 'source' | 'answer') => {
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  const copySource = () => {
    // Labelled, because pasted into a ticket or a message the two halves need
    // to stay distinguishable.
    const parts = [
      context ? ['Context:', context].join('\n') : null,
      asked ? ['Question:', asked].join('\n') : null,
    ].filter(Boolean)
    void navigator.clipboard.writeText(parts.join('\n\n'))
    flash('source')
  }

  return (
    <article className="turn">
      <header className="turn__time muted small">{clock(turn.startedAt)}</header>

      <section className="source">
        <div className="source__tools">
          {turn.context && (
            <span className="muted small range">
              {turn.context.fromSequence}–{turn.context.throughSequence}
            </span>
          )}
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
          <button className="link" onClick={copySource}>
            {copied === 'source' ? 'Copied' : 'Copy'}
          </button>
        </div>

        {context && (
          <>
            <h3>Context</h3>
            <p className="context">{context}</p>
          </>
        )}

        {asked && <h3 className="source__qlabel">Question</h3>}

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
          asked && <p className="question">{asked}</p>
        )}
      </section>

      <section className="generated">
        <header className="generated__head">
          <h3>TeamBridge Assist</h3>
          <span className="grow" />
          {turn.answer && turn.status !== 'generating' && (
            <button
              className="link"
              onClick={() => {
                void navigator.clipboard.writeText(turn.answer)
                flash('answer')
              }}
            >
              {copied === 'answer' ? 'Copied' : 'Copy'}
            </button>
          )}
          {turn.status === 'failed' && turn.error?.retryable && (
            <button className="link" onClick={() => void window.tb.regenerate(turn.id)}>
              Retry
            </button>
          )}
        </header>

        {turn.status === 'generating' && !turn.answer && <p className="muted">Thinking…</p>}

        {turn.answer && (
          <p className="answer">
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
      </section>
    </article>
  )
}

type TimelineItem =
  | { kind: 'turn'; at: number; id: string; turn: CaptureTurn }
  | { kind: 'message'; at: number; id: string; message: AssistMessage }

/**
 * A message from someone watching the round.
 *
 * Labelled by person and marked as written rather than generated: the whole
 * value of showing it beside an answer is knowing which of the two you are
 * reading. An 'answer' is a whole reply to read out, a 'note' is a steer to
 * work in, so they are weighted differently.
 */
function Message({ message }: { message: AssistMessage }) {
  const [copied, setCopied] = useState(false)
  const who = message.sender.name ?? 'A colleague'

  return (
    <article className={`human human--${message.type}`}>
      <header className="human__head">
        <span className="human__who">{who}</span>
        <span className="human__kind">{message.type === 'answer' ? 'suggested answer' : 'note'}</span>
        <span className="muted small">{clock(Date.parse(message.createdAt) || Date.now())}</span>
        <span className="grow" />
        <button
          className="link"
          onClick={() => {
            void navigator.clipboard.writeText(message.content)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      {message.question && <p className="human__about muted small">on: {message.question}</p>}
      <p className="human__text">{message.content}</p>
    </article>
  )
}

/* --------------------------- live tail ---------------------------- */

/**
 * The current activity, always last, so the page never visually resets.
 *
 * Split by what the server actually has. Transcript that has reached
 * TeamBridge appears in a context box — the same box it will become when
 * Answer freezes it — while Listening holds only what has been heard here and
 * not yet sent. The line between them is the honest one: it moves when an
 * upload succeeds, not when it is started.
 */
function Tail({ live, partial }: { live: LiveSessionState; partial: string }) {
  const turn = live.activeTurn
  const sent = turn?.sentTranscript?.trim() ?? ''
  const heard = turn?.transcript ?? ''
  // sentTranscript is always a prefix of transcript, so the remainder is what
  // is still only local.
  const unsent = [heard.startsWith(sent) ? heard.slice(sent.length).trim() : heard, partial]
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (live.status === 'idle' || live.status === 'error') return null

  return (
    <>
      {sent && (
        <section className="source source--live">
          <h3>Context</h3>
          <p className="context">{sent}</p>
        </section>
      )}

      <div className="tail">
        {live.status === 'recording' && (
          <span className="tail__label">
            <span className="dot dot--live" aria-hidden /> Listening
          </span>
        )}
        {live.status === 'finalizing' && <span className="tail__label">Processing question…</span>}
        {live.status === 'starting' && <span className="tail__label">Starting…</span>}

        {unsent ? (
          <p className="muted tail__text">{unsent}</p>
        ) : (
          live.status === 'recording' && (
            <p className="muted tail__text">
              {sent ? 'Waiting for the next sentence…' : 'Building context…'}
            </p>
          )
        )}
      </div>
    </>
  )
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
          className="sendbtn"
          disabled={!answering || live.sending}
          title="Send what has been heard so far, so TeamBridge can read the question"
          onClick={() => void window.tb.sendTranscript()}
        >
          {live.sending ? 'Sending…' : 'Send'}
        </button>
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
