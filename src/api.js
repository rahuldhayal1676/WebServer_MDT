/**
 * WebServer_MDT API layer.
 * Stages 1–3: PubChem compound identity, tiered ChEMBL molecule resolution,
 * malaria-specific target association and UniProt sequence retrieval.
 * All external API requests for the app are routed through this module.
 */

const PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const CHEMBL_BASE = "https://www.ebi.ac.uk/chembl/api/data";
const CHEMBL_PROXY_PATH = "/api/chembl";
const UNIPROT_PROXY_PATH = "/api/uniprot";
const PUBCHEM_PROPERTIES = [
  "Title",
  "MolecularFormula",
  "MolecularWeight",
  "IUPACName",
  "ConnectivitySMILES",
  "SMILES",
  "InChIKey"
].join(",");

const SESSION_CACHE = new Map();
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
export const CHEMBL_REQUEST_TIMEOUT_MS = 35_000;
const CHEMBL_CIRCUIT_COOLDOWN_MS = 20_000;
let chemblCircuitOpenUntil = 0;
const MAX_NAME_OR_SMILES_MATCHES = 20;

export class ApiError extends Error {
  constructor(message, { status = null, code = "API_ERROR", url = null, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.url = url;
    this.details = details;
  }
}

function responsePreview(text, maxLength = 180) {
  return String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function classifyNonJsonBody(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "an empty response body";
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) return "an HTML page";
  if (/^<\?xml|^<[^>]+>/.test(trimmed)) return "an XML response";
  return "a non-JSON or malformed response";
}

function urlHasPathname(value, pathname) {
  try {
    return new URL(String(value), "http://localhost").pathname === pathname;
  } catch {
    return false;
  }
}

function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.min(10_000, timestamp - Date.now()));
}

function cacheKey(url, method, body) {
  return `${method}:${url}:${body ?? ""}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The request was cancelled.", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("The request was cancelled.", "AbortError"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Fetch JSON with a per-attempt timeout, retry/back-off, and session cache. */
export async function requestJson(url, options = {}) {
  const {
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    useCache = true,
    bypassChemblCircuitBreaker = false,
    serviceName = "The external database",
    ...fetchOptions
  } = options;
  const method = (fetchOptions.method || "GET").toUpperCase();
  const body = fetchOptions.body ?? "";
  const key = cacheKey(url, method, body);

  if (useCache && SESSION_CACHE.has(key)) {
    return structuredClone(SESSION_CACHE.get(key));
  }

  const isChemblRequest = urlHasPathname(url, CHEMBL_PROXY_PATH);
  if (isChemblRequest && !bypassChemblCircuitBreaker && Date.now() < chemblCircuitOpenUntil) {
    const secondsRemaining = Math.max(1, Math.ceil((chemblCircuitOpenUntil - Date.now()) / 1000));
    throw new ApiError(
      `ChEMBL recently returned an upstream service error. Requests are paused for about ${secondsRemaining} seconds to avoid waiting on the same unavailable service.`,
      { code: "CHEMBL_CIRCUIT_OPEN", url, details: { cooldownMs: secondsRemaining * 1000 } }
    );
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let retryDelayMs = null;
    if (signal?.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        method,
        headers: {
          Accept: "application/json",
          ...(fetchOptions.headers || {})
        },
        signal: controller.signal
      });

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        retryDelayMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const bodyText = await response.text();
        let proxyError = null;
        try { proxyError = bodyText ? JSON.parse(bodyText) : null; } catch { /* body may be HTML from an upstream gateway */ }

        let message = response.status === 404
          ? `${serviceName} could not find a record for this request.`
          : `${serviceName} request failed (HTTP ${response.status}).`;
        let code = response.status === 404 ? "NOT_FOUND" : "HTTP_ERROR";

        if (response.status === 400 && url.includes("/smiles/")) {
          message = "PubChem could not parse this SMILES string. Check its syntax and try again.";
          code = "INVALID_SMILES";
        }

        // Preserve structured error details returned by the same-origin database proxies.
        const isChemblProxy = urlHasPathname(url, CHEMBL_PROXY_PATH);
        const isUniProtProxy = urlHasPathname(url, UNIPROT_PROXY_PATH);
        const isSameOriginDatabaseProxy = isChemblProxy || isUniProtProxy;
        if (isSameOriginDatabaseProxy && typeof proxyError?.error === "string") {
          const upstreamIsDown = isChemblProxy && Number(proxyError.upstreamStatus) >= 500;
          if (upstreamIsDown) {
            message = `ChEMBL is temporarily unavailable (upstream HTTP ${proxyError.upstreamStatus}). The failure is at EMBL-EBI, not in the compound query.`;
            code = "CHEMBL_UPSTREAM_EBI_OUTAGE";
          } else {
            message = proxyError.error;
            code = proxyError.code || (isUniProtProxy ? "UNIPROT_PROXY_ERROR" : "CHEMBL_PROXY_ERROR");
            if (proxyError.upstreamStatus) message += ` (upstream HTTP ${proxyError.upstreamStatus})`;
            if (proxyError.upstreamContentType) message += `; content-type: ${proxyError.upstreamContentType}`;
            if (proxyError.responsePreview) message += `; response preview: ${proxyError.responsePreview}`;
          }
        } else if (isSameOriginDatabaseProxy) {
          const contentType = response.headers.get("content-type") || "not supplied";
          const preview = responsePreview(bodyText);
          const looksLikeChEMBLHtml5xx = isChemblProxy
            && response.status >= 500
            && /text\/html/i.test(contentType);
          if (looksLikeChEMBLHtml5xx) {
            const isKnownEbiError = /technical error|European Bioinformatics Institute|EMBL/i.test(bodyText);
            message = isKnownEbiError
              ? `ChEMBL is temporarily unavailable: EMBL-EBI returned its HTML HTTP ${response.status} service-error page. This is not an invalid compound or target.`
              : `ChEMBL returned an HTML HTTP ${response.status} error page. The upstream service or proxy may be unavailable; this is not evidence that the compound is invalid.`;
            code = isKnownEbiError ? "CHEMBL_UPSTREAM_EBI_OUTAGE" : "CHEMBL_UPSTREAM_SERVICE_UNAVAILABLE";
          }
          if (looksLikeChEMBLHtml5xx) {
            message += ` Content-type: ${contentType}. Alternative requests to the same ChEMBL backend were skipped.`;
          } else {
            message += ` Content-type: ${contentType}.`;
            if (preview) message += ` Response preview: ${preview}`;
          }
        }

        const error = new ApiError(message, {
          status: response.status,
          code,
          url,
          details: {
            contentType: response.headers.get("content-type"),
            proxy: response.headers.get("x-webserver-mdt-proxy"),
            upstreamStatus: proxyError?.upstreamStatus ?? response.headers.get("x-chembl-upstream-status"),
            upstreamContentType: proxyError?.upstreamContentType ?? response.headers.get("x-chembl-upstream-content-type"),
            responsePreview: proxyError?.responsePreview || responsePreview(bodyText)
          }
        });

        const confirmedChemblOutage = isChemblProxy && (
          code === "CHEMBL_UPSTREAM_EBI_OUTAGE"
          || code === "CHEMBL_UPSTREAM_SERVICE_UNAVAILABLE"
          || (code === "CHEMBL_UPSTREAM_HTTP_ERROR" && Number(error.details?.upstreamStatus) >= 500)
        );
        if (confirmedChemblOutage) {
          chemblCircuitOpenUntil = Date.now() + CHEMBL_CIRCUIT_COOLDOWN_MS;
          throw error;
        }
        if (!retryable || attempt === retries) throw error;
        lastError = error;
      } else {
        const bodyText = await response.text();
        let data;
        try {
          if (!bodyText.trim()) throw new Error("Empty response body");
          data = JSON.parse(bodyText);
        } catch {
          const contentType = response.headers.get("content-type") || "not supplied";
          const bodyKind = classifyNonJsonBody(bodyText);
          const preview = responsePreview(bodyText);
          const isChEMBL = urlHasPathname(url, CHEMBL_PROXY_PATH);
          let message = `${serviceName} returned ${bodyKind} instead of JSON (HTTP ${response.status}; content-type: ${contentType}).`;
          const isEbiBrandedHtml = isChEMBL && /HTML page/i.test(bodyKind)
            && /EMBL|European Bioinformatics Institute|technical error|Error:\s*500/i.test(bodyText);
          let code = "INVALID_JSON";
          if (isEbiBrandedHtml) {
            message = `${serviceName} is temporarily unavailable: EMBL-EBI returned its HTML service-error page. This is an upstream outage, not an invalid compound. No alternative ChEMBL queries will be sent.`;
            code = "CHEMBL_UPSTREAM_EBI_OUTAGE";
            chemblCircuitOpenUntil = Date.now() + CHEMBL_CIRCUIT_COOLDOWN_MS;
          } else if (isChEMBL && /HTML page/i.test(bodyKind)) {
            message += " The ChEMBL proxy returned an HTML page instead of JSON.";
          } else if (isChEMBL) {
            message += " The response may have been truncated or returned by an upstream gateway.";
          }
          if (preview && code !== "CHEMBL_UPSTREAM_EBI_OUTAGE") message += ` Response preview: ${preview}`;
          const error = new ApiError(message, {
            status: response.status,
            code,
            url,
            details: {
              contentType,
              proxy: response.headers.get("x-webserver-mdt-proxy"),
              responseUrl: response.url,
              responsePreview: preview
            }
          });
          console.warn("[WebServer_MDT] Non-JSON API response", error.details);
          throw error;
        }

        if (data?.Fault?.Message) {
          const fault = data.Fault;
          const notFound = /not found|no records|cannot be found/i.test(fault.Message);
          throw new ApiError(
            notFound
              ? `${serviceName} could not find a record matching this request. Check the supplied identifier or structure.`
              : `${serviceName} could not process this request: ${fault.Message}`,
            { code: notFound ? "NOT_FOUND" : "API_FAULT", url }
          );
        }

        if (useCache) SESSION_CACHE.set(key, data);
        return structuredClone(data);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException("The request was cancelled.", "AbortError");
      }

      if (error instanceof ApiError) {
        if (error.code === "INVALID_JSON" && attempt < retries) {
          // Retry malformed/transient upstream responses; assign lastError below.
        } else if (
          error.code === "NOT_FOUND" ||
          error.code === "INVALID_SMILES" ||
          error.code === "API_FAULT" ||
          error.code === "CHEMBL_UPSTREAM_EBI_OUTAGE" ||
          error.code === "CHEMBL_UPSTREAM_SERVICE_UNAVAILABLE" ||
          error.code === "CHEMBL_CIRCUIT_OPEN" ||
          (error.status !== null && error.status !== 408 && error.status !== 429 && error.status < 500)
        ) {
          throw error;
        }
        lastError = error;
      } else if (timedOut) {
        lastError = new ApiError(`${serviceName} did not respond within ${timeoutMs / 1000} seconds.`, {
          code: "TIMEOUT",
          url
        });
      } else {
        const isChemblProxy = urlHasPathname(url, CHEMBL_PROXY_PATH);
        const isUniProtProxy = urlHasPathname(url, UNIPROT_PROXY_PATH);
        lastError = new ApiError(
          isChemblProxy
            ? "The same-origin ChEMBL proxy could not be reached. Restart the Vite server locally, or verify that the Netlify Function is deployed. If the proxy is running, the upstream ChEMBL service or your network may be temporarily unavailable."
            : `A network error prevented the ${serviceName} request. Check your connection and try again.`,
          { code: isChemblProxy ? "CHEMBL_PROXY_NETWORK_ERROR" : isUniProtProxy ? "UNIPROT_PROXY_NETWORK_ERROR" : "NETWORK_ERROR", url }
        );
      }

      if (attempt === retries) throw lastError;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortFromCaller);
    }

    await sleep(retryDelayMs ?? Math.min(3_000, 500 * (2 ** attempt)), signal);
  }

  throw lastError || new ApiError(`The ${serviceName} request could not be completed.`, { url });
}

export function parsePubChemCidResponse(payload) {
  const cids = payload?.IdentifierList?.CID;
  if (!Array.isArray(cids) || cids.length === 0) {
    throw new ApiError("PubChem did not return a compound identifier for this input.", {
      code: "NOT_FOUND"
    });
  }

  return [...new Set(cids.map(value => String(value)).filter(value => /^\d+$/.test(value)))];
}

export function parsePubChemPropertyResponse(payload) {
  const records = payload?.PropertyTable?.Properties;
  if (!Array.isArray(records) || records.length === 0) {
    throw new ApiError("PubChem returned no compound property records.", {
      code: "NO_PROPERTIES"
    });
  }

  return records
    .filter(record => record?.CID !== undefined && record?.CID !== null)
    .map(record => ({
      cid: String(record.CID),
      title: record.Title || null,
      formula: record.MolecularFormula || null,
      molecularWeight: record.MolecularWeight ?? null,
      iupacName: record.IUPACName || null,
      connectivitySmiles: record.ConnectivitySMILES || null,
      smiles: record.SMILES || null,
      inchiKey: record.InChIKey || null,
      source: "PubChem PUG-REST",
      sourceUrl: `https://pubchem.ncbi.nlm.nih.gov/compound/${record.CID}`
    }));
}

