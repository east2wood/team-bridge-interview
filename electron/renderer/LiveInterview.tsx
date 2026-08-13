import { useEffect, useRef, useState } from 'react'
import {
  SOURCE_LABELS,
  type AudioSource,
  type EngineStatus,
  type LevelPayload,
  type Segment,
  type SessionStatePayload,
  type Settings,
} from '@shared/types'

interface Notice {
  level: 'info' | 'warn' | 'error' | 'consent'
  message: string
}

/** The three capture states the user actually needs to tell apart. */
type CaptureState = 'idle' | 'listening' | 'error'

export function LiveInterview() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [session, setSession] = useState<SessionStatePayload>({
    state: 'idle',
    sessionId: null,
    startedAt: null,
  })
  const [engine, setEngine] = useState<EngineStatus>({
    state: 'stopped',
    model: null,
    device: null,
    computeType: null,
  })
  const [segments, setSegments] = useState<Segment[]>([])
  const [partials, setPartials] = useState<Record<string, string>>({})
  const [level, setLevel] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    const off = [
      window.tb.onSessionState((s) => {
        setSession((prev) => {
          if (s.state === 'starting' && prev.state !== 'starting') {
            setSegments([])
            setPartials({})
            setNotice(null)
          }
          return s
        })
      }),
      window.tb.onEngineStatus(setEngine),
      window.tb.onSegment((s) => {
        setSegments((prev) => [...prev, s])
        setPartials((prev) => ({ ...prev, [s.channel]: '' }))
      }),
      window.tb.onPartial((p) => setPartials((prev) => ({ ...prev, [p.channel]: p.text }))),
      window.tb.onLevel((l: LevelPayload) => setLevel(l.rms)),
      window.tb.onBusy(setTranscribing),
      window.tb.onNotice((n) => setNotice(n)),
    ]

    void window.tb.getSettings().then((s) => {
      setSettings(s)
      setEngine(s.engine)
      setSession(s.session)
    })

    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [])

  // Levels only arrive while capturing; decay to zero so the meter does not
  // freeze at its last value after a session ends.
  const recording = session.state === 'recording' || session.state === 'starting'
  useEffect(() => {
    if (recording) return
    setLevel(0)
  }, [recording])

  const captureState: CaptureState =
    session.state === 'failed' || notice?.level === 'error'
      ? 'error'
      : recording
        ? 'listening'
        : 'idle'

  if (!settings) return <div className="live"><p className="muted">Loading…</p></div>

  return (
    <div className="live">
      <TopBar state={captureState} session={session} engine={engine} />
      <div className="live__body">
        <SessionPane
          settings={settings}
          onSettings={setSettings}
          state={captureState}
          session={session}
          level={level}
          recording={recording}
        />
        <ConversationPane
          segments={segments}
          partials={partials}
          recording={recording}
          transcribing={transcribing}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
        />
        <AssistancePane serverUrl={settings.serverUrl} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TopBar({
  state,
  session,
  engine,
}: {
  state: CaptureState
  session: SessionStatePayload
  engine: EngineStatus
}) {
  return (
    <header className="topbar">
      <strong>TeamBridge Assist</strong>
      <span className={`badge badge--${state}`}>
        <span className="dot" aria-hidden />
        {state === 'listening' ? 'Listening' : state === 'error' ? 'Problem' : 'Idle'}
      </span>
      {session.startedAt && <Elapsed since={session.startedAt} />}
      <span className="topbar__spacer" />
      <span className="muted">
        {engine.state === 'ready'
          ? `${engine.model} · ${engine.device}`
          : engine.state === 'loading'
            ? 'Loading model…'
            : 'Engine unavailable'}
      </span>
      <button onClick={() => window.tb.minimiseToOverlay()} title="Shrink to the floating overlay">
        Float
      </button>
      <button onClick={() => window.tb.openSettings()}>⚙ Settings</button>
    </header>
  )
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const total = Math.max(0, Math.floor((now - since) / 1000))
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return <span className="elapsed">{`${h}:${m}:${s}`}</span>
}

/* --------------------------- left: capture -------------------------- */

function SessionPane({
  settings,
  onSettings,
  state,
  session,
  level,
  recording,
}: {
  settings: Settings
  onSettings: (s: Settings) => void
  state: CaptureState
  session: SessionStatePayload
  level: number
  recording: boolean
}) {
  const [device, setDevice] = useState<string | null>(null)

  useEffect(() => {
    // Purely informational: confirms which endpoint Windows will hand us.
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((devices) => {
        const output = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')
        setDevice(output?.label || null)
      })
      .catch(() => setDevice(null))
  }, [])

  const setSource = async (audioSource: AudioSource) => {
    const result = await window.tb.patchSettings({ audioSource })
    onSettings(result.settings)
  }

  return (
    <aside className="pane pane--session">
      <h2>Session</h2>

      <label className="field">
        <span className="field__label">Source</span>
        <select
          value={settings.audioSource}
          disabled={recording}
          onChange={(e) => void setSource(e.target.value as AudioSource)}
        >
          {(['system', 'microphone', 'both'] as AudioSource[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <p className="device">
        <span className="muted">Device</span>
        <br />
        {device ?? 'Default output device'}
      </p>

      <Meter level={level} recording={recording} />

      {recording ? (
        <button className="capture capture--stop" onClick={() => window.tb.stopSession()}>
          Stop Capture
        </button>
      ) : (
        <button className="capture primary" onClick={() => window.tb.startSession()}>
          🎙 Start Capture
        </button>
      )}

      {state === 'error' && session.reason && <p className="muted small">{session.reason}</p>}
    </aside>
  )
}

function Meter({ level, recording }: { level: number; recording: boolean }) {
  // Sampled at ~15 Hz, so keep a short history rather than one moving bar:
  // a strip of recent levels shows whether audio is arriving continuously.
  const history = useRef<number[]>(new Array(24).fill(0))
  const [, force] = useState(0)

  useEffect(() => {
    history.current = [...history.current.slice(1), recording ? level : 0]
    force((n) => n + 1)
  }, [level, recording])

  const loud = level > 0.002
  return (
    <div className="meterbox">
      <div className="meter" aria-hidden>
        {history.current.map((v, i) => (
          <span
            key={i}
            className="meter__bar"
            style={{ height: `${Math.min(100, Math.sqrt(v) * 160)}%` }}
          />
        ))}
      </div>
      <span className={`muted small ${recording && !loud ? 'warn' : ''}`}>
        {!recording ? 'Not capturing' : loud ? 'Audio detected' : 'Quiet'}
      </span>
    </div>
  )
}

/* ------------------------ centre: conversation ---------------------- */

function ConversationPane({
  segments,
  partials,
  recording,
  transcribing,
  notice,
  onDismissNotice,
}: {
  segments: Segment[]
  partials: Record<string, string>
  recording: boolean
  transcribing: boolean
  notice: Notice | null
  onDismissNotice: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)

  useEffect(() => {
    if (stick && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [segments, partials, stick])

  const live = Object.entries(partials).filter(([, text]) => text.length > 0)
  const copy = () => void window.tb.copyTranscript()

  return (
    <section className="pane pane--conversation">
      <div className="pane__head">
        <h2>Live Transcript</h2>
        <span className="grow" />
        {transcribing && <span className="chip">1 segment transcribing</span>}
        <button onClick={copy} disabled={segments.length === 0}>
          Copy
        </button>
      </div>

      {notice && (
        <button className={`notice notice--${notice.level}`} onClick={onDismissNotice}>
          {notice.message}
        </button>
      )}

      <div
        className="transcript"
        ref={ref}
        onScroll={() => {
          const el = ref.current
          if (!el) return
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
      >
        {segments.length === 0 && live.length === 0 && (
          <p className="muted">
            {recording ? 'Listening…' : 'Start capture to see the conversation here.'}
          </p>
        )}

        {segments.map((s) => (
          <article key={s.id} className="turn">
            <header>
              <span className={`who who--${s.channel}`}>
                {s.channel === 'system' ? 'Interviewer' : 'You'}
              </span>
              <span className="muted small">{clockOf(s)}</span>
            </header>
            <p className={s.confidence < 0.5 ? 'unsure' : ''}>{s.text}</p>
          </article>
        ))}

        {live.map(([channel, text]) => (
          <article key={`p-${channel}`} className="turn turn--partial">
            <header>
              <span className={`who who--${channel}`}>
                {channel === 'system' ? 'Interviewer' : 'You'}
              </span>
            </header>
            <p>{text}</p>
          </article>
        ))}

        {recording && <p className="cursor">▌ Listening…</p>}
      </div>

      {!stick && (
        <button className="jump" onClick={() => setStick(true)}>
          Jump to latest
        </button>
      )}
    </section>
  )
}

function clockOf(segment: Segment): string {
  const total = Math.floor(segment.startMs / 1000)
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

/* ------------------------- right: assistance ------------------------ */

function AssistancePane({ serverUrl }: { serverUrl: string }) {
  const configured = serverUrl.trim().length > 0

  return (
    <aside className="pane pane--assist">
      <h2>Assistance</h2>
      {configured ? (
        <>
          <p className="muted">
            Connected to <code>{serverUrl}</code>.
          </p>
          <p className="muted small">
            Question detection and suggested answers are not implemented yet. When they land,
            the current question and its suggested answer appear here.
          </p>
        </>
      ) : (
        <>
          <p className="muted">No TeamBridge server configured.</p>
          <p className="muted small">
            Suggested answers come from your TeamBridge server. Add its URL and API token to
            enable them.
          </p>
          <button onClick={() => window.tb.openSettings()}>Open Settings</button>
        </>
      )}
    </aside>
  )
}
