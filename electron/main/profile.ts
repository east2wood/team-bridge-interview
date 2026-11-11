import { app } from 'electron'

/**
 * A second copy of the app, for testing: `TB_PROFILE=<name>` in the
 * environment, or `--profile=<name>` on the command line.
 *
 * A profile is its own data folder beside the usual one — its own server,
 * API token, settings and log — so two copies can be signed in as two people
 * at once, say an interviewer and an assistant. The single-instance lock is
 * held per data folder, so each profile is also its own single instance.
 *
 * Imported first, before anything that reads the data folder: the logger
 * opens its file there as soon as it is imported.
 */
function requested(): string | null {
  const flag = process.argv.find((arg) => arg.startsWith('--profile='))
  const raw = flag ? flag.slice('--profile='.length) : process.env['TB_PROFILE']
  const name = raw?.trim().replace(/[^\w-]/g, '')
  return name ? name : null
}

export const profile = requested()

// Once per process, however many times this runs: the bundle can carry two
// copies of a module reached by two spellings of its path, and moving the
// folder twice would make it "-second-second".
const process_ = globalThis as { __tbProfileApplied?: boolean }
if (profile && !process_.__tbProfileApplied) {
  process_.__tbProfileApplied = true
  app.setPath('userData', `${app.getPath('userData')}-${profile}`)
}
