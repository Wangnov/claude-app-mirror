// Static site builder for claudeapp.agentsmirror.com
// Copies logo asset, hashes CSS/JS, builds zh & en HTML + 404 + OG SVGs,
// and pins inline JSON-LD SHA-256 hashes into dist/_headers.

import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COPY } from "../site/copy.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.dirname(path.dirname(ROOT));
const DIST = path.join(ROOT, "dist");
const PUBLIC = path.join(ROOT, "public");

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hashShort(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 10);
}

function buildJsonLd(t) {
  const graph = [
    {
      "@type": "Person",
      "@id": "https://agentsmirror.com/#wangnov",
      name: "Wangnov",
      url: "https://agentsmirror.com/",
      sameAs: ["https://github.com/Wangnov"],
    },
    {
      "@type": "WebSite",
      "@id": "https://claudeapp.agentsmirror.com/#website",
      name: "claude-app-mirror",
      alternateName: ["Claude 桌面版国内镜像", "Claude Desktop Mirror", "claudeapp.agentsmirror.com"],
      url: "https://claudeapp.agentsmirror.com/",
      inLanguage: ["zh-CN", "en"],
      publisher: { "@id": "https://agentsmirror.com/#wangnov" },
      isPartOf: {
        "@type": "WebSite",
        name: "agentsmirror",
        url: "https://agentsmirror.com/",
      },
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://claudeapp.agentsmirror.com/#software",
      name: "claude-app-mirror (Official Claude Desktop Verbatim Installer Mirror)",
      url: "https://claudeapp.agentsmirror.com/",
      downloadUrl: "https://claudeapp.agentsmirror.com/latest/mac",
      softwareVersion: "6.28899.6",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Windows 10/11, Ubuntu 22.04+, Debian 12+",
      maintainer: { "@id": "https://agentsmirror.com/#wangnov" },
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@type": "FAQPage",
      "@id": `${t.canonical}#faq`,
      mainEntity: t.faqSection.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.a,
        },
      })),
    },
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

