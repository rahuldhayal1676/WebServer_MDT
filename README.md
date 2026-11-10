# WebServer_MDT — Public Cloud Demo Build

WebServer_MDT is a browser-based academic research prototype for exploring compound information and *Plasmodium falciparum* protein-target evidence. This version is configured for public deployment so evaluators can use it from their own laptop or phone. The developer's laptop does not need to stay on after deployment.

## Architecture

- **Frontend:** React + Vite, built as a static site.
- **Cloud backend:** Netlify Functions proxy requests to ChEMBL, UniChem and UniProtKB.
- **Compound data:** PubChem PUG REST.
- **Bioactivity and target evidence:** ChEMBL.
- **Protein enrichment:** UniProtKB, restricted to *P. falciparum* taxa 5833 and 3D7 taxon 36329 for protein-name searches.

The browser calls same-origin `/api/...` routes. Vite provides local development proxies; Netlify redirects those routes to cloud functions in production.

## Deploy a public demo URL

1. Create a GitHub repository named `WebServer_MDT` (or another name).
2. Upload/push the **contents of this folder** to the repository root. Do not upload `node_modules`.
3. Sign in to Netlify and choose **Add new site → Import an existing project**.
4. Connect the GitHub repository.
5. Confirm the settings (Netlify reads these from `netlify.toml`):
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
6. Choose **Deploy**. No API key is required for the current public data endpoints.
7. Open the generated `https://....netlify.app` address from a different laptop or phone. This is the URL to show your professors.

Every new GitHub push will trigger a new Netlify deployment.

## Local development (optional)

Requirements: Node.js 20.19+ or 22.12+.

```bash
npm ci
npm test
npm run lint
npm run build
npm run dev
```

Local development is for editing and testing only. The final presentation should use the public Netlify URL, not `localhost` or a Vite development server.

## Suggested live-demo sequence

1. Open the public URL in an incognito window or on another device.
2. Search for `Pyrimethamine` by compound name.
3. Inspect the ChEMBL molecule match; CHEMBL36 is the expected record for the intended demonstration, but confirm the returned identity and structure before selecting it.
4. Click **Find Plasmodium falciparum proteins** or **Refresh malaria protein results**.
5. Show ChEMBL-verified target records separately from provisional UniProtKB name-matched leads.
6. Open a protein's UniProt source link and sequence view.

## Verification and scientific limitations

- `npm test` uses mocked API responses. Passing tests validate application logic, not live upstream service availability.
- ChEMBL activity records are bioactivity evidence, not proof of direct drug binding or clinical target validation.
- UniProtKB name matches are provisional leads, not proof that the compound binds the protein.
- Species-level *P. falciparum* results are not automatically confirmed as the 3D7 strain unless the source taxonomy says so.
- ChEMBL, UniProtKB or PubChem may occasionally be slow or unavailable. For a high-stakes presentation, keep a short screen recording as a backup, while clearly labelling it as a recording.

## Project checks

- `node --test`: 60 tests passed in the assembly environment.
- `npm run build`: not verified here because dependency installation (`npm ci`) timed out in this environment. Netlify will install dependencies during its own build; check the deploy log and resolve any reported build issue before presenting.
- Live upstream requests and a public deployment have not yet been verified.

## Curated reference-target evidence (Phase I)

For Pyrimethamine (`CHEMBL36`), Stage 3 now checks whether the retrieved *P. falciparum* organism-level ChEMBL assay descriptions explicitly mention DHFR/DHFR-TS. When such records are present, the UI displays PfDHFR-TS (`CHEMBL4296323`, UniProt `Q8I1R6`, PlasmoDB `PF3D7_0417200`) in a separate **Curated reference targets** section. The ChEMBL target record and UniProt sequence are fetched through the existing cloud proxies.

Important evidence distinction: these organism-level phenotypic assays remain assigned by ChEMBL to `CHEMBL364` (the organism). They are displayed as contextual supporting records, not as direct protein-binding measurements or ChEMBL single-protein assignments. The curated 3D7 target mapping is linked to the IUPHAR/BPS reference page and PlasmoDB.
