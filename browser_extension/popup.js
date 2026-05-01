// SkillLens — toolbar popup logic.
// The popup is the first thing users see after pinning the extension; it has to
// communicate the product story (utility, safety, cost — measured) in under
// five seconds and route users to the live surfaces (GitHub overlay, marketplace
// button, full report popup).

// Public artifacts mirror works zero-config. Switch to a local
// ``http://127.0.0.1:8765`` server via the Backend URL setting if you want
// to evaluate skills on demand or self-host the lookup index.
const DEFAULT_SERVER_BASE_URL = "https://skilllens-ai.github.io/skilllens/artifacts/api";
const SERVER_BASE_URL_STORAGE_KEY = "skilllens_server_base_url";

function getServerBaseUrl() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(SERVER_BASE_URL_STORAGE_KEY, (result) => {
        const stored = result && result[SERVER_BASE_URL_STORAGE_KEY];
        resolve(String(stored || DEFAULT_SERVER_BASE_URL).replace(/\/+$/, ""));
      });
    } catch (_err) {
      resolve(DEFAULT_SERVER_BASE_URL);
    }
  });
}

function setServerBaseUrl(value) {
  const cleaned = String(value || "").trim().replace(/\/+$/, "") || DEFAULT_SERVER_BASE_URL;
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set({ [SERVER_BASE_URL_STORAGE_KEY]: cleaned }, () => resolve(cleaned));
    } catch (_err) {
      resolve(cleaned);
    }
  });
}

const FEATURED_AUDITS = [
  {
    name: "anthropics/skills · pdf",
    sub: "v0.4.2 · paired · +18.2pp Δpass@1",
    score: 88,
    verdict: "adopt",
    href: "https://github.com/anthropics/skills/tree/main/document-skills/pdf"
  },
  {
    name: "anthropics/skills · brand-guidelines",
    sub: "v0.3.1 · paired · +16.4pp Δpass@1",
    score: 86,
    verdict: "adopt",
    href: "https://github.com/anthropics/skills/tree/main/document-skills/brand-guidelines"
  },
  {
    name: "obra/superpowers · refactor",
    sub: "v1.2.0 · paired · +9.8pp Δpass@1",
    score: 76,
    verdict: "adopt",
    href: "https://github.com/obra/superpowers/tree/main/skills/refactor"
  },
  {
    name: "example-org/legacy-skill",
    sub: "v0.9 · 4 static hits · shell + net flags",
    score: 22,
    verdict: "avoid",
    href: ""
  }
];

const SUGGESTIONS = [
  { label: "github.com/anthropics/skills", href: "https://github.com/anthropics/skills" },
  { label: "github.com/obra/superpowers",  href: "https://github.com/obra/superpowers" },
  { label: "skillsmp.com",                 href: "https://skillsmp.com" }
];

const PROJECT_URLS = {
  docs:    "https://skilllens-ai.github.io/",
  github:  "https://github.com/SkillLens-AI/skilllens",
  privacy: "https://github.com/SkillLens-AI/skilllens/blob/main/browser_extension/README.md#privacy"
};

const VERDICT_COLOR = {
  adopt:  { color: "#4ade80" },
  review: { color: "#facc15" },
  avoid:  { color: "#f87171" }
};

function el(id) { return document.getElementById(id); }

function openTab(url) {
  if (!url) return;
  if (chrome?.tabs?.create) chrome.tabs.create({ url });
  else window.open(url, "_blank", "noopener");
}

function showToast(message, tone = "info", ms = 2400) {
  const toast = el("pop-toast");
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, ms);
}

function renderFeatured() {
  const feed = el("pop-feed");
  feed.innerHTML = "";

  for (const item of FEATURED_AUDITS) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pop-feed-row";

    const ringColor = VERDICT_COLOR[item.verdict]?.color || "#22d7cf";
    const ring = document.createElement("div");
    ring.className = "pop-feed-ring";
    ring.style.setProperty("--ring-color", ringColor);
    ring.style.setProperty("--ring-pct", String(item.score));
    const ringNum = document.createElement("span");
    ringNum.textContent = String(item.score);
    ring.appendChild(ringNum);

    const meta = document.createElement("div");
    meta.className = "pop-feed-meta";
    const name = document.createElement("div");
    name.className = "pop-feed-name";
    name.textContent = item.name;
    const sub = document.createElement("div");
    sub.className = "pop-feed-sub";
    sub.textContent = item.sub;
    meta.appendChild(name);
    meta.appendChild(sub);

    const pill = document.createElement("span");
    pill.className = "pop-feed-pill";
    pill.dataset.verdict = item.verdict;
    pill.textContent = item.verdict;

    row.appendChild(ring);
    row.appendChild(meta);
    row.appendChild(pill);

    row.addEventListener("click", () => {
      if (item.href) {
        openTab(item.href);
        showToast(`Opening ${item.name}`);
      } else {
        showToast("Demo audit · live registry coming soon", "info");
      }
    });

    feed.appendChild(row);
  }
}

