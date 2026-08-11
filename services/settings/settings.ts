import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { child } from '../logger'

const log = child('settings')

/**
 * Preferences live in a plain JSON file. Secrets never go in it — API keys are
 * encrypted with the OS credential store and written separately, so a leaked
 * settings file leaks preferences and nothing else.
 */
class SettingsStore {
  private file = join(app.getPath('userData'), 'settings.json')
  private secretFile = join(app.getPath('userData'), 'credentials.bin')
  private cache: Settings

  constructor() {
    this.cache = this.load()
  }

  private load(): Settings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      // Merge over defaults so a settings file written by an older version
      // gains new keys instead of leaving them undefined.
      return { ...DEFAULT_SETTINGS, ...parsed }
    } catch (err) {
      // Preserve the unreadable file rather than overwriting it — it is the
      // only copy of whatever the user had configured.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try {
        renameSync(this.file, backup)
        log.error({ err, backup }, 'settings file unreadable, backed up and reset to defaults')
      } catch (renameErr) {
        log.error({ err: renameErr }, 'could not back up corrupt settings file')
      }
      return { ...DEFAULT_SETTINGS }
    }
  }

  all(): Settings {
    return { ...this.cache }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.cache[key]
  }

  patch(patch: Partial<Settings>): Settings {
    this.cache = { ...this.cache, ...patch }
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2), 'utf8')
    return this.all()
  }

  /** Returns null when no key is stored or when decryption is unavailable. */
  getApiKey(): string | null {
    if (!existsSync(this.secretFile)) return null
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('OS encryption unavailable; refusing to read stored credential')
      return null
    }
    try {
      return safeStorage.decryptString(readFileSync(this.secretFile))
    } catch (err) {
      log.error({ err }, 'stored credential could not be decrypted')
      return null
    }
  }

  setApiKey(key: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption is unavailable; refusing to store the key in plaintext')
    }
    writeFileSync(this.secretFile, safeStorage.encryptString(key))
  }

  /** Last 4 characters only — enough to recognise, useless if leaked. */
  apiKeyHint(): string | null {
    const key = this.getApiKey()
    return key ? key.slice(-4) : null
  }
}

let instance: SettingsStore | null = null

export function settings(): SettingsStore {
  if (!instance) instance = new SettingsStore()
  return instance
}