function renderPage(t, assets, ogPath) {
  const ogUrl = `https://claudeapp.agentsmirror.com${ogPath}`;

  const statsHtml = t.stats
    .map(
      (s) => `
        <div class="stat-box">
          <p class="stat-num"${s.attr ? ` data-live="${esc(s.attr)}"` : ""}>${esc(s.val)}</p>
          <p class="stat-lbl">${esc(s.lbl)}</p>
        </div>`,
    )
    .join("");

  const dlCardsHtml = t.dlSection.platforms
    .map(
      (p) => `
        <div class="dl-card-wrap${p.wide ? " is-wide" : ""}">
          <article class="dl-card">
            <div>
              <div class="dl-top">
                <div>
                  <h3 class="dl-title">${esc(p.title)}</h3>
                  <p class="dl-sub">${esc(p.sub)}</p>
                </div>
                <a class="btn btn-terra" href="${esc(p.href)}">${esc(t.dlSection.dlBtn)}</a>
              </div>
              <div class="dl-meta" style="margin-top: 0.75rem;">
                <span class="dl-pill" data-size="${esc(p.key)}">${esc(p.defaultSize)}</span>
                <span class="dl-pill" data-sha="${esc(p.key)}">SHA256: ${esc(p.defaultSha.slice(0, 12))}…</span>
                <button class="copy-btn" type="button" data-sha-copy="${esc(p.key)}" data-copy="${esc(p.defaultSha)}">${esc(t.dlSection.copySha)}</button>
              </div>
            </div>
            <div class="cmd-row">
              <code>${esc(p.cmd)}</code>
              <button class="copy-btn" type="button" data-copy="${esc(p.cmd)}">${esc(t.dlSection.copyCmd)}</button>
            </div>
          </article>
        </div>`,
    )
    .join("");

  const notesHtml = t.guideSection.notes
    .map(
      (n) => `
        <article class="note-card">
          <h3>${esc(n.title)}</h3>
          <p>${esc(n.body)}</p>
          <pre><code>${esc(n.code)}</code></pre>
        </article>`,
    )
    .join("");

  const faqHtml = t.faqSection.items
    .map(
      (item, i) => `
        <details class="faq-item"${i === 0 ? " open" : ""}>
          <summary>${esc(item.q)}</summary>
          <div class="faq-answer">${esc(item.a)}</div>
        </details>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${esc(t.htmlLang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${esc(t.title)}</title>
  <meta name="description" content="${esc(t.description)}">
  <meta name="author" content="Wangnov">
  <link rel="canonical" href="${esc(t.canonical)}">
  <link rel="author" href="https://agentsmirror.com/">
  <link rel="alternate" hreflang="zh-CN" href="https://claudeapp.agentsmirror.com/">
  <link rel="alternate" hreflang="en" href="https://claudeapp.agentsmirror.com/en/">
  <link rel="alternate" hreflang="x-default" href="https://claudeapp.agentsmirror.com/">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="claude-app-mirror">
  <meta property="og:title" content="${esc(t.title)}">
  <meta property="og:description" content="${esc(t.description)}">
  <meta property="og:url" content="${esc(t.canonical)}">
  <meta property="og:image" content="${esc(ogUrl)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="${esc(t.ogLocale)}">
  <meta property="og:locale:alternate" content="${esc(t.ogAltLocale)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(t.title)}">
  <meta name="twitter:description" content="${esc(t.description)}">
  <meta name="twitter:image" content="${esc(ogUrl)}">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${esc(assets.css)}">
  <script type="application/ld+json">${buildJsonLd(t)}</script>
</head>
<body>
  <a class="skip-link" href="#main">${esc(t.skipLink)}</a>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="${esc(t.htmlLang === "zh-CN" ? "/" : "/en/")}">
        <img src="/favicon.svg" alt="" width="28" height="28">
        <span>claude-app-mirror</span>
        <span class="brand-tag">${esc(t.brandTag)}</span>
      </a>
      <nav class="nav-links" aria-label="Primary">
        ${t.nav.map(([h, l]) => `<a href="${esc(h)}">${esc(l)}</a>`).join("")}
      </nav>
      <div class="header-actions">
        <button class="pill-btn" type="button" data-theme-toggle aria-label="Toggle theme">◐</button>
        <a class="pill-btn" href="${esc(t.altHref)}" hreflang="${t.htmlLang === "zh-CN" ? "en" : "zh-CN"}" aria-label="${esc(t.altAria)}">${esc(t.altLabel)}</a>
        <a class="pill-btn" href="https://github.com/Wangnov/claude-app-mirror">GitHub</a>
      </div>
    </div>
  </header>

  <main id="main">
    <section class="hero">
      <div class="container">
        <div class="hero-grid">
          <div>
            <div class="status-pill">
              <span class="live-dot" aria-hidden="true"></span>
              <span>${esc(t.statusPrefix)} <strong class="mono" data-live="version">v6.28899.6</strong> · ${esc(t.statusCadence)}</span>
            </div>
            <h1>${esc(t.h1)}</h1>
            <p class="hero-lead">${esc(t.lead)}</p>
            <div class="hero-ctas">
              <a class="btn btn-terra" href="https://claudeapp.agentsmirror.com/latest/mac">${esc(t.ctaMac)}</a>
              <a class="btn btn-outline" href="https://claudeapp.agentsmirror.com/latest/win-x64">${esc(t.ctaWin)}</a>
              <a class="btn btn-outline mono" href="https://claudeapp.agentsmirror.com/latest/checksums">${esc(t.ctaChecksums)}</a>
            </div>
          </div>

          <aside class="summary-panel" aria-label="Mirror status">
            <div class="summary-brand">
              <img src="/logo.png" alt="claude-app-mirror icon" width="52" height="52" fetchpriority="high">
              <div>
                <strong style="display:block;font-size:1.05rem;">${esc(t.summaryTitle)}</strong>
                <span style="font-size:0.8rem;color:var(--ink-3);">${esc(t.summarySub)}</span>
              </div>
            </div>
            <div class="summary-stats">
              ${statsHtml}
            </div>
          </aside>
        </div>

        <div class="compliance-banner" role="note">
          ${t.complianceHtml}
        </div>
      </div>
    </section>

    <section class="section" id="download">
      <div class="container">
        <div class="section-head">
          <div>
            <span class="kicker">${esc(t.dlSection.kicker)}</span>
            <h2>${esc(t.dlSection.title)}</h2>
          </div>
          <p class="section-desc">${esc(t.dlSection.desc)}</p>
        </div>
        <div class="dl-grid">
          ${dlCardsHtml}
        </div>
      </div>
    </section>

    <section class="section" id="guide">
      <div class="container">
        <div class="section-head">
          <div>
            <span class="kicker">${esc(t.guideSection.kicker)}</span>
            <h2>${esc(t.guideSection.title)}</h2>
          </div>
          <p class="section-desc">${esc(t.guideSection.desc)}</p>
        </div>
        <div class="notes-grid">
          ${notesHtml}
        </div>
      </div>
    </section>

    <section class="section" id="faq">
      <div class="container">
        <div class="section-head">
          <div>
            <span class="kicker">${esc(t.faqSection.kicker)}</span>
            <h2>${esc(t.faqSection.title)}</h2>
          </div>
          <p class="section-desc">${esc(t.faqSection.desc)}</p>
        </div>
        <div class="faq-list">
          ${faqHtml}
        </div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container">
      <div class="footer-row">
        <div>
          <strong>claudeapp.agentsmirror.com</strong> · Maintained by <a href="https://agentsmirror.com/">Wangnov</a>
        </div>
        <div class="footer-links">
          ${t.footer.links.map(([l, h]) => `<a href="${esc(h)}">${esc(l)}</a>`).join("")}
        </div>
      </div>
      <p class="footer-disclaimer">${esc(t.footer.disclaimer)}</p>
    </div>
  </footer>
  <script src="${esc(assets.js)}" defer></script>
</body>
</html>
`;
}

function render404(assets) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="noindex">
  <title>404 · claudeapp.agentsmirror.com</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${esc(assets.css)}">
</head>
<body>
  <main class="container" style="padding-block: 6rem; max-width: 42rem;">
    <span class="kicker">404 / NOT FOUND</span>
    <h1 style="margin: 0.4rem 0 1rem;">页面未找到 · Page not found</h1>
    <p style="color: var(--ink-2); margin-bottom: 1.5rem;">请返回 Claude 桌面版镜像站首页下载最新 macOS DMG、Windows MSIX 或 Linux deb 安装包。</p>
    <div class="hero-ctas">
      <a class="btn btn-terra" href="/">中文首页</a>
      <a class="btn btn-outline" href="/en/">English Home</a>
    </div>
  </main>
</body>
</html>
`;
}

function makeOgSvg(lang) {
  const isZh = lang === "zh";
  const sub = isZh
    ? "Claude 桌面版官方原样国内镜像 · macOS DMG / Windows 离线 MSIX / Linux deb"
    : "Verbatim Official Claude Desktop Installers · macOS DMG · Windows MSIX · Linux deb";
  const line2 = isZh
    ? "每 15 分钟探测上游 · 完整保留官方代码签名与 SHA256SUMS.txt · 34.1万+ 次下载"
    : "Probed Every 15 Minutes · Intact Vendor Signatures & SHA256SUMS.txt · 341.6k+ Served";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#141110"/>
    <rect x="36" y="36" width="1128" height="558" rx="28" fill="#1c1816" stroke="#3b322d" stroke-width="2"/>
    <circle cx="104" cy="112" r="8" fill="#49c686"/>
    <text x="126" y="118" fill="#c2b9ac" font-family="-apple-system, PingFang SC, sans-serif" font-size="22">claudeapp.agentsmirror.com · Public-Interest Mirror</text>
    <text x="96" y="255" fill="#f5efe6" font-family="-apple-system, PingFang SC, sans-serif" font-size="68" font-weight="700">claude-app-mirror</text>
    <text x="96" y="338" fill="#e2805e" font-family="-apple-system, PingFang SC, sans-serif" font-size="33" font-weight="600">${esc(sub)}</text>
    <text x="96" y="412" fill="#c2b9ac" font-family="-apple-system, PingFang SC, sans-serif" font-size="25">${esc(line2)}</text>
    <line x1="96" y1="482" x2="1104" y2="482" stroke="#332c28" stroke-width="2"/>
    <text x="96" y="534" fill="#8e8579" font-family="SF Mono, Menlo, monospace" font-size="22">/latest/mac  ·  /latest/win-x64  ·  /latest/win-arm64  ·  /latest/linux-x64  ·  /latest/checksums</text>
  </svg>`;
}

