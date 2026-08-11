import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioChannel } from '@shared/types'
import { CaptureController } from './audio/capture'
import { useOverlay } from './store'

export function App() {
  const store = useOverlay()
  const capture = useMemo(
    () => new CaptureController((channel, rms) => useOverlay.getState().setLevel(channel, rms)),
    [],
  )

  useEffect(() => {
    const off = [
      window.tb.onSessionState((s) => useOverlay.getState().setSession(s)),
      window.tb.onEngineStatus((e) => useOverlay.getState().setEngine(e)),
      window.tb.onSegment((s) => useOverlay.getState().addSegment(s)),
      window.tb.onPartial((p) => useOverlay.getState().setPartial(p.channel, p.text)),
      window.tb.onNotice((n) => useOverlay.getState().setNotice(n)),
      window.tb.onCaptureCommand((cmd) => {
        if (cmd.action === 'start') {
          void capture.start(cmd.channels).catch(() => {
            // The controller has already reported the failure to main, which
            // owns the user-facing message.
          })
        } else {
          void capture.stop()
        }
      }),
    ]

    void window.tb.getSettings().then((s) => {
      useOverlay.getState().setEngine(s.engine)
      useOverlay.getState().setSession(s.session)
    })

    return () => {
      for (const unsubscribe of off) unsubscribe()
      void capture.stop()
    }
  }, [capture])

  const recording = store.session.state === 'recording' || store.session.state === 'starting'
  const finished = store.session.state === 'idle' && store.segments.length > 0

  return (
    <div className="overlay">
      <Header />
      {store.consentRequired ? <Consent /> : <Transcript />}
      <Footer recording={recording} finished={finished} />
    </div>
  )
}

function Header() {
  const { session, engine, levels } = useOverlay()
  const recording = session.state === 'recording' || session.state === 'starting'
  const level = Math.max(levels['system'] ?? 0, levels['microphone'] ?? 0)

  return (
    <header className="header" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <span className={`dot ${recording ? 'dot--live' : ''}`} aria-hidden />
      <span className="status">{describeState(session.state, engine.state)}</span>
      {recording && <Elapsed since={session.startedAt} />}
      <span className="meter" aria-hidden>
        <span className="meter__fill" style={{ width: `${Math.min(100, level * 220)}%` }} />
      </span>
    </header>
  )
}

function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  if (!since) return null
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return <span className="elapsed">{`${m}:${s}`}</span>
}

function Transcript() {
  const { segments, partials, session, autoScroll, setAutoScroll } = useOverlay()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [segments, partials, autoScroll])

  const onScroll = () => {
    const el = ref.current
    if (!el) return
    // Within a line of the bottom counts as "at the bottom" — otherwise
    // sub-pixel scroll positions permanently disable auto-scroll.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== autoScroll) setAutoScroll(atBottom)
  }

  const live = Object.entries(partials).filter(([, text]) => text.length > 0)
  const empty = segments.length === 0 && live.length === 0

  return (
    <div className="transcript" ref={ref} onScroll={onScroll}>
      {empty && (
        <p className="placeholder">
          {session.state === 'recording' ? 'Listening…' : 'Press the hotkey to start recording.'}
        </p>
      )}
      {segments.map((s) => (
        <p key={s.id} className={`line ${s.confidence < 0.5 ? 'line--unsure' : ''}`}>
          <ChannelTag channel={s.channel} />
          {s.text}
        </p>
      ))}
      {live.map(([channel, text]) => (
        <p key={`partial-${channel}`} className="line line--partial">
          <ChannelTag channel={channel as AudioChannel} />
          {text}
        </p>
      ))}
      {!autoScroll && (
        <button className="jump" onClick={() => setAutoScroll(true)}>
          Jump to latest
        </button>
      )}
    </div>
  )
}

function ChannelTag({ channel }: { channel: AudioChannel }) {
  // Only worth showing when both channels are in play.
  const hasBoth = useOverlay(
    (s) => new Set(s.segments.map((seg) => seg.channel)).size > 1,
  )
  if (!hasBoth) return null
  return <span className={`tag tag--${channel}`}>{channel === 'system' ? 'them' : 'me'}</span>
}

function Consent() {
  const clearConsent = useOverlay((s) => s.clearConsent)
  const engine = useOverlay((s) => s.engine)
  const ready = engine.state === 'ready'

  return (
    <div className="consent">
      <p>
        This records audio playing on this computer and turns it into text on this machine.
      </p>
      <p className="consent__warn">
        Recording a conversation without telling the other people is illegal in many places.
        Getting consent is your responsibility.
      </p>
      <button
        className="primary"
        disabled={!ready}
        onClick={() => {
          // Take the panel down immediately. Main confirms by moving the
          // session to `starting`, but the click must feel like it landed.
          clearConsent()
          window.tb.acknowledgeConsent()
        }}
      >
        {ready ? 'I understand — start recording' : 'Waiting for the speech model…'}
      </button>
    </div>
  )
}

function Footer({ recording, finished }: { recording: boolean; finished: boolean }) {
  const { notice, setNotice } = useOverlay()
  const [copied, setCopied] = useState<string | null>(null)

  const copy = async () => {
    const result = await window.tb.copyTranscript()
    setCopied(result.copied ? 'Copied' : (result.reason ?? 'Nothing to copy'))
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <footer className="footer">
      {notice && (
        <button className={`notice notice--${notice.level}`} onClick={() => setNotice(null)}>
          {notice.message}
        </button>
      )}
      <div className="actions">
        {recording ? (
          <button onClick={() => window.tb.stopSession()}>Stop</button>
        ) : (
          <button onClick={() => window.tb.startSession()}>Record</button>
        )}
        {finished && <button onClick={() => void copy()}>{copied ?? 'Copy'}</button>}
        <button className="ghost" onClick={() => window.tb.dismiss()}>
          Hide
        </button>
      </div>
    </footer>
  )
}

function describeState(state: string, engine: string): string {
  if (engine === 'loading') return 'Loading model…'
  if (engine === 'failed') return 'Engine unavailable'
  switch (state) {
    case 'starting':
      return 'Starting…'
    case 'recording':
      return 'Listening'
    case 'stopping':
      return 'Stopping…'
    case 'finalising':
      return 'Finishing transcription…'
    case 'failed':
      return 'Recording failed'
    default:
      return 'Ready'
  }
}
