import type { TeamBridgeApi } from './index'

declare global {
  interface Window {
    tb: TeamBridgeApi
  }
}

export {}
