import { useEffect, useRef, useState } from 'react'
import type { AssistMessage, LiveSessionState } from '@shared/api-types'
import { formatTime } from './InterviewList'
import { RecruitmentPanel } from './RecruitmentPanel'
import { CaptionsPanel } from './CaptionsPanel'

/**
 * One interview: the chat with the people watching it on TeamBridge Web, and —
 * while listening — the Live Captions beside it.
 *
 * The chat belongs to the round, not to a run of listening, so it is there
 * before Start Listening and after Stop.
 */
export function InterviewDetail({ live }: { live: LiveSessionState }) {
  const interview = live.interview
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [unread, setUnread] = useState(false)
  const [details, setDetails] = useState(false)

  // A new message follows the chat down — but only if the reader is already
  // at the bottom. Yanking them away from one they are re-reading is worse
  // than a missed scroll.
  const newest = live.messages.at(-1)?.id ?? 0
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    if (pinned) el.scrollTop = el.scrollHeight
    else if (newest) setUnread(true)
  }, [newest, pinned])

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

  // A run that is actually going, as opposed to one that stopped on an error.
  const running = live.status === 'starting' || live.status === 'recording'

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
        <button
          className={`compact ${details ? 'on' : ''}`}
          onClick={() => setDetails((open) => !open)}
          title="Candidate, job and resume, beside the interview"
        >
          Recruitment Details
        </button>
        {running && live.sessionStartedAt && <Elapsed since={live.sessionStartedAt} />}
        {running && <OpenChatGPT className="compact" />}
        {running && (
          <button className="compact" onClick={() => void window.tb.openLiveCaptions()}>
            Live Captions
          </button>
        )}
        {running && (
          <button className="compact" onClick={() => void window.tb.stopListening()}>
            Stop
          </button>
        )}
        <StatusPill live={live} />
      </header>

      <div className="chat__body">
        <div className="chat__main">
          <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
            <div className="thread">
              {live.messages.length === 0 && (
                <div className="ready">
                  <strong>Chat with the support team</strong>
                  <p className="muted">
                    Messages from people watching this round on TeamBridge Web appear here, and
                    what you send goes to them.
                  </p>
                </div>
              )}

              {live.messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
            </div>
          </div>

          <div className="dock">
            {unread && (
              <button className="jump" onClick={jump}>
                ↓ Newest
              </button>
            )}
          </div>

          <ChatInput />
        </div>

        {running && <CaptionsPanel />}
        {details && <RecruitmentPanel interview={interview} onClose={() => setDetails(false)} />}
      </div>

      {!running && <StartBar live={live} />}
    </div>
  )
}

/* ------------------------------- chat ---------------------------------- */

/**
 * One line of the chat. Theirs on the left, labelled with who sent it and —
 * for a suggested answer — that it is one; yours on the right.
 */
function ChatMessage({ message }: { message: AssistMessage }) {
  const [copied, setCopied] = useState(false)
  const mine = message.source === 'desktop'
  const who = mine ? 'You' : (message.sender.name ?? 'Support')

  return (
    <article
      className={`chatmsg ${mine ? 'chatmsg--mine' : 'chatmsg--theirs'} ${message.type === 'caption' ? 'chatmsg--caption' : ''}`}
    >
      <header className="chatmsg__head">
        <span className="chatmsg__from">{who}</span>
        {!mine && message.type === 'answer' && <span className="chatmsg__kind">Suggested answer</span>}
        {message.type === 'caption' && <span className="chatmsg__kind chatmsg__kind--caption">Live caption</span>}
        <span className="muted small">{clock(Date.parse(message.createdAt) || Date.now())}</span>
        {!mine && (
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
        )}
      </header>
      {message.question && <p className="chatmsg__about muted small">on: {message.question}</p>}
      <p className="chatmsg__text">{message.content}</p>
    </article>
  )
}

/* ------------------------------ composer ------------------------------- */

/** The message box under the chat: always there while a round is open. */
function ChatInput() {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    if (!text.trim() || sending) return
    setSending(true)
    try {
      const result = await window.tb.sendChat(text)
      if (result.ok) setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <footer className="composer">
      <div className="composer__row">
        <input
          value={text}
          placeholder="Message the support team…"
          disabled={sending}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <button onClick={() => void send()} disabled={!text.trim() || sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </footer>
  )
}

/**
 * The round's actions before listening. While listening they move into the
 * captions column, where the text they act on is.
 */
function StartBar({ live }: { live: LiveSessionState }) {
  return (
    <footer className="composer composer--start">
      <div className="composer__actions">
        <button className="primary big" onClick={() => void window.tb.startListening()}>
          Start Listening
        </button>
        <OpenChatGPT className="big" />
      </div>
      {live.error && <span className="muted small">{live.error}</span>}
    </footer>
  )
}

/* ------------------------------- bits ---------------------------------- */

/**
 * Opens ChatGPT with the round's briefing — candidate, job description and
 * resume — pasted in but not sent. Held while it works: a second click would
 * paste the briefing twice.
 */
function OpenChatGPT({ className }: { className: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={className}
      disabled={busy}
      title="Open ChatGPT and paste the candidate, job description and resume into it"
      onClick={async () => {
        setBusy(true)
        try {
          await window.tb.openChatGPT()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? 'Opening ChatGPT…' : 'Open ChatGPT'}
    </button>
  )
}

function StatusPill({ live }: { live: LiveSessionState }) {
  const listening = live.status === 'recording'
  return (
    <span className="statuspill">
      <span className={`dot ${listening ? 'dot--live' : ''}`} aria-hidden />
      {listening ? 'Listening' : live.status === 'idle' ? 'Ready' : 'Working…'}
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
