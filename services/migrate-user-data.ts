import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Where the app kept its data before it was renamed from TeamBridge Assist:
 * by package name in development, by product name when installed.
 */
const PREVIOUS_FOLDERS = ['teambridge-assist', 'TeamBridge Assist']

/**
 * What carries over. The token in credentials.bin is encrypted with a key that
 * Chromium keeps in `Local State`, so the two only work together: copying the
 * token alone would leave one that cannot be decrypted.
 */
const CARRIED = ['settings.json', 'credentials.bin', 'Local State']

/**
 * Brings the server address, API token and preferences over from the folder
 * the app used before it was renamed, the first time the new one runs.
 *
 * Must run before the app is ready: Chromium creates its own `Local State`
 * during startup, and once it has, the old token's key can no longer be used.
 * Nothing is moved or deleted — the old folder is left as it was.
 */
export function migrateUserData(): void {
  const target = app.getPath('userData')
  if (existsSync(join(target, 'settings.json'))) return

  const appData = app.getPath('appData')
  for (const folder of PREVIOUS_FOLDERS) {
    const source = join(appData, folder)
    if (source === target || !existsSync(join(source, 'settings.json'))) continue

    try {
      mkdirSync(target, { recursive: true })
      for (const file of CARRIED) {
        const from = join(source, file)
        const to = join(target, file)
        // Never over anything already there: a `Local State` the new app made
        // holds its own key, and replacing it would orphan whatever used it.
        if (existsSync(from) && !existsSync(to)) copyFileSync(from, to)
      }
    } catch (err) {
      // The worst outcome is the first-run state: settings to fill in again.
      console.error('could not carry settings over from', source, err)
    }
    return
  }
}
