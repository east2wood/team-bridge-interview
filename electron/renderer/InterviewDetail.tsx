import { useEffect, useRef, useState } from 'react'
import type { AssistMessage, CaptureTurn, LiveSessionState, TranscriptItem } from '@shared/api-types'
import { formatTime } from './InterviewList'
import { buildTimeline, currentContext } from './timeline'

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
    `${live.segments.length}:${live.sentThroughPosition}`,
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

  const items = buildTimeline(live)

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
            item.kind === 'segment' ? (
              <Line
                key={item.id}
                segment={item.segment}
                sent={item.segment.position <= live.sentThroughPosition}
              />
            ) : item.kind === 'message' ? (
              <WebMessage key={item.id} message={item.message} />
            ) : (
              <Checkpoint key={item.id} turn={item.turn} />
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

/* ---------------------------- transcript ------------------------------- */

/**
 * One committed stretch of speech.
 *
 * Deliberately plain: this is the bulk of the page, and anything boxed or
 * bordered at this frequency turns the record into a list of cards. Speech not
 * yet uploaded is dimmed rather than held back, so the reader can see the
 * difference between "said" and "TeamBridge has it" without the text moving.
 */
function Line({ segment, sent }: { segment: TranscriptItem; sent: boolean }) {
  return (
    <div
      className={[
        'line',
        segment.speaker === 'candidate' ? 'line--self' : '',
        sent ? '' : 'line--pending',
      ]
        .filter(Boolean)
        .join(' ')}
      title={sent ? undefined : 'Not yet sent to TeamBridge'}
    >
      <span className="line__time muted small">{clock(segment.startedAt)}</span>
      <p className="line__text">{segment.text}</p>
    </div>
  )
}

/* ---------------------------- web message ------------------------------ */

/**
 * A message from someone watching the round, at the point they sent it.
 *
 * Its position is the information: it says what the sender could see when they
 * wrote it. Marked as written rather than generated, because the whole value of
 * showing it next to an answer is knowing which of the two you are reading.
 */
function WebMessage({ message }: { message: AssistMessage }) {
  const [copied, setCopied] = useState(false)
  const who = message.sender.name ?? 'a colleague'

  return (
    <article className={`web web--${message.type}`}>
      <header className="web__head">
        <span className="web__from">TeamBridge Web · {who}</span>
        <span className="grow" />
        <span className="muted small">{clock(Date.parse(message.createdAt) || Date.now())}</span>
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
      <p className="web__kind">{message.type === 'answer' ? 'Suggested answer' : 'Note'}</p>
      {message.question && <p className="web__about muted small">on: {message.question}</p>}
      <p className="web__text">{message.content}</p>
    </article>
  )
}

/* ---------------------------- checkpoint -------------------------------- */

/**
 * Where an answer was asked for, and what came back.
 *
 * No context box: the transcript it was answered from is the segments directly
 * above, which is the point of one continuous timeline. The range is still
 * shown, so what the server used can be checked against what was read.
 */
function Checkpoint({ turn }: { turn: CaptureTurn }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(turn.question ?? '')
  const [copied, setCopied] = useState<'question' | 'answer' | null>(null)

  if (turn.status === 'boundary') {
    return (
      <div className="conversation-line">
        <span>New conversation</span>
      </div>
    )
  }

  if (turn.status === 'empty') {
    return (
      <div className="msg msg--system">
        <p className="muted">
          Nothing was asked in that stretch of audio, so nothing was sent. Listening resumed.
        </p>
      </div>
    )
  }

  // Where TeamBridge could not isolate a question it answers the turn as a
  // whole and hands the context back as the question. That is the transcript
  // immediately above, so printing it again under a heading would claim it
  // found something it did not.
  const context = turn.context?.text?.trim()
  const question = turn.question?.trim()
  const asked = question && question !== context ? question : null

  const flash = (which: 'question' | 'answer') => {
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <article className="checkpoint">
      <header className="checkpoint__head">
        <h3 className="checkpoint__label">Question</h3>
        {turn.context && (
          <span className="muted small range" title="Transcript answered from">
            {turn.context.fromSequence}–{turn.context.throughSequence}
          </span>
        )}
        <span className="grow" />
        <span className="muted small">{clock(turn.endedAt ?? turn.startedAt)}</span>
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
        {asked && (
          <button
            className="link"
            onClick={() => {
              void navigator.clipboard.writeText(asked)
              flash('question')
            }}
          >
            {copied === 'question' ? 'Copied' : 'Copy'}
          </button>
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
      ) : asked ? (
        <p className="question">{asked}</p>
      ) : (
        <p className="question question--whole muted">
          Answered everything said since the last checkpoint.
        </p>
      )}

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

/* --------------------------- live tail ---------------------------- */

/**
 * What is being heard right now, always last so the page never resets.
 *
 * Only the phrase in progress. Anything committed has already taken its place
 * in the timeline above — dimmed until it reaches TeamBridge — so repeating it
 * here would show the same words twice and move them when they were sent.
 */
function Tail({ live, partial }: { live: LiveSessionState; partial: string }) {
  if (live.status === 'idle' || live.status === 'error') return null

  return (
    <div className="tail">
      {live.status === 'recording' && (
        <span className="tail__label">
          <span className="dot dot--live" aria-hidden /> Listening
        </span>
      )}
      {live.status === 'finalizing' && <span className="tail__label">Processing question…</span>}
      {live.status === 'starting' && <span className="tail__label">Starting…</span>}

      {partial ? (
        <p className="muted tail__text">{partial}</p>
      ) : (
        live.status === 'recording' && (
          <p className="muted tail__text">
            {live.segments.length > 0 ? 'Waiting for the next sentence…' : 'Building context…'}
          </p>
        )
      )}
    </div>
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
  const [copied, setCopied] = useState(false)
  // What the next answer would be built from — so copying it and leaving it
  // behind are the same text.
  const context = currentContext(live)

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
          disabled={!context}
          title="Copy everything said since the last answer"
          onClick={() => {
            void navigator.clipboard.writeText(context)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy context'}
        </button>
        <button
          disabled={!answering || !context}
          title="Copy what has been said, then start a new conversation in the record"
          onClick={() => {
            void navigator.clipboard.writeText(context)
            void window.tb.newConversation()
          }}
        >
          New conversation
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
