/** Types shared across main, preload, and renderer. No runtime imports here. */

/** Who the configured token belongs to, as reported by the server. */
export interface Identity {
  id: number | string
  name: string
  email: string
  team: { id: number | string; name: string }
}

/** Result of probing the configured TeamBridge server. */
export interface ConnectionTestResult {
  ok: boolean
  /** HTTP status, when a response was received at all. */
  status?: number
  message: string
  latencyMs?: number
  /** True when the token would travel over plain http. */
  insecure?: boolean
  /** Present on success: naming the holder proves the token, not just the host. */
  identity?: Identity
}

/** What the renderer is allowed to know about stored secrets. */
export interface SecretsInfo {
  hasToken: boolean
  /** Last 4 characters only — enough to recognise, useless if leaked. */
  hint: string | null
  /** False when the OS credential store is unavailable and tokens cannot be saved. */
  storageAvailable: boolean
}

export interface Settings {
  /** Base URL of the TeamBridge server, without a trailing slash. */
  serverUrl: string
  /** Opens Live Captions. */
  hotkey: string
  /** Ask GPT: sends the Live Captions collected since the last ask to ChatGPT. */
  captureHotkey: string
  theme: 'system' | 'dark' | 'light'
  overlayBounds: { x: number; y: number; width: number; height: number } | null
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  hotkey: 'Control+Shift+Space',
  captureHotkey: 'Control+Alt+Q',
  theme: 'system',
  overlayBounds: null,
}

/** The settings that hold a global hotkey. */
export type HotkeySetting = 'hotkey' | 'captureHotkey'

export interface HotkeyResult {
  ok: boolean
  reason?: string
}

/**
 * The Live Captions text as the listening panel shows it. Offsets index into
 * `text`: from `collectedFrom` is what has not been asked about yet, and up to
 * `completeUntil` of that is complete sentences — what an ask would send.
 */
export interface CaptionsView {
  status: 'ok' | 'unavailable'
  /** Why the captions cannot be read, when they cannot. */
  reason?: string
  text: string
  collectedFrom: number
  completeUntil: number
}

/** Where collected captions can be sent: the support chat, or ChatGPT. */
export type CaptionTarget = 'chat' | 'chatgpt'
