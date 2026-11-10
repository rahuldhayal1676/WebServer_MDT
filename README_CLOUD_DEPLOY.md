# WebServer_MDT — Cloud demo build

This build is intended to be deployed publicly so the BTP demo can be opened from another laptop or phone. It does not require your laptop to remain running after deployment.

## Architecture
- React + Vite frontend
- Netlify Functions backend proxy for ChEMBL, UniChem and UniProtKB
- PubChem public REST API for compound resolution
- ChEMBL activity/target evidence plus UniProtKB protein-name and sequence enrichment

## Deploy on Netlify
1. Push this folder to a GitHub repository.
2. In Netlify, choose **Add new site → Import an existing project** and connect that repository.
3. Netlify should detect `netlify.toml`. Confirm:
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Functions directory: `netlify/functions`
4. Deploy. No API key or environment variable is required for the current public endpoints.
5. Open the generated `https://....netlify.app` URL from a separate device/network and test the search.

## Run locally for development only
Requirements: Node.js 20.19+ or 22.12+.

```bash
npm ci
npm test
npm run lint
npm run build
npm run dev
```

Local development is not the final presentation method. The public Netlify URL is.

## Demo checklist
- Open the deployed URL in an incognito window or another device.
- Search `Pyrimethamine` using the compound name.
- Select the correctly matched ChEMBL molecule (expected CHEMBL36, subject to live database results).
- Run **Find Plasmodium falciparum proteins** / **Refresh malaria protein results**.
- Check that verified ChEMBL targets and provisional UniProt name-matched leads are shown separately.
- Explain that activity associations and name matches are evidence leads, not proof of direct binding.

## Important
Automated tests use mocked responses. They do not guarantee that PubChem, ChEMBL or UniProtKB is online at demo time. Keep the live URL and a recorded screen capture as backup. Do not claim a target is experimentally validated solely because it appears in this application.
