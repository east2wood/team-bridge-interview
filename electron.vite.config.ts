import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const alias = {
  '@shared': resolve('shared'),
  '@services': resolve('services'),
}

export default defineConfig({
  // Formats are left to electron-vite: with no "type": "module" in
  // package.json it emits CommonJS for main and preload, which is what
  // Electron's loader and `__dirname` expect.
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { lib: { entry: resolve('electron/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { lib: { entry: resolve('electron/preload/index.ts') } },
  },
  renderer: {
    root: resolve('electron/renderer'),
    resolve: { alias },
    plugins: [react()],
    // Bind IPv4 explicitly. Left to default, Vite can end up listening on
    // [::1] only while Electron resolves `localhost` to 127.0.0.1, and the
    // overlay fails to load with ERR_CONNECTION_REFUSED.
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: {
      // Never inline JavaScript assets. The AudioWorklet is small enough that
      // Vite would turn it into a `data:` URL, which the overlay's
      // `script-src 'self'` CSP blocks just like a blob: URL — and the
      // resulting AbortError is indistinguishable from a capture failure.
      // Non-JS assets keep the default inlining behaviour.
      assetsInlineLimit: (filePath: string) =>
        filePath.endsWith('.js') ? false : undefined,
      rollupOptions: {
        input: {
          overlay: resolve('electron/renderer/index.html'),
          live: resolve('electron/renderer/live.html'),
          settings: resolve('electron/renderer/settings.html'),
        },
      },
    },
  },
})
