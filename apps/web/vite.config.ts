import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/** The commit this bundle was built from: Vercel's, else the local checkout's. */
function commit(): string {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT
  if (fromEnv) return fromEnv
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  define: { __COMMIT__: JSON.stringify(commit()) },
})
