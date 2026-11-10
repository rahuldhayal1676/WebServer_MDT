# Netlify Function handler compatibility fix

## Root cause
The deployed function files used the legacy Lambda-style named `handler` export (and in two files a default object containing `handler`). The current Netlify Functions runtime expects a default-exported function that accepts a web `Request` and returns a web `Response`.

## Files changed
- `netlify/functions/_shared.js`: adds an adapter from the web Request API to the existing tested Lambda-style business logic and converts its result to a web Response.
- `netlify/functions/chembl.js`: adds a modern default Request/Response handler while retaining the named handler for unit tests.
- `netlify/functions/uniprot.js`: adds the modern default Request/Response handler while retaining the named handler for unit tests.
- `netlify/functions/unichem.js`: adds the modern default Request/Response handler while retaining the named handler for unit tests.
- `test/netlify-modern-handler.test.js`: tests the actual default exports used by Netlify.

## Apply the fix
1. Copy these files into the matching locations in the local `WebServer_MDT` Git repository, replacing the old versions.
2. In GitHub Desktop, commit with message `Fix Netlify function handler format`.
3. Click `Push origin`.
4. Netlify should automatically build and publish a new deploy from `main`.
5. Check the deployed function endpoints before testing the app:
   - `/.netlify/functions/chembl?endpoint=status`
   - `/.netlify/functions/uniprot?search=Falcipain%202`
   - `/.netlify/functions/unichem?cid=123`

A successful invocation should return JSON or a clear upstream-service error. It should not return `D.handler is not a function`.

## Validation performed here
- `npm test`: 63 tests passed, 0 failed, including 3 tests invoking the modern default handlers.
- `node --check` on the changed function files: passed.
- A fresh Vite build could not be run in this environment because dependency installation (`npm ci`) timed out. Netlify will perform a fresh dependency install during its deployment.

Important: this fix resolves the Netlify function invocation error. It cannot guarantee that ChEMBL itself is always available; an actual ChEMBL upstream 5xx response must still be handled as an upstream outage, while UniProt fallback should now be reachable.
