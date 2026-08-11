import { randomUUID } from 'node:crypto'
import type { Segment, SessionSummaryRow } from '@shared/types'
import { openDatabase } from './db'

export interface NewSession {
  source: string
  startedAt: number
}

export function createSession(input: NewSession): string {
  const id = randomUUID()
  openDatabase()
    .prepare(
      `INSERT INTO sessions (id, title, started_at, source, incomplete)
       VALUES (?, '', ?, ?, 1)`,
    )
    .run(id, input.startedAt, input.source)
  return id
}

export function insertSegment(seg: Segment): void {
  openDatabase()
    .prepare(
      `INSERT INTO segments (id, session_id, channel, text, start_ms, end_ms, confidence, language)
       VALUES (@id, @sessionId, @channel, @text, @startMs, @endMs, @confidence, @language)`,
    )
    .run(seg)
}

/**
 * Marks a session complete. `endedAt` is derived from the last committed
 * segment when the session was interrupted, so a crashed session still
 * reports an honest duration rather than zero.
 */
export function finaliseSession(
  sessionId: string,
  opts: { endedAt: number; language: string | null; incomplete?: boolean },
): void {
  const db = openDatabase()
  const row = db
    .prepare(`SELECT started_at AS startedAt FROM sessions WHERE id = ?`)
    .get(sessionId) as { startedAt: number } | undefined
  if (!row) return

  db.prepare(
    `UPDATE sessions
        SET ended_at = ?, duration_ms = ?, language = ?, incomplete = ?,
            title = CASE WHEN title = '' THEN ? ELSE title END
      WHERE id = ?`,
  ).run(
    opts.endedAt,
    Math.max(0, opts.endedAt - row.startedAt),
    opts.language,
    opts.incomplete ? 1 : 0,
    deriveTitle(sessionId),
    sessionId,
  )
}

/** A session with no speech is not worth keeping; it is noise in history. */
export function deleteIfEmpty(sessionId: string): boolean {
  const db = openDatabase()
  const { n } = db
    .prepare(`SELECT COUNT(*) AS n FROM segments WHERE session_id = ?`)
    .get(sessionId) as { n: number }
  if (n > 0) return false
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
  return true
}

export function segmentCount(sessionId: string): number {
  const { n } = openDatabase()
    .prepare(`SELECT COUNT(*) AS n FROM segments WHERE session_id = ?`)
    .get(sessionId) as { n: number }
  return n
}

export function transcriptText(sessionId: string, withTimestamps = false): string {
  const rows = openDatabase()
    .prepare(
      `SELECT text, start_ms AS startMs, channel FROM segments
        WHERE session_id = ? ORDER BY start_ms ASC`,
    )
    .all(sessionId) as { text: string; startMs: number; channel: string }[]

  return rows
    .map((r) => (withTimestamps ? `[${formatOffset(r.startMs)}] ${r.text}` : r.text))
    .join('\n')
}

export function listSessions(limit = 50, offset = 0): SessionSummaryRow[] {
  const rows = openDatabase()
    .prepare(
      `SELECT s.id, s.title, s.started_at AS startedAt, s.ended_at AS endedAt,
              s.duration_ms AS durationMs, s.source, s.language, s.incomplete,
              COALESCE((SELECT text FROM segments WHERE session_id = s.id
                         ORDER BY start_ms ASC LIMIT 1), '') AS preview
         FROM sessions s
        ORDER BY s.started_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as (Omit<SessionSummaryRow, 'incomplete'> & { incomplete: number })[]

  return rows.map((r) => ({ ...r, incomplete: r.incomplete === 1 }))
}

export function searchSegments(query: string, limit = 50) {
  // FTS5 treats bare punctuation as syntax; quoting makes user input literal.
  const safe = `"${query.replace(/"/g, '""')}"`
  return openDatabase()
    .prepare(
      `SELECT seg.id, seg.session_id AS sessionId, seg.start_ms AS startMs,
              s.title, s.started_at AS startedAt,
              snippet(segments_fts, 0, '[', ']', '...', 12) AS snippet
         FROM segments_fts
         JOIN segments seg ON seg.rowid = segments_fts.rowid
         JOIN sessions s ON s.id = seg.session_id
        WHERE segments_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(safe, limit)
}

export function deleteSession(sessionId: string): void {
  openDatabase().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId)
}

/** Sessions left mid-recording by a crash, repaired at next startup. */
export function repairInterruptedSessions(): number {
  const db = openDatabase()
  const stale = db
    .prepare(`SELECT id, started_at AS startedAt FROM sessions WHERE ended_at IS NULL`)
    .all() as { id: string; startedAt: number }[]

  for (const s of stale) {
    const last = db
      .prepare(`SELECT MAX(end_ms) AS endMs FROM segments WHERE session_id = ?`)
      .get(s.id) as { endMs: number | null }
    if (last.endMs === null) {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(s.id)
      continue
    }
    finaliseSession(s.id, {
      endedAt: s.startedAt + last.endMs,
      language: null,
      incomplete: true,
    })
  }
  return stale.length
}

function deriveTitle(sessionId: string): string {
  const first = openDatabase()
    .prepare(`SELECT text FROM segments WHERE session_id = ? ORDER BY start_ms ASC LIMIT 1`)
    .get(sessionId) as { text: string } | undefined
  if (!first) return 'Empty session'
  const words = first.text.trim().split(/\s+/).slice(0, 7).join(' ')
  return words.length > 0 ? words.replace(/[.,;:!?]$/, '') : 'Untitled session'
}

function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}
