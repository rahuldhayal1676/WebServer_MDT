import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parsePubChemCidResponse,
  parsePubChemPropertyResponse,
  parseChemblMoleculeResponse,
  parseChemblMoleculeCandidateResponse,
  parseChemblStatusResponse,
  resolveChemblMoleculeByInchiKey,
  toChemblProxyUrl,
  clearApiSessionCache,
  requestJson,
  CHEMBL_REQUEST_TIMEOUT_MS,
  parseChemblActivityResponse,
  groupChemblActivitiesByTarget,
  retrieveChemblActivities,
  toUniProtProxyUrl,
  toUniProtNameSearchProxyUrl,
  parseChemblTargetResponse,
  parseUniProtProteinResponse,
  parseUniProtNameSearchResponse,
  retrievePfProteinTargets,
  parseChemblMechanismResponse
} from "../src/api.js";

const propertyFixture = JSON.parse(
  await readFile(new URL("./fixtures/pubchem-chloroquine-properties.json", import.meta.url), "utf8")
);
const cidFixture = JSON.parse(
  await readFile(new URL("./fixtures/pubchem-cids.json", import.meta.url), "utf8")
);


test("ChEMBL client timeout is longer than the slow successful pages observed in the browser", () => {
  assert.equal(CHEMBL_REQUEST_TIMEOUT_MS, 35_000);
});

test("parsePubChemCidResponse removes duplicate identifiers", () => {
  assert.deepEqual(parsePubChemCidResponse(cidFixture), ["2719", "2720"]);
});

test("parsePubChemCidResponse rejects an empty identifier response", () => {
  assert.throws(() => parsePubChemCidResponse({ IdentifierList: { CID: [] } }), {
    code: "NOT_FOUND"
  });
});

test("parsePubChemPropertyResponse maps the PubChem fields without inventing values", () => {
  const [compound] = parsePubChemPropertyResponse(propertyFixture);
  assert.equal(compound.cid, "2719");
  assert.equal(compound.title, "Chloroquine");
  assert.equal(compound.formula, "C18H26ClN3");
  assert.equal(compound.molecularWeight, 319.9);
  assert.equal(compound.iupacName, null);
  assert.equal(compound.connectivitySmiles, null);
  assert.equal(compound.smiles, null);
  assert.equal(compound.inchiKey, null);
  assert.equal(compound.sourceUrl, "https://pubchem.ncbi.nlm.nih.gov/compound/2719");
});

test("parsePubChemPropertyResponse preserves unavailable fields as null", () => {
  const [compound] = parsePubChemPropertyResponse({
    PropertyTable: { Properties: [{ CID: 123, MolecularFormula: "H2O" }] }
  });
  assert.equal(compound.iupacName, null);
  assert.equal(compound.smiles, null);
  assert.equal(compound.inchiKey, null);
});

test("parsePubChemPropertyResponse rejects an empty response", () => {
  assert.throws(() => parsePubChemPropertyResponse({ PropertyTable: { Properties: [] } }), {
    code: "NO_PROPERTIES"
  });
});


const chemblMoleculeFixture = JSON.parse(
  await readFile(new URL("./fixtures/chembl-molecule-response.json", import.meta.url), "utf8")
);
const chemblStatusFixture = JSON.parse(
  await readFile(new URL("./fixtures/chembl-status-response.json", import.meta.url), "utf8")
);

test("parseChemblMoleculeResponse maps an exact InChIKey match", () => {
  const [molecule] = parseChemblMoleculeResponse(
    chemblMoleculeFixture,
    "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"
  );
  assert.equal(molecule.chemblId, "CHEMBL25");
  assert.equal(molecule.preferredName, "ASPIRIN");
  assert.equal(molecule.standardInchiKey, "BSYNRYMUTXBXSQ-UHFFFAOYSA-N");
  assert.equal(molecule.molecularFormula, "C9H8O4");
  assert.equal(molecule.molecularWeight, 180.16);
  assert.equal(molecule.recordUrl, "https://www.ebi.ac.uk/chembl/compound_report_card/CHEMBL25/");
});

test("parseChemblMoleculeResponse discards non-exact and incomplete records", () => {
  const payload = {
    molecules: [
      ...chemblMoleculeFixture.molecules,
      {
        molecule_chembl_id: "CHEMBL999",
        pref_name: "Different structure",
        molecule_structures: { standard_inchi_key: "AAAAAAAAAAAAAA-BBBBBBBBBB-C" }
      },
      { molecule_chembl_id: "CHEMBL1000", pref_name: "No structure key", molecule_structures: null }
    ]
  };
  assert.deepEqual(
    parseChemblMoleculeResponse(payload, "BSYNRYMUTXBXSQ-UHFFFAOYSA-N").map(item => item.chemblId),
    ["CHEMBL25"]
  );
});

test("parseChemblMoleculeResponse rejects unexpected payload shape", () => {
  assert.throws(() => parseChemblMoleculeResponse({ targets: [] }, "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"), {
    code: "INVALID_CHEMBL_RESPONSE"
  });
});

test("parseChemblStatusResponse extracts the ChEMBL release metadata", () => {
  assert.deepEqual(parseChemblStatusResponse(chemblStatusFixture), {
    status: "UP",
    release: "ChEMBL_37",
    releaseDate: "2026-05-01"
  });
});


test("toChemblProxyUrl converts supported EBI ChEMBL URLs to same-origin proxy URLs", () => {
  const proxy = toChemblProxyUrl("https://www.ebi.ac.uk/chembl/api/data/molecule.json?limit=1000&offset=20");
  const parsed = new URL(proxy, "https://example.test");
  assert.equal(parsed.pathname, "/api/chembl");
  assert.equal(parsed.searchParams.get("endpoint"), "molecule");
  assert.equal(parsed.searchParams.get("limit"), "1000");
  assert.equal(parsed.searchParams.get("offset"), "20");
  const activityProxy = toChemblProxyUrl("https://www.ebi.ac.uk/chembl/api/data/activity.json?molecule_chembl_id=CHEMBL269671&limit=1000&offset=0");
  const activityParsed = new URL(activityProxy, "https://example.test");
  assert.equal(activityParsed.searchParams.get("endpoint"), "activity");
  assert.equal(activityParsed.searchParams.get("molecule_chembl_id"), "CHEMBL269671");
  const mechanismProxy = toChemblProxyUrl("https://www.ebi.ac.uk/chembl/api/data/mechanism.json?molecule_chembl_id=CHEMBL269671");
  assert.equal(new URL(mechanismProxy, "https://example.test").searchParams.get("endpoint"), "mechanism");
  const targetRecordProxy = toChemblProxyUrl("https://www.ebi.ac.uk/chembl/api/data/target/CHEMBL3486.json");
  const targetRecordParsed = new URL(targetRecordProxy, "https://example.test");
  assert.equal(targetRecordParsed.searchParams.get("endpoint"), "target-record");
  assert.equal(targetRecordParsed.searchParams.get("target_id"), "CHEMBL3486");
  assert.throws(() => toChemblProxyUrl("https://www.ebi.ac.uk/chembl/api/data/target/not-a-target.json"), { code: "INVALID_CHEMBL_URL" });
  assert.throws(() => toChemblProxyUrl("https://evil.example/molecule.json"), { code: "INVALID_CHEMBL_URL" });
});

