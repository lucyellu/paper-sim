import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-ignore — plain-JS server module (no Node typings in this project)
import { libraryServer } from './server/libraryServer.mjs'

export default defineConfig({
  plugins: [react(), libraryServer()],
  server: { port: 5173 },
})