function validateInput(input, inputType) {
  const value = String(input ?? "").trim();
  if (!value) {
    throw new ApiError("Enter a compound name, PubChem CID or SMILES string.", {
      code: "EMPTY_INPUT"
    });
  }

  if (inputType === "PubChem CID" && !/^\d+$/.test(value)) {
    throw new ApiError("A PubChem CID must contain digits only.", {
      code: "INVALID_CID"
    });
  }

  return value;
}

/** Resolve one or more PubChem records for a name, CID, or SMILES input. */
export async function resolvePubChemCompound(input, inputType, { signal } = {}) {
  const value = validateInput(input, inputType);
  let cids;

  if (inputType === "PubChem CID") {
    cids = [value];
  } else {
    const namespace = inputType === "SMILES" ? "smiles" : "name";
    const lookupUrl = `${PUBCHEM_BASE}/compound/${namespace}/${encodeURIComponent(value)}/cids/JSON`;
    const cidPayload = await requestJson(lookupUrl, { signal, serviceName: "PubChem" });
    cids = parsePubChemCidResponse(cidPayload);
  }

  const truncated = cids.length > MAX_NAME_OR_SMILES_MATCHES;
  const selectedCids = cids.slice(0, MAX_NAME_OR_SMILES_MATCHES);
  const propertyUrl = `${PUBCHEM_BASE}/compound/cid/${selectedCids.join(",")}/property/${PUBCHEM_PROPERTIES}/JSON`;
  const propertyPayload = await requestJson(propertyUrl, { signal, serviceName: "PubChem" });
  const compounds = parsePubChemPropertyResponse(propertyPayload);

  return {
    input: value,
    inputType,
    compounds,
    totalMatches: cids.length,
    truncated,
    retrievedAt: new Date().toISOString(),
    propertyUrl
  };
}

export function clearApiSessionCache() {
  SESSION_CACHE.clear();
  chemblCircuitOpenUntil = 0;
}

export const PUBCHEM_API = Object.freeze({
  baseUrl: PUBCHEM_BASE,
  properties: PUBCHEM_PROPERTIES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retries: DEFAULT_RETRIES,
  chemblBaseUrl: CHEMBL_BASE
});


/**
 * Route browser requests through a same-origin proxy. Vite handles this in local
 * development; Netlify Functions handle it in the deployed site. The original
 * ChEMBL URL remains available as provenance metadata, but is never fetched by
 * the browser directly.
 */
export function toChemblProxyUrl(externalUrl) {
  const parsed = new URL(externalUrl);
  if (parsed.origin !== "https://www.ebi.ac.uk") {
    throw new ApiError("ChEMBL returned an unexpected request host.", {
      code: "INVALID_CHEMBL_URL",
      url: externalUrl
    });
  }

  const targetRecordMatch = parsed.pathname.match(/^\/chembl\/api\/data\/target\/(CHEMBL\d+)\.json$/i);
  const collectionMatch = parsed.pathname.match(/^\/chembl\/api\/data\/(molecule|status|activity|target|mechanism)\.json$/);
  if (!targetRecordMatch && !collectionMatch) {
    throw new ApiError("ChEMBL returned an unsupported endpoint URL.", {
      code: "INVALID_CHEMBL_URL",
      url: externalUrl
    });
  }

  const params = new URLSearchParams(parsed.search);
  if (targetRecordMatch) {
    params.set("endpoint", "target-record");
    params.set("target_id", targetRecordMatch[1].toUpperCase());
  } else {
    params.set("endpoint", collectionMatch[1]);
  }
  return `${CHEMBL_PROXY_PATH}?${params.toString()}`;
}

/** Route a UniProtKB accession lookup through the same-origin proxy. */
export function toUniProtProxyUrl(accession) {
  const value = String(accession || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6,10}$/.test(value)) {
    throw new ApiError("A valid UniProtKB accession is required to retrieve a protein sequence.", {
      code: "INVALID_UNIPROT_ACCESSION"
    });
  }
  return `${UNIPROT_PROXY_PATH}?accession=${encodeURIComponent(value)}`;
}

/** Route a species-restricted UniProtKB protein-name search through the same-origin proxy. */
export function toUniProtNameSearchProxyUrl(proteinName) {
  const value = String(proteinName || "").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s.'()/-]{1,119}$/u.test(value)) {
    throw new ApiError("The target name is not suitable for a safe UniProtKB name search.", {
      code: "INVALID_UNIPROT_SEARCH_NAME"
    });
  }
  return `${UNIPROT_PROXY_PATH}?search=${encodeURIComponent(value)}`;
}

/** Map a ChEMBL molecule record without changing source values. */
function mapChemblMoleculeRecord(molecule, matchType = "exact-inchi-key") {
  const moleculeId = molecule?.molecule_chembl_id || null;
  const synonyms = Array.isArray(molecule?.molecule_synonyms)
    ? molecule.molecule_synonyms.map(item => item?.molecule_synonym).filter(Boolean)
    : [];
  return {
    chemblId: moleculeId,
    preferredName: molecule?.pref_name || null,
    moleculeType: molecule?.molecule_type || null,
    maxPhase: molecule?.max_phase ?? null,
    firstApproval: molecule?.first_approval ?? null,
    standardInchiKey: molecule?.molecule_structures?.standard_inchi_key || null,
    canonicalSmiles: molecule?.molecule_structures?.canonical_smiles || null,
    molecularFormula: molecule?.molecule_properties?.full_molformula || null,
    molecularWeight: molecule?.molecule_properties?.full_mwt ?? null,
    synonyms,
    matchType,
    matchLabel: matchType === "exact-inchi-key"
      ? "Exact full-InChIKey match"
      : matchType === "exact-synonym"
        ? "Exact ChEMBL synonym match; formula and molecular weight cross-checked"
        : matchType === "preferred-name"
          ? "Exact ChEMBL preferred-name match; formula and molecular weight cross-checked"
          : matchType === "preferred-name-contains"
            ? "ChEMBL preferred-name contains the submitted name; formula and molecular weight match, but structure identity requires review"
            : "Connectivity-search candidate; identity requires review",
    source: "ChEMBL Data Web Services",
    apiUrl: moleculeId ? `${CHEMBL_BASE}/molecule/${encodeURIComponent(moleculeId)}.json` : null,
    recordUrl: moleculeId ? `https://www.ebi.ac.uk/chembl/compound_report_card/${encodeURIComponent(moleculeId)}/` : null
  };
}

/** Parse exact full-InChIKey results only. */
export function parseChemblMoleculeResponse(payload, expectedInchiKey) {
  const molecules = payload?.molecules;
  if (!Array.isArray(molecules)) {
    throw new ApiError("ChEMBL returned an unexpected molecule-search response.", {
      code: "INVALID_CHEMBL_RESPONSE"
    });
  }

  const normalizedKey = String(expectedInchiKey || "").trim().toUpperCase();
  return molecules
    .filter(molecule => {
      const returnedKey = molecule?.molecule_structures?.standard_inchi_key;
      return typeof returnedKey === "string" && returnedKey.toUpperCase() === normalizedKey;
    })
    .map(molecule => mapChemblMoleculeRecord(molecule, "exact-inchi-key"))
    .filter(molecule => molecule.chemblId);
}

/** Parse a ChEMBL molecule result as a non-exact candidate. */
export function parseChemblMoleculeCandidateResponse(payload, matchType) {
  const molecules = payload?.molecules;
  if (!Array.isArray(molecules)) {
    throw new ApiError("ChEMBL returned an unexpected molecule-candidate response.", {
      code: "INVALID_CHEMBL_CANDIDATE_RESPONSE"
    });
  }
  return molecules
    .map(molecule => mapChemblMoleculeRecord(molecule, matchType))
    .filter(molecule => molecule.chemblId);
}

/** Parse ChEMBL's current database release metadata. */
export function parseChemblStatusResponse(payload) {
  return {
    status: payload?.status || null,
    release: payload?.chembl_db_version || null,
    releaseDate: payload?.chembl_release_date || null
  };
}

function validateInchiKey(inchiKey) {
  const value = String(inchiKey || "").trim().toUpperCase();
  if (!/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/.test(value)) {
    throw new ApiError("The selected PubChem record has no valid full InChIKey. ChEMBL matching cannot continue.", {
      code: "INVALID_INCHIKEY"
    });
  }
  return value;
}

async function fetchChemblMoleculePages(firstUrl, expectedInchiKey, { signal } = {}) {
  let nextUrl = firstUrl;
  const visited = new Set();
  const exactMolecules = [];
  let totalCount = null;

  while (nextUrl) {
    if (visited.size >= 10) {
      throw new ApiError("ChEMBL molecule lookup exceeded the pagination safety limit.", {
        code: "PAGINATION_LIMIT"
      });
    }
    const parsedUrl = new URL(nextUrl);
    if (parsedUrl.origin !== "https://www.ebi.ac.uk" || !parsedUrl.pathname.startsWith("/chembl/api/data/molecule")) {
      throw new ApiError("ChEMBL returned an unexpected pagination URL. The search was stopped for safety.", {
        code: "INVALID_PAGINATION_URL"
      });
    }
    if (visited.has(parsedUrl.href)) {
      throw new ApiError("ChEMBL returned a repeated pagination link. The search was stopped.", {
        code: "PAGINATION_LOOP"
      });
    }
    visited.add(parsedUrl.href);

    const proxyUrl = toChemblProxyUrl(parsedUrl.href);
    const payload = await requestJson(proxyUrl, { signal, serviceName: "ChEMBL", timeoutMs: CHEMBL_REQUEST_TIMEOUT_MS, retries: 0 });
    exactMolecules.push(...parseChemblMoleculeResponse(payload, expectedInchiKey));
    totalCount ??= payload?.page_meta?.total_count ?? null;
    const next = payload?.page_meta?.next;
    nextUrl = next ? new URL(next, CHEMBL_BASE).href : null;
  }

  const unique = [...new Map(exactMolecules.map(molecule => [molecule.chemblId, molecule])).values()];
  return { molecules: unique, totalCount };
}

/** Compare core chemical descriptors before offering a name-based cross-reference. */
function descriptorsAreCompatible(candidate, { formula, molecularWeight } = {}) {
  const expectedFormula = String(formula || "").replace(/\s+/g, "").toUpperCase();
  const candidateFormula = String(candidate?.molecularFormula || "").replace(/\s+/g, "").toUpperCase();
  if (expectedFormula && candidateFormula && expectedFormula !== candidateFormula) return false;
  if (expectedFormula && !candidateFormula) return false;

  const expectedWeight = Number(molecularWeight);
  const candidateWeight = Number(candidate?.molecularWeight);
  if (Number.isFinite(expectedWeight) && Number.isFinite(candidateWeight)
      && Math.abs(expectedWeight - candidateWeight) > 0.15) return false;
  if (Number.isFinite(expectedWeight) && !Number.isFinite(candidateWeight)) return false;
  return Boolean(expectedFormula || (Number.isFinite(expectedWeight) && Number.isFinite(candidateWeight)));
}

