import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { settings } from '@services/settings/settings'
import { child } from '@services/logger'

const log = child('windows')

const OVERLAY_WIDTH = 420
const OVERLAY_HEIGHT = 200

let overlay: BrowserWindow | null = null

export function getOverlay(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() ? overlay : null
}

export function createOverlay(): BrowserWindow {
  const existing = getOverlay()
  if (existing) return existing

  const win = new BrowserWindow({
    ...initialBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // The overlay must not become the focused window when it appears — the
    // user is typing in a call, not in our app.
    focusable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the preload bundles shared types; no Node is exposed
    },
  })

  // Float above full-screen apps (a meeting in presentation mode, typically).
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadOverlay(win)

  win.on('moved', () => persistBounds(win))
  win.on('resized', () => persistBounds(win))
  win.on('closed', () => {
    overlay = null
  })

  overlay = win
  return win
}

/**
 * Loads the overlay, retrying on failure.
 *
 * In development, Electron can reach `whenReady` before the Vite dev server is
 * accepting connections. Without a retry that race leaves a permanently blank
 * overlay that only a restart fixes, so keep trying for a few seconds before
 * giving up.
 */
function loadOverlay(win: BrowserWindow, attempt = 0): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const load = devUrl
    ? win.loadURL(devUrl)
    : win.loadFile(join(__dirname, '../renderer/index.html'))

  load.catch((err: Error) => {
    if (win.isDestroyed()) return
    if (attempt >= 40) {
      log.error({ err, devUrl }, 'overlay failed to load; giving up')
      return
    }
    if (attempt === 0) log.warn({ err: err.message, devUrl }, 'overlay load failed, retrying')
    setTimeout(() => loadOverlay(win, attempt + 1), 250)
  })
}

/** Show without taking focus from whatever the user is actually doing. */
export function showOverlay(): void {
  const win = getOverlay() ?? createOverlay()
  if (!win.isVisible()) win.showInactive()
}

export function hideOverlay(): void {
  getOverlay()?.hide()
}

function persistBounds(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  settings().patch({ overlayBounds: win.getBounds() })
}

/**
 * Restore the last position, but only if it still lands on an attached
 * display — otherwise the overlay reappears off-screen after a monitor is
 * unplugged and looks like a crash.
 */
function initialBounds() {
  const saved = settings().get('overlayBounds')
  const size = { width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }

  if (saved) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return (
        saved.x + saved.width > a.x &&
        saved.x < a.x + a.width &&
        saved.y + saved.height > a.y &&
        saved.y < a.y + a.height
      )
    })
    if (visible) return { ...size, width: saved.width, height: saved.height, x: saved.x, y: saved.y }
  }

  const area = screen.getPrimaryDisplay().workArea
  return {
    ...size,
    x: area.x + area.width - size.width - 24,
    y: area.y + area.height - size.height - 24,
  }
}
