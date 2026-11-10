/** Same-origin proxy for NCBI RefSeq protein FASTA retrieval. */
export const handler = async (event) => {
  const params = new URLSearchParams(event.rawQuery || new URLSearchParams(event.queryStringParameters || {}).toString());
  const accession = String(params.get("accession") || "").trim();
  if (accession !== "XP_001351479.1") {
    return jsonResponse(400, { error: "Only the curated P. falciparum 3D7 DHFR-TS RefSeq accession is enabled.", code: "INVALID_NCBI_ACCESSION" });
  }
  const url = new URL("https://www.ncbi.nlm.nih.gov/sviewer/viewer.fcgi");
  url.searchParams.set("id", accession);
  url.searchParams.set("db", "protein");
  url.searchParams.set("report", "fasta");
  url.searchParams.set("retmode", "text");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url.href, { headers: { "User-Agent": "WebServer_MDT/1.0 (academic research prototype)", Accept: "text/plain" }, signal: controller.signal });
    const fasta = await response.text();
    if (!response.ok) return jsonResponse(502, { error: `NCBI returned HTTP ${response.status} for ${accession}.`, code: "NCBI_UPSTREAM_HTTP_ERROR" });
    const lines = fasta.trim().split(/\r?\n/);
    if (!lines[0]?.startsWith(">")) return jsonResponse(502, { error: "NCBI did not return a valid FASTA record.", code: "NCBI_INVALID_FASTA" });
    const sequence = lines.slice(1).join("").replace(/\s+/g, "").toUpperCase();
    if (!sequence || !/^[ACDEFGHIKLMNPQRSTVWY]+$/.test(sequence)) return jsonResponse(502, { error: "NCBI FASTA sequence was empty or contained invalid amino-acid characters.", code: "NCBI_INVALID_SEQUENCE" });
    return { statusCode: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-WebServer-MDT-Proxy": "ncbi" }, body: JSON.stringify({ accession, title: lines[0].slice(1), sequence, sequenceLength: sequence.length, proteinName: "Bifunctional dihydrofolate reductase-thymidylate synthase", geneName: "dhfr-ts", organism: "Plasmodium falciparum 3D7", source: "NCBI RefSeq" }) };
  } catch (error) {
    return jsonResponse(502, { error: error?.name === "AbortError" ? "NCBI did not respond before the 20-second proxy timeout." : "The NCBI proxy could not reach the upstream service.", code: error?.name === "AbortError" ? "NCBI_UPSTREAM_TIMEOUT" : "NCBI_NETWORK_ERROR" });
  } finally { clearTimeout(timeout); }
};
function jsonResponse(statusCode, payload) { return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify(payload) }; }