async function fetchChemblMoleculeCandidates(url, matchType, descriptorContext, { signal } = {}) {
  const payload = await requestJson(toChemblProxyUrl(url), {
    signal,
    serviceName: "ChEMBL compound cross-reference service",
    timeoutMs: CHEMBL_REQUEST_TIMEOUT_MS,
    retries: 0
  });
  return parseChemblMoleculeCandidateResponse(payload, matchType)
    .filter(candidate => descriptorsAreCompatible(candidate, descriptorContext));
}

/**
 * Resolve a PubChem compound against ChEMBL. Full InChIKey is authoritative.
 * If it differs, exact synonym/name and carefully labelled partial preferred-name
 * candidates may be offered only after formula and molecular-weight checks. These
 * fallback candidates are never labelled as exact structural matches.
 */
export async function resolveChemblMoleculeByInchiKey(inchiKey, {
  signal,
  input = "",
  inputType = "Name",
  formula = null,
  molecularWeight = null
} = {}) {
  const key = validateInchiKey(inchiKey);
  const searchUrl = new URL(`${CHEMBL_BASE}/molecule.json`);
  searchUrl.searchParams.set("molecule_structures__standard_inchi_key", key);
  searchUrl.searchParams.set("limit", "1000");
  searchUrl.searchParams.set("format", "json");

  // Do not launch a status request in parallel with the identity lookup. If
  // ChEMBL is down, a second request only adds load and makes the UI wait longer.
  // Exact structural identity is always checked first and never downgraded.
  const exactResult = await fetchChemblMoleculePages(searchUrl.href, key, { signal });
  if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");

  let molecules = exactResult.molecules;
  let totalCount = exactResult.totalCount;
  let matchType = molecules.length ? "exact-inchi-key" : null;
  let selectedSearchUrl = searchUrl.href;
  let fallbackWarning = null;

  // A successful empty exact-key result is different from an HTTP error. Only
  // after a valid empty result do we make one broad, descriptor-checked name
  // query. A 500/timeout from ChEMBL is surfaced immediately without trying
  // synonymous filters against the same backend.
  if (!molecules.length && inputType === "Name" && String(input || "").trim()) {
    const cleanInput = String(input).trim().slice(0, 120);
    const descriptorContext = { formula, molecularWeight };
    const nameUrl = new URL(`${CHEMBL_BASE}/molecule.json`);
    nameUrl.searchParams.set("pref_name__icontains", cleanInput);
    nameUrl.searchParams.set("limit", "50");
    nameUrl.searchParams.set("format", "json");
    selectedSearchUrl = nameUrl.href;

    try {
      molecules = await fetchChemblMoleculeCandidates(
        nameUrl.href,
        "preferred-name-contains",
        descriptorContext,
        { signal }
      );
      matchType = molecules.length ? "preferred-name-contains" : null;
      totalCount = molecules.length;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // A ChEMBL outage should stay an outage, not turn into a misleading
      // "no compound found" result.
      if (error?.code?.startsWith("CHEMBL_UPSTREAM") || error?.code === "CHEMBL_CIRCUIT_OPEN" || error?.code === "TIMEOUT") {
        throw error;
      }
      fallbackWarning = `The exact InChIKey lookup returned no match, and the single name-candidate lookup could not be completed: ${error.message}`;
      molecules = [];
      matchType = null;
      totalCount = 0;
    }
  }

  // Release metadata is supplementary. A short timeout prevents it from
  // delaying compound identification when the status service is slow.
  let status = { status: null, release: null, releaseDate: null };
  let statusWarning = null;
  try {
    const statusPayload = await requestJson(toChemblProxyUrl(`${CHEMBL_BASE}/status.json`), {
      signal,
      serviceName: "ChEMBL status service",
      timeoutMs: 1_500,
      retries: 0
    });
    status = parseChemblStatusResponse(statusPayload);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    statusWarning = "Compound matching completed, but ChEMBL release metadata could not be retrieved quickly.";
  }

  return {
    inchiKey: key,
    molecules,
    totalCount,
    exactMatchCount: exactResult.molecules.length,
    exactLookupWarning: null,
    matchType,
    matchLabel: matchType === "exact-inchi-key"
      ? "Exact full-InChIKey match"
      : matchType === "preferred-name-contains"
        ? "Cross-database candidate: ChEMBL preferred name contains the submitted name and formula/molecular weight match; the full structure key differs and must be reviewed"
        : null,
    retrievedAt: new Date().toISOString(),
    searchUrl: selectedSearchUrl,
    exactSearchUrl: searchUrl.href,
    status,
    statusWarning,
    fallbackWarning
  };
}

/**
 * Parse the ChEMBL activity collection while preserving values exactly as
 * supplied by ChEMBL. In particular, standard_value and pchembl_value are not
 * converted, recalculated, inferred, or normalized.
 */
export function parseChemblActivityResponse(payload) {
  const records = payload?.activities;
  if (!Array.isArray(records)) {
    throw new ApiError("ChEMBL returned an unexpected activity-search response.", {
      code: "INVALID_CHEMBL_ACTIVITY_RESPONSE"
    });
  }

  return records.map(record => ({
    activityId: record.activity_id ?? null,
    moleculeChemblId: record.molecule_chembl_id ?? null,
    assayChemblId: record.assay_chembl_id ?? null,
    assayDescription: record.assay_description ?? null,
    assayType: record.assay_type ?? null,
    assayOrganism: record.assay_organism ?? null,
    baoFormat: record.bao_format ?? null,
    baoLabel: record.bao_label ?? null,
    standardType: record.standard_type ?? null,
    standardRelation: record.standard_relation ?? null,
    standardValue: record.standard_value ?? null,
    standardTextValue: record.standard_text_value ?? null,
    standardUnits: record.standard_units ?? null,
    pchemblValue: record.pchembl_value ?? null,
    activityComment: record.activity_comment ?? null,
    dataValidityComment: record.data_validity_comment ?? null,
    targetChemblId: record.target_chembl_id ?? null,
    targetName: record.target_pref_name ?? null,
    targetOrganism: record.target_organism ?? null,
    targetTaxId: record.target_tax_id ?? null,
    targetType: record.target_type ?? null,
    documentChemblId: record.document_chembl_id ?? null,
    sourceDescription: record.src_description ?? null,
    journal: record.document_journal ?? record.doc_journal ?? null,
    publicationYear: record.document_year ?? record.doc_year ?? null
  }));
}

/** Group activity rows by ChEMBL target ID; rows without one are retained. */
export function groupChemblActivitiesByTarget(activities) {
  if (!Array.isArray(activities)) {
    throw new ApiError("Activity records must be an array before grouping.", {
      code: "INVALID_ACTIVITY_COLLECTION"
    });
  }

  const groups = new Map();
  for (const activity of activities) {
    const targetId = activity?.targetChemblId || null;
    const groupKey = targetId || "__UNASSIGNED_TARGET__";
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        targetChemblId: targetId,
        targetName: activity?.targetName || null,
        targetOrganism: activity?.targetOrganism || null,
        targetType: activity?.targetType || null,
        recordCount: 0,
        activities: []
      });
    }

    const group = groups.get(groupKey);
    group.recordCount += 1;
    group.activities.push(activity);
    // Fill summary annotations if earlier records omitted them.
    group.targetName ||= activity?.targetName || null;
    group.targetOrganism ||= activity?.targetOrganism || null;
    group.targetType ||= activity?.targetType || null;
  }

  return [...groups.values()];
}

const MAX_ACTIVITY_PAGES = 1000;
const ACTIVITY_PAGE_LIMIT = 500;
const PF_ACTIVITY_PAGE_LIMIT = 500;
const PF_ACTIVITY_PAGE_CONCURRENCY = 2;
const ACTIVITY_PAGE_CONCURRENCY = 3;

function normalizeActivityPageUrl(externalUrl, moleculeId, activityFields, pageLimit) {
  const parsedUrl = new URL(externalUrl);
  if (parsedUrl.origin !== "https://www.ebi.ac.uk") {
    throw new ApiError("ChEMBL returned an unexpected pagination host. Retrieval was stopped for safety.", {
      code: "INVALID_ACTIVITY_PAGINATION_URL",
      url: externalUrl
    });
  }
  if (parsedUrl.pathname === "/chembl/api/data/activity") {
    parsedUrl.pathname = "/chembl/api/data/activity.json";
  }
  if (parsedUrl.pathname !== "/chembl/api/data/activity.json") {
    throw new ApiError("ChEMBL returned an unexpected activity pagination endpoint. Retrieval was stopped for safety.", {
      code: "INVALID_ACTIVITY_PAGINATION_URL",
      url: externalUrl
    });
  }
  if (!parsedUrl.searchParams.has("molecule_chembl_id")) {
    parsedUrl.searchParams.set("molecule_chembl_id", moleculeId);
  }
  if (parsedUrl.searchParams.get("molecule_chembl_id") !== moleculeId) {
    throw new ApiError("ChEMBL pagination changed the requested molecule identifier. Retrieval was stopped for safety.", {
      code: "INVALID_ACTIVITY_PAGINATION_URL",
      url: externalUrl
    });
  }
  parsedUrl.searchParams.set("limit", String(pageLimit));
  parsedUrl.searchParams.set("format", "json");
  parsedUrl.searchParams.set("only", activityFields);
  parsedUrl.searchParams.set("order_by", "activity_id");
  return parsedUrl;
}

/**
 * Retrieve every ChEMBL activity row for one molecule. Uses 500-row pages and
 * at most three concurrent page requests when total_count is available. The
 * first page's page_meta.next link is used as the pagination template; offsets
 * are then requested in bounded parallel batches. Results are reassembled in
 * offset order before grouping.
 */
