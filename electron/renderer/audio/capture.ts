import { PIPELINE, type AudioChannel } from '@shared/types'

/**
 * Device capture. Lives in the renderer because getDisplayMedia and
 * getUserMedia are renderer-only APIs; it downsamples to the pipeline format
 * and hands frames to main. It never touches the network.
 */

const WORKLET_SOURCE = `
class PCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.frame = options.processorOptions.frameSamples
    this.buf = new Int16Array(this.frame)
    this.n = 0
  }
  process(inputs) {
    const input = inputs[0]
    const ch = input && input[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      // Clamp before scaling: values outside [-1,1] wrap around when cast.
      const s = Math.max(-1, Math.min(1, ch[i]))
      this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.n === this.frame) {
        const copy = this.buf.slice()
        this.port.postMessage(copy.buffer, [copy.buffer])
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-worklet', PCMWorklet)
`

interface ChannelCapture {
  stream: MediaStream
  context: AudioContext
  node: AudioWorkletNode
}

export type LevelListener = (channel: AudioChannel, rms: number) => void

export class CaptureController {
  private active = new Map<AudioChannel, ChannelCapture>()

  constructor(private onLevel: LevelListener) {}

  get isCapturing(): boolean {
    return this.active.size > 0
  }

  async start(channels: AudioChannel[]): Promise<void> {
    await this.stop()
    try {
      for (const channel of channels) {
        const stream =
          channel === 'system' ? await captureSystemAudio() : await captureMicrophone()
        this.active.set(channel, await this.attach(channel, stream))
      }
      window.tb.captureStarted()
    } catch (err) {
      await this.stop()
      window.tb.captureFailed(describeCaptureError(err))
      throw err
    }
  }

  private async attach(channel: AudioChannel, stream: MediaStream): Promise<ChannelCapture> {
    // Asking for a 16 kHz context makes Chromium resample the device's native
    // 44.1/48 kHz for us, so there is no hand-rolled resampler to get wrong.
    const context = new AudioContext({ sampleRate: PIPELINE.sampleRate })
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }

    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { frameSamples: PIPELINE.frameSamples },
    })

    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const buffer = event.data
      this.onLevel(channel, rmsOf(new Int16Array(buffer)))
      window.tb.sendFrame(channel, buffer)
    }

    // A worklet only runs while connected to a destination. Route through a
    // muted gain node so capturing never echoes the audio back out.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(context.destination)

    return { stream, context, node }
  }

  async stop(): Promise<void> {
    for (const [, capture] of this.active) {
      capture.node.port.onmessage = null
      capture.node.disconnect()
      for (const track of capture.stream.getTracks()) track.stop()
      await capture.context.close().catch(() => undefined)
    }
    this.active.clear()
  }
}

async function captureSystemAudio(): Promise<MediaStream> {
  // Chromium rejects an audio-only getDisplayMedia request, so ask for video
  // and drop the track the moment we have it. Main's display-media handler
  // returns loopback audio with no video source attached.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  })
  for (const track of stream.getVideoTracks()) {
    track.stop()
    stream.removeTrack(track)
  }
  if (stream.getAudioTracks().length === 0) {
    throw new Error('no-loopback-audio')
  }
  return stream
}

async function captureMicrophone(): Promise<MediaStream> {
  // All three are off deliberately: the loopback stream is already separate,
  // so processing here would only degrade the user's own voice.
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  })
}

function rmsOf(pcm: Int16Array): number {
  let sum = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! / 32768
    sum += v * v
  }
  return Math.sqrt(sum / pcm.length)
}

function describeCaptureError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const message = err instanceof Error ? err.message : String(err)

  if (message === 'no-loopback-audio') {
    return 'Windows returned no system audio. Check that a playback device is active.'
  }
  switch (name) {
    case 'NotAllowedError':
      return 'Audio capture was denied.'
    case 'NotFoundError':
      return 'No audio device was available to capture.'
    case 'NotReadableError':
      return 'The audio device is in use by another application in exclusive mode.'
    default:
      return `Audio capture failed: ${message}`
  }
}
