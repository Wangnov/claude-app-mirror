// claudeapp.agentsmirror.com site worker.
//
// Static pages (/, /en/, /robots.txt, /sitemap.xml, /llms.txt) are served
// straight from Workers Static Assets; only /api/* runs this worker
// (run_worker_first: ["/api/*"]). /latest/* and /stats/* continue to route to
// claude-app-mirror-download-router via more-specific zone routes.

const TTL_SECONDS = 300;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status.json") {
      return serveStatus(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },
};

async function serveStatus(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const cache = caches.default;
  const key = new Request("https://claudeapp.agentsmirror.com/api/status.json");
  let response = await cache.match(key);

  if (!response) {
    const body = await buildStatus(env);
    const ok = Boolean(body.version);
    response = new Response(JSON.stringify(body), {
      status: ok ? 200 : 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": ok ? `public, max-age=60, s-maxage=${TTL_SECONDS}` : "no-store",
        "x-content-type-options": "nosniff",
      },
    });
    if (ok) {
      ctx.waitUntil(cache.put(key, response.clone()));
    }
  }

  return request.method === "HEAD" ? new Response(null, response) : response;
}

function pickFile(entry) {
  if (!entry) return null;
  return {
    assetName: entry.assetName ?? null,
    bytes: entry.contentLength ?? null,
    sha256: entry.sha256 ?? null,
    lastModified: entry.lastModified ?? null,
  };
}

async function buildStatus(env) {
  const [manifestRes, statsRes] = await Promise.allSettled([
    readJSON(env.MIRROR_BUCKET, "latest/manifest"),
    readJSON(env.MIRROR_BUCKET, "stats/state.json"),
  ]);

  const m = manifestRes.status === "fulfilled" ? manifestRes.value : null;
  const s = statsRes.status === "fulfilled" ? statsRes.value : null;

  return {
    generatedAt: new Date().toISOString(),
    version: m?.version ?? null,
    manifestGeneratedAt: m?.generatedAt ?? null,
    downloads: typeof s?.total === "number" ? s.total : null,
    files: {
      mac: pickFile(m?.sources?.macos?.universal),
      "win-x64": pickFile(m?.sources?.windows?.x64),
      "win-arm64": pickFile(m?.sources?.windows?.arm64),
      "linux-x64": pickFile(m?.sources?.linux?.x64),
      "linux-arm64": pickFile(m?.sources?.linux?.arm64),
    },
  };
}

async function readJSON(bucket, key) {
  if (!bucket) return null;
  const obj = await bucket.get(key);
  return obj ? obj.json() : null;
}
