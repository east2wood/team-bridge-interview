import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  Tray,
} from 'electron'
import {
  MODEL_LABELS,
  SOURCE_LABELS,
  WHISPER_MODELS,
  type AudioChannel,
  type AudioSource,
  type CaptureCommand,
  type LevelPayload,
  type SecretsInfo,
  type Settings,
  type WhisperModel,
} from '@shared/types'
import { IPC } from '@shared/channels'
import { child } from '@services/logger'
import { settings } from '@services/settings/settings'
import { closeDatabase, openDatabase } from '@services/history/db'
import * as repo from '@services/history/session-repo'
import { WhisperService } from '@services/transcription/whisper-service'
import { SessionManager } from './session-manager'
import { registerHotkey, unregisterAll } from './hotkeys'
import { testConnection, normaliseUrl } from '@services/teambridge/connection'
import {
  createOverlay,
  getMainWindow,
  getOverlay,
  getSettingsWindow,
  hideOverlay,
  showMain,
  showOverlay,
  showSettings,
} from './windows'

const log = child('main')

let tray: Tray | null = null
let whisper: WhisperService
let sessions: SessionManager
let lastFinishedSessionId: string | null = null

// One instance only: two processes fighting over the same hotkey and the same
// SQLite file is a support ticket waiting to happen.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMain())
  void app.whenReady().then(bootstrap)
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.teambridge.assist')

  openDatabase()
  const repaired = repo.repairInterruptedSessions()
  if (repaired > 0) log.info({ repaired }, 'repaired sessions interrupted by a crash')

  configureLoopbackCapture()

  whisper = new WhisperService(whisperOptions())
  sessions = new SessionManager(whisper)

  wireEvents()
  registerIpc()
  applyTheme()
  createOverlay() // capture host: created once, only ever hidden
  showMain()
  createTray()
  applyHotkey()

  whisper.start()

  app.on('window-all-closed', () => {
    // The overlay closing is not a reason to quit — we live in the tray.
  })
}

/**
 * Grants our own renderer WASAPI loopback capture. Without this handler
 * getDisplayMedia is rejected outright in Electron.
 */
function configureLoopbackCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      log.info(
        {
          videoRequested: request.videoRequested,
          audioRequested: request.audioRequested,
          frame: request.frame?.url,
        },
        'display-media requested',
      )
      try {
        // Audio only: omit `video` entirely. Electron validates the property
        // whenever the key is present, so `video: undefined` throws
        // "video must be a WebFrameMain or DesktopCapturerSource" before
        // capture even starts. The renderer must correspondingly request
        // `video: false`, or this fails with "Video was requested, but no
        // video stream was provided".
        callback({ audio: 'loopback' })
      } catch (err) {
        // Without this the rejection is unhandled and the renderer sees only
        // a generic AbortError with no clue what went wrong.
        log.error({ err }, 'display-media request handler failed')
        callback({})
      }
    },
    { useSystemPicker: false },
  )
}

function whisperOptions() {
  const cfg = settings().all()
  return {
    pythonPath: cfg.pythonPath,
    model: cfg.model,
    device: cfg.gpu === 'off' ? ('cpu' as const) : ('auto' as const),
    language: cfg.language,
    partials: cfg.partials,
  }
}

