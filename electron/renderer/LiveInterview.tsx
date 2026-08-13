import { useEffect, useState } from 'react'
import type { LiveSessionState } from '@shared/api-types'
import type { EngineStatus, LevelPayload } from '@shared/types'
import { InterviewList } from './InterviewList'
import { InterviewDetail } from './InterviewDetail'

interface Notice {
  level: 'info' | 'warn' | 'error' | 'consent'
  message: string
}

/**
 * Root of the Live Interview window.
 *
 * Two screens, chosen by whether an interview is open. The selected interview
 * is real application state held in main, so it survives this window being
 * closed and reopened — which is why the switch reads from live state rather
 * than a local flag.
 */
export function LiveInterview() {
  const [live, setLive] = useState<LiveSessionState | null>(null)
  const [engine, setEngine] = useState<EngineStatus | null>(null)
  const [level, setLevel] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    const off = [
      window.tb.onLiveState(setLive),
      window.tb.onEngineStatus(setEngine),
      window.tb.onLevel((l: LevelPayload) => setLevel(l.rms)),
      window.tb.onNotice(setNotice),
    ]
    void window.tb.getLive().then(setLive)
    void window.tb.getSettings().then((s) => setEngine(s.engine))
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [])

  useEffect(() => {
    if (live?.status !== 'recording') setLevel(0)
  }, [live?.status])

  if (!live) return <main className="live"><p className="muted">Loading…</p></main>

  return (
    <main className="live">
      {engine && engine.state !== 'ready' && (
        <p className={`callout ${engine.state === 'failed' ? 'callout--error' : 'callout--warn'}`}>
          {engine.state === 'loading'
            ? `Loading the ${engine.model ?? 'speech'} model…`
            : (engine.reason ?? 'The transcription engine is unavailable.')}
        </p>
      )}

      {notice && (
        <button className={`callout callout--${notice.level}`} onClick={() => setNotice(null)}>
          {notice.message}
        </button>
      )}

      {live.interview ? (
        <InterviewDetail live={live} level={level} />
      ) : (
        <InterviewList onOpen={(interview) => window.tb.selectInterview(interview)} />
      )}
    </main>
  )
}
