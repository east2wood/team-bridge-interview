import { useEffect, useState } from 'react'
import type { LiveSessionState } from '@shared/api-types'
import type { Partials } from './InterviewDetail'
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
  /**
   * Speech that has been heard but not yet committed, per channel.
   *
   * Ephemeral by nature: it is replaced wholesale on every update and thrown
   * away when the segment it becomes arrives. Never sent anywhere and never
   * part of a question — a half-heard phrase must not be able to become one —
   * but shown immediately, because waiting for the commit left the page two or
   * three seconds behind the room.
   */
  const [partials, setPartials] = useState<Partials>({})

  useEffect(() => {
    const off = [
      window.tb.onLiveState(setLive),
      window.tb.onEngineStatus(setEngine),
      window.tb.onLevel((l: LevelPayload) => setLevel(l.rms)),
      window.tb.onNotice(setNotice),
      window.tb.onPartial((p) => setPartials((was) => ({ ...was, [p.channel]: p.text }))),
      // The committed segment supersedes the provisional text it was made
      // from; the next phrase starts the live line again from nothing.
      window.tb.onSegment((s) => setPartials((was) => ({ ...was, [s.channel]: '' }))),
    ]
    void window.tb.getLive().then(setLive)
    void window.tb.getSettings().then((s) => setEngine(s.engine))
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [])

  useEffect(() => {
    if (live?.status !== 'recording') {
      setLevel(0)
      // A turn boundary ends the provisional text: anything still unresolved
      // was either committed by the flush or is not coming.
      setPartials({})
    }
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
        <InterviewDetail live={live} level={level} partials={partials} />
      ) : (
        <InterviewList onOpen={(interview) => window.tb.selectInterview(interview)} />
      )}
    </main>
  )
}
