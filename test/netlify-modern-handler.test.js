import test from 'node:test';
import assert from 'node:assert/strict';
import chemblFunction from '../netlify/functions/chembl.js';
import uniprotFunction from '../netlify/functions/uniprot.js';
import unichemFunction from '../netlify/functions/unichem.js';

const originalFetch = globalThis.fetch;

test('modern ChEMBL function accepts a web Request and returns a web Response', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok' }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
  try {
    const response = await chemblFunction(new Request('https://example.net/.netlify/functions/chembl?endpoint=status'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally { globalThis.fetch = originalFetch; }
});

test('modern UniProt function accepts a web Request and returns protein search JSON', async () => {
  globalThis.fetch = async url => {
    assert.match(String(url), /organism_id%3A5833|organism_id:5833/);
    return new Response(JSON.stringify({ results: [{ primaryAccession: 'Q8I6T1' }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const response = await uniprotFunction(new Request('https://example.net/.netlify/functions/uniprot?search=Falcipain%202'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { results: [{ primaryAccession: 'Q8I6T1' }] });
  } finally { globalThis.fetch = originalFetch; }
});

test('modern UniChem function accepts a web Request and returns a web Response', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify([{ src_compound_id: 'CHEMBL36' }]), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
  try {
    const response = await unichemFunction(new Request('https://example.net/.netlify/functions/unichem?cid=123'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ src_compound_id: 'CHEMBL36' }]);
  } finally { globalThis.fetch = originalFetch; }
});
