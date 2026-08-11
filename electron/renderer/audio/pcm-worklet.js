/**
 * Converts float samples to the pipeline format: 16-bit signed PCM in
 * fixed-size frames.
 *
 * This is a real file rather than a blob: URL on purpose. The overlay's CSP is
 * `script-src 'self'`, which blocks blob: worklet modules — `addModule()` then
 * rejects with `AbortError: The user aborted a request.`, a message
 * indistinguishable from a capture failure. Loading it as a same-origin asset
 * keeps the CSP strict and the failure mode honest.
 *
 * Plain JS: worklets are loaded by the browser as-is, outside the TS build.
 */
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
