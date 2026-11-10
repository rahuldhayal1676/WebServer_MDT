const DEFAULT_TIMEOUT_MS = 22_000;
const USER_AGENT = 'WebServer_MDT/1.0 (academic research prototype)';

export function getQueryParams(event = {}) {
  if (typeof event.rawQuery === 'string') return new URLSearchParams(event.rawQuery.replace(/^\?/, ''));
  if (typeof event.rawUrl === 'string') {
    try { return new URL(event.rawUrl).searchParams; } catch { /* use queryStringParameters */ }
  }
  return new URLSearchParams(Object.entries(event.queryStringParameters || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)]));
}

export function jsonResponse(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  };
}

function serviceCode(serviceName) {
  if (serviceName === 'ChEMBL') return 'CHEMBL';
  if (serviceName === 'UniProtKB') return 'UNIPROT';
  if (serviceName === 'UniChem') return 'UNICHEM';
  return String(serviceName).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function isHtml(contentType, body) {
  return /text\/html/i.test(contentType || '') || /^\s*(?:<!doctype\s+html|<html\b)/i.test(body || '');
}

export const PROXY_UPSTREAM_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export async function fetchUpstreamJson(url, {
  serviceName = 'Upstream database',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  redirect = 'follow',
  headers = {}
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      redirect,
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        ...headers
      },
      signal: controller.signal
    });
    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'not supplied';

    if (upstream.status >= 300 && upstream.status < 400) {
      return {
        ok: false,
        redirect: true,
        status: upstream.status,
        location: upstream.headers.get('location'),
        contentType,
        body,
        payload: null
      };
    }
    if (isHtml(contentType, body)) {
      return {
        ok: false,
        status: 503,
        contentType,
        payload: {
          error: `${serviceName} returned an HTML error page.`,
          code: `${serviceCode(serviceName)}_HTML_ERROR`,
          upstreamStatus: upstream.status,
          upstreamContentType: contentType,
          responsePreview: 'Upstream returned an HTML error page.'
        }
      };
    }

    let payload;
    try { payload = body.trim() ? JSON.parse(body) : null; } catch { payload = null; }
    if (!upstream.ok || payload === null) {
      const unavailable = upstream.status >= 500 || payload === null;
      return {
        ok: false,
        status: unavailable ? 503 : upstream.status,
        contentType,
        payload: {
          error: unavailable
            ? `${serviceName} is temporarily unavailable or returned an invalid JSON response.`
            : `${serviceName} returned HTTP ${upstream.status}.`,
          code: unavailable ? `${serviceCode(serviceName)}_UPSTREAM_UNAVAILABLE` : `${serviceCode(serviceName)}_UPSTREAM_HTTP_ERROR`,
          upstreamStatus: upstream.status,
          upstreamContentType: contentType,
          responsePreview: payload === null ? 'Upstream response was empty or not valid JSON.' : undefined
        }
      };
    }
    return { ok: true, status: 200, contentType, payload };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      ok: false,
      status: 503,
      payload: {
        error: timedOut
          ? `${serviceName} timed out after ${Math.round(timeoutMs / 1000)} seconds.`
          : `The proxy could not reach ${serviceName}.`,
        code: timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK_ERROR',
        timeoutMs
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

export function eventMethod(event = {}) {
  return String(event.httpMethod || event.requestContext?.http?.method || event.method || 'GET').toUpperCase();
}

export function getAllowedRedirectAccession(location) {
  if (!location) return null;
  try {
    const url = new URL(location, 'https://rest.uniprot.org');
    if (url.origin !== 'https://rest.uniprot.org') return null;
    const match = url.pathname.match(/^\/uniprotkb\/([A-Z0-9]{6,10})(?:\.json)?\/?$/i);
    return match ? match[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Adapt the existing Lambda-style business logic to Netlify's modern Request/Response API. */
export async function adaptLambdaHandler(request, lambdaHandler) {
  const url = new URL(request.url);
  const event = {
    httpMethod: request.method,
    rawUrl: request.url,
    rawQuery: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(request.headers.entries()),
    body: null,
    isBase64Encoded: false
  };
  const result = await lambdaHandler(event, {});
  return new Response(result?.body ?? '', {
    status: result?.statusCode ?? 200,
    headers: result?.headers ?? {}
  });
}
