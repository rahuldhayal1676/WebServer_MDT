import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../netlify/functions/uniprot.js";

test("UniProt proxy retrieves a valid accession JSON entry", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ primaryAccession: "P12345", sequence: { value: "MPEPTIDE" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await handler({ rawQuery: "accession=P12345" });
    assert.equal(response.statusCode, 200);
    assert.match(requestedUrl, /uniprotkb\/P12345\.json$/);
    assert.equal(JSON.parse(response.body).primaryAccession, "P12345");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("UniProt proxy rejects malformed accessions without a network request", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("Should not be called"); };
  try {
    const response = await handler({ rawQuery: "accession=not%20valid" });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, "INVALID_UNIPROT_ACCESSION");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("UniProt proxy sends a P. falciparum-restricted protein-name search", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async url => {
    requestedUrl = new URL(String(url));
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await handler({ rawQuery: "search=Falcipain%202" });
    assert.equal(response.statusCode, 200);
    assert.equal(requestedUrl.pathname, "/uniprotkb/search");
    assert.equal(requestedUrl.searchParams.get("query"), '(organism_id:5833 OR organism_id:36329) AND protein_name:"Falcipain 2"');
    assert.equal(requestedUrl.searchParams.get("size"), "10");
    assert.deepEqual(JSON.parse(response.body), { results: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("UniProt proxy rejects unsafe protein-name search text", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("Should not be called"); };
  try {
    const response = await handler({ rawQuery: "search=Falcipain%202%22%20OR%20organism_id%3A*" });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).code, "INVALID_UNIPROT_SEARCH_NAME");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
