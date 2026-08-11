import { join } from 'node:path'
import { app } from 'electron'
import pino from 'pino'

const isDev = !app.isPackaged

export const logger = pino(
  {
    level: isDev ? 'debug' : 'info',
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  isDev
    ? pino.destination(1)
    : pino.destination({
        dest: join(app.getPath('userData'), 'teambridge.log'),
        mkdir: true,
        sync: false,
      }),
)

export function child(module: string) {
  return logger.child({ module })
}
