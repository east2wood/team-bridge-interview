import { useEffect, useRef, useState } from 'react'
import type { AssistMessage, CaptureTurn, LiveSessionState, TranscriptItem } from '@shared/api-types'
import type { AudioChannel } from '@shared/types'
import { formatTime } from './InterviewList'
import { buildTimeline, currentContext, formatTurn, turnText } from './timeline'

/**
 * One interview as a single continuous conversation.
 *
 * Not a transcript panel beside an answer panel: the interview *is* a
 * sequence of questions and answers, and showing it as one timeline means
 * nothing has to be visually reset between turns. Capture happens at the
 * bottom, becomes a question in place, and the answer streams directly
 * beneath it.
 */
/**
 * Speech heard but not committed, keyed by channel.
 *
 * A third kind of thing, alongside a transcript segment and a checkpoint: it
 * has no position, no identity, and no permanence. Every update replaces it,
 * and the segment it becomes deletes it.
 */
export type Partials = Partial<Record<AudioChannel, string>>

export function InterviewDetail({
  live,
  level,
  partials,
}: {
  live: LiveSessionState
  level: number
  partials: Partials
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
    // Not keyed on the live text: it sits outside the scroller now, so it
    // cannot move the bottom of the record.
  }, [tail, live.status, pinned])

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
  // A run that is actually going, as opposed to one that stopped on an error:
  // there is nothing to stop and nothing to count.
  const running =
    live.status === 'starting' || live.status === 'recording' || live.status === 'finalizing'

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
        {running && live.sessionStartedAt && <Elapsed since={live.sessionStartedAt} />}
        {running && (
          <button className="compact" onClick={() => void window.tb.stopListening()}>
            Stop
          </button>
        )}
        <StatusPill live={live} level={level} />
      </header>

      <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
        <div className="thread">
          {live.loadingRecord && <p className="muted small loading">Reading earlier runs…</p>}

          {items.length === 0 && !started && !live.loadingRecord && (
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

        </div>
      </div>

      {/* Both anchored to the bottom of the record: the jump sits on top of
          the live text rather than at a distance measured from the window. */}
      <div className="dock">
        {unread && (
          <button className="jump" onClick={jump}>
            ↓ Newest
          </button>
        )}
        <Tail live={live} partials={partials} />
      </div>

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
      <span className="line__time muted small">{clockPrecise(segment.startedAt)}</span>
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
  const [copied, setCopied] = useState<'question' | 'answer' | 'turn' | null>(null)

  if (turn.status === 'boundary') {
    // What was set aside when the line was drawn. Copied to the clipboard at
    // the time, but a clipboard holds one thing and an interview is long, so
    // the line keeps its own copy of what it closed.
    const closed = formatTurn(turn)
    return (
      <div className="turn-line">
        <span>New turn</span>
        {closed && (
          <button
            className="link"
            title="Copy what was set aside here"
            onClick={() => {
              void navigator.clipboard.writeText(closed)
              setCopied('turn')
              setTimeout(() => setCopied(null), 1500)
            }}
          >
            {copied === 'turn' ? 'Copied' : 'Copy turn'}
          </button>
        )}
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

/* --------------------------- live listening ---------------------------- */

/**
 * What is being heard right now, always last so the page never resets.
 *
 * Drawn as a transcript line rather than beside one, because that is what it
 * is about to become: when the segment commits, the same words appear in the
 * same place, permanent, and the live line starts empty again.
 *
 * The mark takes the place of the time, which is the one thing a line still
 * being said does not have. That leaves the words starting exactly where every
 * line above them starts, so the column reads unbroken from the first thing
 * said to the words still arriving.
 */
function Tail({ live, partials }: { live: LiveSessionState; partials: Partials }) {
  if (live.status === 'idle' || live.status === 'error') return null

  if (live.status !== 'recording') {
    return (
      <div className="tail">
        <LiveRow text={live.status === 'starting' ? 'Starting…' : 'Processing question…'} />
      </div>
    )
  }

  // The interviewer first: the room reads by who is asking, not by which
  // device happened to commit.
  const heard = (['system', 'microphone'] as const)
    .map((channel) => [channel, partials[channel]?.trim() ?? ''] as const)
    .filter(([, text]) => text.length > 0)

  return (
    <div className="tail">
      {heard.length > 0 ? (
        heard.map(([channel, text]) => (
          <LiveRow key={channel} text={text} self={channel === 'microphone'} speaking />
        ))
      ) : (
        <LiveRow text={live.segments.length > 0 ? 'Waiting for the next sentence…' : 'Building context…'} />
      )}
    </div>
  )
}

/** One live line: the mark where the time goes, the words in the words' column. */
function LiveRow({
  text,
  self = false,
  speaking = false,
}: {
  text: string
  self?: boolean
  /** Whether these are words being said, rather than a note about the state. */
  speaking?: boolean
}) {
  return (
    <div className={`line line--live ${self ? 'line--self' : ''}`}>
      <span className="line__time">
        <span className="live__mark">
          <span className="dot dot--live" aria-hidden /> Live
        </span>
      </span>
      <p className="line__text live__words">
        {text}
        {speaking && <span className="caret" aria-hidden />}
      </p>
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
  // What the next answer would be built from: what a new turn leaves behind,
  // and what there has to be some of for that to mean anything.
  const context = currentContext(live)
  const turn = turnText(live)

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
        <button
          className="secondary"
          disabled={!answering || !context}
          title="Leave what has been said out of the next answer and start collecting again"
          onClick={() => {
            // Copied on the way past: this is the one action that puts the
            // context beyond reach, so it is the one that should not be able
            // to lose it.
            void navigator.clipboard.writeText(turn)
            void window.tb.newTurn()
          }}
        >
          New turn
        </button>
        <button
          disabled={!turn}
          title="Copy this turn: what was said, and the question and answer if there are any"
          onClick={() => {
            void navigator.clipboard.writeText(turn)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy turn'}
        </button>
        <span className="grow" />
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

/** For a heading, where the minute is enough to place something. */
function clock(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(ms),
  )
}

/**
 * For a transcript line, which needs the second.
 *
 * Somebody says several things a minute, and a column of identical times tells
 * the reader nothing about where in the round they are.
 */
function clockPrecise(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(ms))
}
