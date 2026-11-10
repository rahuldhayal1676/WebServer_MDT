import test from "node:test";
import assert from "node:assert/strict";
import { handler } from "../netlify/functions/ncbi.js";

const SEQ = "MAEQQKKKLVLAKDF".repeat(40);

test("NCBI proxy returns validated RefSeq FASTA as JSON for the curated DHFR-TS accession", async () => {
  const originalFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async url => {
    requested = new URL(String(url));
    return new Response(`>XP_001351479.1 bifunctional dihydrofolate reductase-thymidylate synthase\n${SEQ.slice(0, 60)}\n${SEQ.slice(60)}\n`, { status: 200 });
  };
  try {
    const res = await handler({ rawQuery: "accession=XP_001351479.1" });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.accession, "XP_001351479.1");
    assert.equal(body.sequence, SEQ);
    assert.equal(body.sequenceLength, SEQ.length);
    assert.equal(requested.searchParams.get("id"), "XP_001351479.1");
  } finally { globalThis.fetch = originalFetch; }
});

test("NCBI proxy rejects other accessions without a network request", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("no network"); };
  try {
    const res = await handler({ rawQuery: "accession=NP_000001.1" });
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  } finally { globalThis.fetch = originalFetch; }
});

test("NCBI proxy reports an upstream HTML/invalid body as JSON, never as HTML", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><html>error</html>", { status: 200 });
  try {
    const res = await handler({ rawQuery: "accession=XP_001351479.1" });
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).code, "NCBI_INVALID_FASTA");
  } finally { globalThis.fetch = originalFetch; }
});
