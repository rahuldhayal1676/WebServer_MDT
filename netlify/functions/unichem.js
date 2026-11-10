import { adaptLambdaHandler, eventMethod, fetchUpstreamJson, getQueryParams, jsonResponse } from './_shared.js';

export async function handler(event = {}) {
  if (eventMethod(event) !== 'GET') return jsonResponse(405, { error: 'Only GET requests are supported.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
  const cid = String(getQueryParams(event).get('cid') || '').trim();
  if (!/^\d+$/.test(cid)) return jsonResponse(400, { error: 'A valid PubChem CID is required.', code: 'INVALID_PUBCHEM_CID' });
  const url = `https://www.ebi.ac.uk/unichem/rest/src_compound_id/${encodeURIComponent(cid)}/22/1`;
  const result = await fetchUpstreamJson(url, { serviceName: 'UniChem', timeoutMs: 22_000 });
  if (!result.ok) return jsonResponse(result.status, result.payload, {
    'X-WebServer-MDT-Proxy': 'unichem',
    'X-UniChem-Upstream-Status': String(result.payload?.upstreamStatus ?? result.status),
    'X-UniChem-Upstream-Content-Type': result.payload?.upstreamContentType || 'not supplied'
  });
  return jsonResponse(200, result.payload, { 'X-WebServer-MDT-Proxy': 'unichem', 'X-UniChem-Upstream-Status': '200' });
}

export default async function netlifyHandler(request) {
  return adaptLambdaHandler(request, handler);
}
