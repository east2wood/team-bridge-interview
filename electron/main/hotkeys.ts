import { globalShortcut } from 'electron'
import { child } from '@services/logger'

const log = child('hotkeys')

export interface HotkeyHandlers {
  onTrigger: () => void
}

export interface HotkeyRegistration {
  ok: boolean
  accelerator: string
  reason?: string
}

let registered: string | null = null
let lastTriggerAt = 0

/**
 * Windows key auto-repeat fires globalShortcut continuously while the
 * combination is held, which toggles recording many times a second. Anything
 * faster than a deliberate second press is repeat, not intent.
 */
const REPEAT_GUARD_MS = 600

/**
 * Registers the recording accelerator.
 *
 * Only toggle mode is wired up: Electron's globalShortcut fires on key-down
 * with no key-up event, so push-to-talk needs a native low-level keyboard
 * hook (`native/global_hotkey.cpp`) that does not exist yet. Selecting
 * push-to-talk in settings falls back to toggle rather than silently doing
 * nothing.
 */
export function registerHotkey(accelerator: string, handlers: HotkeyHandlers): HotkeyRegistration {
  unregisterHotkey()

  if (!/\+/.test(accelerator)) {
    return { ok: false, accelerator, reason: 'a hotkey needs at least one modifier' }
  }

  const onTrigger = () => {
    const now = Date.now()
    if (now - lastTriggerAt < REPEAT_GUARD_MS) {
      log.debug({ sinceLast: now - lastTriggerAt }, 'ignoring hotkey auto-repeat')
      return
    }
    lastTriggerAt = now
    handlers.onTrigger()
  }

  let ok = false
  try {
    ok = globalShortcut.register(accelerator, onTrigger)
  } catch (err) {
    return { ok: false, accelerator, reason: (err as Error).message }
  }

  if (!ok) {
    log.warn({ accelerator }, 'hotkey registration refused')
    return {
      ok: false,
      accelerator,
      reason: `${accelerator} is already in use by another application`,
    }
  }

  registered = accelerator
  log.info({ accelerator }, 'hotkey registered')
  return { ok: true, accelerator }
}

export function unregisterHotkey(): void {
  if (registered) {
    globalShortcut.unregister(registered)
    registered = null
  }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  registered = null
}
