# Stage 3.12 change log and verification

## Included repairs

1. **Molecule-indexed activity retrieval:** malaria discovery now queries by `molecule_chembl_id` only. It does not add `target_tax_id__in` or organism filters to ChEMBL's activity request. Compact fields include `target_type` for fallback classification and exclude `assay_description`; pages are sequential, 200 rows each (or the smaller page size reported by ChEMBL), with one retry and a strict 5,000-row cap. Species and strain filtering (taxa 5833 and 36329) happens locally.
2. **UniProt inactive accessions:** parser reads `entryType` and `inactiveReason.mergeDemergeTo`. A sole successor can be queried, multiple successors are left unresolved rather than guessed, and successful mappings include `resolvedFrom`/`resolutionReason`. No hard-coded accession substitution is present.
3. **MOA handling:** mechanism queries are molecule-only. Target IDs from MOA records are included in batched target metadata lookups even when they have no activity rows. Confirmed *P. falciparum* mechanism targets are displayed in dedicated cards; mechanism-only targets remain visible. Targets with missing organism metadata are surfaced separately as unresolved.
4. **Exact-match-first resolver and HTML sanitization:** full-InChIKey ChEMBL matching runs before UniChem. UniChem is called only after an exact match miss. The final preferred-name query uses `pref_name__iexact`, not `icontains`. Proxy HTML responses are converted to generic diagnostics and no HTML body is included in warnings.
5. **Parent/salt evidence:** molecule responses include `molecule_hierarchy`; a parent is selected for Stage 3. When a salt/alternative form is selected, both parent and form activity records are queried, then deduplicated by `activity_id`.
6. **Complex subunits:** complex targets remain separate from single-protein targets. Component accessions are linked to UniProt entries; each component sequence is retrieved and shown where species validation succeeds.
7. **Proxy parity:** Vite development proxy and Netlify functions call the same handlers. ChEMBL, UniProt and UniChem upstream requests have a 22,000 ms timeout.

## Tests executed

- `node --test`: **32 passed, 0 failed** after adding tests for a server-reported smaller page size and the strict 5,000-row ceiling. All are deterministic tests with mocked API responses.
- `node node_modules/eslint/bin/eslint.js .`: **passed** using the cached ESLint 10.14.0 package tree in this workspace.
- JSX parse check with `@babel/parser`: `src/App.jsx` and `src/main.jsx` both parsed successfully.
- `node --check`: `src/api.js`, `vite.config.js`, and all three Netlify function files passed syntax checks.
- `vite build`: **not completed**. The cached Rolldown installation lacks the Linux native binding `@rolldown/binding-linux-x64-gnu`. A clean platform-specific `npm ci` timed out in this environment. Run `npm ci && npm run build` on the target computer.
- Live upstream calls: **not verified** from this build environment.

## Important scientific guardrails

- No accession is hard-coded as a replacement for another. UniProt controls merge/demerge successor data.
- ChEMBL activity counts are evidence records, not a count of validated drug targets.
- A protein-complex target is not counted as a single-protein target; constituent proteins are shown as complex subunits.
- Organism-level targets are not treated as proteins.
- Missing target metadata, capped scans and failed pagination are not presented as negative biological evidence.

## Stage 3.12.1 — local dev NCBI route fix
- `vite.config.js` now mounts all four `/api/*` routes (chembl, uniprot, ncbi, unichem) using the same Netlify handlers as production. Before, `/api/ncbi` did not exist in `npm run dev`, so the DHFR-TS RefSeq request returned `index.html` ("HTML page instead of JSON").
- Added `test/ncbi-proxy.test.js` and `test/dev-proxy-parity.test.js` (every netlify.toml `/api` redirect must have a dev route). 64 tests pass; lint and build pass.
- Removed an unused variable that failed ESLint.
- Restart `npm run dev` after replacing files.
- Removed `export default { handler }` from `netlify/functions/chembl.js` and `unichem.js`. With a default export Netlify treats the file as a v2 function and fails with `TypeError: D.handler is not a function` (seen under `netlify dev`). All four functions now use only the named `handler` export; a test enforces this.

## Stage 3.12.2 — evidence clarity
- Evidence rows now carry a heuristic band (`describeEvidenceRecord`): percent inhibition < 50 %, IC50/Ki ≥ 10 µM or reported as ">" are labelled "tested, weak or inactive"; ≤ 1 µM "potent in this assay". Raw values are never hidden. Missing values show "value not reported" instead of a bare unit.
- Stage 2 non-exact candidates now compare PubChem vs ChEMBL InChIKeys (`compareInchiKeys`): a differing connectivity block is explained as a likely tautomer/salt/charge/drawing difference; a stereo-only difference is stated as such.
- The PfDHFR-TS section states that the mapping is a literature reference built in for pyrimethamine only.
- 67 tests, lint and build pass.
