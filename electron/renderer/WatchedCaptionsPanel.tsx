import { useEffect, useRef, useState } from 'react'

/**
 * The right-hand column for an assistant: what the interviewer's Live
 * Captions show, as they change.
 *
 * Read-only. The interviewer's app reads the captions and sends them on; the
 * server passes each change to everybody watching the run, and main hands it
 * here. Nothing to ask or send from — the chat beside it is how the assistant
 * says something.
 */
export function WatchedCaptionsPanel({ interviewer, live }: { interviewer: string; live: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    const off = window.tb.onWatchedCaptions(setText)
    void window.tb.getWatchedCaptions().then((initial) => setText((current) => current ?? initial))
    return off
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  }, [text, pinned])

  const onScroll = () => {
    const el = scroller.current
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  return (
    <aside className="panel captions" aria-label="The interviewer's live captions">
      <header className="panel__head">
        <div className="panel__title">
          <strong>Live Captions</strong>
          <span className="muted small">From {interviewer}, as they are spoken</span>
        </div>
      </header>

      <div className="panel__body captions__body" ref={scroller} onScroll={onScroll}>
        {!live && (
          <p className="muted">
            Waiting for {interviewer === 'The interviewer' ? 'the interviewer' : interviewer} to start
            listening. Their captions appear here as soon as they do.
          </p>
        )}
        {live && !text && <p className="muted">Nothing captioned yet. Captions appear here as people speak.</p>}
        {live && text && <p className="captions__text">{text}</p>}
      </div>

      {!pinned && text && (
        <button
          className="jump captions__jump"
          onClick={() => {
            const el = scroller.current
            if (el) el.scrollTop = el.scrollHeight
            setPinned(true)
          }}
        >
          ↓ Latest
        </button>
      )}
    </aside>
  )
}
