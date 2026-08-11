import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type {
  AudioChannel,
  CaptureCommand,
  EngineStatus,
  Partial as PartialText,
  Segment,
  SessionStatePayload,
  Settings,
} from '@shared/types'

export interface Notice {
  level: 'info' | 'warn' | 'error' | 'consent'
  message: string
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

/**
 * The entire surface the renderer gets. No `ipcRenderer`, no Node, no
 * filesystem — a compromised renderer can send audio frames and ask for a
 * transcript, and nothing else.
 */
const api = {
  onCaptureCommand: (cb: (cmd: CaptureCommand) => void) => subscribe(IPC.onCaptureCommand, cb),
  onSessionState: (cb: (s: SessionStatePayload) => void) => subscribe(IPC.onSessionState, cb),
  onPartial: (cb: (p: PartialText) => void) => subscribe(IPC.onPartial, cb),
  onSegment: (cb: (s: Segment) => void) => subscribe(IPC.onSegment, cb),
  onEngineStatus: (cb: (s: EngineStatus) => void) => subscribe(IPC.onEngineStatus, cb),
  onNotice: (cb: (n: Notice) => void) => subscribe(IPC.onNotice, cb),

  sendFrame: (channel: AudioChannel, pcm: ArrayBuffer) =>
    ipcRenderer.send(IPC.captureFrame, channel, pcm),
  captureStarted: () => ipcRenderer.send(IPC.captureStarted),
  captureFailed: (reason: string) => ipcRenderer.send(IPC.captureFailed, reason),

  startSession: () => ipcRenderer.send(IPC.sessionStart),
  stopSession: () => ipcRenderer.send(IPC.sessionStop),
  acknowledgeConsent: () => ipcRenderer.send(IPC.consentAcknowledge),
  dismiss: () => ipcRenderer.send(IPC.overlayDismiss),

  getSettings: (): Promise<Settings & { engine: EngineStatus; session: SessionStatePayload }> =>
    ipcRenderer.invoke(IPC.settingsGet),
  patchSettings: (patch: globalThis.Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.settingsPatch, patch),
  copyTranscript: (
    sessionId?: string,
  ): Promise<{ copied: boolean; chars?: number; reason?: string }> =>
    ipcRenderer.invoke(IPC.copyTranscript, sessionId),
}

export type TeamBridgeApi = typeof api

contextBridge.exposeInMainWorld('tb', api)