async function collectHtmlFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await collectHtmlFiles(p)));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, "assets"), { recursive: true });
await mkdir(path.join(DIST, "en"), { recursive: true });
await cp(PUBLIC, DIST, { recursive: true });
await cp(path.join(REPO_ROOT, "assets/logo.png"), path.join(DIST, "logo.png"));

const cssRaw = await readFile(path.join(ROOT, "src/site.css"));
const jsRaw = await readFile(path.join(ROOT, "src/site.js"));
const cssName = `site-${hashShort(cssRaw)}.css`;
const jsName = `site-${hashShort(jsRaw)}.js`;
await writeFile(path.join(DIST, "assets", cssName), cssRaw);
await writeFile(path.join(DIST, "assets", jsName), jsRaw);

await writeFile(path.join(DIST, "og-zh.svg"), makeOgSvg("zh"), "utf8");
await writeFile(path.join(DIST, "og-en.svg"), makeOgSvg("en"), "utf8");

const assets = { css: `/assets/${cssName}`, js: `/assets/${jsName}` };
await writeFile(path.join(DIST, "index.html"), renderPage(COPY.zh, assets, "/og-zh.svg"), "utf8");
await writeFile(path.join(DIST, "en/index.html"), renderPage(COPY.en, assets, "/og-en.svg"), "utf8");
await writeFile(path.join(DIST, "404.html"), render404(assets), "utf8");

const hashes = new Set();
for (const file of await collectHtmlFiles(DIST)) {
  const html = await readFile(file, "utf8");
  for (const [, body] of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    hashes.add(`'sha256-${createHash("sha256").update(body).digest("base64")}'`);
  }
}
const headersPath = path.join(DIST, "_headers");
let headers = await readFile(headersPath, "utf8");
headers = headers.replace("__INLINE_SCRIPT_HASHES__", [...hashes].sort().join(" "));
await writeFile(headersPath, headers, "utf8");

console.log(`Built claudeapp.agentsmirror.com into ${DIST} (pinned ${hashes.size} inline script hash(es))`);
