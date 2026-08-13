import { net } from 'electron'
import type { ConnectionTestResult, Identity } from '@shared/types'
import { child } from '../logger'

const log = child('teambridge')

/**
 * Identity endpoint appended to the configured base URL.
 *
 * Not /health: that answers without authentication, so it proves the host is
 * up and nothing about the token. A reply naming the holder has tested the
 * URL, the token, and which team the app is pointed at — and a 401 has tested
 * it the other way. The API has no /test_connection for exactly this reason.
 */
const IDENTITY_PATH = '/api/v1/assist/me'
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
    url = new URL(IDENTITY_PATH, `${base}/`)
  } catch {
    return { ok: false, message: `"${rawUrl}" is not a valid URL.` }
  }

  if (!token) {
    return { ok: false, message: 'Add an API token: the server cannot say who you are without one.' }
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
      // Naming the holder is the actual test result; the status code alone
      // would not distinguish a working token from a server that answers
      // everything.
      const body = (await response.json().catch(() => null)) as { data?: Identity } | null
      const identity = body?.data
      return {
        ok: true,
        status: response.status,
        latencyMs,
        insecure,
        identity,
        message: identity
          ? `Connected as ${identity.name} · ${identity.team.name} (${latencyMs} ms).`
          : `Connected in ${latencyMs} ms.`,
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
      return 'The server rejected the API token. Check that it is a current integration key.'
    case 404:
      return `Reached the server, but ${url} is not there. Check the URL points at TeamBridge itself.`
    case 429:
      return 'The server is rate limiting this client. Try again shortly.'
    default:
      return status >= 500
        ? `The server returned ${status}. It may be unhealthy.`
        : `The server returned ${status}.`
  }
}
