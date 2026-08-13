/** Types shared across main, preload, and renderer. No runtime imports here. */

export type AudioChannel = 'system' | 'microphone'

/** What the user picks in the UI; channels are derived from it. */
export type AudioSource = 'system' | 'microphone' | 'both'

export function channelsFor(source: AudioSource): AudioChannel[] {
  if (source === 'both') return ['system', 'microphone']
  return [source]
}

export const SOURCE_LABELS: Record<AudioSource, string> = {
  system: 'System Audio',
  microphone: 'Microphone',
  both: 'System Audio + Microphone',
}

/** Audio level for the meter, sampled far below frame rate. */
export interface LevelPayload {
  channel: AudioChannel
  rms: number
}

/**
 * How long the capture may stay below the silence floor before the UI says so.
 * Silence is legitimate — nobody is talking — but eight seconds of nothing
 * usually means the wrong output device, not a quiet room.
 */
export const NO_AUDIO_TIMEOUT_MS = 8000

/** RMS below this counts as silence. Speech sits orders of magnitude above it. */
export const SILENCE_RMS = 0.002

export type SessionState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'finalising'
  | 'failed'

export interface SessionStatePayload {
  state: SessionState
  sessionId: string | null
  startedAt: number | null
  /** Present only in the `failed` state. */
  reason?: string
}

/** Provisional text for speech still being spoken. Displayed, never persisted. */
export interface Partial {
  channel: AudioChannel
  text: string
}

/** A committed unit of transcript. The persisted unit. */
export interface Segment {
  id: string
  sessionId: string
  channel: AudioChannel
  text: string
  /** Milliseconds from session start. */
  startMs: number
  endMs: number
  confidence: number
  language: string
}

export interface SessionSummaryRow {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  durationMs: number
  source: string
  language: string | null
  incomplete: boolean
  preview: string
}

export interface EngineStatus {
  state: 'stopped' | 'loading' | 'ready' | 'failed'
  model: string | null
  device: string | null
  computeType: string | null
  reason?: string
  /** Set when the engine started but in a degraded mode worth telling the user about. */
  notice?: string
}

/** Ordered smallest to largest: download size and accuracy both climb. */
export const WHISPER_MODELS = ['tiny', 'small', 'medium', 'turbo', 'large-v3'] as const
export type WhisperModel = (typeof WHISPER_MODELS)[number]

export const MODEL_LABELS: Record<WhisperModel, string> = {
  tiny: 'tiny — ~75 MB, fastest, roughest',
  small: 'small — ~500 MB',
  medium: 'medium — ~1.5 GB',
  turbo: 'turbo — ~1.6 GB, recommended',
  'large-v3': 'large-v3 — ~3 GB, most accurate',
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
  hotkey: string
  hotkeyMode: 'toggle' | 'push-to-talk'
  audioSource: AudioSource
  language: string // 'auto' or an ISO code
  model: WhisperModel
  gpu: 'auto' | 'off'
  partials: boolean
  autoCopy: boolean
  autoSave: boolean
  saveAudio: boolean
  theme: 'system' | 'dark' | 'light'
  pythonPath: string
  consentAcknowledged: boolean
  overlayBounds: { x: number; y: number; width: number; height: number } | null
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  hotkey: 'Control+Shift+Space',
  hotkeyMode: 'toggle',
  audioSource: 'system',
  language: 'auto',
  model: 'turbo',
  gpu: 'auto',
  partials: true,
  autoCopy: false,
  autoSave: true,
  saveAudio: false,
  theme: 'system',
  pythonPath: '',
  consentAcknowledged: false,
  overlayBounds: null,
}

/** Main → renderer: begin or end device capture. */
export interface CaptureCommand {
  action: 'start' | 'stop'
  channels: AudioChannel[]
}

export const PIPELINE = {
  sampleRate: 16000,
  /** Samples per IPC frame. 320 = 20 ms at 16 kHz. */
  frameSamples: 320,
} as const
