import { create } from 'zustand'
import type {
  AudioChannel,
  EngineStatus,
  Segment,
  SessionStatePayload,
} from '@shared/types'

export interface Notice {
  level: 'info' | 'warn' | 'error' | 'consent'
  message: string
}

interface OverlayState {
  session: SessionStatePayload
  engine: EngineStatus
  segments: Segment[]
  partials: Record<string, string>
  levels: Record<string, number>
  notice: Notice | null
  consentRequired: boolean
  autoScroll: boolean

  setSession: (s: SessionStatePayload) => void
  clearConsent: () => void
  setEngine: (e: EngineStatus) => void
  addSegment: (s: Segment) => void
  setPartial: (channel: AudioChannel, text: string) => void
  setLevel: (channel: AudioChannel, rms: number) => void
  setNotice: (n: Notice | null) => void
  setAutoScroll: (on: boolean) => void
  resetTranscript: () => void
}

export const useOverlay = create<OverlayState>((set) => ({
  session: { state: 'idle', sessionId: null, startedAt: null },
  engine: { state: 'stopped', model: null, device: null, computeType: null },
  segments: [],
  partials: {},
  levels: {},
  notice: null,
  consentRequired: false,
  autoScroll: true,

  setSession: (session) =>
    set((prev) => {
      // A new recording starts from a clean transcript. Clearing the consent
      // panel here too is what makes the acknowledge button visibly work —
      // acknowledging sends a capture command, never a notice, so nothing
      // else would take the panel down.
      const starting = session.state === 'starting' && prev.session.state !== 'starting'
      return starting
        ? {
            session,
            segments: [],
            partials: {},
            notice: null,
            consentRequired: false,
            autoScroll: true,
          }
        : { session }
    }),

  clearConsent: () => set({ consentRequired: false }),

  setEngine: (engine) => set({ engine }),

  addSegment: (segment) =>
    set((prev) => ({
      segments: [...prev.segments, segment],
      // The committed text supersedes whatever partial was showing.
      partials: { ...prev.partials, [segment.channel]: '' },
    })),

  setPartial: (channel, text) =>
    set((prev) => ({ partials: { ...prev.partials, [channel]: text } })),

  setLevel: (channel, rms) => set((prev) => ({ levels: { ...prev.levels, [channel]: rms } })),

  setNotice: (notice) =>
    set({
      notice: notice && notice.level === 'consent' ? null : notice,
      consentRequired: notice?.level === 'consent',
    }),

  setAutoScroll: (autoScroll) => set({ autoScroll }),

  resetTranscript: () => set({ segments: [], partials: {} }),
}))
