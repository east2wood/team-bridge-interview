// First, before anything reads the data folder: a test profile moves it.
import { profile } from './profile'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  Tray,
} from 'electron'
import type {
  CaptionTarget,
  CaptionsView,
  HotkeyResult,
  HotkeySetting,
  SecretsInfo,
  Settings,
} from '@shared/types'
import { IPC } from '@shared/channels'
import type { Recruitment } from '@shared/api-types'
import { child } from '@services/logger'
import { settings } from '@services/settings/settings'
import { migrateUserData } from '@services/migrate-user-data'
import { openLiveCaptions, readLiveCaptions } from '@services/live-captions'
import { pasteIntoChatGPT } from '@services/chatgpt'
import { TeamBridgeClient } from '@services/teambridge/teambridge-client'
import { MessagePoller } from '@services/teambridge/message-poller'
import { RealtimeClient } from '@services/teambridge/realtime-client'
import { InterviewSession } from './interview-session'
import { buildBriefing } from './briefing'
import { CaptionCapture } from './caption-capture'
import { registerHotkey, unregisterAll } from './hotkeys'
import { testConnection, normaliseUrl } from '@services/teambridge/connection'
import {
  bringMainToFront,
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
let poller: MessagePoller
let realtime: RealtimeClient
let live: InterviewSession
const captions = new CaptionCapture()

// Before anything reads settings or Chromium starts: the first run after the
// rename from TeamBridge Assist brings the old settings and token across. A
// test profile starts empty instead: it is there to be somebody else.
if (!profile) migrateUserData()

// TeamBridge runs on the local network behind Caddy, whose certificates come
// from its own authority, which other machines don't trust. Certificate errors
// are ignored so they can connect, as the candidate app does. This covers what
// goes through Chromium — every API request and the connection test; the live
// socket goes through Node instead and is told the same (realtime-client.ts).
app.commandLine.appendSwitch('ignore-certificate-errors')

// One instance only: two processes fighting over the same hotkey and the same
// interview run is a support ticket waiting to happen. The lock is held per
// data folder, so a test profile runs beside the usual copy.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMain())
  void app.whenReady().then(bootstrap)
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.teambridge.interview')

  poller = new MessagePoller(teamBridgeClient)
  realtime = new RealtimeClient(() => {
    const store = settings()
    const url = store.get('serverUrl')
    const token = store.getApiKey()
    return url && token ? { baseUrl: url, token } : null
  })
  live = new InterviewSession(poller, realtime, teamBridgeClient)

  wireEvents()
  registerIpc()
  applyTheme()
  createOverlay() // created once, only ever hidden
  showMain()
  createTray()
  bindHotkey('hotkey')
  bindHotkey('captureHotkey')

  app.on('window-all-closed', () => {
    // The overlay closing is not a reason to quit — we live in the tray.
  })
}

/**
 * A client for the configured server, or null when it is not set up. Built per
 * call so a settings change takes effect without a restart.
 */
function teamBridgeClient(): TeamBridgeClient | null {
  const store = settings()
  const url = store.get('serverUrl')
  const token = store.getApiKey()
  if (!url || !token) return null
  return new TeamBridgeClient(url, token)
}

