import { useEffect, useRef, useState } from 'react'
import type { AssistMessage, LiveSessionState } from '@shared/api-types'
import { formatTime } from './InterviewList'
import { RecruitmentPanel } from './RecruitmentPanel'
import { CaptionsPanel } from './CaptionsPanel'
import { WatchedCaptionsPanel } from './WatchedCaptionsPanel'
import { isMine } from '@shared/chat'

/**
 * One interview: the chat with the people watching it on TeamBridge Web, and —
 * while listening — the Live Captions beside it.
 *
 * The chat belongs to the round, not to a run of listening, so it is there
 * before Start Listening and after Stop.
 *
 * Somebody who is not the round's interviewer is in it as an assistant: the
 * same chat, written from the support side, and Join Listening where Start
 * Listening would be — which puts the interviewer's Live Captions beside the
 * chat, as they change.
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
  const assistant = live.role === 'assistant'
  const joined = assistant && live.joined
  const interviewerName =
    (live.watching ?? live.liveRun)?.interviewer.name ?? 'The interviewer'

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
        {assistant && live.watching?.startedAt && <Elapsed since={live.watching.startedAt} />}
        {(running || joined) && <OpenChatGPT className="compact" />}
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
        {joined && (
          <button className="compact" onClick={() => void window.tb.leaveListening()}>
            Leave
          </button>
        )}
        {assistant ? <WatchPill live={live} /> : <StatusPill live={live} />}
      </header>

      <div className="chat__body">
        <div className="chat__main">
          <div className="chat__scroll" ref={scroller} onScroll={onScroll}>
            <div className="thread">
              {live.messages.length === 0 && (
                <div className="ready">
                  {assistant ? (
                    <>
                      <strong>You are the support team on this round</strong>
                      <p className="muted">
                        What you send goes to the interviewer and to everybody watching on
                        TeamBridge Web. Join Listening to see their Live Captions beside the chat.
                      </p>
                    </>
                  ) : (
                    <>
                      <strong>Chat with the support team</strong>
                      <p className="muted">
                        Messages from people watching this round on TeamBridge Web appear here, and
                        what you send goes to them.
                      </p>
                    </>
                  )}
                </div>
              )}

              {live.messages.map((message) => (
                <ChatMessage key={message.id} message={message} live={live} />
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

          <ChatInput
            placeholder={assistant ? `Message ${interviewerName === 'The interviewer' ? 'the interviewer' : interviewerName}…` : undefined}
          />
        </div>

        {running && <CaptionsPanel />}
        {joined && <WatchedCaptionsPanel interviewer={interviewerName} live={live.watching !== null} />}
        {details && <RecruitmentPanel interview={interview} onClose={() => setDetails(false)} />}
      </div>

      {!running && !assistant && <StartBar live={live} />}
      {assistant && !joined && <AssistantBar live={live} />}
    </div>
  )
}

/* ------------------------------- chat ---------------------------------- */

/**
 * One line of the chat. Theirs on the left, labelled with who sent it and —
 * for a suggested answer — that it is one; yours on the right. Which are yours
 * depends on the side: the interviewer's from the desktop, an assistant's
 * from the support side.
 */
function ChatMessage({ message, live }: { message: AssistMessage; live: LiveSessionState }) {
  const [copied, setCopied] = useState(false)
  const mine = isMine(message, live.role, live.meId)
  const who = mine
    ? 'You'
    : (message.sender.name ?? (message.source === 'desktop' ? 'Interviewer' : 'Support'))

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
function ChatInput({ placeholder = 'Message the support team…' }: { placeholder?: string }) {
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
          placeholder={placeholder}
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
  // Only shown to the round's interviewer: everybody else has the AssistantBar.
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

/**
 * What an assistant has instead of Start Listening: Join Listening, which
 * puts the interviewer's Live Captions beside the chat. Pressed before the
 * interviewer has started, it waits for them. Only they start or stop it.
 */
function AssistantBar({ live }: { live: LiveSessionState }) {
  const name = live.liveRun?.interviewer.name ?? 'The interviewer'
  return (
    <footer className="composer composer--start">
      <div className="composer__actions">
        <button className="primary big" onClick={() => void window.tb.joinListening()}>
          Join Listening
        </button>
        <OpenChatGPT className="big" />
      </div>
      <span className="muted small">
        {live.liveRun
          ? `${name} is listening now.`
          : 'The interviewer has not started listening yet. Join now to be let in as soon as they do.'}
      </span>
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

function WatchPill({ live }: { live: LiveSessionState }) {
  const watching = live.watching !== null
  const label = watching
    ? 'Watching live'
    : live.joined
      ? 'Waiting for the interviewer'
      : live.liveRun
        ? 'Interviewer is live'
        : 'Assistant'
  return (
    <span className="statuspill" title="You are this round's assistant">
      <span className={`dot ${watching || (!live.joined && live.liveRun) ? 'dot--live' : ''}`} aria-hidden />
      {label}
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
