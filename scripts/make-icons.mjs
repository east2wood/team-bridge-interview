// Generates the tray and application icons as PNGs.
//
// These are drawn in code rather than committed as binaries so the repo stays
// diffable and the icons can be re-tinted from one place. Pure Node — no
// image library, no build-time dependency.

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'build')

const ACCENT = [99, 102, 241] // indigo
const GLYPH = [255, 255, 255]

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

/** @param {number} size @param {(x:number,y:number)=>[number,number,number,number]} shade */
function png(size, shade) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = shade(x, y)
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
      raw[p++] = a
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // bytes 10-12 stay zero: deflate compression, adaptive filtering, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Antialiased coverage of a shape, sampled on a 3x3 grid per pixel.
function coverage(x, y, inside) {
  let hits = 0
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++
    }
  }
  return hits / 9
}

function blend(base, over, alpha) {
  return base.map((c, i) => Math.round(c * (1 - alpha) + over[i] * alpha))
}

/** A filled disc with a microphone glyph knocked out in white. */
function micIcon(size) {
  const u = size / 32 // design the glyph on a 32x32 grid, then scale
  const cx = size / 2
  const cy = size / 2

  const inDisc = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= (size / 2 - 0.5) ** 2

  // Capsule body: rounded rect from y=9u to y=19u, half-width 3.5u.
  const inBody = (x, y) => {
    const dx = Math.abs(x - cx)
    if (dx > 3.5 * u) return false
    const top = cy - 7 * u
    const bot = cy + 3 * u
    if (y >= top + 3.5 * u && y <= bot - 3.5 * u) return true
    const ny = y < top + 3.5 * u ? top + 3.5 * u : bot - 3.5 * u
    return dx ** 2 + (y - ny) ** 2 <= (3.5 * u) ** 2
  }

  // Cradle: an arc under the body, plus a short stem.
  const inCradle = (x, y) => {
    const dx = x - cx
    const dy = y - cy
    const r = Math.hypot(dx, dy)
    if (dy > 0 && r >= 5.5 * u && r <= 7 * u && Math.abs(dx) <= 7 * u) return true
    return Math.abs(dx) <= 1.1 * u && dy >= 6.2 * u && dy <= 9 * u
  }

  return png(size, (x, y) => {
    const disc = coverage(x, y, inDisc)
    if (disc === 0) return [0, 0, 0, 0]
    const glyph = Math.max(coverage(x, y, inBody), coverage(x, y, inCradle))
    const rgb = blend(ACCENT, GLYPH, glyph)
    return [rgb[0], rgb[1], rgb[2], Math.round(disc * 255)]
  })
}

mkdirSync(outDir, { recursive: true })
for (const [name, size] of [
  ['tray.png', 32],
  ['tray@2x.png', 64],
  ['icon.png', 256],
]) {
  writeFileSync(resolve(outDir, name), micIcon(size))
}
console.log(`icons written to ${outDir}`)
