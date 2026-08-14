/** IPC channel names. Keeping them in one place stops main and renderer drifting. */

export const IPC = {
  // renderer → main
  captureFrame: 'capture:frame',
  captureStarted: 'capture:started',
  captureFailed: 'capture:failed',
  sessionStop: 'session:stop',
  sessionStart: 'session:start',
  consentAcknowledge: 'consent:acknowledge',
  copyTranscript: 'clipboard:copy-transcript',
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  overlayBoundsChanged: 'overlay:bounds-changed',
  overlayDismiss: 'overlay:dismiss',
  transcriptGet: 'transcript:get',

  // live interview
  interviewsList: 'interviews:list',
  liveGet: 'live:get',
  liveSelect: 'live:select',
  liveStart: 'live:start',
  liveNewTurn: 'live:new-turn',
  liveAnswer: 'live:answer',
  liveStop: 'live:stop',
  liveClose: 'live:close',
  liveAsk: 'live:ask',
  liveRegenerate: 'live:regenerate',
  onLiveState: 'live:state',

  // settings window
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  secretsGet: 'secrets:get',
  secretsSetToken: 'secrets:set-token',
  secretsClearToken: 'secrets:clear-token',
  connectionTest: 'connection:test',
  hotkeyProbe: 'hotkey:probe',

  // window management
  mainOpen: 'main:open',
  mainMinimise: 'main:minimise',

  // renderer → main (capture host only)
  captureLevel: 'capture:level',

  // main → renderer
  onLevel: 'capture:on-level',
  onBusy: 'engine:busy',
  onCaptureCommand: 'capture:command',
  onSessionState: 'session:state',
  onPartial: 'transcript:partial',
  onSegment: 'transcript:segment',
  onEngineStatus: 'engine:status',
  onNotice: 'ui:notice',
} as const
