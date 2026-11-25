// CI guard: run this mirror's real wrangler.jsonc (ROUTE_CONFIG + access policy
// + split TTL + extended analytics) and zone redirect rule against the pinned
// kit download-router worker and TERMS.md contract. Requires agents-mirror-kit
// checked out at .mirror-kit (the CI workflow does this).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const wrangler = JSON.parse(
  readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"),
);
const redirectRule = JSON.parse(
  readFileSync(new URL("../zone-rules/claudeapp-redirect.json", import.meta.url), "utf8"),
);
const cacheBypassRule = JSON.parse(
  readFileSync(new URL("../zone-rules/claudeapp-r2-cache-bypass.json", import.meta.url), "utf8"),
);
const termsMarkdown = readFileSync(new URL("../../TERMS.md", import.meta.url), "utf8");

const vars = wrangler.vars || {};
const routeConfig = vars.ROUTE_CONFIG;
assert.ok(routeConfig && routeConfig.aliases, "wrangler.jsonc must define vars.ROUTE_CONFIG.aliases");
assert.equal(
  vars.GLOBAL_MIRROR_BASE_URL,
  "https://claudeapp-r2.agentsmirror.com",
  "wrangler.jsonc must set GLOBAL_MIRROR_BASE_URL to https://claudeapp-r2.agentsmirror.com",
);
assert.equal(vars.SECONDARY_COUNTRY_CODES, "CN", "wrangler.jsonc must set SECONDARY_COUNTRY_CODES to CN");
assert.equal(vars.TERMS_HOME_URL, "https://github.com/Wangnov/claude-app-mirror", "TERMS_HOME_URL must point to GitHub repo (root / on claudeapp is 404)");
assert.equal(vars.TERMS_URL, "https://github.com/Wangnov/claude-app-mirror/blob/main/TERMS.md");
assert.equal(vars.SOURCE_REPO_URL, "https://github.com/Wangnov/claude-app-mirror");
assert.ok(vars.OFFICIAL_CHANNELS_HINT && vars.OFFICIAL_CHANNELS_HINT.includes("claude.ai"));
assert.ok(vars.INFRA_ATTRIBUTION && !vars.INFRA_ATTRIBUTION.includes("IHEP"));
assert.ok(vars.INFRA_ATTRIBUTION_CN && !vars.INFRA_ATTRIBUTION_CN.includes("高能物理研究所"));
assert.ok(Array.isArray(vars.BLOCKED_UA_SUBSTRINGS) && vars.BLOCKED_UA_SUBSTRINGS.length > 0);
assert.ok(Array.isArray(vars.BLOCKED_REFERER_HOSTS) && vars.BLOCKED_REFERER_HOSTS.length > 0);

// Guard against overly broad substrings or explicitly exempted projects.
for (const forbiddenToken of [
  "manager",
  "updater",
  "installer",
  "setup",
  "codex",
  "claude",
  "mirror",
  "curl",
  "xingmang-ai-manager",
  "pimpmyclaude",
]) {
  assert.ok(
    !vars.BLOCKED_UA_SUBSTRINGS.includes(forbiddenToken),
    `BLOCKED_UA_SUBSTRINGS must not include forbidden/exempt token: ${forbiddenToken}`,
  );
}

