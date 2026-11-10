import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function chemblDevProxy() {
  return {
    name: 'webserver-mdt-chembl-dev-proxy',
    configureServer(server) {
      server.middlewares.use('/api/chembl', async (req, res, next) => {
        if (req.method !== 'GET') return next()
        const incoming = new URL(req.url || '/', 'http://localhost')
        const endpoint = incoming.searchParams.get('endpoint')
        const allowed = ['molecule', 'status', 'activity', 'target', 'mechanism', 'target-record']
        if (!allowed.includes(endpoint)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ error: 'Unsupported ChEMBL endpoint.', code: 'UNSUPPORTED_ENDPOINT', activities: [] }))
        }
        const upstreamParams = new URLSearchParams(incoming.searchParams)
        upstreamParams.delete('endpoint')
        let upstreamUrl
        if (endpoint === 'target-record') {
          const id = String(upstreamParams.get('target_id') || '').toUpperCase()
          if (!/^CHEMBL\d+$/.test(id)) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            return res.end(JSON.stringify({ error: 'Invalid ChEMBL target ID.', code: 'INVALID_TARGET_ID', activities: [] }))
          }
          upstreamParams.delete('target_id')
          upstreamUrl = new URL(`https://www.ebi.ac.uk/chembl/api/data/target/${id}.json`)
        } else {
          upstreamUrl = new URL(`https://www.ebi.ac.uk/chembl/api/data/${endpoint}.json`)
        }
        for (const [key, value] of upstreamParams) upstreamUrl.searchParams.append(key, value)
        upstreamUrl.searchParams.set('format', 'json')

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 40_000)
        try {
          const upstream = await fetch(upstreamUrl, {
            headers: { Accept: 'application/json', 'User-Agent': 'WebServer_MDT/1.0 (academic research prototype)' },
            signal: controller.signal
          })
          const text = await upstream.text()
          const contentType = upstream.headers.get('content-type') || 'not supplied'
          let payload
          try { payload = text.trim() ? JSON.parse(text) : null } catch { payload = null }
          const html = /text\/html/i.test(contentType) || /^\s*<!doctype\s+html|^\s*<html/i.test(text)
          if (upstream.status >= 500 || html || !upstream.ok || payload === null) {
            const unavailable = upstream.status >= 500 || html || payload === null
            res.writeHead(unavailable ? 503 : upstream.status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-WebServer-MDT-Proxy': 'chembl',
              'X-Chembl-Upstream-Status': String(upstream.status),
              'X-Chembl-Upstream-Content-Type': contentType
            })
            return res.end(JSON.stringify({
              error: unavailable ? 'Upstream ChEMBL timeout or service failure.' : `Upstream ChEMBL returned HTTP ${upstream.status}.`,
              code: unavailable ? 'CHEMBL_UPSTREAM_UNAVAILABLE' : 'CHEMBL_UPSTREAM_HTTP_ERROR',
              upstreamStatus: upstream.status,
              upstreamContentType: contentType,
              responsePreview: text.replace(/\s+/g, ' ').slice(0, 220),
              activities: []
            }))
          }
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-WebServer-MDT-Proxy': 'chembl',
            'X-Chembl-Upstream-Status': String(upstream.status),
            'X-Chembl-Upstream-Content-Type': contentType
          })
          return res.end(JSON.stringify(payload))
        } catch (error) {
          const timedOut = error?.name === 'AbortError'
          if (!res.headersSent) res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-WebServer-MDT-Proxy': 'chembl' })
          return res.end(JSON.stringify({
            error: timedOut ? 'Upstream ChEMBL timeout after 40 seconds.' : 'Local proxy could not reach ChEMBL.',
            code: timedOut ? 'CHEMBL_UPSTREAM_TIMEOUT' : 'CHEMBL_DEV_PROXY_ERROR',
            activities: []
          }))
        } finally {
          clearTimeout(timeout)
        }
      })
    }
  }
}

export default defineConfig({
  plugins: [chemblDevProxy(), react()],
  server: {
    proxy: {
      '/api/uniprot': {
        target: 'https://rest.uniprot.org',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => {
          const requestUrl = new URL(path, 'http://localhost')
          const accession = requestUrl.searchParams.get('accession')
          if (accession && /^[A-Z0-9]{6,10}$/i.test(accession)) {
            return `/uniprotkb/${encodeURIComponent(accession)}.json`
          }
          const proteinName = requestUrl.searchParams.get('search')
          if (!proteinName || !/^[\p{L}\p{N}][\p{L}\p{N}\s.'()/-]{1,119}$/u.test(proteinName)) {
            return '/invalid-uniprot-request.json'
          }
          const query = `(organism_id:5833 OR organism_id:36329) AND protein_name:"${proteinName}"`
          const params = new URLSearchParams({ query, format: 'json', size: '10' })
          return `/uniprotkb/search?${params.toString()}`
        }
      }
    }
  }
})
