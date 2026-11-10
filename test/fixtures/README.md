# Saved parser fixtures

The PubChem fixtures are minimal response-shape samples for parser tests only. They are never read by the running website.

The ChEMBL molecule fixture uses the documented aspirin record shape for testing exact InChIKey matching. The activity fixture is based on a publicly displayed ChEMBL activity record for CHEMBL2069840 (activity 10991473; CYP3A4 assay). It is used only to test response parsing and is not presented as an Artemisinin result or as a live WebServer_MDT result.

All results displayed by the running application are fetched live from PubChem and ChEMBL through `src/api.js`.
