import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { handler as chemblHandler } from './netlify/functions/chembl.js'
import { handler as uniprotHandler } from './netlify/functions/uniprot.js'
import { handler as ncbiHandler } from './netlify/functions/ncbi.js'
import { handler as unichemHandler } from './netlify/functions/unichem.js'

/**
 * Local development gateway.
 *
 * Every /api/* route is served by the SAME handler that Netlify runs in
 * production (netlify/functions/*.js), so `npm run dev` and the deployed site
 * behave identically. Previously only /api/chembl and /api/uniprot existed
 * here; /api/ncbi (DHFR-TS RefSeq sequence) and /api/unichem fell through to
 * Vite's single-page-app fallback and returned index.html, which the client
 * reported as "an HTML page instead of JSON".
 *
 * Add any new function to ROUTES and to netlify.toml together.
 */
const ROUTES = {
  '/api/chembl': chemblHandler,
  '/api/uniprot': uniprotHandler,
  '/api/ncbi': ncbiHandler,
  '/api/unichem': unichemHandler
}

function netlifyFunctionsDevProxy() {
  return {
    name: 'webserver-mdt-netlify-functions-dev-proxy',
    configureServer(server) {
      for (const [route, handler] of Object.entries(ROUTES)) {
        server.middlewares.use(route, async (req, res) => {
          try {
            const incoming = new URL(req.url || '/', 'http://localhost')
            const result = await handler({
              httpMethod: req.method || 'GET',
              rawQuery: incoming.search.replace(/^\?/, ''),
              queryStringParameters: Object.fromEntries(incoming.searchParams)
            })
            res.writeHead(result.statusCode || 200, result.headers || {})
            res.end(result.body ?? '')
          } catch (error) {
            if (res.headersSent) return res.end()
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify({
              error: `The local ${route} development function failed: ${String(error?.message || error).slice(0, 200)}`,
              code: 'DEV_FUNCTION_ERROR'
            }))
          }
        })
      }
    }
  }
}

export default defineConfig({
  plugins: [netlifyFunctionsDevProxy(), react()]
})
