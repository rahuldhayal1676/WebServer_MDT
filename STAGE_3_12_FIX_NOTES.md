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
