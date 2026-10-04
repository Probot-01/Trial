import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // '' prefix: read non-VITE_ variables too. CENTRAL_API_PROXY_TARGET is dev-
  // server configuration only and is never exposed to the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  const target = (env.CENTRAL_API_PROXY_TARGET || '').trim()
  if (!target) {
    console.warn('[vite] CENTRAL_API_PROXY_TARGET is not set: /api and /media are not proxied. ' +
      'Set it in central-system/frontend/.env (see .env.example).')
  }

  const proxy = target
    ? Object.fromEntries(['/api', '/media'].map((p) => [p, { target, changeOrigin: false, xfwd: true }]))
    : undefined

  return {
    plugins: [react()],

    server: { port: Number(env.CENTRAL_WEB_PORT) || 5174, strictPort: true, proxy },
    preview: { port: 4174, strictPort: true, proxy },
  }
})
