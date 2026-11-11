import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { child } from './logger'
import { win32 } from './win32'

const log = child('live-captions')

export type LaunchResult = { ok: true } | { ok: false; reason: string }

/** Windows 11 22H2 and later ship Live Captions as a System32 executable. */
function executable(): string {
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'LiveCaptions.exe')
}

/**
 * Opens Windows Live Captions.
 *
 * Detached, so it outlives this app and is the user's to close. Launching it
 * while it is already open just brings the existing window forward.
 */
export function openLiveCaptions(): Promise<LaunchResult> {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'Live Captions is a Windows 11 feature.' })
  }

  const exe = executable()
  if (!existsSync(exe)) {
    return Promise.resolve({
      ok: false,
      reason: 'Live Captions was not found. It needs Windows 11 version 22H2 or later.',
    })
  }

  return new Promise((resolve) => {
    const proc = spawn(exe, [], { detached: true, stdio: 'ignore' })
    proc.once('error', (err) => {
      log.error({ err }, 'could not open Live Captions')
      resolve({ ok: false, reason: `Live Captions could not be opened: ${err.message}` })
    })
    proc.once('spawn', () => {
      proc.unref()
      log.info('opened Live Captions')
      resolve({ ok: true })
    })
  })
}

export type ReadResult = { ok: true; text: string } | { ok: false; reason: string }

/** The text block Live Captions draws its captions into. */
const CAPTIONS_ELEMENT = 'CaptionsTextBlock'

/**
 * Reads what the Live Captions window is showing, through UI Automation.
 *
 * Live Captions keeps a rolling window of recent speech, so this is the last
 * few sentences rather than the whole conversation.
 */
export function readLiveCaptions(): ReadResult {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Live Captions is a Windows 11 feature.' }
  }
  try {
    const w = win32()
    const hwnd = w.findAppWindow((image) => image.toLowerCase().endsWith('\\livecaptions.exe'))
    if (hwnd === null) return { ok: false, reason: 'Live Captions is not open.' }

    const text = w.readElementName(hwnd, CAPTIONS_ELEMENT)
    if (text === null) return { ok: false, reason: 'The Live Captions text could not be found.' }
    return { ok: true, text }
  } catch (err) {
    log.error({ err }, 'could not read Live Captions')
    return { ok: false, reason: 'Live Captions could not be read.' }
  }
}