test("resolveChemblMoleculeByInchiKey requests the exact InChIKey via the same-origin proxy", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  clearApiSessionCache();
  globalThis.fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith("/api/chembl?") && new URL(url, "https://example.test").searchParams.get("endpoint") === "status") {
      return new Response(JSON.stringify(chemblStatusFixture), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.startsWith("/api/chembl?") && new URL(url, "https://example.test").searchParams.get("endpoint") === "molecule") {
      return new Response(JSON.stringify(chemblMoleculeFixture), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    const result = await resolveChemblMoleculeByInchiKey("BSYNRYMUTXBXSQ-UHFFFAOYSA-N");
    const moleculeUrl = requestedUrls.find(url => url.startsWith("/api/chembl?") && new URL(url, "https://example.test").searchParams.get("endpoint") === "molecule");
    const parsedUrl = new URL(moleculeUrl, "https://example.test");
    assert.equal(
      parsedUrl.searchParams.get("molecule_structures__standard_inchi_key"),
      "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"
    );
    assert.equal(parsedUrl.searchParams.get("limit"), "1000");
    assert.equal(result.molecules[0].chemblId, "CHEMBL25");
    assert.equal(result.status.release, "ChEMBL_37");
    assert.ok(result.retrievedAt);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


const atovaquoneSynonymFixture = JSON.parse(
  await readFile(new URL("./fixtures/chembl-atovaquone-synonym-response.json", import.meta.url), "utf8")
);

test("parseChemblMoleculeCandidateResponse preserves a non-exact match classification", () => {
  const [candidate] = parseChemblMoleculeCandidateResponse(atovaquoneSynonymFixture, "exact-synonym");
  assert.equal(candidate.chemblId, "CHEMBL1450");
  assert.equal(candidate.standardInchiKey, "KUCQYCKVKVOKAY-CTYIDZIISA-N");
  assert.equal(candidate.molecularFormula, "C22H19ClO3");
  assert.equal(candidate.matchType, "exact-synonym");
  assert.match(candidate.matchLabel, /formula and molecular weight cross-checked/);
});

test("resolveChemblMoleculeByInchiKey uses one descriptor-checked name query after an empty exact match", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url, "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "status") {
      return new Response(JSON.stringify(chemblStatusFixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_structures__standard_inchi_key")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { limit: 1000, next: null, offset: 0, total_count: 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("pref_name__icontains")) {
      assert.equal(parsed.searchParams.get("pref_name__icontains"), "Atovaquone");
      return new Response(JSON.stringify(atovaquoneSynonymFixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  try {
    const result = await resolveChemblMoleculeByInchiKey("BSJMWHQBCZFXBR-UHFFFAOYSA-N", {
      input: "Atovaquone",
      inputType: "Name",
      formula: "C22H19ClO3",
      molecularWeight: 366.8
    });
    assert.equal(result.exactMatchCount, 0);
    assert.equal(result.matchType, "preferred-name-contains");
    assert.equal(result.molecules[0].chemblId, "CHEMBL1450");
    assert.match(result.matchLabel, /preferred name contains/);
    assert.equal(requestedUrls.filter(url => url.includes("endpoint=molecule")).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("name fallback makes only one broader preferred-name query", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const requestUrls = [];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    requestUrls.push(parsed);
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "status") return new Response(JSON.stringify(chemblStatusFixture), { status: 200 });
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_structures__standard_inchi_key")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("pref_name__icontains")) {
      return new Response(JSON.stringify(atovaquoneSynonymFixture), { status: 200 });
    }
    throw new Error(`Unexpected URL ${parsed.href}`);
  };
  try {
    const result = await resolveChemblMoleculeByInchiKey("BSJMWHQBCZFXBR-UHFFFAOYSA-N", {
      input: "Atovaquone", inputType: "Name", formula: "C22H19ClO3", molecularWeight: 366.8
    });
    assert.equal(result.molecules[0].chemblId, "CHEMBL1450");
    assert.equal(result.matchType, "preferred-name-contains");
    assert.equal(requestUrls.filter(url => url.searchParams.get("endpoint") === "molecule").length, 2);
    assert.ok(requestUrls.some(url => url.searchParams.has("pref_name__icontains")));
    assert.ok(!requestUrls.some(url => url.searchParams.has("molecule_synonyms__molecule_synonym__iexact")));
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("resolveChemblMoleculeByInchiKey finds Doxycycline through a descriptor-checked preferred-name fragment", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const requested = [];
  const doxycyclineChemblRecord = {
    molecules: [{
      molecule_chembl_id: "CHEMBL1433",
      pref_name: "DOXYCYCLINE ANHYDROUS",
      molecule_type: "Small molecule",
      max_phase: 4,
      molecule_structures: {
        // Deliberately different from the PubChem consensus key: this must
        // remain a review-only candidate, not an exact structural match.
        standard_inchi_key: "JBIWCJUYHHGXTC-AKNGSSGZSA-N",
        canonical_smiles: "C[C@H]1c2cccc(O)c2C(=O)C2=C(O)[C@]3(O)C(=O)C(C(N)=O)=C(O)[C@@H](N(C)C)[C@@H]3[C@@H](O)[C@@H]21"
      },
      molecule_properties: { full_molformula: "C22H24N2O8", full_mwt: 444.44 },
      molecule_synonyms: []
    }],
    page_meta: { limit: 100, offset: 0, total_count: 1, next: null }
  };

  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    requested.push(parsed);
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "status") return new Response(JSON.stringify(chemblStatusFixture), { status: 200 });
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_structures__standard_inchi_key")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_synonyms__molecule_synonym__iexact")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("pref_name__iexact")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("pref_name__icontains")) {
      assert.equal(parsed.searchParams.get("pref_name__icontains"), "Doxycycline");
      return new Response(JSON.stringify(doxycyclineChemblRecord), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${parsed.href}`);
  };

  try {
    const result = await resolveChemblMoleculeByInchiKey("SGKRLCUYIXIAHR-AKNGSSGZSA-N", {
      input: "Doxycycline",
      inputType: "Name",
      formula: "C22H24N2O8",
      molecularWeight: 444.4
    });
    assert.equal(result.matchType, "preferred-name-contains");
    assert.equal(result.molecules[0].chemblId, "CHEMBL1433");
    assert.equal(result.molecules[0].preferredName, "DOXYCYCLINE ANHYDROUS");
    assert.equal(result.molecules[0].standardInchiKey, "JBIWCJUYHHGXTC-AKNGSSGZSA-N");
    assert.match(result.matchLabel, /full structure key differs/i);
    assert.equal(result.molecules[0].matchType, "preferred-name-contains");
    assert.ok(requested.some(url => url.searchParams.get("pref_name__icontains") === "Doxycycline"));
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("preferred-name fragment candidates are rejected when formula descriptors disagree", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "status") return new Response(JSON.stringify(chemblStatusFixture), { status: 200 });
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_structures__standard_inchi_key")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && (parsed.searchParams.has("molecule_synonyms__molecule_synonym__iexact") || parsed.searchParams.has("pref_name__iexact"))) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("pref_name__icontains")) {
      return new Response(JSON.stringify({ molecules: [{
        molecule_chembl_id: "CHEMBL9999",
        pref_name: "DOXYCYCLINE ANALOGUE",
        molecule_structures: { standard_inchi_key: "AAAAAAAAAAAAAA-BBBBBBBBBB-C" },
        molecule_properties: { full_molformula: "C19H21N3O", full_mwt: 307.4 }
      }], page_meta: { total_count: 1, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_structures__canonical_smiles__connectivity")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${parsed.href}`);
  };
  try {
    const result = await resolveChemblMoleculeByInchiKey("SGKRLCUYIXIAHR-AKNGSSGZSA-N", {
      input: "Doxycycline", inputType: "Name", formula: "C22H24N2O8", molecularWeight: 444.4,
      connectivitySmiles: "CC(O)"
    });
    assert.equal(result.molecules.length, 0);
    assert.equal(result.matchType, null);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("resolveChemblMoleculeByInchiKey rejects preferred-name candidates with incompatible formula", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "status") return new Response(JSON.stringify(chemblStatusFixture), { status: 200 });
    if (endpoint === "molecule" && parsed.searchParams.has("molecule_structures__standard_inchi_key")) {
      return new Response(JSON.stringify({ molecules: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "molecule" && parsed.searchParams.has("pref_name__icontains")) {
      return new Response(JSON.stringify(atovaquoneSynonymFixture), { status: 200 });
    }
    throw new Error(`Unexpected URL ${String(input)}`);
  };
  try {
    const result = await resolveChemblMoleculeByInchiKey("BSJMWHQBCZFXBR-UHFFFAOYSA-N", {
      input: "Atovaquone", inputType: "Name", formula: "C20H21N3O", molecularWeight: 319.4
    });
    assert.equal(result.molecules.length, 0);
    assert.equal(result.matchType, null);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


const chemblActivityFixture = JSON.parse(
  await readFile(new URL("./fixtures/chembl-activity-response.json", import.meta.url), "utf8")
);

test("parseChemblActivityResponse maps target and assay fields without changing activity values", () => {
  const [activity] = parseChemblActivityResponse(chemblActivityFixture);
  assert.equal(activity.activityId, 10991473);
  assert.equal(activity.moleculeChemblId, "CHEMBL2069840");
  assert.equal(activity.targetChemblId, "CHEMBL340");
  assert.equal(activity.targetName, "Cytochrome P450 3A4");
  assert.equal(activity.targetOrganism, "Homo sapiens");
  assert.equal(activity.targetType, "SINGLE PROTEIN");
  assert.equal(activity.standardType, "IC50");
  assert.equal(activity.standardRelation, "=");
  assert.equal(activity.standardValue, "1000.0");
  assert.equal(activity.standardUnits, "nM");
  assert.equal(activity.pchemblValue, "6.00");
});

test("parseChemblActivityResponse rejects a missing activities collection", () => {
  assert.throws(() => parseChemblActivityResponse({ targets: [] }), {
    code: "INVALID_CHEMBL_ACTIVITY_RESPONSE"
  });
});

test("groupChemblActivitiesByTarget groups rows and retains rows without a target ID", () => {
  const first = parseChemblActivityResponse(chemblActivityFixture)[0];
  const second = { ...first, activityId: 10991474 };
  const unassigned = { ...first, activityId: 10991475, targetChemblId: null, targetName: null };
  const groups = groupChemblActivitiesByTarget([first, second, unassigned]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].targetChemblId, "CHEMBL340");
  assert.equal(groups[0].recordCount, 2);
  assert.equal(groups[1].targetChemblId, null);
  assert.equal(groups[1].recordCount, 1);
  assert.equal(groups.reduce((sum, group) => sum + group.recordCount, 0), 3);
});

test("retrieveChemblActivities uses page_meta.next, bounded parallel pages, and verifies total_count", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  clearApiSessionCache();

  const makeRows = (startId, count) => Array.from({ length: count }, (_, index) => ({
    ...chemblActivityFixture.activities[0],
    activity_id: startId + index
  }));

  globalThis.fetch = async input => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url, "https://example.test");
    assert.equal(parsed.pathname, "/api/chembl");
    assert.equal(parsed.searchParams.get("endpoint"), "activity");
    assert.equal(parsed.searchParams.get("molecule_chembl_id"), "CHEMBL2069840");
    assert.equal(parsed.searchParams.get("limit"), "500");

    const offset = Number(parsed.searchParams.get("offset"));
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    // Small delay lets the test verify that page requests overlap.
    await new Promise(resolve => setTimeout(resolve, 10));
    activeRequests -= 1;

    let activities;
    let next = null;
    if (offset === 0) {
      activities = makeRows(100000, 500);
      next = "https://www.ebi.ac.uk/chembl/api/data/activity.json?limit=500&offset=500";
    } else if (offset === 500) {
      activities = makeRows(100500, 500);
      next = "https://www.ebi.ac.uk/chembl/api/data/activity.json?limit=500&offset=1000";
    } else if (offset === 1000) {
      activities = makeRows(101000, 500);
      next = "https://www.ebi.ac.uk/chembl/api/data/activity.json?limit=500&offset=1500";
    } else if (offset === 1500) {
      activities = makeRows(101500, 1);
    } else {
      throw new Error(`Unexpected offset: ${offset}`);
    }

    return new Response(JSON.stringify({
      activities,
      page_meta: { limit: 500, next, offset, previous: offset ? "previous" : null, total_count: 1501 }
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const progress = [];
    const result = await retrieveChemblActivities("CHEMBL2069840", {
      onProgress: value => progress.push(value)
    });
    const firstUrl = new URL(requestedUrls[0], "https://example.test");
    const requestedOffsets = requestedUrls.map(url => new URL(url, "https://example.test").searchParams.get("offset"));
    assert.equal(firstUrl.searchParams.get("limit"), "500");
    assert.equal(firstUrl.searchParams.get("offset"), "0");
    assert.equal(firstUrl.searchParams.get("format"), "json");
    assert.equal(firstUrl.searchParams.get("only").includes("standard_value"), true);
    assert.equal(firstUrl.searchParams.get("order_by"), "activity_id");
    assert.deepEqual(new Set(requestedOffsets), new Set(["0", "500", "1000", "1500"]));
    assert.equal(requestedUrls.length, 4);
    assert.ok(maxActiveRequests >= 2, `Expected overlapping requests; max observed concurrency was ${maxActiveRequests}`);
    assert.ok(maxActiveRequests <= 3, `Concurrency exceeded the configured limit: ${maxActiveRequests}`);
    assert.equal(result.totalCount, 1501);
    assert.equal(result.retrievedCount, 1501);
    assert.equal(result.pageCount, 4);
    assert.equal(result.groupCount, 1);
    assert.equal(result.countMatches, true);
    assert.equal(result.groups[0].targetChemblId, "CHEMBL340");
    assert.equal(result.groups[0].recordCount, 1501);
    assert.equal(result.pageLimit, 500);
    assert.equal(result.maxConcurrentRequests, 3);
    assert.equal(progress.at(-1).retrievedCount, 1501);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("requestJson gives useful diagnostics when a ChEMBL proxy returns HTML instead of JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><html><body>Gateway error</body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
  try {
    await assert.rejects(
      requestJson("/api/chembl?endpoint=activity&molecule_chembl_id=CHEMBL269671", {
        serviceName: "ChEMBL activity service",
        retries: 0,
        useCache: false
      }),
      error => {
        assert.equal(error.code, "INVALID_JSON");
        assert.match(error.message, /HTML page instead of JSON/);
        assert.match(error.message, /content-type: text\/html/);
        assert.match(error.message, /Gateway error/);
        assert.equal(error.details.contentType, "text/html; charset=utf-8");
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


const pfActivityFixture = JSON.parse(await readFile(new URL("./fixtures/chembl-pf-activity-response.json", import.meta.url), "utf8"));
const pfTargetFixture = JSON.parse(await readFile(new URL("./fixtures/chembl-target-response.json", import.meta.url), "utf8"));
const uniprotFixture = JSON.parse(await readFile(new URL("./fixtures/uniprot-protein-response.json", import.meta.url), "utf8"));
const mechanismFixture = JSON.parse(await readFile(new URL("./fixtures/chembl-mechanism-response.json", import.meta.url), "utf8"));

test("toUniProtProxyUrl validates and routes UniProtKB accessions", () => {
  assert.equal(toUniProtProxyUrl("p12345"), "/api/uniprot?accession=P12345");
  assert.throws(() => toUniProtProxyUrl("bad accession"), { code: "INVALID_UNIPROT_ACCESSION" });
});

test("parseChemblTargetResponse maps target type, organism and component accessions from a collection", () => {
  const targets = parseChemblTargetResponse(pfTargetFixture);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].targetType, "SINGLE PROTEIN");
  assert.equal(targets[0].organism, "Plasmodium falciparum");
  assert.equal(targets[0].components[0].accession, "P12345");
  assert.equal(targets[1].targetType, "ORGANISM");
  assert.deepEqual(targets[1].components, []);
});

test("parseChemblTargetResponse accepts a single-target resource response", () => {
  const [target] = parseChemblTargetResponse({
    target_chembl_id: "CHEMBL3486",
    pref_name: "Dihydroorotate dehydrogenase",
    target_type: "SINGLE PROTEIN",
    organism: "Plasmodium falciparum",
    tax_id: 5833,
    target_components: [{
      accession: "Q54A96",
      component_id: 3486,
      component_type: "PROTEIN",
      component_description: "Dihydroorotate dehydrogenase (quinone), mitochondrial"
    }]
  });
  assert.equal(target.chemblId, "CHEMBL3486");
  assert.equal(target.name, "Dihydroorotate dehydrogenase");
  assert.equal(target.targetType, "SINGLE PROTEIN");
  assert.equal(target.organism, "Plasmodium falciparum");
  assert.equal(target.taxonId, 5833);
  assert.equal(target.components[0].accession, "Q54A96");
  assert.equal(target.components[0].description, "Dihydroorotate dehydrogenase (quinone), mitochondrial");
});

test("parseChemblMechanismResponse preserves curated action and interaction metadata", () => {
  const [mechanism] = parseChemblMechanismResponse(mechanismFixture);
  assert.equal(mechanism.targetChemblId, "CHEMBL9001");
  assert.equal(mechanism.mechanismOfAction, "Example inhibitor of parasite enzyme");
  assert.equal(mechanism.actionType, "INHIBITOR");
  assert.equal(mechanism.directInteraction, true);
});

test("toUniProtNameSearchProxyUrl creates a same-origin search and rejects unsafe query text", () => {
  const parsed = new URL(toUniProtNameSearchProxyUrl("Falcipain 2"), "https://example.test");
  assert.equal(parsed.pathname, "/api/uniprot");
  assert.equal(parsed.searchParams.get("search"), "Falcipain 2");
  assert.throws(() => toUniProtNameSearchProxyUrl('Falcipain 2" OR organism_id:*'), {
    code: "INVALID_UNIPROT_SEARCH_NAME"
  });
});

test("parseUniProtNameSearchResponse accepts exact normalized P. falciparum name matches only", () => {
  const entry = {
    primaryAccession: "Q9N6S8",
    proteinDescription: { submissionNames: [{ fullName: { value: "Falcipain-2" } }] },
    organism: { scientificName: "Plasmodium falciparum", taxonId: 5833 },
    sequence: { value: "MPEPTIDE", length: 8 },
    uniProtKBCrossReferences: [{ database: "ChEMBL", id: "CHEMBL5800" }]
  };
  const results = parseUniProtNameSearchResponse({ results: [
    entry,
    { ...entry, primaryAccession: "P12345", organism: { scientificName: "Plasmodium vivax", taxonId: 5855 } },
    { ...entry, primaryAccession: "P54321", proteinDescription: { submissionNames: [{ fullName: { value: "Falcipain-like protein" } }] } },
    { ...entry, primaryAccession: "Q7KWJ5", organism: { scientificName: "Plasmodium falciparum (isolate 3D7)", taxonId: 36329 }, proteinDescription: { recommendedName: { fullName: { value: "Falcipain 2" } } } }
  ] }, "Falcipain 2");
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.accession).sort(), ["Q7KWJ5", "Q9N6S8"]);
  assert.equal(results.find(item => item.accession === "Q9N6S8").taxonId, 5833);
  assert.equal(results.find(item => item.accession === "Q7KWJ5").taxonId, 36329);
  assert.equal(results[0].nameMatchType, "normalized-exact");
  assert.equal(results.find(item => item.accession === "Q9N6S8").chemblCrossReferences.includes("CHEMBL5800"), true);
  assert.equal(results.find(item => item.accession === "Q9N6S8").sequence, "MPEPTIDE");
});

test("parseUniProtProteinResponse preserves organism, accession and sequence", () => {
  const protein = parseUniProtProteinResponse(uniprotFixture, "P12345");
  assert.equal(protein.accession, "P12345");
  assert.equal(protein.proteinName, "Example parasite protein");
  assert.equal(protein.geneName, "example1");
  assert.equal(protein.organism, "Plasmodium falciparum");
  assert.equal(protein.sequence, "MALWMRLLPLLALLALWGPGPGG");
  assert.equal(protein.sequenceLength, 22);
});

test("retrievePfProteinTargets filters to malaria evidence and hydrates only single-protein UniProt candidates", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const url = String(input);
    requestedUrls.push(url);
    const parsed = new URL(url, "https://example.test");
    if (parsed.pathname === "/api/chembl" && parsed.searchParams.get("endpoint") === "activity") {
      assert.equal(parsed.searchParams.get("target_tax_id"), "5833");
      assert.equal(parsed.searchParams.has("target_organism__in"), false);
      return new Response(JSON.stringify(pfActivityFixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/chembl" && parsed.searchParams.get("endpoint") === "target-record") {
      const targetId = parsed.searchParams.get("target_id");
      assert.ok(["CHEMBL9001", "CHEMBL364"].includes(targetId));
      const targetRecord = pfTargetFixture.targets.find(target => target.target_chembl_id === targetId);
      assert.ok(targetRecord);
      return new Response(JSON.stringify(targetRecord), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/chembl" && parsed.searchParams.get("endpoint") === "mechanism") {
      assert.equal(parsed.searchParams.has("only"), false);
      return new Response(JSON.stringify(mechanismFixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/uniprot" && parsed.searchParams.get("accession") === "P12345") {
      return new Response(JSON.stringify(uniprotFixture), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(result.malariaActivityTotal, 2);
    assert.equal(result.malariaActivityRetrieved, 2);
    assert.equal(result.malariaActivityCountMatches, true);
    assert.equal(result.targetCount, 2);
    assert.equal(result.mechanismCount, 1);
    assert.equal(result.nonProteinTargets.length, 1);
    assert.equal(result.proteins.length, 1);
    assert.equal(result.proteins[0].chemblId, "CHEMBL9001");
    assert.equal(result.proteins[0].activityCount, 1);
    assert.equal(result.proteins[0].mechanismCount, 1);
    assert.equal(result.proteins[0].mechanisms[0].mechanismOfAction, "Example inhibitor of parasite enzyme");
    assert.equal(result.proteins[0].uniprot.sequence, "MALWMRLLPLLALLALWGPGPGG");
    assert.equal(result.sequenceCount, 1);
    assert.ok(requestedUrls.some(url => url.includes("target_tax_id=5833")));
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("retrievePfProteinTargets does not invent proteins from organism-only activity records", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    if (parsed.pathname === "/api/chembl" && parsed.searchParams.get("endpoint") === "activity") {
      const organismOnly = { activities: [pfActivityFixture.activities[1]], page_meta: { limit: 500, next: null, offset: 0, total_count: 1 } };
      return new Response(JSON.stringify(organismOnly), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/chembl" && parsed.searchParams.get("endpoint") === "target-record") {
      return new Response(JSON.stringify(pfTargetFixture.targets[1]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/chembl" && parsed.searchParams.get("endpoint") === "mechanism") {
      return new Response(JSON.stringify({ error: "temporary upstream failure" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected test URL: ${String(input)}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(result.targetCount, 1);
    assert.equal(result.nonProteinTargets.length, 1);
    assert.equal(result.proteins.length, 0);
    assert.equal(result.sequenceCount, 0);
    assert.match(result.mechanismWarning, /temporary upstream failure/);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


test("retrievePfProteinTargets falls back to exact UniProt name matches when ChEMBL target metadata is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const activities = {
    activities: [
      { activity_id: 701, target_chembl_id: "CHEMBL364", target_pref_name: "Plasmodium falciparum", target_organism: "Plasmodium falciparum", target_tax_id: 5833 },
      { activity_id: 702, target_chembl_id: "CHEMBL4697", target_pref_name: "Hexose transporter 1", target_organism: "Plasmodium falciparum", target_tax_id: 5833 },
      { activity_id: 703, target_chembl_id: "CHEMBL5800", target_pref_name: "Falcipain 2", target_organism: "Plasmodium falciparum", target_tax_id: 5833 }
    ],
    page_meta: { limit: 500, next: null, offset: 0, total_count: 3 }
  };
  const makeUniprotEntry = (accession, proteinName, sequence) => ({
    primaryAccession: accession,
    proteinDescription: { recommendedName: { fullName: { value: proteinName } } },
    organism: { scientificName: "Plasmodium falciparum", taxonId: 5833 },
    sequence: { value: sequence, length: sequence.length }
  });
  const uniprotEntries = {
    "Hexose transporter 1": makeUniprotEntry("O97467", "Hexose transporter 1", "MHEXOSESEQ"),
    "Falcipain 2": makeUniprotEntry("Q9N6S8", "Falcipain 2", "MFALCIPAINSEQ")
  };
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "mechanism") {
      return new Response(JSON.stringify({ error: "ChEMBL temporarily unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "activity") {
      return new Response(JSON.stringify(activities), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "target-record") {
      return new Response(JSON.stringify({ error: "ChEMBL temporarily unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.pathname === "/api/uniprot" && parsed.searchParams.has("search")) {
      const name = parsed.searchParams.get("search");
      const entry = uniprotEntries[name];
      return new Response(JSON.stringify({ results: entry ? [entry] : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected test URL: ${String(input)}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL36", { forceRefresh: true });
    assert.equal(result.malariaActivityRetrieved, 3);
    assert.equal(result.targetCount, 3);
    assert.equal(result.mechanismCount, 0);
    assert.equal(result.mechanismStatus, "unavailable");
    assert.equal(result.proteins.length, 0);
    assert.deepEqual(result.uniprotNameCandidates.map(item => item.accession).sort(), ["O97467", "Q9N6S8"]);
    assert.equal(result.sequenceCount, 2);
    assert.equal(result.uniprotNameCandidates.find(item => item.accession === "Q9N6S8").chemblId, "CHEMBL5800");
    assert.equal(result.uniprotNameCandidates.find(item => item.accession === "O97467").chemblId, "CHEMBL4697");
    assert.equal(result.unclassifiedTargets.length, 3);
    assert.equal(result.excludedTargets.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("retrievePfProteinTargets resolves Atovaquone's CHEMBL3486 target through the single-record endpoint", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const atovaquoneActivities = {
    activities: [
      {
        activity_id: 501,
        target_chembl_id: "CHEMBL3486",
        target_pref_name: "Dihydroorotate dehydrogenase",
        target_organism: "Plasmodium falciparum",
        target_tax_id: 5833,
        target_type: "SINGLE PROTEIN",
        assay_chembl_id: "CHEMBLASSAY501",
        assay_description: "Inhibition of Plasmodium falciparum DHODH",
        assay_type: "B",
        standard_type: "IC50",
        standard_relation: "=",
        standard_value: "10000",
        standard_units: "nM",
        document_chembl_id: "CHEMBLDOC501",
        document_year: 2013
      },
      {
        activity_id: 502,
        target_chembl_id: "CHEMBL364",
        target_pref_name: "Plasmodium falciparum",
        target_organism: "Plasmodium falciparum",
        target_tax_id: 5833,
        target_type: "ORGANISM",
        assay_chembl_id: "CHEMBLASSAY502",
        assay_description: "Whole-organism antimalarial activity",
        assay_type: "F",
        standard_type: "IC50",
        standard_relation: "=",
        standard_value: "1",
        standard_units: "uM",
        document_chembl_id: "CHEMBLDOC502",
        document_year: 2013
      }
    ],
    page_meta: { limit: 500, next: null, offset: 0, total_count: 2 }
  };
  const atovaquoneTarget = {
    target_chembl_id: "CHEMBL3486",
    pref_name: "Dihydroorotate dehydrogenase",
    target_type: "SINGLE PROTEIN",
    organism: "Plasmodium falciparum",
    tax_id: 5833,
    target_components: [{
      accession: "Q54A96",
      component_id: 3486,
      component_type: "PROTEIN",
      component_description: "Dihydroorotate dehydrogenase (quinone), mitochondrial"
    }]
  };
  const atovaquoneUniprot = {
    primaryAccession: "Q54A96",
    entryType: "UniProtKB unreviewed (TrEMBL)",
    proteinDescription: { recommendedName: { fullName: { value: "Dihydroorotate dehydrogenase (quinone), mitochondrial" } } },
    genes: [{ geneName: { value: "dhod" } }],
    organism: { scientificName: "Plasmodium falciparum", taxonId: 5833 },
    sequence: { value: "MTESTSEQUENCE", length: 12 }
  };

  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") return new Response(JSON.stringify(atovaquoneActivities), { status: 200 });
    if (endpoint === "mechanism") return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    if (endpoint === "target-record") {
      const targetId = parsed.searchParams.get("target_id");
      const targetRecord = targetId === "CHEMBL3486"
        ? atovaquoneTarget
        : pfTargetFixture.targets.find(target => target.target_chembl_id === targetId);
      assert.ok(targetRecord, `Unexpected target ID ${targetId}`);
      return new Response(JSON.stringify(targetRecord), { status: 200 });
    }
    if (parsed.pathname === "/api/uniprot" && parsed.searchParams.get("accession") === "Q54A96") {
      return new Response(JSON.stringify(atovaquoneUniprot), { status: 200 });
    }
    throw new Error(`Unexpected test URL: ${String(input)}`);
  };

  try {
    const result = await retrievePfProteinTargets("CHEMBL1450", { forceRefresh: true });
    assert.equal(result.malariaActivityTotal, 2);
    assert.equal(result.targetCount, 2);
    assert.equal(result.proteins.length, 1);
    assert.equal(result.proteins[0].chemblId, "CHEMBL3486");
    assert.equal(result.proteins[0].accession, "Q54A96");
    assert.equal(result.proteins[0].uniprot.geneName, "dhod");
    assert.equal(result.proteins[0].uniprot.sequence, "MTESTSEQUENCE");
    assert.equal(result.proteins[0].activityCount, 1);
    assert.equal(result.excludedTargets.length, 1);
    assert.equal(result.excludedTargets[0].chemblId, "CHEMBL364");
    assert.equal(result.excludedTargets[0].targetType, "ORGANISM");
    assert.equal(result.sequenceCount, 1);
    assert.equal(result.targetLookupWarnings.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("retrievePfProteinTargets preserves activity-derived organism labels when target metadata fails", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") {
      return new Response(JSON.stringify({ activities: [pfActivityFixture.activities[1]], page_meta: { limit: 500, next: null, offset: 0, total_count: 1 } }), { status: 200 });
    }
    if (endpoint === "mechanism") {
      return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0, next: null } }), { status: 200 });
    }
    if (endpoint === "target-record") {
      return new Response(JSON.stringify({ error: "upstream failure" }), { status: 500 });
    }
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(result.targetCount, 1);
    assert.equal(result.proteins.length, 0);
    assert.equal(result.excludedTargets.length, 0, "missing type metadata must not be labelled as a confirmed non-protein target");
    assert.equal(result.unclassifiedTargets.length, 1);
    assert.equal(result.unclassifiedTargets[0].chemblId, "CHEMBL364");
    assert.equal(result.unclassifiedTargets[0].name, "Plasmodium falciparum");
    assert.equal(result.unclassifiedTargets[0].organism, "Plasmodium falciparum");
    assert.equal(result.targetLookupWarnings.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("retrievePfProteinTargets reports an HTML ChEMBL 500 without sending equivalent fallback filters", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const seen = [];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    seen.push(parsed);
    if (parsed.searchParams.get("endpoint") === "activity") {
      return new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title><body>There was a technical error.</body></html>", {
        status: 500, headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    throw new Error(`Unexpected request after ChEMBL outage: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(result.activityUnavailable, true);
    assert.equal(result.malariaActivityRetrieved, 0);
    assert.equal(seen.filter(url => url.searchParams.get("endpoint") === "activity").length, 1);
    assert.equal(seen.filter(url => url.searchParams.get("endpoint") === "mechanism").length, 1);
    assert.equal(seen.filter(url => url.searchParams.get("endpoint") === "activity")[0].searchParams.get("target_tax_id"), "5833");
    assert.equal(seen.some(url => url.searchParams.get("endpoint") === "target"), false);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("malaria protein discovery prefers the exact P. falciparum taxonomy filter", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  let requested;
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    if (parsed.searchParams.get("endpoint") === "activity") {
      requested = parsed;
      return new Response(JSON.stringify({
        activities: [],
        page_meta: { limit: 500, offset: 0, next: null, total_count: 0 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (parsed.searchParams.get("endpoint") === "mechanism") {
      return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0 } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(requested.searchParams.get("target_tax_id"), "5833");
    assert.equal(requested.searchParams.has("target_organism__in"), false);
    assert.equal(result.activityFilterMode, "tax-id");
    assert.equal(result.malariaActivityRetrieved, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("malaria pagination rejects a broken next offset instead of skipping activity records", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") {
      return new Response(JSON.stringify({
        activities: [{ activity_id: 1, target_chembl_id: "CHEMBL364", target_organism: "Plasmodium falciparum", target_tax_id: 5833 }],
        page_meta: { limit: 100, offset: 0, next: "/chembl/api/data/activity.json?limit=100&offset=200", total_count: 201 }
      }), { status: 200 });
    }
    throw new Error(`Unexpected request after invalid page link: ${parsed.href}`);
  };
  try {
    await assert.rejects(
      retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true }),
      error => error.code === "PF_ACTIVITY_OFFSET_MISMATCH"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("malaria discovery falls back to organism-name filter only when taxonomy filter gets HTTP 400", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const requestedFilters = [];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") {
      requestedFilters.push({ taxId: parsed.searchParams.get("target_tax_id"), organism: parsed.searchParams.get("target_organism__in") });
      if (parsed.searchParams.has("target_tax_id")) {
        return new Response(JSON.stringify({ error_message: "Unsupported target_tax_id filter" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({
        activities: [],
        page_meta: { limit: 500, offset: 0, next: null, total_count: 0 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "mechanism") {
      return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0 } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.deepEqual(requestedFilters, [
      { taxId: "5833", organism: null },
      { taxId: null, organism: "Plasmodium falciparum" }
    ]);
    assert.equal(result.activityFilterMode, "organism");
    assert.equal(result.activityQueryWarnings.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("malaria pagination retries one failed chunk and keeps other successful chunks as partial evidence", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const seenOffsets = [];
  let offsetOneAttempts = 0;
  const baseRecord = {
    target_chembl_id: "CHEMBL364",
    target_pref_name: "Plasmodium falciparum",
    target_organism: "Plasmodium falciparum",
    target_tax_id: 5833
  };
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") {
      const offset = Number(parsed.searchParams.get("offset") || 0);
      seenOffsets.push(offset);
      if (offset === 0) return new Response(JSON.stringify({
        activities: [{ ...baseRecord, activity_id: 1 }],
        page_meta: { limit: 100, offset: 0, next: "/chembl/api/data/activity.json?limit=100&offset=100", total_count: 201 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (offset === 100) {
        offsetOneAttempts += 1;
        return new Response(JSON.stringify({ error: "Upstream ChEMBL timeout", activities: [], code: "CHEMBL_UPSTREAM_UNAVAILABLE", upstreamStatus: 500 }), {
          status: 503, headers: { "Content-Type": "application/json" }
        });
      }
      if (offset === 200) return new Response(JSON.stringify({
        activities: [{ ...baseRecord, activity_id: 201 }],
        page_meta: { limit: 100, offset: 200, next: null, total_count: 201 }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "target-record") return new Response(JSON.stringify({
      target_chembl_id: "CHEMBL364", pref_name: "Plasmodium falciparum", organism: "Plasmodium falciparum",
      target_type: "ORGANISM", target_components: []
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (endpoint === "mechanism") return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0 } }), { status: 200 });
    throw new Error(`Unexpected request: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(offsetOneAttempts, 2, "failed offset is attempted once plus exactly one retry");
    assert.deepEqual(seenOffsets.sort((a, b) => a - b), [0, 100, 100, 200]);
    assert.equal(result.malariaActivityRetrieved, 2);
    assert.equal(result.malariaActivityTotal, 201);
    assert.equal(result.activityComplete, false);
    assert.deepEqual(result.activityMissingOffsets, [100]);
    assert.equal(result.targetCount, 1, "target attribution from retained activity rows is still processed");
    assert.equal(result.unclassifiedTargets.length, 1, "organism name is retained but missing ChEMBL type metadata is not guessed");
    assert.equal(result.excludedTargets.length, 0);
    assert.ok(result.activityQueryWarnings.some(item => item.offset === 100));
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("requestJson identifies the EMBL-EBI HTML HTTP 500 page as an upstream ChEMBL outage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<!doctype html><html><title>Error: 500 | EMBL's European Bioinformatics Institute</title><body>There was a technical error.</body></html>",
    { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
  try {
    await assert.rejects(
      requestJson("/api/chembl?endpoint=activity", { serviceName: "ChEMBL malaria-target association service", retries: 0 }),
      error => error.code === "CHEMBL_UPSTREAM_EBI_OUTAGE"
        && /temporarily unavailable/i.test(error.message)
        && /HTTP 500/.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ChEMBL circuit breaker stops repeated requests for 20 seconds after an upstream outage", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title><body>Technical error</body></html>", {
      status: 500, headers: { "Content-Type": "text/html" }
    });
  };
  try {
    await assert.rejects(requestJson("/api/chembl?endpoint=status", { retries: 2 }), {
      code: "CHEMBL_UPSTREAM_EBI_OUTAGE"
    });
    await assert.rejects(requestJson("/api/chembl?endpoint=molecule", { retries: 2 }), {
      code: "CHEMBL_CIRCUIT_OPEN"
    });
    assert.equal(fetchCount, 1, "only the first request should reach the unavailable backend");
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("resolveChemblMoleculeByInchiKey does not issue slow name fallbacks after an exact lookup outage", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const requested = [];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    requested.push(parsed);
    if (parsed.searchParams.get("endpoint") === "molecule") {
      return new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title></html>", {
        status: 500, headers: { "Content-Type": "text/html" }
      });
    }
    throw new Error(`Unexpected follow-up request: ${parsed.href}`);
  };
  try {
    await assert.rejects(
      resolveChemblMoleculeByInchiKey("AAAAAAAAAAAAAA-BBBBBBBBBB-C", {
        input: "Aspirin", inputType: "Name", formula: "C9H8O4", molecularWeight: 180.16
      }),
      error => error.code === "CHEMBL_UPSTREAM_EBI_OUTAGE"
    );
    assert.equal(requested.length, 1, "exact-key outage should stop all fallback and status requests");
    assert.ok(requested[0].searchParams.has("molecule_structures__standard_inchi_key"));
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("retrievePfProteinTargets does not launch a broad selected-molecule query after an upstream HTML 500", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const requested = [];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    requested.push(parsed);
    if (parsed.searchParams.get("endpoint") === "activity") {
      return new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title></html>", {
        status: 500, headers: { "Content-Type": "text/html" }
      });
    }
    throw new Error(`Unexpected request after ChEMBL outage: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(result.activityUnavailable, true);
    assert.equal(requested.filter(url => url.searchParams.get("endpoint") === "activity").length, 1);
    assert.equal(requested.filter(url => url.searchParams.get("endpoint") === "mechanism").length, 1);
    assert.equal(requested.some(url => url.searchParams.get("endpoint") === "molecule"), false);
    assert.equal(requested.some(url => url.searchParams.get("endpoint") === "target-record"), false);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

test("retrievePfProteinTargets does not retry target metadata through another endpoint after an EBI 500", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  let targetRequests = 0;
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") return new Response(JSON.stringify(pfActivityFixture), { status: 200 });
    if (endpoint === "target-record") {
      targetRequests += 1;
      return new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title></html>", {
        status: 500, headers: { "Content-Type": "text/html" }
      });
    }
    throw new Error(`Unexpected request after target metadata outage: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.ok(targetRequests >= 1 && targetRequests <= 4);
    assert.equal(result.proteins.length, 0);
    assert.ok(result.targetLookupWarnings.length > 0);
    assert.ok(result.unclassifiedTargets.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


test("requestJson recognises an absolute same-origin ChEMBL proxy URL and identifies EBI 500 outages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title><body>There was a technical error. Service currently unavailable.</body></html>", {
    status: 500,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
  try {
    await assert.rejects(
      requestJson("http://localhost:5173/api/chembl?endpoint=activity", { retries: 0, useCache: false, serviceName: "ChEMBL" }),
      error => error.code === "CHEMBL_UPSTREAM_EBI_OUTAGE" && /temporarily unavailable/i.test(error.message)
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


test("retrievePfProteinTargets rejects duplicate activity IDs rather than double-counting records", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const duplicatePayload = {
    activities: [
      { ...pfActivityFixture.activities[0], activity_id: 88001 },
      { ...pfActivityFixture.activities[1], activity_id: 88001 }
    ],
    page_meta: { limit: 100, next: null, offset: 0, total_count: 2 }
  };
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") return new Response(JSON.stringify(duplicatePayload), { status: 200 });
    if (endpoint === "mechanism") return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0 } }), { status: 200 });
    if (endpoint === "target-record") {
      const id = parsed.searchParams.get("target_id");
      const record = pfTargetFixture.targets.find(item => item.target_chembl_id === id);
      return new Response(JSON.stringify(record), { status: 200 });
    }
    if (parsed.pathname === "/api/uniprot") return new Response(JSON.stringify(uniprotFixture), { status: 200 });
    throw new Error(`Unexpected test URL: ${String(input)}`);
  };
  try {
    await assert.rejects(
      retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true }),
      error => error.code === "PF_ACTIVITY_DUPLICATE_ROWS"
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


test("retrievePfProteinTargets marks malaria activity rows without a target ID as unassigned", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const payload = {
    activities: [{
      activity_id: 99001,
      molecule_chembl_id: "CHEMBL269671",
      target_chembl_id: null,
      target_pref_name: null,
      target_organism: "Plasmodium falciparum",
      target_tax_id: 5833,
      assay_chembl_id: "CHEMBLASSAY9"
    }],
    page_meta: { limit: 100, offset: 0, next: null, total_count: 1 }
  };
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") return new Response(JSON.stringify(payload), { status: 200 });
    if (endpoint === "mechanism") return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0 } }), { status: 200 });
    throw new Error(`Unexpected test URL: ${String(input)}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(result.malariaActivityRetrieved, 1);
    assert.equal(result.targetCount, 0);
    assert.equal(result.unassignedActivityCount, 1);
    assert.equal(result.proteins.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


test("retrievePfProteinTargets does not issue fallback filter requests after the branded EBI outage page", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  const requestedEndpoints = [];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    requestedEndpoints.push(parsed.searchParams.get("endpoint"));
    return new Response("<!doctype html><html><title>Error: 500 | EMBL-EBI</title><body>There was a technical error. The service is currently unavailable.</body></html>", {
      status: 500,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL1450", { forceRefresh: true });
    assert.equal(result.activityUnavailable, true);
    assert.deepEqual(requestedEndpoints.sort(), ["activity", "mechanism"], "do not repeat equivalent malaria filters against a confirmed EBI outage");
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});


test("retrievePfProteinTargets retries a failed later page once and preserves earlier evidence as explicitly partial", async () => {
  const originalFetch = globalThis.fetch;
  clearApiSessionCache();
  let offsetOneAttempts = 0;
  const firstRecord = pfActivityFixture.activities[0];
  globalThis.fetch = async input => {
    const parsed = new URL(String(input), "https://example.test");
    const endpoint = parsed.searchParams.get("endpoint");
    if (endpoint === "activity") {
      const offset = Number(parsed.searchParams.get("offset") || 0);
      if (offset === 0) {
        return new Response(JSON.stringify({
          activities: [firstRecord],
          page_meta: { limit: 1, offset: 0, next: "/chembl/api/data/activity.json?limit=1&offset=1&molecule_chembl_id=CHEMBL269671", total_count: 2 }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      offsetOneAttempts += 1;
      return new Response(JSON.stringify({ error: "Upstream ChEMBL timeout", activities: [], code: "CHEMBL_UPSTREAM_UNAVAILABLE", upstreamStatus: 500 }), {
        status: 503, headers: { "Content-Type": "application/json" }
      });
    }
    if (endpoint === "target-record") {
      const target = pfTargetFixture.targets.find(item => item.target_chembl_id === "CHEMBL9001");
      return new Response(JSON.stringify(target), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (endpoint === "mechanism") return new Response(JSON.stringify({ mechanisms: [], page_meta: { total_count: 0 } }), { status: 200 });
    if (parsed.pathname === "/api/uniprot") return new Response(JSON.stringify(uniprotFixture), { status: 200 });
    throw new Error(`Unexpected test request: ${parsed.href}`);
  };
  try {
    const result = await retrievePfProteinTargets("CHEMBL269671", { forceRefresh: true });
    assert.equal(offsetOneAttempts, 2, "failed offset is attempted once plus exactly one retry");
    assert.equal(result.malariaActivityRetrieved, 1);
    assert.equal(result.malariaActivityTotal, 2);
    assert.equal(result.activityComplete, false);
    assert.deepEqual(result.activityMissingOffsets, [1]);
    assert.equal(result.targetCount, 1, "target attribution from retained activity rows is still processed");
    assert.equal(result.unclassifiedTargets.length, 1, "organism name is retained but missing ChEMBL type metadata is not guessed");
    assert.equal(result.excludedTargets.length, 0);
    assert.ok(result.activityQueryWarnings.some(item => item.offset === 1));
  } finally {
    globalThis.fetch = originalFetch;
    clearApiSessionCache();
  }
});

import { describeEvidenceRecord, compareInchiKeys } from "../src/api.js";

test("describeEvidenceRecord flags weak/inactive results and hides bare units", () => {
  assert.equal(describeEvidenceRecord({ standardType: "Inhibition", units: "%" }).text, "Inhibition: value not reported");
  assert.equal(describeEvidenceRecord({ standardType: "Inhibition", value: 3.31, relation: "=", units: "%" }).band, "inactive-or-weak");
  assert.equal(describeEvidenceRecord({ standardType: "IC50", value: 10000, relation: ">", units: "nM" }).band, "inactive-or-weak");
  assert.equal(describeEvidenceRecord({ standardType: "Ki", value: 27000, relation: "=", units: "nM" }).band, "inactive-or-weak");
  assert.equal(describeEvidenceRecord({ standardType: "IC50", value: 50, relation: "=", units: "nM" }).band, "potent");
  assert.equal(describeEvidenceRecord({ standardType: "IC50", value: 0.13, relation: "=", units: "ug.mL-1" }).band, "unclassified");
  assert.equal(describeEvidenceRecord({ standardType: "IC50", value: 3.2, relation: "=", units: "uM" }).band, "moderate");
});

test("compareInchiKeys separates tautomer/connectivity from stereo-only differences", () => {
  assert.equal(compareInchiKeys("BSJMWHQBCZFXBR-UHFFFAOYSA-N", "KUCQYCKVKVOKAY-CTYIDZIISA-N"), "connectivity-differs");
  assert.equal(compareInchiKeys("KUCQYCKVKVOKAY-UHFFFAOYSA-N", "KUCQYCKVKVOKAY-CTYIDZIISA-N"), "stereo-or-isotope-only");
  assert.equal(compareInchiKeys("X", "Y"), "unknown");
});