// Validate TERMS.md anchor contract (#open-client-policy) and R6/IHEP accuracy.
assert.match(termsMarkdown, /^## Open Client Policy$/m, "TERMS.md must contain exact '## Open Client Policy' heading for #open-client-policy anchor");
assert.ok(!termsMarkdown.includes("公开通报"), "TERMS.md must not include '公开通报' wording");
assert.ok(!termsMarkdown.includes("IHEP"), "TERMS.md must not claim CAS IHEP usage while secondary S3 is unconfigured");

// Validate Zone Single Redirect Rule stays in sync with BLOCKED_UA_SUBSTRINGS and within 4KB limit.
assert.equal(redirectRule.enabled, true, "redirect rule must be enabled");
assert.equal(redirectRule.action, "redirect", "redirect rule must use redirect action");
assert.equal(redirectRule.ref, "claudeapp_unauthorized_ua_redirect", "redirect rule must declare explicit ref");
const redirectExprBytes = Buffer.byteLength(redirectRule.expression, "utf8");
assert.ok(redirectExprBytes < 4096, `redirect rule expression exceeds 4096 UTF-8 bytes: ${redirectExprBytes}`);
assert.ok(
  redirectRule.expression.includes('http.host in {"claudeapp.agentsmirror.com" "claudeapp-r2.agentsmirror.com"}'),
  "redirect rule must cover both claudeapp and claudeapp-r2 hosts to prevent %2F encoded path bypass",
);
assert.ok(
  redirectRule.expression.includes('not (http.host eq "claudeapp.agentsmirror.com" and starts_with(http.request.uri.path, "/latest/"))'),
  "redirect rule must exclude normal /latest/* paths on claudeapp main host to prevent self-redirect",
);
assert.ok(
  redirectRule.expression.includes('not starts_with(http.request.uri.path, "/stats/")'),
  "redirect rule must exclude /stats/* paths",
);
assert.equal(
  redirectRule.action_parameters?.from_value?.target_url?.value,
  "https://claudeapp.agentsmirror.com/latest/manifest?mirror_policy=r2",
  "redirect rule must target constant allowed alias with ?mirror_policy=r2 loop breaker",
);
assert.equal(redirectRule.action_parameters?.from_value?.preserve_query_string, false);
assert.equal(redirectRule.action_parameters?.from_value?.status_code, 307);

const ruleUaMatches = [...redirectRule.expression.matchAll(/lower\(http\.user_agent\) contains "([^"]+)"/g)].map(
  (m) => m[1],
);
assert.ok(ruleUaMatches.length > 0, "redirect rule must contain UA match clauses");
for (const ruleUa of ruleUaMatches) {
  assert.ok(
    vars.BLOCKED_UA_SUBSTRINGS.includes(ruleUa),
    `redirect rule UA '${ruleUa}' must be present in wrangler.jsonc BLOCKED_UA_SUBSTRINGS`,
  );
}
assert.deepEqual(ruleUaMatches, vars.BLOCKED_UA_SUBSTRINGS, "redirect rule UA list should stay 1:1 aligned with BLOCKED_UA_SUBSTRINGS");

// Validate Cache Bypass Rule on claudeapp-r2 covers all 5 installer aliases and excludes metadata/stats.
assert.equal(cacheBypassRule.enabled, true, "cache bypass rule must be enabled");
assert.equal(cacheBypassRule.ref, "claudeapp_r2_large_binary_cache_bypass");
assert.equal(cacheBypassRule.action, "set_cache_settings");
assert.equal(cacheBypassRule.action_parameters?.cache, false);
assert.ok(Buffer.byteLength(cacheBypassRule.expression, "utf8") < 4096);
assert.ok(cacheBypassRule.expression.includes('http.host eq "claudeapp-r2.agentsmirror.com"'));
for (const [aliasPath, aliasSpec] of Object.entries(routeConfig.aliases)) {
  if (aliasSpec.category === "installer") {
    assert.ok(
      cacheBypassRule.expression.includes(`"${aliasPath}"`),
      `cache bypass rule must cover installer alias '${aliasPath}'`,
    );
  } else {
    assert.ok(
      !cacheBypassRule.expression.includes(`"${aliasPath}"`),
      `cache bypass rule must not match metadata alias '${aliasPath}'`,
    );
  }
}

assert.deepEqual(
  (wrangler.routes || []).map((route) => route.pattern),
  ["claudeapp.agentsmirror.com/latest/*", "claudeapp.agentsmirror.com/stats/*"],
  "wrangler.jsonc must declare /latest/* and /stats/* routes for claudeapp.agentsmirror.com",
);
assert.deepEqual(
  (wrangler.analytics_engine_datasets || []).map((d) => [d.binding, d.dataset]),
  [
    ["DOWNLOAD_ANALYTICS", "claude_mirror_downloads"],
    ["ABUSE_ANALYTICS", "claude_mirror_abuse"],
  ],
  "wrangler.jsonc must configure claude_mirror_downloads and claude_mirror_abuse datasets",
);

