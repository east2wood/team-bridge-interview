import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type { Interview, LiveSessionState, Recruitment } from '@shared/api-types'
import type {
  AudioChannel,
  CaptureCommand,
  ConnectionTestResult,
  EngineStatus,
  LevelPayload,
  Partial as PartialText,
  SecretsInfo,
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
  onNotice: (cb: (n: Notice | null) => void) => subscribe(IPC.onNotice, cb),
  onLevel: (cb: (l: LevelPayload) => void) => subscribe(IPC.onLevel, cb),
  onBusy: (cb: (transcribing: boolean) => void) => subscribe(IPC.onBusy, cb),

  reportLevel: (payload: LevelPayload) => ipcRenderer.send(IPC.captureLevel, payload),
  openMain: () => ipcRenderer.send(IPC.mainOpen),
  minimiseToOverlay: () => ipcRenderer.send(IPC.mainMinimise),

  // Live interview. The renderer drives the session; main owns it.
  listInterviews: (): Promise<{
    ok: boolean
    reason?: string
    message?: string
    interviews: Interview[]
  }> => ipcRenderer.invoke(IPC.interviewsList),
  getLive: (): Promise<LiveSessionState> => ipcRenderer.invoke(IPC.liveGet),
  onLiveState: (cb: (s: LiveSessionState) => void) => subscribe(IPC.onLiveState, cb),
  selectInterview: (interview: Interview | null) => ipcRenderer.send(IPC.liveSelect, interview),
  startListening: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.liveStart),
  newTurn: (): Promise<void> => ipcRenderer.invoke(IPC.liveNewTurn),
  getRecruitment: (id: number): Promise<Recruitment> =>
    ipcRenderer.invoke(IPC.recruitmentGet, id),
  answerNow: (): Promise<void> => ipcRenderer.invoke(IPC.liveAnswer),
  stopListening: (): Promise<void> => ipcRenderer.invoke(IPC.liveStop),
  closeInterview: (): Promise<void> => ipcRenderer.invoke(IPC.liveClose),
  askManually: (question: string): Promise<void> => ipcRenderer.invoke(IPC.liveAsk, question),
  regenerate: (turnId: string, question?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.liveRegenerate, turnId, question),

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
  patchSettings: (
    patch: globalThis.Partial<Settings>,
  ): Promise<{ settings: Settings; hotkey?: { ok: boolean; reason?: string } }> =>
    ipcRenderer.invoke(IPC.settingsPatch, patch),

  // Secrets: the renderer can store, clear, and see a hint. It can never read
  // the token back — connection tests happen in main.
  getSecrets: (): Promise<SecretsInfo> => ipcRenderer.invoke(IPC.secretsGet),
  setToken: (token: string): Promise<SecretsInfo> =>
    ipcRenderer.invoke(IPC.secretsSetToken, token),
  clearToken: (): Promise<SecretsInfo> => ipcRenderer.invoke(IPC.secretsClearToken),
  testConnection: (serverUrl?: string): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke(IPC.connectionTest, serverUrl),

  openSettings: () => ipcRenderer.send(IPC.settingsOpen),
  closeSettings: () => ipcRenderer.send(IPC.settingsClose),
  copyTranscript: (
    sessionId?: string,
  ): Promise<{ copied: boolean; chars?: number; reason?: string }> =>
    ipcRenderer.invoke(IPC.copyTranscript, sessionId),
}

export type TeamBridgeApi = typeof api

contextBridge.exposeInMainWorld('tb', api)
