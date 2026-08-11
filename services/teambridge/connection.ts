import { net } from 'electron'
import type { ConnectionTestResult } from '@shared/types'
import { child } from '../logger'

const log = child('teambridge')

/** Health endpoint appended to the configured base URL. */
const HEALTH_PATH = '/api/health'
const TIMEOUT_MS = 8000

/**
 * Probes the configured TeamBridge server.
 *
 * Runs in main so the token never reaches the renderer. Uses Electron's `net`
 * rather than global fetch so the request follows the system proxy and
 * certificate store, which is what a corporate network will expect.
 */
export async function testConnection(
  rawUrl: string,
  token: string | null,
): Promise<ConnectionTestResult> {
  const base = normaliseUrl(rawUrl)
  if (!base) {
    return { ok: false, message: 'Enter a server URL, for example https://teambridge.example.com' }
  }

  let url: URL
  try {
    url = new URL(HEALTH_PATH, `${base}/`)
  } catch {
    return { ok: false, message: `"${rawUrl}" is not a valid URL.` }
  }

  const insecure = url.protocol === 'http:' && !isLoopback(url.hostname)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = Date.now()

  try {
    const response = await net.fetch(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    })
    const latencyMs = Date.now() - started

    if (response.ok) {
      return {
        ok: true,
        status: response.status,
        latencyMs,
        insecure,
        message: `Connected in ${latencyMs} ms.`,
      }
    }

    // Report the status rather than a generic failure: 401 and 404 mean very
    // different things and the user can only act on the difference.
    return {
      ok: false,
      status: response.status,
      latencyMs,
      insecure,
      message: describeStatus(response.status, url.toString()),
    }
  } catch (err) {
    const error = err as Error
    if (error.name === 'AbortError') {
      return { ok: false, insecure, message: `No response within ${TIMEOUT_MS / 1000} s.` }
    }
    log.warn({ err: error.message, url: url.toString() }, 'connection test failed')
    return { ok: false, insecure, message: `Could not reach the server: ${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}

/** Trims whitespace and trailing slashes; adds https:// when no scheme is given. */
export function normaliseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function describeStatus(status: number, url: string): string {
  switch (status) {
    case 401:
    case 403:
      return 'The server rejected the API token.'
    case 404:
      return `The server responded, but ${url} was not found. Check the URL.`
    case 429:
      return 'The server is rate limiting this client. Try again shortly.'
    default:
      return status >= 500
        ? `The server returned ${status}. It may be unhealthy.`
        : `The server returned ${status}.`
  }
}
