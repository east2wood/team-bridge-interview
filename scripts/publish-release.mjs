// Copies the installer the release build just made to the TeamBridge server,
// where its Downloads page offers it: <server>/public/interview-app,
// named for the version, the older ones taken away.
//
// Run by `npm run dist` after electron-builder. The servers are the checkouts
// on this machine: TEAMBRIDGE_SERVER_DIRS (separated by ;) when set, else the
// production and development checkouts, those that are there. Production
// mounts that folder into its container, so a release is offered without a
// deploy.

import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_SERVERS = ['D:/team-bridge', 'D:/projects/team_bridge']
const PREFIX = 'TeamBridge-Interview-Setup-'

const root = join(import.meta.dirname, '..')
const { version, build } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const product = build?.productName ?? 'TeamBridge Interview'
const built = join(root, 'release', `${product} Setup ${version}.exe`)

const exists = (path) => stat(path).then(() => true, () => false)

if (!(await exists(built))) {
  console.error(`publish-release: no installer at ${built}`)
  process.exit(1)
}

const servers = (process.env.TEAMBRIDGE_SERVER_DIRS ?? DEFAULT_SERVERS.join(';'))
  .split(';')
  .map((dir) => dir.trim())
  .filter(Boolean)

const name = `${PREFIX}${version}.exe`
let copied = 0
for (const server of servers) {
  // A server checkout, not just any folder by that name.
  if (!(await exists(join(server, 'config', 'routes.rb')))) {
    console.log(`publish-release: skipped ${server} (no TeamBridge server there)`)
    continue
  }
  const dir = join(server, 'public', 'interview-app')
  await mkdir(dir, { recursive: true })
  // Under another name until it's whole, so the page never links half a file.
  const part = join(dir, `${name}.part`)
  await copyFile(built, part)
  await rename(part, join(dir, name))
  for (const file of await readdir(dir)) {
    if (file !== name && file.startsWith(PREFIX)) await rm(join(dir, file), { force: true })
  }
  console.log(`publish-release: ${name} -> ${dir}`)
  copied++
}

if (!copied) {
  console.error('publish-release: no TeamBridge server found to copy the installer to')
  process.exit(1)
}
