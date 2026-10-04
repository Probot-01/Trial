import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],

    server: { port: Number(env.PHC_WEB_PORT) || 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  }
})
