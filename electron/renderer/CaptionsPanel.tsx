import { useEffect, useRef, useState } from 'react'
import type { CaptionTarget, CaptionsView } from '@shared/types'

/**
 * The right-hand column while listening: what Live Captions is showing,
 * refreshed every second by main.
 *
 * Split three ways, because that is what the ask buttons act on: text from
 * before the last ask (or before listening began) is faded; everything
 * collected since — which starts just after the last sentence the previous ask
 * ended on — is highlighted, the complete sentences that the next ask sends
 * strongly and the sentence still being spoken lightly, since it is held back
 * until it finishes.
 */
export function CaptionsPanel() {
  const [view, setView] = useState<CaptionsView | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const [sending, setSending] = useState<CaptionTarget | null>(null)

  const sendTo = async (to: CaptionTarget) => {
    if (sending) return
    setSending(to)
    try {
      await window.tb.sendCaptions(to)
    } finally {
      setSending(null)
    }
  }

  useEffect(() => {
    const off = window.tb.onCaptions(setView)
    void window.tb.getCaptions().then((initial) => setView((current) => current ?? initial))
    return off
  }, [])

  useEffect(() => {
    const el = scroller.current
    if (el && pinned) el.scrollTop = el.scrollHeight
  }, [view, pinned])

  const onScroll = () => {
    const el = scroller.current
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const text = view?.text ?? ''
  const asked = view ? text.slice(0, view.collectedFrom) : ''
  const collected = view ? text.slice(view.collectedFrom, view.completeUntil) : ''
  const speaking = view ? text.slice(view.completeUntil) : ''

  return (
    <aside className="panel captions" aria-label="Live captions">
      <header className="panel__head">
        <div className="panel__title">
          <strong>Live Captions</strong>
          <span className="muted small">
            <span className="captions__key captions__key--collected" /> collected since the last send
            {' · '}
            <span className="captions__key captions__key--speaking" /> still being spoken
          </span>
        </div>
      </header>

      <div className="panel__body captions__body" ref={scroller} onScroll={onScroll}>
        {!view && <p className="muted">Reading Live Captions…</p>}

        {view?.status === 'unavailable' && (
          <div className="panel__error">
            <p>{view.reason}</p>
            <button onClick={() => void window.tb.openLiveCaptions()}>Open Live Captions</button>
          </div>
        )}

        {view?.status === 'ok' && !text && (
          <p className="muted">Nothing captioned yet. Captions appear here as people speak.</p>
        )}

        {view?.status === 'ok' && text && (
          <p className="captions__text">
            {asked && <span className="captions__asked">{asked} </span>}
            {collected && <mark className="captions__collected">{collected}</mark>}
            {collected && speaking && ' '}
            {speaking && (
              <mark className="captions__speaking" title="Still being spoken: sent once the sentence ends">
                {speaking}
              </mark>
            )}
          </p>
        )}
      </div>

      {!pinned && view?.status === 'ok' && (
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

      <footer className="captions__actions">
        <span className="muted small">Sends the strongly highlighted sentences.</span>
        <div className="captions__buttons">
          <button
            disabled={sending !== null}
            title="Send the collected captions to the support team's chat, tagged as a live caption"
            onClick={() => void sendTo('chat')}
          >
            {sending === 'chat' ? 'Sending…' : 'Send to assistant'}
          </button>
          <button
            className="primary"
            disabled={sending !== null}
            title="Paste the collected captions into ChatGPT and send them"
            onClick={() => void sendTo('chatgpt')}
          >
            {sending === 'chatgpt' ? 'Sending to ChatGPT…' : 'Ask GPT'}
          </button>
        </div>
      </footer>
    </aside>
  )
}
