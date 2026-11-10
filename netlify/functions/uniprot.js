/** Same-origin proxy for UniProtKB accession and species-restricted name searches. */
import { adaptLambdaHandler } from './_shared.js';
export const handler = async (event) => {
  const params = new URLSearchParams(event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString());
  const accession = String(params.get("accession") || "").trim().toUpperCase();
  const searchName = String(params.get("search") || "").trim();

  let upstreamUrl;
  if (accession) {
    if (!/^[A-Z0-9]{6,10}$/.test(accession) || searchName) {
      return jsonResponse(400, { error: "A valid UniProtKB accession is required for an accession lookup.", code: "INVALID_UNIPROT_ACCESSION" });
    }
    upstreamUrl = new URL(`https://rest.uniprot.org/uniprotkb/${encodeURIComponent(accession)}.json`);
  } else if (searchName) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}\s.'()/-]{1,119}$/u.test(searchName)) {
      return jsonResponse(400, { error: "The target name is not valid for a UniProtKB search.", code: "INVALID_UNIPROT_SEARCH_NAME" });
    }
    upstreamUrl = new URL("https://rest.uniprot.org/uniprotkb/search");
    upstreamUrl.searchParams.set("query", `(organism_id:5833 OR organism_id:36329) AND protein_name:"${searchName}"`);
    upstreamUrl.searchParams.set("format", "json");
    upstreamUrl.searchParams.set("size", "10");
  } else {
    return jsonResponse(400, { error: "Provide either a UniProtKB accession or a protein name.", code: "UNIPROT_LOOKUP_REQUIRED" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const upstream = await fetch(upstreamUrl.href, {
      headers: { Accept: "application/json", "User-Agent": "WebServer_MDT/1.0 (academic research prototype)" },
      signal: controller.signal
    });
    const body = await upstream.text();
    let parsed;
    try { parsed = body.trim() ? JSON.parse(body) : null; } catch { parsed = undefined; }
    if (!upstream.ok) {
      return jsonResponse(502, {
        error: `UniProtKB returned HTTP ${upstream.status} for ${accession ? `accession ${accession}` : `protein name ${searchName}`}.`,
        code: "UNIPROT_UPSTREAM_HTTP_ERROR",
        upstreamStatus: upstream.status,
        responsePreview: preview(body)
      });
    }
    const validPayload = accession
      ? parsed && parsed.primaryAccession !== undefined
      : parsed && Array.isArray(parsed.results);
    if (!validPayload) {
      return jsonResponse(502, {
        error: "UniProtKB returned an unexpected response.",
        code: "UNIPROT_INVALID_RESPONSE",
        responsePreview: preview(body)
      });
    }
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "X-WebServer-MDT-Proxy": "uniprot"
      },
      body
    };
  } catch (error) {
    return jsonResponse(502, {
      error: error?.name === "AbortError"
        ? "UniProtKB did not respond before the 20-second proxy timeout."
        : "The UniProtKB proxy could not reach the upstream service.",
      code: error?.name === "AbortError" ? "UNIPROT_UPSTREAM_TIMEOUT" : "UNIPROT_NETWORK_ERROR"
    });
  } finally {
    clearTimeout(timeout);
  }
};

function preview(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 220);
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(payload)
  };
}


export default async function netlifyHandler(request) {
  return adaptLambdaHandler(request, handler);
}
