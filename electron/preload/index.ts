import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/channels'
import type { Interview, LiveSessionState, Recruitment } from '@shared/api-types'
import type {
  CaptionTarget,
  CaptionsView,
  ConnectionTestResult,
  HotkeyResult,
  HotkeySetting,
  SecretsInfo,
  Settings,
} from '@shared/types'

export interface Notice {
  level: 'info' | 'warn' | 'error'
  message: string
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.off(channel, handler)
}

/**
 * The entire surface the renderer gets. No `ipcRenderer`, no Node, no
 * filesystem — a compromised renderer can drive the interview and the
 * settings, and nothing else.
 */
const api = {
  onNotice: (cb: (n: Notice | null) => void) => subscribe(IPC.onNotice, cb),

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
  openLiveCaptions: (): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.liveCaptionsOpen),
  openChatGPT: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke(IPC.chatgptOpen),
  getRecruitment: (id: number): Promise<Recruitment> =>
    ipcRenderer.invoke(IPC.recruitmentGet, id),
  stopListening: (): Promise<void> => ipcRenderer.invoke(IPC.liveStop),
  /** As an assistant: watch the interviewer's captions, now or as soon as they start. */
  joinListening: (): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke(IPC.liveJoin),
  leaveListening: (): Promise<void> => ipcRenderer.invoke(IPC.liveLeave),
  closeInterview: (): Promise<void> => ipcRenderer.invoke(IPC.liveClose),
  /**
   * Sends the Live Captions collected since the last ask, up to its last
   * complete sentence, to the support chat or to ChatGPT.
   */
  sendCaptions: (to: CaptionTarget): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.captionsSend, to),
  /** Sends a chat message to the people watching the round on the web. */
  sendChat: (text: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.chatSend, text),
  /** Fetches the open round's messages now. */
  refreshChat: (): Promise<void> => ipcRenderer.invoke(IPC.chatRefresh),
  getCaptions: (): Promise<CaptionsView | null> => ipcRenderer.invoke(IPC.captionsGet),
  onCaptions: (cb: (view: CaptionsView | null) => void) => subscribe(IPC.onCaptions, cb),
  /** As an assistant: the interviewer's Live Captions, null when they are not listening. */
  getWatchedCaptions: (): Promise<string | null> => ipcRenderer.invoke(IPC.watchedCaptionsGet),
  onWatchedCaptions: (cb: (text: string | null) => void) => subscribe(IPC.onWatchedCaptions, cb),

  dismiss: () => ipcRenderer.send(IPC.overlayDismiss),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
  patchSettings: (
    patch: Partial<Settings>,
  ): Promise<{ settings: Settings; hotkeys: Partial<Record<HotkeySetting, HotkeyResult>> }> =>
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
}

export type TeamBridgeApi = typeof api

contextBridge.exposeInMainWorld('tb', api)
