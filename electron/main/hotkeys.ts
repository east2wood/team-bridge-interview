import { globalShortcut } from 'electron'
import { child } from '@services/logger'

const log = child('hotkeys')

export interface HotkeyRegistration {
  ok: boolean
  accelerator: string
  reason?: string
}

/** What each named hotkey is bound to right now, so it can be replaced. */
const registered = new Map<string, string>()
const lastTriggerAt = new Map<string, number>()

/**
 * Windows key auto-repeat fires globalShortcut continuously while the
 * combination is held. Anything faster than a deliberate second press is
 * repeat, not intent.
 */
const REPEAT_GUARD_MS = 600

/**
 * Binds a named hotkey to an accelerator, replacing whatever that name was
 * bound to before. Names keep the app's hotkeys independent: changing one
 * never unregisters another.
 */
export function registerHotkey(
  name: string,
  accelerator: string,
  onTrigger: () => void,
): HotkeyRegistration {
  unregisterHotkey(name)

  if (!/\+/.test(accelerator)) {
    return { ok: false, accelerator, reason: 'a hotkey needs at least one modifier' }
  }
  for (const [other, bound] of registered) {
    if (bound === accelerator) {
      return { ok: false, accelerator, reason: `${accelerator} is already used for ${other}` }
    }
  }

  const fire = () => {
    const now = Date.now()
    if (now - (lastTriggerAt.get(name) ?? 0) < REPEAT_GUARD_MS) {
      log.debug({ name }, 'ignoring hotkey auto-repeat')
      return
    }
    lastTriggerAt.set(name, now)
    onTrigger()
  }

  let ok = false
  try {
    ok = globalShortcut.register(accelerator, fire)
  } catch (err) {
    return { ok: false, accelerator, reason: (err as Error).message }
  }

  if (!ok) {
    log.warn({ name, accelerator }, 'hotkey registration refused')
    return {
      ok: false,
      accelerator,
      reason: `${accelerator} is already in use by another application`,
    }
  }

  registered.set(name, accelerator)
  log.info({ name, accelerator }, 'hotkey registered')
  return { ok: true, accelerator }
}

export function unregisterHotkey(name: string): void {
  const accelerator = registered.get(name)
  if (accelerator) {
    globalShortcut.unregister(accelerator)
    registered.delete(name)
  }
}

export function unregisterAll(): void {
  globalShortcut.unregisterAll()
  registered.clear()
}
