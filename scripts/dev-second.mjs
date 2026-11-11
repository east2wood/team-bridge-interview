/**
 * A second copy of the app beside `npm run dev`, for testing two people at
 * once — an interviewer in one, an assistant in the other.
 *
 *   npm run dev              # first copy: the dev server and the usual profile
 *   npm run dev:second       # second copy, profile "second"
 *   npm run dev:second -- b  # or any other profile name
 *
 * The second copy has its own data folder (server, API token, settings, log),
 * so give it a different user's token in its Settings. It loads the first
 * copy's dev server rather than starting another: that one holds port 5173,
 * and sharing it means a renderer change reaches both. A change to main or
 * preload needs both restarted.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electron = require('electron')

const name = (process.argv[2] ?? 'second').replace(/[^\w-]/g, '') || 'second'
const url = process.env.ELECTRON_RENDERER_URL ?? 'http://127.0.0.1:5173'

if (!existsSync('out/main/index.js')) {
  console.error('Nothing built yet: start `npm run dev` first, then run this beside it.')
  process.exit(1)
}

try {
  await fetch(url, { method: 'HEAD' })
} catch {
  console.error(`No dev server at ${url}: start \`npm run dev\` first, then run this beside it.`)
  process.exit(1)
}

console.log(`Starting profile "${name}" against ${url}`)
// A terminal inside VS Code sets ELECTRON_RUN_AS_NODE, which would start
// Electron as plain Node with no app to run.
const env = { ...process.env, ELECTRON_RENDERER_URL: url }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.', `--profile=${name}`], { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code ?? 0))