function renderSuggestions() {
  const wrap = el("pop-suggest");
  wrap.innerHTML = "";
  for (const item of SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "pop-suggest-chip";
    chip.textContent = item.label;
    chip.addEventListener("click", () => {
      el("pop-inspect-input").value = item.href;
      el("pop-inspect-input").focus();
    });
    wrap.appendChild(chip);
  }
}

function normalizeUrl(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (/^github\.com\//i.test(trimmed)) return `https://${trimmed}`;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return "";
}

function bindInspect() {
  const form = el("pop-inspect-form");
  const input = el("pop-inspect-input");

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const url = normalizeUrl(input.value);
    if (!url) {
      showToast("Paste a GitHub or marketplace URL first.", "error");
      input.focus();
      return;
    }
    openTab(url);
    showToast("Opening — SkillLens panel will load on the page.");
  });

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") input.value = "";
  });
}

function bindButtons() {
  el("pop-view-all").addEventListener("click", () => {
    showToast("Public registry opens this summer — Q3 2026.", "info", 2600);
  });

  el("pop-notify-btn").addEventListener("click", () => {
    showToast("Saved · we'll ping you when the registry opens.", "info", 2400);
  });

  el("pop-docs-btn").addEventListener("click", () => {
    openTab(PROJECT_URLS.docs);
  });

  document.querySelectorAll(".pop-foot-links button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      openTab(PROJECT_URLS[action] || PROJECT_URLS.docs);
    });
  });
}

async function detectEngine() {
  // Optimistic UI: assume the engine is ready, then quietly probe.
  const label = el("pop-status-label");
  const status = label.closest(".pop-status");
  const baseUrl = await getServerBaseUrl();
  const engineUrl = `${baseUrl}/health`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1500);

  fetch(engineUrl, { signal: controller.signal, cache: "no-store" })
    .then((r) => {
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      label.textContent = "Engine ready";
      status.dataset.tone = "";
    })
    .catch(() => {
      clearTimeout(t);
      // Offline engine is the common case during a demo — keep the language
      // optimistic and aligned with the "preview" branding.
      label.textContent = "Preview mode";
      status.dataset.tone = "warn";
    });
}

async function bindBackendSettings() {
  const toggle = el("pop-settings-toggle");
  const panel = el("pop-settings-panel");
  const input = el("pop-settings-input");
  const saveBtn = el("pop-settings-save");
  const resetBtn = el("pop-settings-reset");
  if (!toggle || !panel || !input || !saveBtn || !resetBtn) return;

  input.value = await getServerBaseUrl();
  input.placeholder = DEFAULT_SERVER_BASE_URL;

  toggle.addEventListener("click", () => {
    const open = panel.hasAttribute("hidden") ? false : true;
    if (open) {
      panel.setAttribute("hidden", "");
    } else {
      panel.removeAttribute("hidden");
      input.focus();
      input.select();
    }
  });

  saveBtn.addEventListener("click", async () => {
    const saved = await setServerBaseUrl(input.value);
    input.value = saved;
    showToast(`Backend set to ${saved}`, "info");
    detectEngine();
  });

  resetBtn.addEventListener("click", async () => {
    const saved = await setServerBaseUrl(DEFAULT_SERVER_BASE_URL);
    input.value = saved;
    showToast("Backend reset to default", "info");
    detectEngine();
  });
}

function animateStats() {
  const targets = [
    { id: "pop-stat-skills", to: 2847, fmt: (n) => n.toLocaleString("en-US") },
    { id: "pop-stat-audits", to: 142,  fmt: (n) => String(n) }
  ];
  for (const t of targets) {
    const node = el(t.id);
    if (!node) continue;
    const duration = 900;
    const start = performance.now();
    const startVal = 0;
    function tick(now) {
      const k = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      const value = Math.round(startVal + (t.to - startVal) * eased);
      node.textContent = t.fmt(value);
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
}

function bindShortcuts() {
  document.addEventListener("keydown", (ev) => {
    const key = ev.key?.toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && key === "k") {
      ev.preventDefault();
      el("pop-inspect-input").focus();
      el("pop-inspect-input").select();
    }
  });
}

function main() {
  renderFeatured();
  renderSuggestions();
  bindInspect();
  bindButtons();
  bindShortcuts();
  bindBackendSettings();
  detectEngine();
  animateStats();
}

main();
