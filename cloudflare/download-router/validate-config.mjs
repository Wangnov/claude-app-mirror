// CI guard: run this mirror's real ROUTE_CONFIG (from wrangler.jsonc) through
// the pinned kit download-router worker and assert the key routing behaviors.
// This catches drift/typos in the hand-maintained ROUTE_CONFIG that the kit's
// own tests (which use their own fixture) cannot see. Requires agents-mirror-kit
// checked out at .mirror-kit (the CI workflow does this).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wrangler = JSON.parse(
  readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
);
const routeConfig = wrangler.vars?.ROUTE_CONFIG;
assert.ok(routeConfig && routeConfig.aliases, "wrangler.jsonc must define vars.ROUTE_CONFIG.aliases");
assert.equal(
  wrangler.vars?.GLOBAL_MIRROR_BASE_URL,
  "https://claudeapp-r2.agentsmirror.com",
  "wrangler.jsonc must set GLOBAL_MIRROR_BASE_URL to https://claudeapp-r2.agentsmirror.com",
);
assert.equal(
  wrangler.vars?.SECONDARY_COUNTRY_CODES,
  "CN",
  "wrangler.jsonc must set SECONDARY_COUNTRY_CODES to CN",
);
assert.deepEqual(
  (wrangler.routes || []).map((route) => route.pattern),
  ["claudeapp.agentsmirror.com/latest/*", "claudeapp.agentsmirror.com/stats/*"],
  "wrangler.jsonc must declare /latest/* and /stats/* routes for claudeapp.agentsmirror.com",
);
assert.equal(
  wrangler.analytics_engine_datasets?.[0]?.dataset,
  "claude_mirror_downloads",
  "wrangler.jsonc must configure claude_mirror_downloads analytics dataset",
);

const { default: worker } = await import(
  new URL("../../.mirror-kit/workers/download-router/src/index.js", import.meta.url)
);

const GLOBAL = wrangler.vars.GLOBAL_MIRROR_BASE_URL;
const SECONDARY = {
  SECONDARY_COUNTRY_CODES: "CN",
  SECONDARY_S3_ENDPOINT: "https://s3.example.invalid",
  SECONDARY_S3_BUCKET: "secondary-bucket",
  SECONDARY_S3_REGION: "auto",
  SECONDARY_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
  SECONDARY_S3_SECRET_ACCESS_KEY: "secretexamplekey",
  SECONDARY_S3_PREFIX: "edge",
};

function analytics() {
  return { points: [], writeDataPoint(p) { this.points.push(p); } };
}

async function run(path, { country = "US", method = "GET", secondary = false } = {}) {
  const a = analytics();
  const env = {
    ROUTE_CONFIG: routeConfig,
    GLOBAL_MIRROR_BASE_URL: GLOBAL,
    DOWNLOAD_ANALYTICS: a,
    ...(secondary ? SECONDARY : {}),
  };
  const res = await worker.fetch(
    new Request(`https://claudeapp.agentsmirror.com${path}`, {
      method,
      headers: { "CF-IPCountry": country },
    }),
    env,
  );
  return { status: res.status, location: res.headers.get("Location"), points: a.points, res };
}

const installerCases = [
  ["/latest/mac", "Claude-mac-universal.dmg", "application/x-apple-diskimage"],
  ["/latest/win-x64", "Claude-win-x64.msix", "application/vnd.ms-appx"],
  ["/latest/win-arm64", "Claude-win-arm64.msix", "application/vnd.ms-appx"],
  ["/latest/linux-x64", "Claude-linux-x64.deb", "application/octet-stream"],
  ["/latest/linux-arm64", "Claude-linux-arm64.deb", "application/octet-stream"],
];

// All installer aliases: global 302 + counted as installer; CN 302 presigns secondary S3.
for (const [path, filename, contentType] of installerCases) {
  const globalResult = await run(path, { country: "US", secondary: true });
  assert.equal(globalResult.status, 302);
  assert.equal(globalResult.location, `${GLOBAL}${path}`);
  assert.deepEqual(globalResult.points.map((p) => p.blobs), [["global", "US", "installer"]]);

  const cnResult = await run(path, { country: "CN", secondary: true });
  assert.equal(cnResult.status, 302);
  const loc = new URL(cnResult.location);
  assert.equal(loc.origin, "https://s3.example.invalid");
  assert.equal(loc.pathname, `/secondary-bucket/edge${path}`);
  assert.equal(loc.searchParams.get("response-content-disposition"), `attachment; filename="${filename}"`);
  assert.equal(loc.searchParams.get("response-content-type"), contentType);
  assert.deepEqual(cnResult.points.map((p) => p.blobs), [["secondary", "CN", "installer"]]);
}

// Metadata paths: allowed for both global and CN, never counted in analytics.
for (const [path, filename, contentType] of [
  ["/latest/checksums", "SHA256SUMS.txt", "text/plain; charset=utf-8"],
  ["/latest/manifest", "release-manifest.json", "application/json"],
]) {
  const globalMeta = await run(path, { country: "US", secondary: true });
  assert.equal(globalMeta.status, 302);
  assert.equal(globalMeta.location, `${GLOBAL}${path}`);
  assert.deepEqual(globalMeta.points, []);

  const cnMeta = await run(path, { country: "CN", secondary: true });
  assert.equal(cnMeta.status, 302);
  const loc = new URL(cnMeta.location);
  assert.equal(loc.searchParams.get("response-content-disposition"), `attachment; filename="${filename}"`);
  assert.equal(loc.searchParams.get("response-content-type"), contentType);
  assert.deepEqual(cnMeta.points, []);
}

// Unknown paths (including Sparkle paths that Claude does not serve): 404.
for (const unknownPath of ["/latest/definitely-not-a-thing", "/latest/mac/arm64/Claude-1.0.0.delta"]) {
  const r = await run(unknownPath);
  assert.equal(r.status, 404);
}

// Stats badge proxy reads from GLOBAL_MIRROR_BASE_URL/stats/downloads.json.
{
  const originalFetch = globalThis.fetch;
  const badge = '{"schemaVersion":1,"label":"downloads","message":"12.3k","color":"brightgreen"}';
  globalThis.fetch = async (input) => {
    assert.equal(String(input), `${GLOBAL}/stats/downloads.json`);
    return new Response(badge, { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const r = await run("/stats/downloads.json");
    assert.equal(r.status, 200);
    assert.equal(await r.res.text(), badge);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("download-router config validated against kit worker");
