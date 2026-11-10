import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../netlify/functions/chembl.js';

const json = (payload, status = 200, headers = {}) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('Netlify ChEMBL proxy forwards compact molecule-indexed activity queries', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async input => { requestedUrl = String(input); return json({ activities: [], page_meta: { total_count: 0, next: null } }); };
  try {
    const response = await handler({ rawQuery: 'endpoint=activity&molecule_chembl_id=CHEMBL1&limit=200&only=activity_id,target_tax_id' });
    const url = new URL(requestedUrl);
    assert.equal(response.statusCode, 200);
    assert.equal(url.searchParams.get('molecule_chembl_id'), 'CHEMBL1');
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(url.searchParams.get('format'), 'json');
  } finally { globalThis.fetch = originalFetch; }
});

test('Netlify ChEMBL proxy handles batched target metadata', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async input => { requestedUrl = String(input); return json({ targets: [] }); };
  try {
    const response = await handler({ rawQuery: 'endpoint=target&target_chembl_id__in=CHEMBL364,CHEMBL1&limit=1000' });
    assert.equal(response.statusCode, 200);
    assert.match(requestedUrl, /target\.json/);
    assert.equal(new URL(requestedUrl).searchParams.get('target_chembl_id__in'), 'CHEMBL364,CHEMBL1');
  } finally { globalThis.fetch = originalFetch; }
});

test('Netlify ChEMBL proxy mechanism lookup is not forced through a taxonomy join', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async input => { requestedUrl = String(input); return json({ mechanisms: [] }); };
  try {
    const response = await handler({ rawQuery: 'endpoint=mechanism&molecule_chembl_id=CHEMBL1&limit=200' });
    const url = new URL(requestedUrl);
    assert.equal(response.statusCode, 200);
    assert.equal(url.searchParams.get('molecule_chembl_id'), 'CHEMBL1');
    assert.equal(url.searchParams.has('target_tax_id'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Netlify ChEMBL proxy sanitizes HTML even when the upstream returns HTTP 200', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!doctype html><html><body>private gateway details</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  try {
    const response = await handler({ rawQuery: 'endpoint=activity&molecule_chembl_id=CHEMBL1' });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 503);
    assert.equal(body.responsePreview, 'Upstream returned an HTML error page.');
    assert.equal(response.body.includes('<html'), false);
    assert.equal(response.body.includes('private gateway details'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('Netlify ChEMBL proxy sanitizes upstream 500 HTML and returns a stable JSON diagnostic', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<!doctype html><html><title>500</title></html>', { status: 500, headers: { 'Content-Type': 'text/html' } });
  try {
    const response = await handler({ rawQuery: 'endpoint=activity&molecule_chembl_id=CHEMBL1' });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 503);
    assert.equal(body.upstreamStatus, 500);
    assert.equal(body.responsePreview, 'Upstream returned an HTML error page.');
  } finally { globalThis.fetch = originalFetch; }
});

test('Netlify ChEMBL proxy rejects invalid target IDs before network access', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not call'); };
  try {
    const response = await handler({ rawQuery: 'endpoint=target-record&target_id=bad' });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, 'INVALID_TARGET_ID');
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});
