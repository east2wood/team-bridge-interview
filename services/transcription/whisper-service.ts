import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { join } from 'node:path'
import { app } from 'electron'
import type { AudioChannel, EngineStatus } from '@shared/types'
import { child } from '../logger'

const log = child('whisper')

/** Give up after this many consecutive failed starts and tell the user. */
const MAX_RESTARTS = 3

export interface WorkerSegment {
  channel: AudioChannel
  text: string
  startMs: number
  endMs: number
  confidence: number
  language: string
}

export interface WhisperOptions {
  pythonPath: string
  model: string
  device: 'auto' | 'cpu'
  language: string
  partials: boolean
}

type WorkerMessage =
  | { type: 'ready'; model: string; device: string; compute_type: string; notice?: string }
  | { type: 'partial'; channel: AudioChannel; text: string }
  | {
      type: 'segment'
      channel: AudioChannel
      text: string
      start_ms: number
      end_ms: number
      confidence: number
      language: string
    }
  | { type: 'log'; level: string; msg: string }
  | { type: 'error'; msg: string; fatal?: boolean }
  | { type: 'flushed' }

/**
 * Owns the Python speech engine. Whisper runs out-of-process so that a CUDA
 * fault, a model stall, or a segfault takes down a restartable child rather
 * than the app and the recording with it.
 */
export class WhisperService extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private restarts = 0
  private stopping = false
  private status: EngineStatus = {
    state: 'stopped',
    model: null,
    device: null,
    computeType: null,
  }

  constructor(private opts: WhisperOptions) {
    super()
  }

  getStatus(): EngineStatus {
    return { ...this.status }
  }

  private setStatus(next: Partial<EngineStatus>) {
    this.status = { ...this.status, ...next }
    this.emit('status', this.getStatus())
  }

  start(): void {
    if (this.proc) return
    this.stopping = false

    const script = this.workerScript()
    if (!existsSync(script)) {
      this.setStatus({ state: 'failed', reason: `worker script not found at ${script}` })
      return
    }

    const python = this.opts.pythonPath || defaultPython()
    const args = [
      script,
      '--model', this.opts.model,
      '--device', this.opts.device,
      '--language', this.opts.language,
      ...(this.opts.partials ? ['--partials'] : []),
    ]

    log.info({ python, args }, 'starting whisper worker')
    this.setStatus({ state: 'loading', model: this.opts.model, reason: undefined })

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(python, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (err) {
      this.fail(`could not launch Python (${python}): ${(err as Error).message}`)
      return
    }

    this.proc = proc

    proc.on('error', (err) => {
      this.fail(`could not launch Python (${python}): ${err.message}`)
    })

    this.reader = createInterface({ input: proc.stdout })
    this.reader.on('line', (line) => this.handleLine(line))

    // The worker's stderr is Python tracebacks and library noise. Keep it in
    // the log; surface the tail only if the process dies.
    let stderrTail = ''
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (data: string) => {
      stderrTail = (stderrTail + data).slice(-2000)
      log.debug({ stderr: data.trimEnd() }, 'worker stderr')
    })

    proc.on('exit', (code, signal) => {
      this.reader?.close()
      this.reader = null
      this.proc = null
      if (this.stopping) {
        this.setStatus({ state: 'stopped' })
        return
      }
      log.error({ code, signal }, 'whisper worker exited unexpectedly')
      this.restarts += 1
      if (this.restarts > MAX_RESTARTS) {
        this.fail(
          `the transcription engine failed to start ${MAX_RESTARTS} times.\n${stderrTail.trim()}`,
        )
        return
      }
      // Linear backoff: a model that fails to load fails fast, and hammering
      // it does not help.
      setTimeout(() => this.start(), this.restarts * 1000)
    })
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let msg: WorkerMessage
    try {
      msg = JSON.parse(line) as WorkerMessage
    } catch {
      log.warn({ line }, 'unparseable line from worker')
      return
    }

    switch (msg.type) {
      case 'ready':
        this.restarts = 0
        this.setStatus({
          state: 'ready',
          model: msg.model,
          device: msg.device,
          computeType: msg.compute_type,
          notice: msg.notice,
        })
        log.info(
          { model: msg.model, device: msg.device, notice: msg.notice },
          'whisper worker ready',
        )
        if (msg.notice) this.emit('degraded', msg.notice)
        break
      case 'partial':
        this.emit('partial', { channel: msg.channel, text: msg.text })
        break
      case 'segment':
        this.emit('segment', {
          channel: msg.channel,
          text: msg.text,
          startMs: msg.start_ms,
          endMs: msg.end_ms,
          confidence: msg.confidence,
          language: msg.language,
        } satisfies WorkerSegment)
        break
      case 'flushed':
        this.emit('flushed')
        break
      case 'log':
        log.debug({ workerLevel: msg.level }, msg.msg)
        break
      case 'error':
        log.error({ msg: msg.msg, fatal: msg.fatal }, 'worker reported an error')
        if (msg.fatal) this.fail(msg.msg)
        break
    }
  }

  private fail(reason: string): void {
    this.setStatus({ state: 'failed', reason })
    this.emit('fatal', reason)
  }

  /** Feed 16 kHz mono PCM. Silently dropped when the engine is not ready. */
  push(channel: AudioChannel, pcm: Int16Array): void {
    if (!this.proc || this.status.state !== 'ready') return
    const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
    this.write({ type: 'audio', channel, pcm: b64 })
  }

  /** Transcribe whatever speech is buffered; resolves when the queue drains. */
  async flush(timeoutMs = 30_000): Promise<void> {
    if (!this.proc || this.status.state !== 'ready') return
    this.write({ type: 'flush' })
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.off('flushed', done)
        resolve()
      }
      const timer = setTimeout(() => {
        log.warn('flush timed out; finalising anyway')
        done()
      }, timeoutMs)
      this.once('flushed', done)
    })
  }

  /** Drop buffered audio without transcribing it. Used between sessions. */
  reset(): void {
    this.write({ type: 'reset' })
  }

  private write(obj: unknown): void {
    if (!this.proc?.stdin.writable) return
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  async restartWith(opts: WhisperOptions): Promise<void> {
    this.opts = opts
    await this.stop()
    this.restarts = 0
    this.start()
  }

  async stop(): Promise<void> {
    this.stopping = true
    const proc = this.proc
    if (!proc) return
    proc.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log.warn('worker did not exit; killing')
        proc.kill()
        resolve()
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.proc = null
  }

  private workerScript(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'worker', 'whisper_worker.py')
      : join(app.getAppPath(), 'services', 'transcription', 'worker', 'whisper_worker.py')
  }
}

/** Prefer the project venv in development; fall back to whatever is on PATH. */
function defaultPython(): string {
  if (!app.isPackaged) {
    const venv = join(app.getAppPath(), '.venv', 'Scripts', 'python.exe')
    if (existsSync(venv)) return venv
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}
