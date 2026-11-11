/** IPC channel names. Keeping them in one place stops main and renderer drifting. */

export const IPC = {
  // renderer → main
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  overlayBoundsChanged: 'overlay:bounds-changed',
  overlayDismiss: 'overlay:dismiss',

  // live interview
  interviewsList: 'interviews:list',
  liveGet: 'live:get',
  liveSelect: 'live:select',
  liveStart: 'live:start',
  liveCaptionsOpen: 'live-captions:open',
  chatgptOpen: 'chatgpt:open',
  recruitmentGet: 'recruitment:get',
  liveStop: 'live:stop',
  liveJoin: 'live:join',
  liveLeave: 'live:leave',
  liveClose: 'live:close',
  captionsSend: 'captions:send',
  chatSend: 'chat:send',
  chatRefresh: 'chat:refresh',
  captionsGet: 'captions:get',
  watchedCaptionsGet: 'watched-captions:get',
  onLiveState: 'live:state',

  // settings window
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  secretsGet: 'secrets:get',
  secretsSetToken: 'secrets:set-token',
  secretsClearToken: 'secrets:clear-token',
  connectionTest: 'connection:test',

  // window management
  mainOpen: 'main:open',
  mainMinimise: 'main:minimise',

  // main → renderer
  onNotice: 'ui:notice',
  onCaptions: 'captions:view',
  /** As an assistant: what the interviewer's Live Captions show. */
  onWatchedCaptions: 'watched-captions:view',
} as const