const { default: worker } = await import(
  new URL("../../.mirror-kit/workers/download-router/src/index.js", import.meta.url)
);

const GLOBAL = vars.GLOBAL_MIRROR_BASE_URL;
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

function asLatin1ByteString(utf8Text) {
  return String.fromCharCode(...new TextEncoder().encode(utf8Text));
}

async function run(path, { country = "US", method = "GET", secondary = false, headers = {}, envOverrides = {} } = {}) {
  const downloads = analytics();
  const abuse = analytics();
  const env = {
    ...vars,
    DOWNLOAD_ANALYTICS: downloads,
    ABUSE_ANALYTICS: abuse,
    ABUSE_SAMPLE_RATE: "1",
    ...(secondary ? SECONDARY : {}),
    ...envOverrides,
  };
  const res = await worker.fetch(
    new Request(`https://claudeapp.agentsmirror.com${path}`, {
      method,
      headers: { "CF-IPCountry": country, ...headers },
    }),
    env,
  );
  return { status: res.status, location: res.headers.get("Location"), points: downloads.points, abuse: abuse.points, res };
}

const installerCases = [
  ["/latest/mac", "Claude-mac-universal.dmg", "application/x-apple-diskimage"],
  ["/latest/win-x64", "Claude-win-x64.msix", "application/vnd.ms-appx"],
  ["/latest/win-arm64", "Claude-win-arm64.msix", "application/vnd.ms-appx"],
  ["/latest/linux-x64", "Claude-linux-x64.deb", "application/octet-stream"],
  ["/latest/linux-arm64", "Claude-linux-arm64.deb", "application/octet-stream"],
];

// All installer aliases: global 302 + 8-blob extended schema; CN 302 presigns secondary S3 with 600s TTL.
for (const [path, filename, contentType] of installerCases) {
  const globalResult = await run(path, { country: "US", secondary: true, headers: { "User-Agent": "curl/8.13.0" } });
  assert.equal(globalResult.status, 302);
  assert.equal(globalResult.location, `${GLOBAL}${path}`);
  assert.equal(globalResult.points.length, 1);
  assert.deepEqual(globalResult.points[0].blobs.slice(0, 4), ["global", "US", "installer", path]);
  assert.equal(globalResult.points[0].blobs[5], "curl/8.13.0");
  assert.equal(globalResult.points[0].blobs.length, 8);

  const cnResult = await run(path, { country: "CN", secondary: true, headers: { "User-Agent": "curl/8.13.0" } });
  assert.equal(cnResult.status, 302);
  const loc = new URL(cnResult.location);
  assert.equal(loc.origin, "https://s3.example.invalid");
  assert.equal(loc.pathname, `/secondary-bucket/edge${path}`);
  assert.equal(loc.searchParams.get("X-Amz-Expires"), "600");
  assert.equal(loc.searchParams.get("response-content-disposition"), `attachment; filename="${filename}"`);
  assert.equal(loc.searchParams.get("response-content-type"), contentType);
  assert.deepEqual(cnResult.points[0].blobs.slice(0, 3), ["secondary", "CN", "installer"]);

  const cnHead = await run(path, { country: "CN", secondary: true, method: "HEAD", headers: { "User-Agent": "curl/8.13.0" } });
  assert.equal(cnHead.status, 302);
  assert.equal(cnHead.points.length, 0);
}

// Phase 1 posture (no SECONDARY_S3_* secrets): CN requests safely fall back to global R2 302.
{
  const cnNoSec = await run("/latest/mac", { country: "CN", secondary: false, headers: { "User-Agent": "curl/8.13.0" } });
  assert.equal(cnNoSec.status, 302);
  assert.equal(cnNoSec.location, `${GLOBAL}/latest/mac`);
  assert.deepEqual(cnNoSec.points[0].blobs.slice(0, 3), ["global", "CN", "installer"]);
}