/** Broadcast to every open window: overlay, Live Interview, and settings. */
function send(channel: string, payload?: unknown): void {
  for (const win of [getOverlay(), getMainWindow(), getSettingsWindow()]) {
    if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function wireEvents(): void {
  live.on('state', (state) => {
    send(IPC.onLiveState, state)
    updateTray()
    watchCaptions(state.status === 'recording')
  })
  live.on('notice', (notice) => send(IPC.onNotice, notice))
  live.on('remote-captions', (text: string | null) => send(IPC.onWatchedCaptions, text))
  live.on('incoming-message', (message: { sender: { name: string | null } }) => {
    // Worth a nudge only when the window is not being looked at; in view it
    // is already in the timeline.
    const win = getMainWindow()
    if (win && !win.isFocused() && Notification.isSupported()) {
      new Notification({
        title: 'TeamBridge Interview',
        body: `New message from ${message.sender.name ?? 'a colleague'}`,
      }).show()
    }
  })
}

function registerIpc(): void {
  ipcMain.handle(IPC.interviewsList, async () => {
    const client = teamBridgeClient()
    if (!client) return { ok: false, reason: 'not_configured', interviews: [] }
    try {
      return { ok: true, interviews: await client.interviews() }
    } catch (err) {
      const error = err as Error & { code?: string }
      log.warn({ err: error.message }, 'could not list interviews')
      return { ok: false, reason: error.code ?? 'error', message: error.message, interviews: [] }
    }
  })

  ipcMain.handle(IPC.liveGet, () => live.snapshot())
  ipcMain.on(IPC.liveSelect, (_e, interview) => live.selectInterview(interview))
  ipcMain.handle(IPC.liveStart, async () => {
    const result = await live.startListening()
    if (result.ok) {
      // Captions already showing belong to before this run; the first capture
      // starts from here.
      const showing = readLiveCaptions()
      captions.reset(showing.ok ? showing.text : '')
    }
    return result
  })
  ipcMain.handle(IPC.liveCaptionsOpen, () => launchLiveCaptions())
  ipcMain.handle(IPC.chatgptOpen, () => briefAssistant())
  ipcMain.handle(IPC.recruitmentGet, (_e, id: number) => loadRecruitment(id))
  ipcMain.handle(IPC.liveStop, () => live.stopListening())
  ipcMain.handle(IPC.liveJoin, () => live.joinListening())
  ipcMain.handle(IPC.liveLeave, () => live.leaveListening())
  ipcMain.handle(IPC.liveClose, () => live.close())
  // From the window's own buttons: after Ask GPT, come back to the window.
  ipcMain.handle(IPC.captionsSend, (_e, to: CaptionTarget) => sendCaptions(to, { returnFocus: true }))
  ipcMain.handle(IPC.chatSend, async (_e, text: string) => {
    const result = await live.sendMessage(text)
    if (!result.ok && result.reason) send(IPC.onNotice, { level: 'error', message: result.reason })
    return result
  })
  ipcMain.handle(IPC.chatRefresh, () => live.refreshMessages())
  ipcMain.handle(IPC.captionsGet, () => captionsView)
  ipcMain.handle(IPC.watchedCaptionsGet, () => live.watchedCaptions())

  ipcMain.on(IPC.mainOpen, () => showMain())
  ipcMain.on(IPC.mainMinimise, () => {
    getMainWindow()?.hide()
    showOverlay()
  })

  ipcMain.handle(IPC.settingsGet, () => settings().all())

  ipcMain.handle(IPC.settingsPatch, async (_e, patch: Partial<Settings>) => {
    // Store the server URL in a canonical form so "example.com/" and
    // "https://example.com" do not behave differently.
    if (patch.serverUrl !== undefined) patch.serverUrl = normaliseUrl(patch.serverUrl)
    const before = settings().all()
    let after = settings().patch(patch)

    if (patch.theme !== undefined) applyTheme()

    const hotkeys: Partial<Record<HotkeySetting, HotkeyResult>> = {}
    for (const name of HOTKEY_SETTINGS) {
      if (patch[name] === undefined) continue
      const result = bindHotkey(name)
      hotkeys[name] = result
      // A combination that could not be registered is not kept: the old one
      // still works, and saving the new one would leave neither.
      if (!result.ok) {
        after = settings().patch({ [name]: before[name] })
        bindHotkey(name)
      }
    }
    updateTray()
    return { settings: after, hotkeys }
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

  ipcMain.on(IPC.overlayDismiss, () => hideOverlay())
}

const HOTKEY_SETTINGS: HotkeySetting[] = ['hotkey', 'captureHotkey']

const HOTKEY_ACTIONS: Record<HotkeySetting, { label: string; run: () => void }> = {
  hotkey: { label: 'opening Live Captions', run: () => void launchLiveCaptions() },
  captureHotkey: { label: 'Ask GPT', run: () => void sendCaptions('chatgpt') },
}

function bindHotkey(name: HotkeySetting): HotkeyResult {
  const action = HOTKEY_ACTIONS[name]
  const result = registerHotkey(action.label, settings().get(name), action.run)
  if (!result.ok) {
    log.warn({ name, result }, 'hotkey unavailable')
    send(IPC.onNotice, {
      level: 'warn',
      message: `${result.accelerator} could not be registered for ${action.label}: ${result.reason}. The tray menu does the same.`,
    })
  }
  return { ok: result.ok, reason: result.reason }
}

/**
 * How often Live Captions is read while listening. This is most of the delay
 * between a word appearing for the interviewer and for an assistant — the
 * server passes a change on in tens of milliseconds — so it is kept short. A
 * read is a few milliseconds of UI Automation, and nothing is sent unless the
 * text changed.
 */
const CAPTIONS_POLL_MS = 250

let captionsView: CaptionsView | null = null
let captionsTimer: NodeJS.Timeout | null = null

/**
 * Reads Live Captions four times a second while listening, for the panel
 * beside the interview and for everybody watching. Only a change is sent on.
 */
function watchCaptions(listening: boolean): void {
  if (listening && !captionsTimer) {
    captionsTimer = setInterval(refreshCaptions, CAPTIONS_POLL_MS)
    refreshCaptions()
  } else if (!listening && captionsTimer) {
    clearInterval(captionsTimer)
    captionsTimer = null
    captionsView = null
    send(IPC.onCaptions, null)
  }
}

function refreshCaptions(): void {
  const showing = readLiveCaptions()
  // Before the change check: an unchanged caption still has to be sent again
  // now and then, or the server forgets it for anybody joining later.
  if (showing.ok) live.shareCaptions(showing.text)
  const next: CaptionsView = showing.ok
    ? { status: 'ok', ...captions.view(showing.text) }
    : { status: 'unavailable', reason: showing.reason, text: '', collectedFrom: 0, completeUntil: 0 }

  const before = captionsView
  if (
    before &&
    before.status === next.status &&
    before.reason === next.reason &&
    before.text === next.text &&
    before.collectedFrom === next.collectedFrom &&
    before.completeUntil === next.completeUntil
  ) {
    return
  }
  captionsView = next
  send(IPC.onCaptions, next)
}

/**
 * Sends what Live Captions has shown since the last ask, up to the last
 * complete sentence — so pressing as the interviewer finishes sends their
 * question and not the start of whatever they say next — to the support chat
 * (Send to assistant) or to ChatGPT (Ask GPT).
 */
/**
 * After Ask GPT from the window's button, the interview window comes back to
 * the front once ChatGPT has the question. Not from the hotkey or the tray:
 * pressed from another window — the meeting, say — focus is left where the
 * user will want it. Not after a failure either: ChatGPT is then where the
 * question still needs pasting.
 */
const RETURN_AFTER_SEND_MS = 500

async function sendCaptions(
  to: CaptionTarget,
  { returnFocus = false }: { returnFocus?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  const fail = (level: 'info' | 'warn' | 'error', reason: string) => {
    send(IPC.onNotice, { level, message: reason })
    return { ok: false, reason }
  }

  const state = live.snapshot()
  if (!state.interview || state.status !== 'recording') {
    return fail('warn', 'Start listening on an interview before sending captions.')
  }

  const showing = readLiveCaptions()
  if (!showing.ok) return fail('error', showing.reason)

  const question = captions.take(showing.text, to)
  refreshCaptions()
  if (!question) {
    return fail('info', `No completed sentence in Live Captions since the last send to ${to === 'chat' ? 'the assistant' : 'ChatGPT'}.`)
  }
  log.info({ to, chars: question.length }, 'sending collected captions')

  if (to === 'chat') {
    const result = await live.sendMessage(question, 'caption')
    return result.ok ? result : fail('error', result.reason ?? 'The message was not sent.')
  }

  const result = await pasteIntoChatGPT(question, { submit: true })
  if (!result.ok) return fail('warn', `${result.message} The question is on the clipboard — paste it into ChatGPT.`)
  if (returnFocus) {
    // A moment for ChatGPT to take the Enter before it loses the foreground:
    // keys still queued for it when focus moves can go to the window that
    // gets it instead.
    await new Promise((resolve) => setTimeout(resolve, RETURN_AFTER_SEND_MS))
    if (!bringMainToFront()) log.info('the interview window could not be brought back to the front')
  }
  return { ok: true }
}

/**
 * Drives Chromium's `prefers-color-scheme` in every window, so the renderers
 * need no theme plumbing of their own — they just honour the media query.
 */
function applyTheme(): void {
  nativeTheme.themeSource = settings().get('theme')
}

// Read once and kept: a recruitment does not change during the round it is
// being read for, and the panel is opened and closed repeatedly.
const recruitments = new Map<number, Recruitment>()

async function loadRecruitment(id: number): Promise<Recruitment> {
  const cached = recruitments.get(id)
  if (cached) return cached

  const client = teamBridgeClient()
  if (!client) throw new Error('No TeamBridge server is configured. Add it in Settings.')

  const recruitment = await client.recruitment(id)
  recruitments.set(id, recruitment)
  return recruitment
}

/**
 * Opens ChatGPT and hands it the round: candidate, job description, and
 * resume. A round with no recruitment, or one that cannot be read, still gets
 * what the interview row itself says rather than nothing.
 */
async function briefAssistant(): Promise<{ ok: boolean; reason?: string }> {
  const interview = live.snapshot().interview
  if (!interview) return { ok: false, reason: 'Open an interview first.' }

  let recruitment: Recruitment | null = null
  if (interview.recruitmentId !== null) {
    try {
      recruitment = await loadRecruitment(interview.recruitmentId)
    } catch (err) {
      log.warn({ err }, 'could not read the recruitment for the ChatGPT briefing')
    }
  }

  const result = await pasteIntoChatGPT(buildBriefing(interview, recruitment))
  send(
    IPC.onNotice,
    result.ok
      ? { level: 'info', message: 'Pasted the candidate, job description and resume into ChatGPT. Review it and press Enter to send.' }
      : {
          level: 'warn',
          message: `${result.message} The briefing is on the clipboard — paste it into ChatGPT.`,
        },
  )
  return result.ok ? { ok: true } : { ok: false, reason: result.message }
}

/** Opens Live Captions on its own, outside an interview run, and says why if it cannot. */
async function launchLiveCaptions(): Promise<{ ok: boolean; reason?: string }> {
  const result = await openLiveCaptions()
  if (!result.ok) send(IPC.onNotice, { level: 'error', message: result.reason })
  return result
}

function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('TeamBridge Interview')
  tray.on('click', () => showOverlay())
  updateTray()
}

function updateTray(): void {
  if (!tray) return
  const cfg = settings().all()
  const listening = live.snapshot().status === 'recording'

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Live Captions',
        accelerator: cfg.hotkey,
        click: () => void launchLiveCaptions(),
      },
      {
        label: 'Ask GPT with the collected captions',
        accelerator: cfg.captureHotkey,
        enabled: listening,
        click: () => void sendCaptions('chatgpt'),
      },
      { type: 'separator' },
      { label: 'Open TeamBridge Interview', click: () => showMain() },
      { label: 'Show overlay', click: () => showOverlay() },
      { label: 'Settings…', click: () => showSettings() },
      { type: 'separator' },
      { label: 'Quit', click: () => void shutdown() },
    ]),
  )

  tray.setToolTip(listening ? 'TeamBridge Interview — listening' : 'TeamBridge Interview')
}

async function shutdown(): Promise<void> {
  log.info('shutting down')
  await live.stopListening()
  unregisterAll()
  tray?.destroy()
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  app.quit()
}

app.on('before-quit', () => {
  unregisterAll()
})

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception in main')
  dialog.showErrorBox('TeamBridge Interview', `Unexpected error:\n\n${err.message}`)
})
