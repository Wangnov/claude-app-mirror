// Progressive enhancement for claudeapp.agentsmirror.com:
// 1. Theme toggle + system media query listener
// 2. One-click command & SHA-256 copy
// 3. Live R2 manifest & download count hydration from /api/status.json

(function () {
  const root = document.documentElement;
  const lang = root.lang.startsWith("zh") ? "zh" : "en";
  const STORAGE_KEY = "cam-mirror-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function applyTheme(pref) {
    if (pref === "light" || pref === "dark") root.setAttribute("data-theme", pref);
    else root.removeAttribute("data-theme");
  }

  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {}
  applyTheme(saved);

  media.addEventListener("change", () => {
    if (!saved) applyTheme(null);
  });

  const toggle = document.querySelector("[data-theme-toggle]");
  if (toggle) {
    toggle.addEventListener("click", () => {
      saved = saved === null ? (media.matches ? "light" : "dark") : saved === "dark" ? "light" : null;
      try {
        if (saved) localStorage.setItem(STORAGE_KEY, saved);
        else localStorage.removeItem(STORAGE_KEY);
      } catch {}
      applyTheme(saved);
    });
  }

  document.addEventListener("click", async (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-copy]") : null;
    if (!btn) return;
    const val = btn.getAttribute("data-copy");
    if (!val || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(val);
      const orig = btn.textContent;
      btn.setAttribute("data-copied", "true");
      btn.textContent = lang === "zh" ? "已复制" : "Copied";
      setTimeout(() => {
        btn.removeAttribute("data-copied");
        btn.textContent = orig;
      }, 1600);
    } catch {}
  });

  function fmtMB(bytes) {
    if (typeof bytes !== "number" || bytes <= 0) return null;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function fmtDownloads(n) {
    if (typeof n !== "number" || n <= 0) return null;
    if (lang === "zh") {
      return n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万+` : `${n}+`;
    }
    return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k+` : `${n}+`;
  }

  fetch("/api/status.json", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      if (d.version) {
        for (const el of document.querySelectorAll('[data-live="version"]')) {
          el.textContent = `v${d.version}`;
        }
      }
      if (d.downloads) {
        const dlText = fmtDownloads(d.downloads);
        if (dlText) {
          for (const el of document.querySelectorAll('[data-live="downloads"]')) {
            el.textContent = dlText;
          }
        }
      }
      if (d.files) {
        for (const [key, info] of Object.entries(d.files)) {
          if (!info) continue;
          const mb = fmtMB(info.bytes);
          if (mb) {
            const sizeEl = document.querySelector(`[data-size="${key}"]`);
            if (sizeEl) sizeEl.textContent = mb;
          }
          if (info.sha256) {
            const shaEl = document.querySelector(`[data-sha="${key}"]`);
            if (shaEl) shaEl.textContent = `SHA256: ${info.sha256.slice(0, 12)}…`;
            const shaBtn = document.querySelector(`[data-sha-copy="${key}"]`);
            if (shaBtn) shaBtn.setAttribute("data-copy", info.sha256);
          }
        }
      }
    })
    .catch(() => {});
})();
