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

  // settings window
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  secretsGet: 'secrets:get',
  secretsSetToken: 'secrets:set-token',
  secretsClearToken: 'secrets:clear-token',
  connectionTest: 'connection:test',
  hotkeyProbe: 'hotkey:probe',

  // main → renderer
  onCaptureCommand: 'capture:command',
  onSessionState: 'session:state',
  onPartial: 'transcript:partial',
  onSegment: 'transcript:segment',
  onEngineStatus: 'engine:status',
  onNotice: 'ui:notice',
} as const
