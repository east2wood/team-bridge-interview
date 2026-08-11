import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionTestResult, SecretsInfo, Settings as SettingsShape } from '@shared/types'

type Loaded = SettingsShape & { engine: { state: string; model: string | null; device: string | null } }

export function SettingsPage() {
  const [settings, setSettings] = useState<Loaded | null>(null)
  const [secrets, setSecrets] = useState<SecretsInfo | null>(null)

  useEffect(() => {
    void window.tb.getSettings().then((s) => setSettings(s as Loaded))
    void window.tb.getSecrets().then(setSecrets)
  }, [])

  const patch = useCallback(async (p: Partial<SettingsShape>) => {
    const result = await window.tb.patchSettings(p)
    setSettings((prev) => (prev ? { ...prev, ...result.settings } : prev))
    return result
  }, [])

  if (!settings || !secrets) {
    return <main className="page"><p className="muted">Loading…</p></main>
  }

  return (
    <main className="page">
      <h1>Settings</h1>

      <TeamBridgeSection
        serverUrl={settings.serverUrl}
        secrets={secrets}
        onSecrets={setSecrets}
        onPatch={patch}
      />
      <HotkeysSection settings={settings} onPatch={patch} />
      <AppearanceSection theme={settings.theme} onPatch={patch} />
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  )
}

/* ------------------------------------------------------------------ */

function TeamBridgeSection({
  serverUrl,
  secrets,
  onSecrets,
  onPatch,
}: {
  serverUrl: string
  secrets: SecretsInfo
  onSecrets: (s: SecretsInfo) => void
  onPatch: (p: Partial<SettingsShape>) => Promise<unknown>
}) {
  const [url, setUrl] = useState(serverUrl)
  // Never pre-filled with the stored token: it is write-only by design.
  const [token, setToken] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<ConnectionTestResult | null>(null)

  const saveUrl = () => {
    if (url !== serverUrl) void onPatch({ serverUrl: url })
  }

  const saveToken = async () => {
    const next = await window.tb.setToken(token)
    onSecrets(next)
    setToken('')
    setResult(null)
  }

  const clearToken = async () => {
    onSecrets(await window.tb.clearToken())
    setToken('')
    setResult(null)
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      // Save first so the test reflects what is actually configured.
      if (url !== serverUrl) await onPatch({ serverUrl: url })
      if (token.trim()) await saveToken()
      setResult(await window.tb.testConnection(url))
    } finally {
      setTesting(false)
    }
  }

  return (
    <Section title="TeamBridge">
      <Field label="Server URL" hint="https:// is assumed when no scheme is given.">
        <input
          type="url"
          value={url}
          placeholder="https://teambridge.example.com"
          spellCheck={false}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={saveUrl}
        />
      </Field>

      <Field
        label="API Token"
        hint={
          secrets.storageAvailable
            ? 'Encrypted with the Windows credential store. It is never shown again and never reaches the interface.'
            : 'The OS credential store is unavailable, so the token cannot be stored securely.'
        }
      >
        <div className="row">
          <input
            type="password"
            value={token}
            placeholder={secrets.hasToken ? `Saved — ending ${secrets.hint}` : 'Paste a token'}
            spellCheck={false}
            autoComplete="off"
            disabled={!secrets.storageAvailable}
            onChange={(e) => setToken(e.target.value)}
          />
          <button onClick={() => void saveToken()} disabled={!token.trim()}>
            Save
          </button>
          {secrets.hasToken && (
            <button className="danger" onClick={() => void clearToken()}>
              Remove
            </button>
          )}
        </div>
      </Field>

      <div className="row">
        <button className="primary" onClick={() => void test()} disabled={testing || !url.trim()}>
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
        {result && (
          <span className={`result ${result.ok ? 'result--ok' : 'result--bad'}`}>
            {result.ok ? '✓' : '✕'} {result.message}
          </span>
        )}
      </div>

      {result?.insecure && (
        <p className="callout callout--warn">
          This server uses plain http, so the API token travels unencrypted. Use https unless the
          server is on your own machine.
        </p>
      )}
    </Section>
  )
}

/* ------------------------------------------------------------------ */

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

function HotkeysSection({
  settings,
  onPatch,
}: {
  settings: SettingsShape
  onPatch: (p: Partial<SettingsShape>) => Promise<{ hotkey?: { ok: boolean; reason?: string } }>
}) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!capturing) return

    const onKeyDown = async (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      // Ignore keydowns that are only modifiers — wait for the real key.
      if (MODIFIERS.has(e.key)) return

      const parts: string[] = []
      if (e.ctrlKey) parts.push('Control')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Super')

      if (parts.length === 0) {
        setError('A hotkey needs at least one modifier, so it cannot fire while you type.')
        return
      }

      parts.push(normaliseKey(e))
      const accelerator = parts.join('+')
      setCapturing(false)
      setError(null)

      const result = await onPatch({ hotkey: accelerator })
      if (result.hotkey && !result.hotkey.ok) {
        setError(result.hotkey.reason ?? `${accelerator} could not be registered.`)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing, onPatch])

  return (
    <Section title="Hotkeys">
      <Field label="Start and stop recording">
        <div className="row">
          <button
            ref={inputRef}
            className={`hotkey ${capturing ? 'hotkey--capturing' : ''}`}
            onClick={() => {
              setError(null)
              setCapturing(true)
            }}
          >
            {capturing ? 'Press a combination…' : settings.hotkey}
          </button>
          {capturing && <span className="muted">Esc to cancel</span>}
        </div>
      </Field>

      <Field label="Mode">
        <select
          value={settings.hotkeyMode}
          onChange={(e) => void onPatch({ hotkeyMode: e.target.value as SettingsShape['hotkeyMode'] })}
        >
          <option value="toggle">Toggle — press to start, press again to stop</option>
          <option value="push-to-talk">Hold to record</option>
        </select>
      </Field>

      {settings.hotkeyMode === 'push-to-talk' && (
        <p className="callout callout--warn">
          Hold to record is not implemented yet: the global shortcut reports key presses but not
          releases, so this currently behaves as toggle.
        </p>
      )}

      {error && <p className="callout callout--error">{error}</p>}
    </Section>
  )
}

/** Maps a KeyboardEvent to the name Electron's accelerator parser expects. */
function normaliseKey(e: KeyboardEvent): string {
  if (e.code.startsWith('Digit')) return e.code.slice(5)
  if (e.code.startsWith('Key')) return e.code.slice(3)
  if (e.code.startsWith('Numpad')) return `num${e.code.slice(6).toLowerCase()}`
  if (e.key === ' ') return 'Space'
  if (e.key.length === 1) return e.key.toUpperCase()
  return e.key
}

/* ------------------------------------------------------------------ */

const THEMES: { value: SettingsShape['theme']; label: string }[] = [
  { value: 'system', label: 'Match Windows' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function AppearanceSection({
  theme,
  onPatch,
}: {
  theme: SettingsShape['theme']
  onPatch: (p: Partial<SettingsShape>) => Promise<unknown>
}) {
  return (
    <Section title="Appearance">
      <Field label="Theme">
        <div className="row">
          {THEMES.map((t) => (
            <button
              key={t.value}
              className={theme === t.value ? 'primary' : ''}
              onClick={() => void onPatch({ theme: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Field>
    </Section>
  )
}