export async function retrieveChemblActivities(chemblId, { signal, onProgress, forceRefresh = false } = {}) {
  const moleculeId = String(chemblId || "").trim().toUpperCase();
  if (!/^CHEMBL\d+$/.test(moleculeId)) {
    throw new ApiError("Select a valid ChEMBL molecule record before retrieving activities.", {
      code: "INVALID_CHEMBL_MOLECULE_ID"
    });
  }

  const activityFields = [
    "activity_id", "molecule_chembl_id", "assay_chembl_id", "assay_description",
    "assay_type", "standard_type", "standard_relation", "standard_value",
    "standard_text_value", "standard_units", "pchembl_value", "activity_comment",
    "data_validity_comment", "target_chembl_id", "target_pref_name",
    "target_organism", "target_tax_id", "document_chembl_id",
    "document_journal", "document_year", "relation", "type", "units", "value"
  ].join(",");

  const firstUrl = new URL(`${CHEMBL_BASE}/activity.json`);
  firstUrl.searchParams.set("molecule_chembl_id", moleculeId);
  firstUrl.searchParams.set("limit", String(ACTIVITY_PAGE_LIMIT));
  firstUrl.searchParams.set("offset", "0");
  firstUrl.searchParams.set("format", "json");
  firstUrl.searchParams.set("only", activityFields);
  firstUrl.searchParams.set("order_by", "activity_id");

  const fetchPage = async pageUrl => {
    const safeUrl = normalizeActivityPageUrl(pageUrl, moleculeId, activityFields, ACTIVITY_PAGE_LIMIT);
    const payload = await requestJson(toChemblProxyUrl(safeUrl.href), {
      signal,
      serviceName: "ChEMBL activity service",
      useCache: !forceRefresh,
      timeoutMs: 12_000,
      retries: 0,
      // Pagination owns one explicit retry after 1 second. Permit that one
      // retry even if the global circuit breaker was opened by the first 503.
      bypassChemblCircuitBreaker: true
    });
    return { payload, activities: parseChemblActivityResponse(payload), url: safeUrl };
  };

  if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");

  const firstPage = await fetchPage(firstUrl.href);
  const firstMeta = firstPage.payload?.page_meta || {};
  const countValue = firstMeta.total_count;
  const numericTotal = countValue === null || countValue === undefined ? null : Number(countValue);
  const totalCount = Number.isInteger(numericTotal) && numericTotal >= 0 ? numericTotal : null;
  const actualLimit = Number(firstMeta.limit) > 0 ? Number(firstMeta.limit) : ACTIVITY_PAGE_LIMIT;
  const pageActivitiesByOffset = new Map([[0, firstPage.activities]]);
  let pageCount = 1;

  const reportProgress = () => {
    if (typeof onProgress !== "function") return;
    const retrievedCount = [...pageActivitiesByOffset.values()].reduce((sum, rows) => sum + rows.length, 0);
    onProgress({ pageCount, retrievedCount, totalCount });
  };
  reportProgress();

  const firstNext = firstMeta.next ? new URL(firstMeta.next, firstPage.url) : null;
  let nextOffset = null;
  if (firstNext) {
    const rawOffset = firstNext.searchParams.get("offset");
    nextOffset = rawOffset === null ? Number(firstMeta.offset || 0) + actualLimit : Number(rawOffset);
    if (!Number.isInteger(nextOffset) || nextOffset <= 0) {
      throw new ApiError("ChEMBL returned an invalid activity pagination offset.", {
        code: "INVALID_ACTIVITY_PAGINATION_URL",
        url: firstNext.href
      });
    }
  }

  if (totalCount !== null) {
    if (totalCount > firstPage.activities.length && !firstNext) {
      throw new ApiError(`ChEMBL reported ${totalCount} activity records but did not provide page_meta.next after the first ${firstPage.activities.length}. The result is incomplete.`, {
        code: "MISSING_ACTIVITY_NEXT_PAGE"
      });
    }

    const offsets = [];
    for (let offset = nextOffset; offset !== null && offset < totalCount; offset += actualLimit) {
      offsets.push(offset);
      if (offsets.length + 1 > MAX_ACTIVITY_PAGES) {
        throw new ApiError(`ChEMBL activity retrieval exceeded the safety limit of ${MAX_ACTIVITY_PAGES} pages. No partial result will be presented as complete.`, {
          code: "ACTIVITY_PAGINATION_LIMIT"
        });
      }
    }

    let nextIndex = 0;
    let firstFailure = null;
    const worker = async () => {
      while (!firstFailure && nextIndex < offsets.length) {
        if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
        const offset = offsets[nextIndex++];
        const pageUrl = new URL(firstNext.href);
        pageUrl.searchParams.set("offset", String(offset));
        try {
          const page = await fetchPage(pageUrl.href);
          const returnedOffset = Number(page.payload?.page_meta?.offset);
          if (Number.isInteger(returnedOffset) && returnedOffset !== offset) {
            throw new ApiError(`ChEMBL returned offset ${returnedOffset} when offset ${offset} was requested. The result may contain missing or duplicated pages.`, {
              code: "ACTIVITY_OFFSET_MISMATCH",
              url: pageUrl.href
            });
          }
          const pageTotal = page.payload?.page_meta?.total_count;
          if (pageTotal !== null && pageTotal !== undefined && Number(pageTotal) !== totalCount) {
            throw new ApiError(`ChEMBL reported inconsistent total_count values (${totalCount} and ${pageTotal}) across activity pages.`, {
              code: "ACTIVITY_TOTAL_COUNT_MISMATCH",
              url: pageUrl.href
            });
          }
          const expectedNextOffset = offset + actualLimit;
          const pageNext = page.payload?.page_meta?.next;
          if (expectedNextOffset < totalCount) {
            if (!pageNext) {
              throw new ApiError(`ChEMBL omitted page_meta.next after offset ${offset}; the remaining records cannot be verified.`, {
                code: "MISSING_ACTIVITY_NEXT_PAGE",
                url: pageUrl.href
              });
            }
            const nextPageUrl = new URL(pageNext, page.url);
            const reportedNextOffset = Number(nextPageUrl.searchParams.get("offset"));
            if (Number.isInteger(reportedNextOffset) && reportedNextOffset !== expectedNextOffset) {
              throw new ApiError(`ChEMBL pagination expected offset ${expectedNextOffset} after ${offset}, but returned ${reportedNextOffset}.`, {
                code: "ACTIVITY_OFFSET_MISMATCH",
                url: nextPageUrl.href
              });
            }
          }
          pageActivitiesByOffset.set(offset, page.activities);
          pageCount += 1;
          reportProgress();
        } catch (error) {
          firstFailure ||= error;
        }
      }
    };

    const workerCount = Math.min(ACTIVITY_PAGE_CONCURRENCY, offsets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (firstFailure) throw firstFailure;
  } else {
    // Defensive fallback for a response that omits total_count: follow each
    // page_meta.next link sequentially because the total number of pages is unknown.
    let nextUrl = firstNext?.href || null;
    const visited = new Set([firstPage.url.href]);
    let lastOffset = 0;
    while (nextUrl) {
      if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      if (pageCount >= MAX_ACTIVITY_PAGES) {
        throw new ApiError(`ChEMBL activity retrieval exceeded the safety limit of ${MAX_ACTIVITY_PAGES} pages.`, {
          code: "ACTIVITY_PAGINATION_LIMIT"
        });
      }
      const pageUrl = normalizeActivityPageUrl(nextUrl, moleculeId, activityFields, ACTIVITY_PAGE_LIMIT);
      if (visited.has(pageUrl.href)) {
        throw new ApiError("ChEMBL returned a repeated activity pagination link. Retrieval was stopped to avoid an infinite loop.", {
          code: "ACTIVITY_PAGINATION_LOOP",
          url: pageUrl.href
        });
      }
      visited.add(pageUrl.href);
      const offset = Number(pageUrl.searchParams.get("offset"));
      if (!Number.isInteger(offset) || offset <= lastOffset) {
        throw new ApiError("ChEMBL returned an invalid activity pagination offset.", {
          code: "INVALID_ACTIVITY_PAGINATION_URL",
          url: pageUrl.href
        });
      }
      const page = await fetchPage(pageUrl.href);
      pageActivitiesByOffset.set(offset, page.activities);
      pageCount += 1;
      lastOffset = offset;
      reportProgress();
      nextUrl = page.payload?.page_meta?.next ? new URL(page.payload.page_meta.next, page.url).href : null;
    }
  }

  const sortedOffsets = [...pageActivitiesByOffset.keys()].sort((a, b) => a - b);
  const activities = sortedOffsets.flatMap(offset => pageActivitiesByOffset.get(offset));
  const groups = groupChemblActivitiesByTarget(activities);
  const countMatches = totalCount === null ? null : activities.length === totalCount;
  return {
    moleculeChemblId: moleculeId,
    activities,
    groups,
    totalCount,
    retrievedCount: activities.length,
    groupCount: groups.length,
    pageCount,
    countMatches,
    complete: countMatches === null ? true : countMatches,
    pageLimit: ACTIVITY_PAGE_LIMIT,
    maxConcurrentRequests: ACTIVITY_PAGE_CONCURRENCY,
    retrievedAt: new Date().toISOString(),
    searchUrl: firstUrl.href,
    source: "ChEMBL Data Web Services"
  };
}

/** Parse curated ChEMBL mechanism-of-action annotations without inferring targets. */
export function parseChemblMechanismResponse(payload) {
  const records = payload?.mechanisms;
  if (!Array.isArray(records)) {
    throw new ApiError("ChEMBL returned an unexpected mechanism-search response.", {
      code: "INVALID_CHEMBL_MECHANISM_RESPONSE"
    });
  }
  return records.map(record => ({
    recordId: record.record_id ?? null,
    moleculeChemblId: record.molecule_chembl_id ?? null,
    targetChemblId: record.target_chembl_id ?? null,
    mechanismOfAction: record.mechanism_of_action ?? null,
    actionType: record.action_type ?? null,
    directInteraction: record.direct_interaction ?? null,
    mechanismComment: record.mechanism_comment ?? null,
    siteId: record.site_id ?? null
  }));
}

/** Parse target entities returned by ChEMBL, including their target components. */
export function parseChemblTargetResponse(payload) {
  // The collection endpoint returns { targets: [...] }, while the more robust
  // /target/CHEMBLxxxx.json resource endpoint returns one target object.
  const records = Array.isArray(payload?.targets)
    ? payload.targets
    : payload?.target_chembl_id
      ? [payload]
      : null;
  if (!records) {
    throw new ApiError("ChEMBL returned an unexpected target response.", {
      code: "INVALID_CHEMBL_TARGET_RESPONSE"
    });
  }
  return records.map(record => ({
    chemblId: record.target_chembl_id ?? null,
    name: record.pref_name ?? null,
    targetType: record.target_type ?? null,
    organism: record.organism ?? null,
    taxonId: record.tax_id ?? null,
    components: Array.isArray(record.target_components)
      ? record.target_components.map(component => ({
          accession: component?.accession ?? null,
          componentId: component?.component_id ?? null,
          componentType: component?.component_type ?? null,
          description: component?.component_description ?? component?.description ?? null
        }))
      : []
  }));
}

/** Parse the UniProtKB JSON record and preserve its source sequence exactly. */
export function parseUniProtProteinResponse(payload, requestedAccession) {
  const accession = payload?.primaryAccession || payload?.uniProtkbId || requestedAccession || null;
  const sequence = payload?.sequence?.value;
  if (typeof sequence !== "string" || !sequence.trim()) {
    throw new ApiError(`UniProt did not provide a sequence for accession ${requestedAccession}.`, {
      code: "UNIPROT_SEQUENCE_MISSING"
    });
  }
  const proteinDescription = payload?.proteinDescription || {};
  const recommendedName = proteinDescription?.recommendedName?.fullName?.value;
  const submissionNames = Array.isArray(proteinDescription?.submissionNames)
    ? proteinDescription.submissionNames.map(item => item?.fullName?.value).filter(Boolean)
    : [];
  const alternativeNames = Array.isArray(proteinDescription?.recommendedName?.alternativeNames)
    ? proteinDescription.recommendedName.alternativeNames.map(item => item?.fullName?.value).filter(Boolean)
    : [];
  const proteinNames = [...new Set([recommendedName, ...submissionNames, ...alternativeNames].filter(Boolean))];
  const geneName = payload?.genes?.[0]?.geneName?.value
    || payload?.genes?.[0]?.synonyms?.[0]?.value
    || null;
  return {
    accession,
    proteinName: recommendedName || submissionNames[0] || alternativeNames[0] || null,
    proteinNames,
    geneName,
    organism: payload?.organism?.scientificName || null,
    taxonId: payload?.organism?.taxonId ?? null,
    sequence,
    sequenceLength: payload?.sequence?.length ?? sequence.length,
    chemblCrossReferences: Array.isArray(payload?.uniProtKBCrossReferences)
      ? payload.uniProtKBCrossReferences
          .filter(item => String(item?.database || "").toLowerCase() === "chembl")
          .map(item => item?.id).filter(Boolean)
      : [],
    entryType: payload?.entryType || null,
    entryUrl: accession ? `https://www.uniprot.org/uniprotkb/${encodeURIComponent(accession)}/entry` : null
  };
}

/**
 * Accept only normalized exact protein-name matches from UniProtKB and only
 * entries whose returned taxonomy is P. falciparum (NCBI taxon 5833).
 * Similar-looking or partial-name hits are deliberately discarded.
 */
export function parseUniProtNameSearchResponse(payload, requestedName) {
  if (!Array.isArray(payload?.results)) {
    throw new ApiError("UniProtKB returned an unexpected protein-name search response.", {
      code: "INVALID_UNIPROT_SEARCH_RESPONSE"
    });
  }
  const normalizeName = value => String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const requested = normalizeName(requestedName);
  if (!requested) return [];

  const matches = [];
  for (const entry of payload.results) {
    let protein;
    try {
      protein = parseUniProtProteinResponse(entry, entry?.primaryAccession);
    } catch {
      continue;
    }
    if (!isPlasmodiumFalciparum(protein.organism, protein.taxonId)) continue;
    const matchedNames = protein.proteinNames || [protein.proteinName].filter(Boolean);
    const exactName = matchedNames.find(name => normalizeName(name) === requested);
    if (!exactName) continue;
    matches.push({ ...protein, matchedProteinName: exactName, nameMatchType: "normalized-exact" });
  }
  return [...new Map(matches.map(item => [item.accession, item])).values()];
}

function isPlasmodiumFalciparum(organism, taxonId = null) {
  const taxon = String(taxonId ?? "").trim();
  const organismText = typeof organism === "string" ? organism.trim() : "";
  const organismIsPf = /^plasmodium\s+falciparum(?:\s|\(|$)/i.test(organismText);
  // UniProt uses taxon 5833 for the species-level entry and 36329 for the
  // P. falciparum 3D7 isolate. Accept both only when the organism label agrees.
  const allowedTaxa = new Set(["5833", "36329"]);
  if (taxon && organismText) return allowedTaxa.has(taxon) && organismIsPf;
  if (taxon) return allowedTaxa.has(taxon);
  return organismIsPf;
}

function normalizePfActivityPageUrl(externalUrl, moleculeId, filterMode = "organism") {
  const parsedUrl = new URL(externalUrl);
  if (parsedUrl.origin !== "https://www.ebi.ac.uk") {
    throw new ApiError("ChEMBL returned an unexpected malaria-activity pagination host.", {
      code: "INVALID_PF_ACTIVITY_PAGINATION_URL",
      url: externalUrl
    });
  }
  if (parsedUrl.pathname === "/chembl/api/data/activity") parsedUrl.pathname = "/chembl/api/data/activity.json";
  if (parsedUrl.pathname !== "/chembl/api/data/activity.json") {
    throw new ApiError("ChEMBL returned an unexpected malaria-activity pagination endpoint.", {
      code: "INVALID_PF_ACTIVITY_PAGINATION_URL",
      url: externalUrl
    });
  }
  const requestedMolecule = parsedUrl.searchParams.get("molecule_chembl_id");
  if (requestedMolecule && requestedMolecule !== moleculeId) {
    throw new ApiError("ChEMBL pagination changed the requested molecule identifier.", {
      code: "INVALID_PF_ACTIVITY_PAGINATION_URL",
      url: externalUrl
    });
  }
  parsedUrl.searchParams.set("molecule_chembl_id", moleculeId);

  if (filterMode === "organism") {
    const organismFilter = parsedUrl.searchParams.get("target_organism__in");
    if (organismFilter && organismFilter.trim().toLowerCase() !== "plasmodium falciparum") {
      throw new ApiError("ChEMBL pagination changed the requested parasite-organism filter.", {
        code: "INVALID_PF_ACTIVITY_PAGINATION_URL",
        url: externalUrl
      });
    }
    parsedUrl.searchParams.delete("target_tax_id");
    parsedUrl.searchParams.set("target_organism__in", "Plasmodium falciparum");
  } else if (filterMode === "tax-id") {
    const requestedTaxId = parsedUrl.searchParams.get("target_tax_id");
    if (requestedTaxId && requestedTaxId !== "5833") {
      throw new ApiError("ChEMBL pagination changed the requested P. falciparum taxonomy filter.", {
        code: "INVALID_PF_ACTIVITY_PAGINATION_URL",
        url: externalUrl
      });
    }
    parsedUrl.searchParams.delete("target_organism__in");
    parsedUrl.searchParams.set("target_tax_id", "5833");
  } else {
    throw new ApiError("Unsupported malaria activity filter mode.", { code: "INVALID_PF_ACTIVITY_FILTER_MODE" });
  }
  const limit = Number(parsedUrl.searchParams.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > PF_ACTIVITY_PAGE_LIMIT) {
    parsedUrl.searchParams.set("limit", String(PF_ACTIVITY_PAGE_LIMIT));
  }
  parsedUrl.searchParams.set("format", "json");
  return parsedUrl;
}

const LOCAL_PF_FALLBACK_PAGE_LIMIT = 500;
const LOCAL_PF_FALLBACK_MAX_RECORDS = 25_000;
const LOCAL_PF_FALLBACK_MAX_PAGES = Math.ceil(LOCAL_PF_FALLBACK_MAX_RECORDS / LOCAL_PF_FALLBACK_PAGE_LIMIT);

function normalizeMoleculeActivityPageUrl(externalUrl, moleculeId) {
  const parsedUrl = new URL(externalUrl);
  if (parsedUrl.origin !== "https://www.ebi.ac.uk") {
    throw new ApiError("ChEMBL returned an unexpected host for the selected-molecule fallback.", {
      code: "INVALID_LOCAL_ACTIVITY_PAGINATION_URL", url: externalUrl
    });
  }
  if (parsedUrl.pathname === "/chembl/api/data/activity") parsedUrl.pathname = "/chembl/api/data/activity.json";
  if (parsedUrl.pathname !== "/chembl/api/data/activity.json") {
    throw new ApiError("ChEMBL returned an unexpected endpoint for the selected-molecule fallback.", {
      code: "INVALID_LOCAL_ACTIVITY_PAGINATION_URL", url: externalUrl
    });
  }
  const requestedMolecule = parsedUrl.searchParams.get("molecule_chembl_id");
  if (requestedMolecule && requestedMolecule !== moleculeId) {
    throw new ApiError("ChEMBL pagination changed the selected molecule ID.", {
      code: "INVALID_LOCAL_ACTIVITY_PAGINATION_URL", url: externalUrl
    });
  }
  parsedUrl.searchParams.set("molecule_chembl_id", moleculeId);
  parsedUrl.searchParams.delete("target_organism__in");
  parsedUrl.searchParams.delete("target_tax_id");
  const limit = Number(parsedUrl.searchParams.get("limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > LOCAL_PF_FALLBACK_PAGE_LIMIT) {
    parsedUrl.searchParams.set("limit", String(LOCAL_PF_FALLBACK_PAGE_LIMIT));
  }
  parsedUrl.searchParams.set("format", "json");
  return parsedUrl;
}

/**
 * Last-resort recovery when ChEMBL's organism/taxonomy filters return 5xx HTML.
 * This downloads activity rows for the selected molecule only, verifies every
 * page against ChEMBL's total_count, then filters by target organism/taxonomy
 * locally. It refuses oversized or unverified result sets rather than silently
 * displaying partial data.
 */
export async function retrieveMoleculeActivitiesForLocalPfFilter(moleculeId, { signal, onProgress, forceRefresh = false } = {}) {
  const firstUrl = new URL(`${CHEMBL_BASE}/activity.json`);
  firstUrl.searchParams.set("molecule_chembl_id", moleculeId);
  firstUrl.searchParams.set("limit", String(LOCAL_PF_FALLBACK_PAGE_LIMIT));
  firstUrl.searchParams.set("offset", "0");
  firstUrl.searchParams.set("format", "json");

  const fetchPage = async pageUrl => {
    const safeUrl = normalizeMoleculeActivityPageUrl(pageUrl, moleculeId);
    const payload = await requestJson(toChemblProxyUrl(safeUrl.href), {
      signal,
      serviceName: "ChEMBL selected-molecule fallback service",
      useCache: !forceRefresh,
      timeoutMs: 15_000,
      retries: 0,
      // Pagination owns one explicit retry after 1 second. Permit that retry
      // even if the global circuit breaker was opened by the first 503.
      bypassChemblCircuitBreaker: true
    });
    return { payload, activities: parseChemblActivityResponse(payload), url: safeUrl };
  };

  const firstPage = await fetchPage(firstUrl.href);
  const firstMeta = firstPage.payload?.page_meta || {};
  const totalCount = Number.isInteger(Number(firstMeta.total_count)) ? Number(firstMeta.total_count) : null;
  if (totalCount === null) {
    throw new ApiError("ChEMBL's selected-molecule fallback did not provide a verifiable total_count. A complete local species filter cannot be guaranteed.", {
      code: "LOCAL_FILTER_TOTAL_COUNT_UNAVAILABLE", url: firstUrl.href
    });
  }
  if (totalCount > LOCAL_PF_FALLBACK_MAX_RECORDS) {
    throw new ApiError(`ChEMBL reports ${totalCount.toLocaleString()} activity rows for this molecule. The safe local-filter fallback is capped at ${LOCAL_PF_FALLBACK_MAX_RECORDS.toLocaleString()} rows, so no partial target result was produced.`, {
      code: "LOCAL_FILTER_FALLBACK_TOO_LARGE", url: firstUrl.href
    });
  }

  const actualLimit = Number(firstMeta.limit) > 0 ? Number(firstMeta.limit) : LOCAL_PF_FALLBACK_PAGE_LIMIT;
  if (actualLimit > LOCAL_PF_FALLBACK_PAGE_LIMIT) {
    throw new ApiError("ChEMBL returned a larger page size than the local-filter fallback allows.", {
      code: "LOCAL_FILTER_PAGE_LIMIT_UNEXPECTED", url: firstUrl.href
    });
  }
  const pageData = new Map([[0, firstPage.activities]]);
  let pageCount = 1;
  let retrievedRows = firstPage.activities.length;
  const reportProgress = () => onProgress?.({
    phase: "local-filter-fallback",
    pageCount,
    retrievedCount: retrievedRows,
    totalCount
  });
  reportProgress();

  const firstNext = firstMeta.next ? new URL(firstMeta.next, firstPage.url) : null;
  if (totalCount > firstPage.activities.length && !firstNext) {
    throw new ApiError("ChEMBL's selected-molecule fallback omitted page_meta.next before all records were retrieved.", {
      code: "LOCAL_FILTER_NEXT_PAGE_MISSING", url: firstUrl.href
    });
  }

  if (firstNext) {
    const rawOffset = firstNext.searchParams.get("offset");
    const firstOffset = rawOffset === null ? actualLimit : Number(rawOffset);
    if (!Number.isInteger(firstOffset) || firstOffset <= 0) {
      throw new ApiError("ChEMBL returned an invalid next-page offset for the selected-molecule fallback.", {
        code: "INVALID_LOCAL_ACTIVITY_PAGINATION_URL", url: firstNext.href
      });
    }
    const offsets = [];
    for (let offset = firstOffset; offset < totalCount; offset += actualLimit) {
      offsets.push(offset);
      if (offsets.length + 1 > LOCAL_PF_FALLBACK_MAX_PAGES) {
        throw new ApiError("The selected-molecule fallback exceeded its page safety limit.", {
          code: "LOCAL_FILTER_FALLBACK_PAGE_LIMIT", url: firstUrl.href
        });
      }
    }
    let cursor = 0;
    let firstFailure = null;
    const worker = async () => {
      while (!firstFailure && cursor < offsets.length) {
        if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
        const offset = offsets[cursor++];
        const pageUrl = new URL(firstNext.href);
        pageUrl.searchParams.set("offset", String(offset));
        try {
          const page = await fetchPage(pageUrl.href);
          const returnedOffset = Number(page.payload?.page_meta?.offset);
          if (Number.isInteger(returnedOffset) && returnedOffset !== offset) {
            throw new ApiError(`ChEMBL returned offset ${returnedOffset} when ${offset} was requested in the selected-molecule fallback.`, {
              code: "LOCAL_FILTER_OFFSET_MISMATCH", url: pageUrl.href
            });
          }
          if (Number(page.payload?.page_meta?.total_count) !== totalCount) {
            throw new ApiError("ChEMBL returned inconsistent total_count values in the selected-molecule fallback.", {
              code: "LOCAL_FILTER_TOTAL_COUNT_MISMATCH", url: pageUrl.href
            });
          }
          const next = page.payload?.page_meta?.next;
          const expectedNext = offset + actualLimit;
          if (expectedNext < totalCount) {
            if (!next) {
              throw new ApiError(`ChEMBL omitted a next-page link after offset ${offset} in the selected-molecule fallback.`, {
                code: "LOCAL_FILTER_NEXT_PAGE_MISSING", url: pageUrl.href
              });
            }
            const nextOffset = Number(new URL(next, page.url).searchParams.get("offset"));
            if (Number.isInteger(nextOffset) && nextOffset !== expectedNext) {
              throw new ApiError(`ChEMBL pagination jumped from offset ${offset} to ${nextOffset}; expected ${expectedNext}.`, {
                code: "LOCAL_FILTER_OFFSET_MISMATCH", url: pageUrl.href
              });
            }
          }
          pageData.set(offset, page.activities);
          retrievedRows += page.activities.length;
          pageCount += 1;
          reportProgress();
        } catch (error) {
          firstFailure ||= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, offsets.length) }, () => worker()));
    if (firstFailure) throw firstFailure;
  }

  const allActivities = [...pageData.keys()].sort((a, b) => a - b).flatMap(offset => pageData.get(offset));
  if (allActivities.length !== totalCount) {
    throw new ApiError(`The selected-molecule fallback retrieved ${allActivities.length} of ${totalCount} records. Partial results will not be used for protein discovery.`, {
      code: "LOCAL_FILTER_INCOMPLETE", url: firstUrl.href
    });
  }
  const activityIds = allActivities.map(row => row.activityId).filter(Boolean);
  if (new Set(activityIds).size !== activityIds.length) {
    throw new ApiError("The selected-molecule fallback contained duplicate activity IDs across pages; results were rejected to avoid double-counting.", {
      code: "LOCAL_FILTER_DUPLICATE_ROWS", url: firstUrl.href
    });
  }
  const pfActivities = allActivities.filter(row => isPlasmodiumFalciparum(row.targetOrganism, row.targetTaxId));
  return {
    activities: pfActivities,
    allActivityCount: totalCount,
    pageCount,
    searchUrl: firstUrl.href
  };
}

function isRetryableChEMBLServiceError(error) {
  return Boolean(
    error?.status >= 500
    || error?.status === 408
    || error?.status === 429
    || error?.code === "INVALID_JSON"
    || error?.code === "TIMEOUT"
    || error?.code === "CHEMBL_PROXY_NETWORK_ERROR"
  );
}

function isConfirmedEbiChEMBLOutage(error) {
  return error?.code === "CHEMBL_UPSTREAM_EBI_OUTAGE"
    || error?.code === "CHEMBL_UPSTREAM_UNAVAILABLE"
    || error?.code === "CHEMBL_UPSTREAM_TIMEOUT"
    || error?.code === "CHEMBL_UPSTREAM_SERVICE_UNAVAILABLE"
    || error?.code === "CHEMBL_CIRCUIT_OPEN"
    || (error?.code === "CHEMBL_UPSTREAM_HTTP_ERROR" && Number(error?.details?.upstreamStatus) >= 500);
}

/**
 * Protein-focused workflow for one selected molecule:
 * 1) query only P. falciparum activity associations;
 * 2) fetch target metadata for the resulting ChEMBL target IDs;
 * 3) retain only single-protein targets with one UniProt component;
 * 4) resolve each UniProt entry and its source sequence.
 * Broad all-organism activity retrieval remains a separate optional audit.
 */
export async function retrievePfProteinTargets(chemblId, { signal, onProgress, forceRefresh = false } = {}) {
  const moleculeId = String(chemblId || "").trim().toUpperCase();
  if (!/^CHEMBL\d+$/.test(moleculeId)) {
    throw new ApiError("Select a valid ChEMBL molecule record before searching for malaria proteins.", {
      code: "INVALID_CHEMBL_MOLECULE_ID"
    });
  }

  const activityFields = [
    "activity_id", "target_chembl_id", "target_pref_name", "target_organism", "target_tax_id",
    "assay_chembl_id", "assay_description", "assay_type", "standard_type", "standard_relation",
    "standard_value", "standard_units", "pchembl_value", "document_chembl_id", "document_year"
  ].join(",");
  const firstUrl = new URL(`${CHEMBL_BASE}/activity.json`);
  firstUrl.searchParams.set("molecule_chembl_id", moleculeId);
  // Use the parasite's NCBI taxonomy ID as the primary filter. This is an
  // exact scalar filter on the activity target_tax_id field and avoids the
  // more expensive joined organism-name filter that has been slow/intermittent.
  firstUrl.searchParams.set("target_tax_id", "5833");
  firstUrl.searchParams.set("limit", String(PF_ACTIVITY_PAGE_LIMIT));
  firstUrl.searchParams.set("offset", "0");
  firstUrl.searchParams.set("format", "json");
  firstUrl.searchParams.set("only", activityFields);
  // Avoid ORDER BY on the joined activity/target query. ChEMBL's pagination
  // metadata is authoritative; offset pages are reassembled and count-checked.

  const activityQueryWarnings = [];
  let localFallbackStats = null;

  const requestActivityPage = async (safeUrl, serviceName, requestSignal = signal) => {
    const payload = await requestJson(toChemblProxyUrl(safeUrl.href), {
      signal: requestSignal,
      serviceName,
      useCache: !forceRefresh,
      timeoutMs: CHEMBL_REQUEST_TIMEOUT_MS,
      retries: 0,
      bypassChemblCircuitBreaker: true
    });
    return { payload, activities: parseChemblActivityResponse(payload), url: safeUrl };
  };

  const fetchActivityPage = async (pageUrl, filterMode = "tax-id", allowModeFallback = false, requestSignal = signal) => {
    const safeUrl = normalizePfActivityPageUrl(pageUrl, moleculeId, filterMode);
    try {
      const page = await requestActivityPage(safeUrl, "ChEMBL malaria-target association service", requestSignal);
      return { ...page, usedFallback: false, filterMode };
    } catch (primaryError) {
      if (primaryError?.name === "AbortError") throw primaryError;
      if (isConfirmedEbiChEMBLOutage(primaryError)) {
        throw new ApiError(
          `${primaryError.message} No alternate filters against the same ChEMBL backend were sent; the failed page was not counted and no partial protein result will be shown. Retry later.`,
          { status: primaryError.status, code: "CHEMBL_UPSTREAM_EBI_OUTAGE", url: safeUrl.href, details: primaryError.details }
        );
      }
      const isTransient = primaryError.status >= 500
        || primaryError.status === 408
        || primaryError.status === 429
        || primaryError.code === "TIMEOUT"
        || primaryError.code === "CHEMBL_PROXY_NETWORK_ERROR"
        || primaryError.code === "CHEMBL_CIRCUIT_OPEN";
      if (isTransient || !allowModeFallback || primaryError.status !== 400) throw primaryError;

      // The scalar taxonomy filter is the preferred path. Only when ChEMBL
      // explicitly rejects that query (HTTP 400) try the equivalent organism
      // name filter once. Server errors and timeouts never trigger alternatives.
      const alternateMode = filterMode === "tax-id" ? "organism" : "tax-id";
      const alternateUrl = new URL(safeUrl.href);
      alternateUrl.searchParams.delete("target_tax_id");
      alternateUrl.searchParams.delete("target_organism__in");
      if (alternateMode === "tax-id") alternateUrl.searchParams.set("target_tax_id", "5833");
      else alternateUrl.searchParams.set("target_organism__in", "Plasmodium falciparum");
      try {
        const alternateSafeUrl = normalizePfActivityPageUrl(alternateUrl.href, moleculeId, alternateMode);
        const alternatePage = await requestActivityPage(alternateSafeUrl, "ChEMBL alternate malaria filter service", requestSignal);
        activityQueryWarnings.push({
          url: safeUrl.href,
          message: `ChEMBL rejected the ${filterMode} filter with HTTP 400; the equivalent ${alternateMode} filter succeeded. Original error: ${primaryError.message}`
        });
        return { ...alternatePage, usedFallback: true, filterMode: alternateMode };
      } catch (alternateError) {
        if (alternateError?.name === "AbortError") throw alternateError;
        throw new ApiError(
          `ChEMBL rejected the primary malaria filter and the one equivalent fallback filter. No broad all-organism query was sent. Primary: ${primaryError.message} Fallback: ${alternateError.message}`,
          {
            status: alternateError.status || primaryError.status || null,
            code: "PF_ACTIVITY_FILTER_REJECTED",
            url: safeUrl.href,
            details: { primary: primaryError.details || null, fallback: alternateError.details || null }
          }
        );
      }
    }
  };

  onProgress?.({ phase: "mechanism", pageCount: 0, retrievedCount: 0, totalCount: null });
  const mechanismUrl = new URL(`${CHEMBL_BASE}/mechanism.json`);
  mechanismUrl.searchParams.set("molecule_chembl_id", moleculeId);
  mechanismUrl.searchParams.set("limit", "100");
  mechanismUrl.searchParams.set("format", "json");
  let mechanismRecords = [];
  let mechanismWarning = null;
  try {
    const mechanismPayload = await requestJson(toChemblProxyUrl(mechanismUrl.href), {
      signal,
      serviceName: "ChEMBL mechanism-of-action service",
      useCache: !forceRefresh,
      timeoutMs: CHEMBL_REQUEST_TIMEOUT_MS,
      retries: 0
    });
    mechanismRecords = parseChemblMechanismResponse(mechanismPayload);
    const mechanismTotal = Number(mechanismPayload?.page_meta?.total_count);
    if (Number.isFinite(mechanismTotal) && mechanismTotal > mechanismRecords.length) {
      mechanismWarning = `ChEMBL reports ${mechanismTotal} mechanism annotations, but the first ${mechanismRecords.length} were returned. The mechanism endpoint result may be paginated.`;
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    mechanismWarning = error?.message || "ChEMBL mechanism annotations could not be retrieved.";
  }

  if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");

  let firstPage;
  let activityUnavailable = false;
  try {
    firstPage = await fetchActivityPage(firstUrl.href, "tax-id", true);
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }

    activityUnavailable = true;
    activityQueryWarnings.push({
      code: error?.code || "PF_ACTIVITY_UNAVAILABLE",
      message: error?.message || "ChEMBL malaria activity retrieval failed."
    });
    firstPage = {
      payload: { page_meta: { offset: 0, limit: PF_ACTIVITY_PAGE_LIMIT, total_count: null, next: null } },
      activities: [],
      url: new URL(firstUrl.href),
      filterMode: "tax-id"
    };
  }
  const firstMeta = firstPage.payload?.page_meta || {};
  const rawTotal = firstMeta.total_count;
  const parsedTotal = rawTotal === null || rawTotal === undefined ? null : Number(rawTotal);
  let totalCount = Number.isInteger(parsedTotal) && parsedTotal >= 0 ? parsedTotal : null;
  let actualLimit = Number(firstMeta.limit) > 0 ? Number(firstMeta.limit) : PF_ACTIVITY_PAGE_LIMIT;
  const pageData = new Map([[0, firstPage.activities]]);
  let pageCount = activityUnavailable ? 0 : (firstPage.localFilterResult?.pageCount || 1);
  const filterMode = firstPage.filterMode || "organism";
  const isLocalFilterFallback = filterMode === "local-filter";
  const reportProgress = () => {
    if (typeof onProgress === "function") {
      const retrievedCount = [...pageData.values()].reduce((sum, rows) => sum + rows.length, 0);
      onProgress({ phase: "malaria-evidence", retrievedCount, totalCount, pageCount, pageLimit: actualLimit, filterMode });
    }
  };
  if (isLocalFilterFallback) {
    totalCount = firstPage.activities.length;
    actualLimit = LOCAL_PF_FALLBACK_PAGE_LIMIT;
    reportProgress();
  } else {
    reportProgress();
  }

  const firstNext = !isLocalFilterFallback && firstMeta.next ? new URL(firstMeta.next, firstPage.url) : null;
  const rawNextOffset = firstNext?.searchParams.get("offset");
  const nextOffset = firstNext
    ? (rawNextOffset === null ? Number(firstMeta.offset || 0) + actualLimit : Number(rawNextOffset))
    : null;
  const firstReturnedOffset = Number(firstMeta.offset);
  if (!Number.isInteger(firstReturnedOffset) || firstReturnedOffset !== 0) {
    throw new ApiError(`ChEMBL returned first-page offset ${Number.isFinite(firstReturnedOffset) ? firstReturnedOffset : "unknown"}; expected 0.`, {
      code: "PF_ACTIVITY_OFFSET_MISMATCH",
      url: firstPage.url.href
    });
  }
  if (firstNext && (!Number.isInteger(nextOffset) || nextOffset <= 0)) {
    throw new ApiError("ChEMBL returned an invalid malaria-activity pagination offset.", {
      code: "INVALID_PF_ACTIVITY_PAGINATION_URL",
      url: firstNext.href
    });
  }
  if (firstNext && totalCount !== null && nextOffset !== actualLimit) {
    throw new ApiError(`ChEMBL's first next-page offset is ${nextOffset}, but the effective page size is ${actualLimit}.`, {
      code: "PF_ACTIVITY_OFFSET_MISMATCH",
      url: firstNext.href
    });
  }

  if (!isLocalFilterFallback && totalCount !== null && totalCount > firstPage.activities.length && !firstNext) {
    throw new ApiError("ChEMBL reported more malaria activity records than were returned but omitted its next-page link.", {
      code: "MISSING_PF_ACTIVITY_NEXT_PAGE"
    });
  }

  if (!isLocalFilterFallback && totalCount !== null && firstNext) {
    const offsets = [];
    for (let offset = nextOffset; offset < totalCount; offset += actualLimit) {
      offsets.push(offset);
      if (offsets.length + 1 > MAX_ACTIVITY_PAGES) {
        throw new ApiError("Malaria activity pagination exceeded the safety page limit.", {
          code: "PF_ACTIVITY_PAGINATION_LIMIT"
        });
      }
    }
    let cursor = 0;
    const pageFailures = [];
    const pageBatchController = new AbortController();
    const abortPageBatchFromCaller = () => pageBatchController.abort();
    signal?.addEventListener("abort", abortPageBatchFromCaller, { once: true });
    const worker = async () => {
      while (cursor < offsets.length && !pageBatchController.signal.aborted) {
        if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
        const offset = offsets[cursor++];
        const pageUrl = new URL(firstNext.href);
        pageUrl.searchParams.set("offset", String(offset));
        let page = null;
        let lastError = null;
        // Exactly one retry for a failed chunk, after one second. A failed
        // second attempt is recorded as a gap; other completed pages are kept.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            if (attempt === 1) await sleep(1_000, pageBatchController.signal);
            page = await fetchActivityPage(pageUrl.href, filterMode, false, pageBatchController.signal);
            const returnedOffset = Number(page.payload?.page_meta?.offset);
            if (!Number.isInteger(returnedOffset) || returnedOffset !== offset) {
              throw new ApiError(`ChEMBL returned offset ${Number.isFinite(returnedOffset) ? returnedOffset : "unknown"} when ${offset} was requested.`, {
                code: "PF_ACTIVITY_OFFSET_MISMATCH", url: pageUrl.href
              });
            }
            if (page.payload?.page_meta?.total_count === undefined
                || Number(page.payload.page_meta.total_count) !== totalCount) {
              throw new ApiError("ChEMBL omitted or changed total_count across malaria activity pages.", {
                code: "PF_ACTIVITY_TOTAL_COUNT_MISMATCH", url: pageUrl.href
              });
            }
            const returnedLimit = Number(page.payload?.page_meta?.limit);
            if (!Number.isInteger(returnedLimit) || returnedLimit !== actualLimit) {
              throw new ApiError(`ChEMBL changed the effective page size from ${actualLimit} to ${Number.isFinite(returnedLimit) ? returnedLimit : "unknown"}.`, {
                code: "PF_ACTIVITY_PAGE_SIZE_MISMATCH", url: pageUrl.href
              });
            }
            break;
          } catch (error) {
            if (error?.name === "AbortError" && (signal?.aborted || pageBatchController.signal.aborted)) throw error;
            lastError = error;
            page = null;
            // Don't retry an explicitly invalid request or pagination mismatch.
            if (error?.status && error.status < 500 && error.status !== 408 && error.status !== 429) break;
          }
        }
        if (!page) {
          pageFailures.push({ offset, code: lastError?.code || "PAGE_FAILED", message: lastError?.message || "Activity page failed after one retry." });
          continue;
        }
        const expectedNextOffset = offset + actualLimit;
        if (expectedNextOffset < totalCount) {
          const nextLink = page.payload?.page_meta?.next;
          if (!nextLink) {
            pageFailures.push({ offset, code: "MISSING_PF_ACTIVITY_NEXT_PAGE", message: `ChEMBL omitted the next-page link after offset ${offset}.` });
            continue;
          }
          const nextPageUrl = new URL(nextLink, page.url);
          const returnedNextOffset = Number(nextPageUrl.searchParams.get("offset"));
          if (!Number.isInteger(returnedNextOffset) || returnedNextOffset !== expectedNextOffset) {
            pageFailures.push({ offset, code: "PF_ACTIVITY_OFFSET_MISMATCH", message: `ChEMBL returned next offset ${returnedNextOffset}; expected ${expectedNextOffset}.` });
            continue;
          }
        }
        pageData.set(offset, page.activities);
        pageCount += 1;
        reportProgress();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PF_ACTIVITY_PAGE_CONCURRENCY, offsets.length) }, () => worker()));
    } finally {
      signal?.removeEventListener("abort", abortPageBatchFromCaller);
    }
    if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
    // Keep all successfully retrieved pages. The final result is explicitly
    // marked incomplete and the UI must not describe it as a complete dataset.
    if (pageFailures.length) activityQueryWarnings.push(...pageFailures.map(failure => ({
      offset: failure.offset,
      code: failure.code,
      message: `Activity page at offset ${failure.offset} failed after one retry: ${failure.message}`
    })));
  } else if (!isLocalFilterFallback && totalCount === null) {
    let nextUrl = firstNext?.href || null;
    const visited = new Set([firstPage.url.href]);
    while (nextUrl) {
      if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      if (pageCount >= MAX_ACTIVITY_PAGES) {
        throw new ApiError("Malaria activity pagination exceeded the safety page limit.", {
          code: "PF_ACTIVITY_PAGINATION_LIMIT"
        });
      }
      const pageUrl = normalizePfActivityPageUrl(nextUrl, moleculeId, filterMode);
      if (visited.has(pageUrl.href)) {
        throw new ApiError("ChEMBL returned a repeated malaria-activity page link.", { code: "PF_ACTIVITY_PAGINATION_LOOP" });
      }
      visited.add(pageUrl.href);
      const page = await fetchActivityPage(pageUrl.href, filterMode, false);
      const offset = Number(page.payload?.page_meta?.offset);
      if (!Number.isInteger(offset) || offset <= 0) {
        throw new ApiError("ChEMBL returned an invalid malaria activity offset.", { code: "INVALID_PF_ACTIVITY_PAGINATION_URL" });
      }
      pageData.set(offset, page.activities);
      pageCount += 1;
      reportProgress();
      nextUrl = page.payload?.page_meta?.next ? new URL(page.payload.page_meta.next, page.url).href : null;
    }
  }



  const sortedOffsets = [...pageData.keys()].sort((a, b) => a - b);
  const expectedOffsets = totalCount === null ? [] : Array.from(
    { length: Math.ceil(totalCount / actualLimit) },
    (_, index) => index * actualLimit
  );
  const missingOffsets = expectedOffsets.filter(offset => !pageData.has(offset));
  const malariaActivities = sortedOffsets.flatMap(offset => pageData.get(offset));
  const activityIds = malariaActivities.map(record => record.activityId);
  if (activityIds.length !== malariaActivities.length) {
    throw new ApiError("One or more malaria activity rows did not include a ChEMBL activity ID. The result was rejected because records cannot be checked for pagination duplicates.", {
      code: "PF_ACTIVITY_ID_MISSING"
    });
  }
  if (new Set(activityIds).size !== activityIds.length) {
    throw new ApiError("ChEMBL returned duplicate activity IDs across malaria pages. The result was rejected to avoid double-counting evidence.", {
      code: "PF_ACTIVITY_DUPLICATE_ROWS"
    });
  }
  const unassignedActivityCount = malariaActivities.filter(record => !record.targetChemblId).length;
  const activityTargetIds = malariaActivities.map(record => record.targetChemblId).filter(Boolean);
  const mechanismTargetIds = mechanismRecords.map(record => record.targetChemblId).filter(Boolean);
  const uniqueTargetIds = [...new Set([...activityTargetIds, ...mechanismTargetIds])];
  const activityCounts = new Map();
  for (const record of malariaActivities) {
    if (!record.targetChemblId) continue;
    activityCounts.set(record.targetChemblId, (activityCounts.get(record.targetChemblId) || 0) + 1);
  }

  onProgress?.({ phase: "target-metadata", pageCount, retrievedCount: malariaActivities.length, totalCount, targetCount: uniqueTargetIds.length });
  // Resolve each target through ChEMBL's single-record resource URL
  // /target/CHEMBLxxxx.json. The previous collection-filter form
  // /target.json?target_chembl_id=... intermittently returned HTTP 500.
  const targetRecords = [];
  const targetLookupWarnings = [];
  const targetLookupFallbacks = [];
  let nextTargetIndex = 0;
  const targetWorker = async () => {
    while (nextTargetIndex < uniqueTargetIds.length) {
      if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      const targetId = uniqueTargetIds[nextTargetIndex++];
      const targetUrl = new URL(`${CHEMBL_BASE}/target/${encodeURIComponent(targetId)}.json`);
      try {
        const targetPayload = await requestJson(toChemblProxyUrl(targetUrl.href), {
          signal,
          serviceName: `ChEMBL target metadata service (${targetId})`,
          useCache: !forceRefresh,
          timeoutMs: CHEMBL_REQUEST_TIMEOUT_MS,
          retries: 0
        });
        targetRecords.push(...parseChemblTargetResponse(targetPayload));
      } catch (primaryError) {
        if (primaryError?.name === "AbortError") throw primaryError;
        if (isConfirmedEbiChEMBLOutage(primaryError) || isRetryableChEMBLServiceError(primaryError)) {
          targetLookupWarnings.push({ targetChemblId: targetId, message: primaryError.message });
          continue;
        }
        // Only try the collection route for a non-transient individual-record
        // problem (for example, a genuine 404). A 5xx/timeout is an upstream
        // failure and another endpoint on the same host would only add delay.
        try {
          const collectionUrl = new URL(`${CHEMBL_BASE}/target.json`);
          collectionUrl.searchParams.set("target_chembl_id", targetId);
          collectionUrl.searchParams.set("limit", "1");
          collectionUrl.searchParams.set("format", "json");
          const collectionPayload = await requestJson(toChemblProxyUrl(collectionUrl.href), {
            signal,
            serviceName: `ChEMBL target metadata fallback service (${targetId})`,
            useCache: !forceRefresh,
            timeoutMs: CHEMBL_REQUEST_TIMEOUT_MS,
            retries: 0
          });
          const records = parseChemblTargetResponse(collectionPayload).filter(item => item.chemblId === targetId);
          if (!records.length) throw new ApiError(`ChEMBL target fallback did not return the requested target ${targetId}.`, { code: "TARGET_FALLBACK_NOT_FOUND" });
          targetRecords.push(...records);
          targetLookupFallbacks.push({ targetChemblId: targetId, method: "target collection exact-ID filter" });
        } catch (fallbackError) {
          if (fallbackError?.name === "AbortError") throw fallbackError;
          targetLookupWarnings.push({
            targetChemblId: targetId,
            message: `${primaryError?.message || "Individual target lookup failed."} Collection fallback: ${fallbackError?.message || "unknown error"}`
          });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, uniqueTargetIds.length) }, () => targetWorker()));


  const targetMap = new Map(targetRecords.map(target => [target.chemblId, target]));
  const activityTargetMetadata = new Map();
  for (const activity of malariaActivities) {
    if (!activity.targetChemblId) continue;
    const existing = activityTargetMetadata.get(activity.targetChemblId) || {};
    activityTargetMetadata.set(activity.targetChemblId, {
      name: existing.name || activity.targetName || null,
      organism: existing.organism || activity.targetOrganism || null,
      taxonId: existing.taxonId || activity.targetTaxId || null,
      targetType: existing.targetType || activity.targetType || null
    });
  }
  const classifiedTargets = uniqueTargetIds.map(targetId => {
    const target = targetMap.get(targetId);
    const activityFallback = activityTargetMetadata.get(targetId) || {};
    return {
      ...(target || { chemblId: targetId, components: [] }),
      name: target?.name || activityFallback.name || null,
      organism: target?.organism || activityFallback.organism || null,
      taxonId: target?.taxonId || activityFallback.taxonId || null,
      targetType: target?.targetType || activityFallback.targetType || null,
      components: target?.components || [],
      metadataFound: Boolean(target),
      metadataSource: target ? "ChEMBL target record" : "ChEMBL activity fields (target metadata unavailable)",
      activityCount: activityCounts.get(targetId) || 0
    };
  });
  const pfTargets = classifiedTargets.filter(target => isPlasmodiumFalciparum(target.organism, target.taxonId));
  const pfTargetIds = new Set(pfTargets.map(target => target.chemblId));
  const pfMechanisms = mechanismRecords.filter(record => record.targetChemblId && pfTargetIds.has(record.targetChemblId));
  const mechanismCounts = new Map();
  for (const record of pfMechanisms) mechanismCounts.set(record.targetChemblId, (mechanismCounts.get(record.targetChemblId) || 0) + 1);
  for (const target of pfTargets) target.mechanismCount = mechanismCounts.get(target.chemblId) || 0;
  // Only entities with a known, non-single-protein ChEMBL type belong in the
  // excluded/non-protein list. Missing metadata is tracked separately.
  const excludedTargets = pfTargets
    .filter(target => Boolean(target.targetType) && String(target.targetType).toUpperCase() !== "SINGLE PROTEIN")
    .map(target => ({
      ...target,
      exclusionReason: `ChEMBL target type is ${target.targetType}, not SINGLE PROTEIN.`
    }));
  const nonProteinTargets = excludedTargets;
  const unclassifiedTargets = pfTargets.filter(target => !target.metadataFound || !target.organism || !target.targetType);
  const singleProteinTargets = pfTargets.filter(target => String(target.targetType || "").toUpperCase() === "SINGLE PROTEIN");
  const proteinCandidates = singleProteinTargets.map(target => {
    const component = target.components.length === 1 ? target.components[0] : null;
    const componentIsProtein = component?.componentType?.toUpperCase() === "PROTEIN";
    return {
      ...target,
      component,
      accession: componentIsProtein ? component.accession : null
    };
  });

  // When ChEMBL target metadata is unavailable, query UniProtKB by the
  // activity-record target name, restricted to taxonomy 5833. Keep these
  // records in a separate provisional list: a name match does not prove that
  // the ChEMBL target entity is a single protein or that the compound binds it.
  const fallbackTargets = pfTargets.filter(target => {
    const targetType = String(target.targetType || "").toUpperCase();
    const normalizedName = String(target.name || "").trim().toLowerCase();
    if (!target.name || /^(plasmodium falciparum|whole organism|organism)$/.test(normalizedName)) return false;
    if (targetType && targetType !== "SINGLE PROTEIN") return false;
    const component = target.components?.length === 1 ? target.components[0] : null;
    return !target.metadataFound || !targetType || !component?.accession;
  });
  const uniprotNameCandidates = [];
  const uniprotNameSearchWarnings = [];
  let nextFallbackTargetIndex = 0;
  let completedFallbackSearches = 0;
  const reportFallbackProgress = () => onProgress?.({
    phase: "uniprot-name-fallback",
    pageCount,
    retrievedCount: malariaActivities.length,
    totalCount,
    sequenceTotalCount: fallbackTargets.length,
    sequenceRetrievedCount: completedFallbackSearches
  });
  const uniprotNameSearchWorker = async () => {
    while (nextFallbackTargetIndex < fallbackTargets.length) {
      if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      const target = fallbackTargets[nextFallbackTargetIndex++];
      try {
        const searchPayload = await requestJson(toUniProtNameSearchProxyUrl(target.name), {
          signal,
          serviceName: `UniProtKB P. falciparum protein-name search (${target.name})`,
          useCache: !forceRefresh,
          timeoutMs: 20_000,
          retries: 1
        });
        const matches = parseUniProtNameSearchResponse(searchPayload, target.name);
        for (const uniprot of matches) {
          uniprotNameCandidates.push({
            ...target,
            targetType: "UniProt name-matched candidate",
            candidateKind: "uniprot-name-fallback",
            candidateStatus: `${uniprot.chemblCrossReferences?.includes(target.chemblId) ? `UniProtKB also cross-references ${target.chemblId}. ` : ""}Exact normalized protein-name match in P. falciparum UniProtKB${String(uniprot.taxonId) === "36329" ? " (3D7 isolate)" : ""}; ChEMBL target type/component metadata remains unavailable, so this is a provisional lead.`,
            chemblCrossReferenceMatch: Boolean(uniprot.chemblCrossReferences?.includes(target.chemblId)),
            accession: uniprot.accession,
            uniprot,
            activityCount: target.activityCount || 0,
            evidence: malariaActivities.filter(record => record.targetChemblId === target.chemblId).map(record => ({
              activityId: record.activityId,
              assayChemblId: record.assayChemblId,
              assayDescription: record.assayDescription,
              standardType: record.standardType,
              relation: record.standardRelation,
              value: record.standardValue,
              units: record.standardUnits,
              pchemblValue: record.pchemblValue,
              documentChemblId: record.documentChemblId,
              publicationYear: record.publicationYear
            })),
            mechanisms: pfMechanisms.filter(record => record.targetChemblId === target.chemblId)
          });
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        uniprotNameSearchWarnings.push({
          targetChemblId: target.chemblId,
          targetName: target.name,
          message: error?.message || "UniProtKB protein-name search failed."
        });
      } finally {
        completedFallbackSearches += 1;
        reportFallbackProgress();
      }
    }
  };
  reportFallbackProgress();
  await Promise.all(Array.from({ length: Math.min(3, fallbackTargets.length) }, () => uniprotNameSearchWorker()));

  const sequenceErrors = [];
  let nextProteinIndex = 0;
  let completedProteinLookups = 0;
  onProgress?.({ phase: "uniprot", pageCount, retrievedCount: malariaActivities.length, totalCount, sequenceTotalCount: proteinCandidates.length, sequenceRetrievedCount: 0 });
  const reportSequenceProgress = () => onProgress?.({
    phase: "uniprot",
    pageCount,
    retrievedCount: malariaActivities.length,
    totalCount,
    sequenceTotalCount: proteinCandidates.length,
    sequenceRetrievedCount: completedProteinLookups
  });
  const hydrateWorker = async () => {
    while (nextProteinIndex < proteinCandidates.length) {
      if (signal?.aborted) throw new DOMException("The request was cancelled.", "AbortError");
      const index = nextProteinIndex++;
      const protein = proteinCandidates[index];
      if (!protein.accession) {
        protein.sequenceError = "ChEMBL classified this as a single protein, but did not provide one confirmed protein component with a UniProt accession.";
        completedProteinLookups += 1;
        reportSequenceProgress();
        continue;
      }
      try {
        const payload = await requestJson(toUniProtProxyUrl(protein.accession), {
          signal,
          serviceName: "UniProtKB protein service",
          useCache: !forceRefresh,
          timeoutMs: 20_000
        });
        const uniprot = parseUniProtProteinResponse(payload, protein.accession);
        if (!isPlasmodiumFalciparum(uniprot.organism, uniprot.taxonId)) {
          protein.sequenceError = `UniProt reports ${uniprot.organism || "an unspecified organism"}; the sequence was not included as a P. falciparum protein.`;
          continue;
        }
        protein.uniprot = uniprot;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        protein.sequenceError = error?.message || "UniProt sequence lookup failed.";
        sequenceErrors.push({ accession: protein.accession, message: protein.sequenceError });
      } finally {
        completedProteinLookups += 1;
        reportSequenceProgress();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, proteinCandidates.length) }, () => hydrateWorker()));

  const proteins = proteinCandidates.map(protein => ({
    ...protein,
    evidence: malariaActivities
      .filter(record => record.targetChemblId === protein.chemblId)
      .map(record => ({
        activityId: record.activityId,
        assayChemblId: record.assayChemblId,
        assayDescription: record.assayDescription,
        standardType: record.standardType,
        relation: record.standardRelation,
        value: record.standardValue,
        units: record.standardUnits,
        pchemblValue: record.pchemblValue,
        documentChemblId: record.documentChemblId,
        publicationYear: record.publicationYear
      })),
    mechanisms: pfMechanisms.filter(record => record.targetChemblId === protein.chemblId)
  }));

  const countMatches = totalCount === null ? null : malariaActivities.length === totalCount;
  const activityComplete = countMatches === true && missingOffsets.length === 0;
  return {
    moleculeChemblId: moleculeId,
    malariaActivityTotal: totalCount,
    malariaActivityRetrieved: malariaActivities.length,
    malariaActivityCountMatches: countMatches,
    activityComplete,
    activityUnavailable,
    activityMissingOffsets: missingOffsets,
    activityFailedPages: activityQueryWarnings.filter(item => Number.isInteger(item.offset)),
    activityPageCount: pageCount,
    activityQueryWarnings,
    activityQueryWarning: activityUnavailable
      ? "ChEMBL malaria activity retrieval failed. Curated mechanism records were checked independently; no activity records are included in this result."
      : activityQueryWarnings.length
        ? (filterMode === "local-filter"
          ? "ChEMBL's server-side species filters were unavailable. The app retrieved and verified all activity rows for this selected molecule only, then filtered the rows locally to Plasmodium falciparum."
          : filterMode === "tax-id"
            ? "The organism-name filter was unavailable; the app used the equivalent NCBI taxonomy ID 5833 filter."
            : "ChEMBL required a simplified response for the same molecule and Plasmodium falciparum filter.")
        : null,
    activityFilterMode: filterMode,
    localFallbackStats,
    targetCount: pfTargets.length,
    unassignedActivityCount,
    allOrganismTargetCount: uniqueTargetIds.length,
    classifiedTargetCount: classifiedTargets.length,
    targetMetadataLookupCount: targetRecords.length,
    targetLookupWarnings,
    targetLookupFallbacks,
    mechanismCount: pfMechanisms.length,
    mechanismWarning,
    mechanismStatus: mechanismWarning
      ? (pfMechanisms.length ? "partial" : "unavailable")
      : "available",
    nonProteinTargets,
    excludedTargets,
    unclassifiedTargets,
    proteins,
    uniprotNameCandidates,
    uniprotNameSearchWarnings,
    sequenceCount: [
      ...proteins.filter(protein => protein.uniprot?.sequence),
      ...uniprotNameCandidates.filter(protein => protein.uniprot?.sequence)
    ].length,
    sequenceErrors,
    retrievedAt: new Date().toISOString(),
    source: "ChEMBL Data Web Services + UniProtKB REST API",
    activitySearchUrl: firstPage.url.href,
    mechanismSearchUrl: mechanismUrl.href
  };
}