/** Broadcast to every open window: overlay, Live Interview, and settings. */
function send(channel: string, payload?: unknown): void {
  for (const win of [getOverlay(), getMainWindow(), getSettingsWindow()]) {
    if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function wireEvents(): void {
  sessions.on('state', (payload) => {
    send(IPC.onSessionState, payload)
    updateTray()
  })
  sessions.on('busy', (transcribing: boolean) => send(IPC.onBusy, transcribing))
  sessions.on('no-audio', (quietForMs: number) =>
    send(IPC.onNotice, {
      level: 'warn',
      message: `No audio detected for ${Math.round(quietForMs / 1000)} seconds. Check that audio is playing to the device being captured.`,
    }),
  )
  sessions.on('audio-restored', () => send(IPC.onNotice, null))
  sessions.on('partial', (payload) => send(IPC.onPartial, payload))
  sessions.on('segment', (payload) => send(IPC.onSegment, payload))
  sessions.on('capture-stop', () =>
    send(IPC.onCaptureCommand, { action: 'stop', channels: [] } satisfies CaptureCommand),
  )

  whisper.on('status', (status) => {
    send(IPC.onEngineStatus, status)
    updateTray()
  })
  whisper.on('degraded', (message: string) => {
    log.warn({ message }, 'engine started in a degraded mode')
    send(IPC.onNotice, { level: 'warn', message })
  })
  whisper.on('fatal', (reason: string) => {
    log.error({ reason }, 'transcription engine failed')
    send(IPC.onNotice, { level: 'error', message: reason })
  })
}

function registerIpc(): void {
  ipcMain.on(IPC.sessionStart, () => startSession())
  ipcMain.on(IPC.sessionStop, () => void stopSession())

  ipcMain.on(IPC.captureStarted, () => sessions.captureStarted())
  ipcMain.on(IPC.captureFailed, (_e, reason: string) => sessions.captureFailed(reason))

  // Hot path: ~50 messages/second/channel while recording.
  ipcMain.on(IPC.captureFrame, (_e, channel: AudioChannel, buffer: ArrayBuffer) => {
    sessions.pushAudio(channel, new Int16Array(buffer))
  })

  // Levels arrive throttled from the capture host and fan out to every window
  // so the meter works wherever the user is looking.
  ipcMain.on(IPC.captureLevel, (_e, payload: LevelPayload) => {
    sessions.noteLevel(payload.rms)
    send(IPC.onLevel, payload)
  })

  ipcMain.on(IPC.mainOpen, () => showMain())
  ipcMain.on(IPC.mainMinimise, () => {
    getMainWindow()?.hide()
    showOverlay()
  })

  ipcMain.handle(IPC.settingsGet, () => ({
    ...settings().all(),
    engine: whisper.getStatus(),
    session: sessions.snapshot(),
  }))

  ipcMain.handle(IPC.settingsPatch, async (_e, patch: Partial<Settings>) => {
    const before = settings().all()
    // Store the server URL in a canonical form so "example.com/" and
    // "https://example.com" do not behave differently.
    if (patch.serverUrl !== undefined) patch.serverUrl = normaliseUrl(patch.serverUrl)
    const after = settings().patch(patch)

    if (patch.theme !== undefined) applyTheme()

    let hotkey: { ok: boolean; reason?: string } | undefined
    if (patch.hotkey !== undefined || patch.hotkeyMode !== undefined) hotkey = applyHotkey()

    const engineChanged =
      after.model !== before.model ||
      after.gpu !== before.gpu ||
      after.language !== before.language ||
      after.partials !== before.partials

    // Reloading the model mid-recording would lose the tail of the session,
    // so a change made while recording applies to the next one.
    if (engineChanged && !sessions.isRecording()) {
      await whisper.restartWith(whisperOptions())
    }
    updateTray()
    return { settings: after, hotkey }
  })

  ipcMain.handle(IPC.secretsGet, (): SecretsInfo => {
    const store = settings()
    return {
      hasToken: store.getApiKey() !== null,
      hint: store.apiKeyHint(),
      storageAvailable: store.encryptionAvailable(),
    }
  })

  ipcMain.handle(IPC.secretsSetToken, (_e, token: string): SecretsInfo => {
    const store = settings()
    const trimmed = token.trim()
    if (trimmed) store.setApiKey(trimmed)
    else store.clearApiKey()
    return {
      hasToken: store.getApiKey() !== null,
      hint: store.apiKeyHint(),
      storageAvailable: store.encryptionAvailable(),
    }
  })

  ipcMain.handle(IPC.secretsClearToken, (): SecretsInfo => {
    const store = settings()
    store.clearApiKey()
    return { hasToken: false, hint: null, storageAvailable: store.encryptionAvailable() }
  })

  // The token stays in main: the renderer asks for a test, never for the token.
  ipcMain.handle(IPC.connectionTest, async (_e, serverUrl?: string) => {
    const store = settings()
    return testConnection(serverUrl ?? store.get('serverUrl'), store.getApiKey())
  })

  ipcMain.on(IPC.settingsOpen, () => showSettings())
  ipcMain.on(IPC.settingsClose, () => getSettingsWindow()?.close())

  ipcMain.handle(IPC.transcriptGet, (_e, sessionId: string) => repo.transcriptText(sessionId))

  ipcMain.handle(IPC.copyTranscript, (_e, sessionId?: string) => {
    const id = sessionId ?? lastFinishedSessionId
    if (!id) return { copied: false, reason: 'there is no transcript to copy' }
    const text = repo.transcriptText(id)
    if (!text.trim()) return { copied: false, reason: 'this session has no transcript' }
    clipboard.writeText(text)
    return { copied: true, chars: text.length }
  })

  ipcMain.on(IPC.consentAcknowledge, () => {
    settings().patch({ consentAcknowledged: true })
    startSession()
  })

  ipcMain.on(IPC.overlayDismiss, () => hideOverlay())
}

function applyHotkey(): { ok: boolean; reason?: string } {
  const cfg = settings().all()
  const result = registerHotkey(cfg.hotkey, { onTrigger: toggleSession })
  if (!result.ok) {
    log.warn({ result }, 'recording hotkey unavailable')
    const win = getOverlay()
    win?.webContents.send(IPC.onNotice, {
      level: 'warn',
      message: `${result.accelerator} could not be registered: ${result.reason}. Use the tray menu to record.`,
    })
  }
  return { ok: result.ok, reason: result.reason }
}

/**
 * Drives Chromium's `prefers-color-scheme` in every window, so the renderers
 * need no theme plumbing of their own — they just honour the media query.
 */
function applyTheme(): void {
  nativeTheme.themeSource = settings().get('theme')
}

function toggleSession(): void {
  if (sessions.isRecording()) void stopSession()
  else startSession()
}

function startSession(): void {
  // Consent is asked before any audio device is opened, not after.
  if (!settings().get('consentAcknowledged')) {
    showOverlay()
    getOverlay()?.webContents.send(IPC.onNotice, { level: 'consent', message: '' })
    return
  }

  const result = sessions.start()
  showOverlay()

  if (!result.ok) {
    getOverlay()?.webContents.send(IPC.onNotice, { level: 'warn', message: result.reason })
    return
  }

  getOverlay()?.webContents.send(IPC.onCaptureCommand, {
    action: 'start',
    channels: result.channels,
  } satisfies CaptureCommand)
}

async function stopSession(): Promise<void> {
  const result = await sessions.stop()
  if (!result) return

  lastFinishedSessionId = result.empty ? null : result.sessionId

  if (result.empty) {
    getOverlay()?.webContents.send(IPC.onNotice, {
      level: 'info',
      message: 'No speech was detected, so nothing was saved.',
    })
    return
  }

  if (settings().get('autoCopy')) {
    const text = repo.transcriptText(result.sessionId)
    if (text.trim()) {
      clipboard.writeText(text)
      getOverlay()?.webContents.send(IPC.onNotice, {
        level: 'info',
        message: 'Transcript copied to the clipboard.',
      })
    }
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('TeamBridge Assist')
  tray.on('click', () => showOverlay())
  updateTray()
}

function updateTray(): void {
  if (!tray) return
  const recording = sessions.isRecording()
  const cfg = settings().all()

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: recording ? 'Stop recording' : 'Start recording',
        accelerator: cfg.hotkey,
        click: () => toggleSession(),
      },
      { type: 'separator' },
      { label: 'Open TeamBridge Assist', click: () => showMain() },
      { label: 'Show overlay', click: () => showOverlay() },
      { label: 'Settings…', click: () => showSettings() },
      {
        label: 'Copy last transcript',
        enabled: lastFinishedSessionId !== null,
        click: () => {
          if (!lastFinishedSessionId) return
          clipboard.writeText(repo.transcriptText(lastFinishedSessionId))
        },
      },
      { type: 'separator' },
      {
        label: 'Source',
        submenu: (['system', 'microphone', 'both'] as AudioSource[]).map((source) => ({
          label: SOURCE_LABELS[source],
          type: 'radio' as const,
          checked: cfg.audioSource === source,
          enabled: !recording,
          click: () => {
            settings().patch({ audioSource: source })
            updateTray()
            send(IPC.onSessionState, sessions.snapshot())
          },
        })),
      },
      {
        label: 'Copy automatically when a recording ends',
        type: 'checkbox',
        checked: cfg.autoCopy,
        click: (item) => {
          settings().patch({ autoCopy: item.checked })
          updateTray()
        },
      },
      { type: 'separator' },
      {
        label: 'Model',
        submenu: WHISPER_MODELS.map((model) => ({
          label: MODEL_LABELS[model],
          type: 'radio' as const,
          checked: cfg.model === model,
          // Changing models mid-recording would lose the tail of the session,
          // so the switch is deferred until the current one finishes.
          enabled: !recording,
          click: () => void selectModel(model),
        })),
      },
      {
        label: `Engine: ${describeEngine()}`,
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Quit', click: () => void shutdown() },
    ]),
  )

  tray.setToolTip(recording ? 'TeamBridge Assist — recording' : 'TeamBridge Assist')
}

async function selectModel(model: WhisperModel): Promise<void> {
  if (settings().get('model') === model) return
  settings().patch({ model })
  updateTray()

  // A model that is not cached yet downloads on load, which can take minutes
  // with no other feedback — say so rather than looking hung.
  getOverlay()?.webContents.send(IPC.onNotice, {
    level: 'info',
    message: `Loading ${model}. The first use of a model downloads it, which can take a few minutes.`,
  })

  await whisper.restartWith(whisperOptions())
  updateTray()
}

function describeEngine(): string {
  const s = whisper.getStatus()
  switch (s.state) {
    case 'ready':
      return `${s.model} on ${s.device}`
    case 'loading':
      return 'loading…'
    case 'failed':
      return 'unavailable'
    default:
      return 'stopped'
  }
}

async function shutdown(): Promise<void> {
  log.info('shutting down')
  if (sessions.isRecording()) await stopSession()
  unregisterAll()
  await whisper.stop()
  closeDatabase()
  tray?.destroy()
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  app.quit()
}

app.on('before-quit', () => {
  unregisterAll()
})

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception in main')
  dialog.showErrorBox('TeamBridge Assist', `Unexpected error:\n\n${err.message}`)
})