// Metadata paths: allowed for both global and CN (120s metadata TTL), never counted in download analytics.
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
  assert.equal(loc.searchParams.get("X-Amz-Expires"), "120");
  assert.equal(loc.searchParams.get("response-content-disposition"), `attachment; filename="${filename}"`);
  assert.equal(loc.searchParams.get("response-content-type"), contentType);
  assert.deepEqual(cnMeta.points, []);
}

// Legitimate first-party, open-source, and exempted UAs pass cleanly.
for (const allowedUa of [
  "Claude-App-Manager/0.1.0",
  "PimpMyClaude/208 CFNetwork/3896.200.61 Darwin/27.2.0",
  "xingmang-ai-manager/0.2.24",
  "codex2api",
  "KJHAssistant/1.20.0",
  "ChatGPTLauncher-CodexInstaller/1",
  "YuluoGptSetup/2.0",
  "XiaojiAssistant-CodexInstaller/1",
  "CopilotBridgeNative/1.5.6",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "aria2/1.37.0",
  "",
]) {
  const r = await run("/latest/win-x64", { headers: allowedUa ? { "User-Agent": allowedUa } : {} });
  assert.equal(r.status, 302, `expected UA to be allowed: '${allowedUa}'`);
}

// Unauthorized UAs (including CJK ByteString) receive 403 JSON with accurate claude attribution.
for (const blockedUa of [
  "Kakou/0.5.41",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RelayAutoConfig/1.0",
  "yrBridge-ClaudeMirror/1.0",
  "yaoyao-claude/0.1",
  "JieshangAI-Installer/0.2",
  "LDXP-Card-Admin/1",
  "NiceCodeTools/1.3.40",
  "TianyuLink-Installer/0.4",
  "yihaogpt-tools",
  "funtoolkit/0.1",
  asLatin1ByteString("Mozilla/5.0 越途AI智枢/1.9.0 Electron/43.2.0"),
]) {
  const r = await run("/latest/win-x64", { country: "CN", secondary: true, headers: { "User-Agent": blockedUa } });
  assert.equal(r.status, 403);
  assert.equal(r.res.headers.get("X-Mirror-Policy"), "client-not-authorized");
  assert.equal(
    r.res.headers.get("Link"),
    '<https://github.com/Wangnov/claude-app-mirror/blob/main/TERMS.md>; rel="terms-of-service"',
  );
  const body = await r.res.json();
  const rawJson = JSON.stringify(body);
  assert.equal(body.error, "client_not_authorized");
  assert.equal(body.terms, "https://github.com/Wangnov/claude-app-mirror/blob/main/TERMS.md");
  assert.ok(body.alternatives[0].includes("claude.ai/download / downloads.claude.ai"));
  assert.ok(body.alternatives[1].includes("TERMS.md#open-client-policy"));
  assert.ok(!rawJson.includes("IHEP"));
  assert.ok(!rawJson.includes("高能物理研究所"));
  assert.ok(!rawJson.includes("公开通报"));
  assert.ok(!rawJson.includes("Microsoft Store"));
  assert.equal(r.points.length, 0);
  assert.equal(r.abuse.length, 1);
}

// Loop-breaker target from R1 Single Redirect Rule always terminates in 403 even if BLOCK_MODE=shadow/off.
{
  const bounced = await run("/latest/manifest?mirror_policy=r2", {
    headers: { "User-Agent": "Kakou/0.5.41" },
    envOverrides: { BLOCK_MODE: "shadow" },
  });
  assert.equal(bounced.status, 403);
  assert.equal(bounced.abuse.length, 1);
  assert.equal(bounced.abuse[0].blobs[0], "blocked-r2-redirect");
}

// Hotlink Referer redirects to GitHub repository home page (NOT 404 claudeapp.agentsmirror.com/).
{
  const hotlink = await run("/latest/win-x64", { headers: { Referer: "https://gpt.dqtx.cc/claude" } });
  assert.equal(hotlink.status, 302);
  assert.equal(hotlink.location, "https://github.com/Wangnov/claude-app-mirror");
  assert.equal(hotlink.abuse.length, 1);
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

console.log("download-router config and zone redirect rule validated against kit worker");
