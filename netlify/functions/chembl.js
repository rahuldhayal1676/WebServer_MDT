import { eventMethod, fetchUpstreamJson, getQueryParams, jsonResponse } from './_shared.js';

const CH_EMBL_BASE = 'https://www.ebi.ac.uk/chembl/api/data';
const ALLOWED_ENDPOINTS = new Set(['molecule', 'status', 'activity', 'target', 'mechanism', 'target-record']);

export async function handler(event = {}) {
  if (eventMethod(event) !== 'GET') return jsonResponse(405, { error: 'Only GET requests are supported.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
  const params = getQueryParams(event);
  const endpoint = params.get('endpoint');
  if (!ALLOWED_ENDPOINTS.has(endpoint)) return jsonResponse(400, { error: 'Unsupported ChEMBL endpoint.', code: 'UNSUPPORTED_ENDPOINT', activities: [] });

  const upstreamParams = new URLSearchParams(params);
  upstreamParams.delete('endpoint');
  let upstreamUrl;
  if (endpoint === 'target-record') {
    const id = String(upstreamParams.get('target_id') || '').toUpperCase();
    if (!/^CHEMBL\d+$/.test(id)) return jsonResponse(400, { error: 'Invalid ChEMBL target ID.', code: 'INVALID_TARGET_ID', activities: [] });
    upstreamParams.delete('target_id');
    upstreamUrl = new URL(`${CH_EMBL_BASE}/target/${id}.json`);
  } else {
    upstreamUrl = new URL(`${CH_EMBL_BASE}/${endpoint}.json`);
  }
  for (const [key, value] of upstreamParams) upstreamUrl.searchParams.append(key, value);
  upstreamUrl.searchParams.set('format', 'json');

  const result = await fetchUpstreamJson(upstreamUrl.href, { serviceName: 'ChEMBL', timeoutMs: 22_000 });
  if (!result.ok) {
    const payload = { ...result.payload, upstreamStatus: result.payload?.upstreamStatus ?? result.status };
    if (endpoint === 'activity' && !Array.isArray(payload.activities)) payload.activities = [];
    return jsonResponse(result.status, payload, {
      'X-WebServer-MDT-Proxy': 'chembl',
      'X-Chembl-Upstream-Status': String(payload.upstreamStatus),
      'X-Chembl-Upstream-Content-Type': payload.upstreamContentType || 'not supplied'
    });
  }
  return jsonResponse(200, result.payload, {
    'X-WebServer-MDT-Proxy': 'chembl',
    'X-Chembl-Upstream-Status': '200',
    'X-Chembl-Upstream-Content-Type': result.contentType
  });
}

