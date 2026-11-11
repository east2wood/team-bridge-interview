import { useEffect, useState } from 'react'
import type { LiveSessionState } from '@shared/api-types'

interface Notice {
  level: 'info' | 'warn' | 'error'
  message: string
}

/**
 * The floating overlay: a glanceable handle on the interview while the main
 * window is out of the way. Live Captions does the listening in its own
 * window, so this only says where the run stands and gets back to it.
 */
export function App() {
  const [live, setLive] = useState<LiveSessionState | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    const off = [window.tb.onLiveState(setLive), window.tb.onNotice(setNotice)]
    void window.tb.getLive().then(setLive)
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [])

  const listening = live?.status === 'recording'
  const title = live?.interview?.position.title ?? null

  return (
    <div className="overlay">
      <header className="header" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <span className={`dot ${listening ? 'dot--live' : ''}`} aria-hidden />
        <span className="status">{describe(live)}</span>
        {listening && live?.sessionStartedAt && <Elapsed since={live.sessionStartedAt} />}
      </header>

      <div className="body">
        <p className="placeholder">
          {title
            ? `${title}${listening ? ' — captions are in the Live Captions window.' : ''}`
            : 'Open an interview in the main window to start.'}
        </p>
      </div>

      <footer className="footer">
        {notice && (
          <button className={`notice notice--${notice.level}`} onClick={() => setNotice(null)}>
            {notice.message}
          </button>
        )}
        <div className="actions">
          {listening ? (
            <button onClick={() => void window.tb.stopListening()}>Stop</button>
          ) : (
            <button onClick={() => void window.tb.openLiveCaptions()}>Live Captions</button>
          )}
          <button className="ghost" onClick={() => window.tb.openMain()} title="Open the full window">
            Expand
          </button>
          <button onClick={() => window.tb.dismiss()}>Hide</button>
        </div>
      </footer>
    </div>
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

function describe(live: LiveSessionState | null): string {
  switch (live?.status) {
    case 'starting':
      return 'Starting…'
    case 'recording':
      return 'Listening'
    case 'error':
      return 'Could not start'
    default:
      return 'Ready'
  }
}
