import { execFile, spawn } from 'node:child_process'
import { clipboard } from 'electron'
import { child } from './logger'
import { VK, win32 } from './win32'

const log = child('chatgpt')

/** The ChatGPT desktop app from the Microsoft Store. */
const PACKAGE = 'OpenAI.ChatGPT-Desktop'
const APP_ID = 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT'

/** Where Windows registers the Store packages installed for this user. */
const PACKAGE_REGISTRY =
  'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages'

const WINDOW_TIMEOUT_MS = 20_000
/** A fresh start shows the window before the message box is ready for input. */
const COLD_START_SETTLE_MS = 2500
const WARM_SETTLE_MS = 600
const FOCUS_ATTEMPTS = 10

export type PasteResult =
  | { ok: true }
  | { ok: false; reason: 'not-installed' | 'no-window' | 'not-focused' | 'failed'; message: string }

/**
 * Launches (or raises) ChatGPT and pastes the text into its message box.
 *
 * The app has no way to be handed text, so this goes through the clipboard and
 * the keyboard: copy, bring ChatGPT to the front, Ctrl+V — all from this
 * process, which matters for the focus step: Windows lets the foreground app
 * hand focus on, and the user has just clicked Start Listening here.
 *
 * Enter is pressed only when asked to (`submit`): a question is sent, but the
 * briefing is left for the user to read and send. Keys are only sent after
 * checking that ChatGPT really is the foreground window — before the paste and
 * again before Enter — so a window that steals focus never receives the text.
 * The text stays on the clipboard either way, so a failure leaves the user one
 * paste away.
 */
export async function pasteIntoChatGPT(
  text: string,
  { submit = false }: { submit?: boolean } = {},
): Promise<PasteResult> {
  clipboard.writeText(text)

  if (process.platform !== 'win32') {
    return { ok: false, reason: 'not-installed', message: 'The ChatGPT app is only driven on Windows.' }
  }

  try {
    if (!(await isInstalled())) {
      return { ok: false, reason: 'not-installed', message: 'The ChatGPT desktop app is not installed.' }
    }

    const w = win32()
    const findChatWindow = () => w.findAppWindow((image) => image.includes(PACKAGE))
    // Launched only when it has no window. Launching an app that is already
    // running hands it a second activation, which ChatGPT answers by reloading
    // its window — a moment after the paste, wiping out what was just sent.
    // An open window is only brought to the front.
    const open = findChatWindow()
    if (open === null) {
      spawn('explorer.exe', [`shell:AppsFolder\\${APP_ID}`], { detached: true, stdio: 'ignore' }).unref()
    }

    const hwnd = open ?? (await waitFor(findChatWindow, WINDOW_TIMEOUT_MS))
    if (hwnd === null) {
      return { ok: false, reason: 'no-window', message: 'ChatGPT did not open in time.' }
    }
    if (open === null) await sleep(COLD_START_SETTLE_MS)

    let focused = false
    for (let attempt = 0; attempt < FOCUS_ATTEMPTS && !focused; attempt++) {
      focused = w.bringToFront(hwnd)
      if (!focused) await sleep(300)
    }
    if (!focused) {
      return { ok: false, reason: 'not-focused', message: 'ChatGPT could not be brought to the front.' }
    }
    // Activation puts the cursor back in the message box; give it a moment.
    await sleep(WARM_SETTLE_MS)

    // Checked again right before the keys: focus can move during the waits.
    if (!w.isInFront(hwnd)) {
      return { ok: false, reason: 'not-focused', message: 'ChatGPT lost focus before the paste.' }
    }
    w.pressChord(VK.CONTROL, VK.V)

    if (submit) {
      await sleep(400)
      if (!w.isInFront(hwnd)) {
        return { ok: false, reason: 'not-focused', message: 'ChatGPT lost focus before the message was sent.' }
      }
      w.pressChord(VK.RETURN)
    }

    log.info({ submit }, 'pasted into ChatGPT')
    return { ok: true }
  } catch (err) {
    log.error({ err }, 'could not drive ChatGPT')
    return { ok: false, reason: 'failed', message: 'ChatGPT could not be driven.' }
  }
}

function isInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', PACKAGE_REGISTRY, '/f', PACKAGE, '/k'], { windowsHide: true }, (err) =>
      resolve(!err),
    )
  })
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = probe()
    if (found !== null) return found
    await sleep(250)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
