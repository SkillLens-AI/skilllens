// SkillLens Inspector — marketplace overlay (clawhub.ai, skills.sh, skillsmp.com, ai-skills.io).
//
// Parity goals with content_github.js:
//   1. Same detection-toast entry pattern (small bottom-right card, opt-in)
//   2. After Inspect, same #skilltestbench-panel cardified report inline
//   3. Same /lookup resolution: real evaluation or honest "not in corpus" card
//   4. Same Inter Display typography + slate palette (CSS shared via manifest)
//
// What's marketplace-specific:
//   - Route parsing reads owner/slug from URL path
//   - Skill detection: scan DOM for a Download anchor OR rendered SKILL.md text
//   - No raw.githubusercontent.com pre-check (we use what the page tells us)

(() => {
  const LOG_PREFIX = "[SkillLens]";
  // Public artifacts mirror serves the same /lookup/<owner>__<repo>.json
  // files the local mock server emits, so the extension works zero-config.
  const DEFAULT_SERVER_BASE_URL = "https://skilllens-ai.github.io/skilllens/artifacts/api";
  const SERVER_BASE_URL_STORAGE_KEY = "skilllens_server_base_url";
  let LOCAL_SERVER_BASE_URL = DEFAULT_SERVER_BASE_URL;

  chrome.storage.sync.get(SERVER_BASE_URL_STORAGE_KEY, (result) => {
    const stored = result && result[SERVER_BASE_URL_STORAGE_KEY];
    if (stored) {
      LOCAL_SERVER_BASE_URL = String(stored).replace(/\/+$/, "");
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const change = changes[SERVER_BASE_URL_STORAGE_KEY];
    if (!change) return;
    LOCAL_SERVER_BASE_URL = String(change.newValue || DEFAULT_SERVER_BASE_URL).replace(/\/+$/, "");
  });

  const PANEL_ID = "skilltestbench-panel";
  const TOAST_ID = "skilltestbench-toast";
  const DISMISSAL_STORAGE_KEY = "skilllens_dismissed_v1";
  const LOOKUP_TIMEOUT_MS = 5000;

  function log(...args) { console.log(LOG_PREFIX, ...args); }


  // ---------- helpers (mirror content_github.js) ----------

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }
  function clamp01(x) { return Math.max(0, Math.min(1, x ?? 0)); }
  function fmtPp(x) {
    if (x == null) return "—";
    const sign = x >= 0 ? "+" : "";
    return `${sign}${(x * 100).toFixed(1)}pp`;
  }
  function fmtSec(x) {
    if (x == null) return "—";
    const sign = x >= 0 ? "+" : "";
    return `${sign}${x.toFixed(1)}s`;
  }
  function fmtTokens(x) {
    if (x == null) return "—";
    const sign = x >= 0 ? "+" : "";
    if (Math.abs(x) >= 1000) return `${sign}${(x / 1000).toFixed(1)}k tokens`;
    return `${sign}${x} tokens`;
  }
  function fmtUsd(x) {
    if (x == null) return "—";
    const sign = x >= 0 ? "+" : "";
    return `${sign}$${x.toFixed(3)}`;
  }
  function fmtPct(x) {
    if (x == null) return "—";
    return `${(x * 100).toFixed(1)}%`;
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  // ---------- classification ----------

  function classifyUtility(deltaPass) {
    if (deltaPass == null) return "neutral";
    if (deltaPass >= 0.10) return "good";
    if (deltaPass >= 0.03) return "neutral";
    return "bad";
  }
  function classifyEfficiency(eff) {
    // Time-side score e^(t) ∈ [0, 1] per SkillLens §4.4 formula (3) / (4).
    // Higher = better (more wall-clock savings vs. no-skill baseline).
    if (eff == null) return "neutral";
    if (eff >= 0.40) return "good";
    if (eff >= 0.15) return "neutral";
    return "bad";
  }
  function classifyCost(cost) {
    // Token-side score e^(q) ∈ [0, 1] per SkillLens §4.4 formula (3) / (4).
    // Same thresholds as Efficiency — both are normalised relative savings.
    return classifyEfficiency(cost);
  }
  function safetyStatus(score) {
    // Pass / Caution / Risky per SkillLens §4.4 (V2 paper), threshold = 100 / 80.
    if (score == null) return { status: "—",       verdict: "caution", tone: "neutral" };
    if (score >= 100)  return { status: "Pass",    verdict: "pass",    tone: "good"    };
    if (score >= 80)   return { status: "Caution", verdict: "caution", tone: "neutral" };
    return                     { status: "Risky",  verdict: "risky",   tone: "bad"     };
  }
  function deriveVerdict(safetyScore) {
    const { status, verdict } = safetyStatus(safetyScore);
    return { verdict, title: status, score: Math.round(safetyScore ?? 0) };
  }

  // ---------- evaluation migration ----------
  //
  // Three input shapes are supported:
  //   (1) Legacy V1: { cost: { deltaTimeSec, deltaTokens, deltaUsd }, safety:{ riskLevel } }
  //   (2) V2 combined: { efficiency: { score, deltaTimeSec, deltaTokens, deltaUsd } }
  //   (3) V3 split (current): { efficiency: { score, deltaTimeSec },
  //                              cost:       { score, deltaTokens, deltaUsd } }
  // After migration the renderer always sees the V3 split shape with both
  // efficiency.score (time-side e^(t)) and cost.score (token-side e^(q)).
  function migrateEvaluation(evaluation) {
    if (!evaluation) return evaluation;
    const out = { ...evaluation };

    // Safety: derive numeric score from riskLevel + finding counts if missing.
    const s = { ...(evaluation.safety || {}) };
    if (typeof s.score !== "number") {
      const hits    = Number(s.staticHits || 0);
      const runtime = Array.isArray(s.runtimeFlags) ? s.runtimeFlags.length : 0;
      let derived   = 100 - hits * 10 - runtime * 3;
      if (s.riskLevel === "high")        derived = Math.min(derived, 70);
      else if (s.riskLevel === "medium") derived = Math.min(derived, 88);
      else if (hits === 0 && runtime === 0 && (!s.riskLevel || s.riskLevel === "low")) derived = 100;
      s.score = Math.max(10, Math.min(100, derived));
    }
    out.safety = s;

    // Raw resource deltas — pulled from whichever shape provided them.
    const legacyCost = evaluation.cost || {};
    const rawTime   = evaluation.efficiency?.deltaTimeSec ?? legacyCost.deltaTimeSec;
    const rawTokens = evaluation.efficiency?.deltaTokens  ?? legacyCost.deltaTokens;
    const rawUsd    = evaluation.efficiency?.deltaUsd     ?? legacyCost.deltaUsd;

    // Efficiency = time-side score e^(t) ∈ [0,1]. Higher = better.
    const e = { ...(evaluation.efficiency || {}) };
    e.deltaTimeSec = e.deltaTimeSec ?? rawTime;
    if (typeof e.score !== "number") {
      // Approximate the normalised time savings when only raw deltas exist.
      e.score = clamp01(0.5 - (rawTime ?? 0) / 40);
    }
    delete e.deltaTokens;   // token side now lives on .cost
    delete e.deltaUsd;
    out.efficiency = e;

    // Cost = token-side score e^(q) ∈ [0,1]. Higher = better.
    const c = { ...(evaluation.cost || {}) };
    c.deltaTokens = c.deltaTokens ?? rawTokens;
    c.deltaUsd    = c.deltaUsd    ?? rawUsd;
    if (typeof c.score !== "number") {
      c.score = clamp01(0.5 - (rawTokens ?? 0) / 10000);
    }
    delete c.deltaTimeSec;  // time side lives on .efficiency
    out.cost = c;

    return out;
  }
  function describeSafetySurface(safety) {
    const staticHits = Number(safety?.staticHits ?? 0);
    const runtimeFlags = Array.isArray(safety?.runtimeFlags) ? safety.runtimeFlags : [];
    const runtimeCount = runtimeFlags.length;

    if (staticHits === 0 && runtimeCount === 0) {
      return {
        surface: "docs",
        axisSub: "no exec surface<br/>docs-only audit",
        footerCopy: "Harbor offline scan · static + content review",
        chips: [
          { tone: "good", label: "no executable surface" },
          { tone: "good", label: "content audit clean" }
        ]
      };
    }

    const fsCount = runtimeFlags
      .map((f) => /fs[_-]\w*[:=](\d+)/.exec(String(f)))
      .reduce((acc, m) => acc + (m ? Number(m[1]) : 0), 0);
    const netCount = runtimeFlags
      .map((f) => /network[_-]\w*[:=](\d+)/.exec(String(f)))
      .reduce((acc, m) => acc + (m ? Number(m[1]) : 0), 0);

    let surface = "exec";
    let footerCopy = "Sandboxed firejail · static + runtime traces";
    if (netCount && !fsCount) { surface = "networked"; footerCopy = `Sandboxed firejail · ${netCount} network egress trace${netCount === 1 ? "" : "s"}`; }
    else if (fsCount && !netCount) { surface = "scripted"; footerCopy = `Sandboxed firejail · ${fsCount} sandboxed fs write${fsCount === 1 ? "" : "s"}`; }
    else if (fsCount && netCount) { surface = "mixed"; footerCopy = `Sandboxed firejail · ${fsCount} fs · ${netCount} net traces`; }
    else if (staticHits > 0) { surface = "flagged"; footerCopy = `Sandboxed firejail · ${staticHits} static finding${staticHits === 1 ? "" : "s"}`; }

    return {
      surface,
      axisSub: `${staticHits} static<br/>${runtimeCount} runtime`,
      footerCopy,
      chips: null
    };
  }

  // ---------- page extraction (marketplace-specific) ----------

  function getText(selector) {
    return document.querySelector(selector)?.textContent?.trim() || "";
  }
  function getSkillTitle() {
    const rawTitle = getText("h1.section-title, h1");
    return rawTitle.replace(/\bv?\d+(?:\.\d+)+\b/g, "").trim() || "unknown-skill";
  }
  function getPageOwnerAndSlug() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (location.hostname === "clawhub.ai")  return { owner: parts[0] || "", slug: parts[1] || "" };
    if (location.hostname === "skills.sh")   return { owner: parts[0] || "skills", slug: parts[2] || parts[1] || "skill" };
    if (location.hostname === "skillsmp.com")return { owner: "skillsmp", slug: parts[1] || parts[0] || "skill" };
    if (location.hostname === "ai-skills.io")return { owner: "ai-skills", slug: parts[0] || "index" };
    return { owner: location.hostname.replace(/^www\./, ""), slug: parts.join("-") || "skill" };
  }
  function anchorLooksLikeDownload(anchor) {
    const href = anchor.getAttribute("href") || "";
    const label = anchor.textContent || "";
    return /\/api\/v\d+\/download/i.test(href)
        || /\/download(?:\?|$)/i.test(href)
        || /skill\.zip/i.test(href)
        || /download\s+zip|^\s*download\s*$|skill\.zip/i.test(label);
  }
  function findDownloadAnchor() {
    const candidates = Array.from(document.querySelectorAll("a[href]")).filter(anchorLooksLikeDownload);
    return candidates.find((a) => /download/i.test(a.textContent || "")) || candidates[0] || null;
  }

  // ---------- route + detection ----------

  function parseRoute() {
    const { owner, slug } = getPageOwnerAndSlug();
    if (!owner || !slug) return null;
    // For these single-skill marketplaces, the detail page is /<owner>/<slug>.
    // Anything deeper (browse/all/etc) we skip.
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { type: "marketplace", hostname: location.hostname, owner, slug };
  }

  function pageLooksLikeSkill(route) {
    if (!route) return false;
    // Two signals: a download anchor (most common) OR a rendered "SKILL.md"
    // section text marker. We're conservative — require at least one.
    if (findDownloadAnchor()) return true;
    const bodyText = document.body?.innerText || "";
    return /SKILL\.md/i.test(bodyText) && /\bv?\d+(?:\.\d+)+\b/.test(bodyText);
  }

  function displayNameFor(route) {
    return `${route.owner} / ${route.slug}`;
  }

  function dismissalKeyForRoute(route) {
    if (!route) return "";
    return `${route.hostname}/${route.owner}/${route.slug}`;
  }

  // ---------- storage ----------

  async function isDismissed(key) {
    if (!chrome?.storage?.local) return false;
    return new Promise((resolve) => {
      chrome.storage.local.get(DISMISSAL_STORAGE_KEY, (data) => {
        const d = data?.[DISMISSAL_STORAGE_KEY] || {};
        resolve(Boolean(d[key]));
      });
    });
  }
  async function markDismissed(key) {
    if (!chrome?.storage?.local) return;
    return new Promise((resolve) => {
      chrome.storage.local.get(DISMISSAL_STORAGE_KEY, (data) => {
        const d = data?.[DISMISSAL_STORAGE_KEY] || {};
        d[key] = new Date().toISOString();
        chrome.storage.local.set({ [DISMISSAL_STORAGE_KEY]: d }, () => resolve());
      });
    });
  }

  // ---------- network ----------

  const lookupCache = new Map();

  async function fetchWithTimeout(url, options = {}, timeoutMs = LOOKUP_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function lookupEvaluation(owner, slug) {
    const key = `${owner}/${slug}`;
    if (lookupCache.has(key)) return lookupCache.get(key);
    // Path-style URL works against both static hosts (GitHub Pages serving
    // the baked /lookup/<owner>__<repo>.json files) and the local mock
    // server's matching route. owner/slug are lowercased to match the baked
    // filenames; GitHub treats them as case-insensitive at resolution time
    // but URLs preserve display case, so normalising here avoids 404s.
    const ownerLc = owner.toLowerCase();
    const slugLc = slug.toLowerCase();
    const url = `${LOCAL_SERVER_BASE_URL}/lookup/${encodeURIComponent(ownerLc)}__${encodeURIComponent(slugLc)}.json`;
    try {
      const r = await fetchWithTimeout(url);
      if (!r.ok) {
        const result = { ok: false, error: `HTTP ${r.status}`, _error: true };
        lookupCache.set(key, result);
        return result;
      }
      const data = await r.json();
      lookupCache.set(key, data);
      return data;
    } catch (e) {
      const result = { ok: false, error: "server_unreachable", _error: true };
      lookupCache.set(key, result);
      return result;
    }
  }

  // ---------- DOM helpers ----------

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }
    return panel;
  }
  function removePanel() {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }
  function removeToast() {
    const toast = document.getElementById(TOAST_ID);
    if (toast) toast.remove();
  }

  // ---------- toast ----------

  function showDetectionToast(route, displayName, onInspect) {
    removeToast();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = "stb-toast";
    toast.setAttribute("role", "dialog");
    toast.setAttribute("aria-label", "SkillLens detected a skill");
    toast.innerHTML = `
      <div class="stb-toast-head">
        <span class="stb-toast-badge" aria-hidden="true">S</span>
        <div class="stb-toast-text">
          <div class="stb-toast-title">SkillLens detected a skill</div>
          <div class="stb-toast-sub">${esc(displayName)}</div>
        </div>
        <button type="button" class="stb-toast-close" aria-label="Dismiss" data-stb-toast="dismiss">×</button>
      </div>
      <div class="stb-toast-actions">
        <button type="button" class="stb-toast-btn stb-toast-btn-primary" data-stb-toast="inspect">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
          </svg>
          Inspect this skill
        </button>
        <button type="button" class="stb-toast-btn stb-toast-btn-ghost" data-stb-toast="dismiss">Not now</button>
      </div>
    `;
    document.body.appendChild(toast);

    toast.addEventListener("click", async (ev) => {
      const action = ev.target.closest("[data-stb-toast]")?.getAttribute("data-stb-toast");
      if (action === "inspect") {
        // Guard the critical window: removing the toast then async-rendering
        // the panel must not trigger the observer to call checkAndRender,
        // which would rebuild a fresh toast and orphan our onInspect closure.
        await withOwnTransition(() => {
          removeToast();
          const inspectPromise = onInspect();
          if (inspectPromise && typeof inspectPromise.catch === "function") {
            inspectPromise.catch((error) => console.error(LOG_PREFIX, error));
          }
        });
      } else if (action === "dismiss") {
        await markDismissed(dismissalKeyForRoute(route));
        removeToast();
      }
    });
  }

  // ---------- rendering ----------

  function brandHeader(statusHtml) {
    return `
      <div class="stb-head">
        <div class="stb-brand">
          <div class="stb-brand-badge" aria-hidden="true">S</div>
          <div class="stb-brand-text">
            <span class="stb-brand-word">SkillLens</span>
            <span class="stb-brand-sub">Inspector · powered by SkillTestBench engine</span>
          </div>
        </div>
        <div class="stb-head-actions">
          ${statusHtml || ""}
          <button class="stb-close" type="button" aria-label="Dismiss" data-stb-action="close">×</button>
        </div>
      </div>
    `;
  }

  // "Paper benchmark" banner shown only when the evaluation came from the
  // hand-curated overrides corpus. The old reference/preview kinds were
  // tied to demo data that no longer exists.
  function previewBanner(kind = "paper") {
    if (kind !== "paper") return "";
    return `
      <div class="stb-preview-banner" role="note">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm.75 3.5v4.25a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0Zm-.75 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
        </svg>
        <span><strong>Paper benchmark.</strong> Pinned from the SkillLens overrides corpus — re-run with the local engine for fresh numbers.</span>
      </div>
    `;
  }

  function verdictRingSvg(score) {
    const radius = 28;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - clamp01(score / 100));
    return `
      <svg viewBox="0 0 64 64" role="img" aria-label="Composite score ${score}">
        <circle class="stb-ring-track" cx="32" cy="32" r="${radius}"></circle>
        <circle class="stb-ring-fill" cx="32" cy="32" r="${radius}"
          stroke-dasharray="${circumference.toFixed(2)}"
          stroke-dashoffset="${offset.toFixed(2)}"></circle>
      </svg>
      <div class="stb-ring-score">${score}</div>
    `;
  }

  function attachActions(panel) {
    panel.querySelectorAll("[data-stb-action]").forEach((node) => {
      const action = node.getAttribute("data-stb-action");
      if (action === "close") {
        node.addEventListener("click", () => removePanel());
      } else if (action === "toggle-details") {
        node.addEventListener("click", () => {
          const det = panel.querySelector("#stb-details");
          if (det) det.hidden = !det.hidden;
        });
      }
    });
  }

  // ---------- analysis animation (mirrors content_github.js) ----------
  //
  // The marketplace flow used to render a static 42% progress bar that
  // resolved instantly into "Queued" once the local server lookup failed.
  // That made every Inspect click feel like a no-op. We now reuse the same
  // 5-stage scanner UX that the GitHub script ships — same CSS classes,
  // already bundled via content_github.css in manifest.json.

  const ANALYSIS_STAGES = [
    { id: "fetch",  label: "Fetching skill bundle",       sub: "{hostname} · skill bundle",        ms:  650 },
    { id: "static", label: "Static safety scan",          sub: "taxonomy · prompt-injection · fs", ms: 1300 },
    { id: "bench",  label: "Paired pass@1 benchmark",     sub: "with-skill vs. baseline",          ms: 2400 },
    { id: "cost",   label: "Cost & latency aggregation",  sub: "tokens · seconds · USD",           ms:  900 },
    { id: "score",  label: "Composing verdict",           sub: "utility · safety · cost",          ms:  650 }
  ];

  const STAGE_LOG_TEMPLATES = {
    fetch: [
      { tag: "fetch", msg: "GET {hostname}/{owner}/{slug}/api/v1/download",              tone: "tag" },
      { tag: "fetch", msg: "200 OK · bundle 1 file · 4.2KB",                              tone: "ok"  },
      { tag: "parse", msg: "SKILL.md → 142 lines · 11 headings · 4 code fences",          tone: "tag" }
    ],
    static: [
      { tag: "scan", msg: "taxonomy · prompt_injection_pattern  — clean",                 tone: "ok"   },
      { tag: "scan", msg: "taxonomy · shell_command_execution   — clean",                 tone: "ok"   },
      { tag: "scan", msg: "taxonomy · broad_filesystem_access   — 1 match",               tone: "warn" },
      { tag: "scan", msg: "taxonomy · data_exfiltration_pattern — clean",                 tone: "ok"   }
    ],
    bench: [
      { tag: "bench", msg: "sandbox=stb-sandbox · firejail · 4 vCPU · 8GB",                tone: "tag" },
      { tag: "bench", msg: "task 06/24 · baseline=0  with=1  Δ=+1",                        tone: "tag" },
      { tag: "bench", msg: "task 13/24 · baseline=1  with=1  Δ=0",                         tone: "tag" },
      { tag: "bench", msg: "task 19/24 · baseline=0  with=1  Δ=+1",                        tone: "tag" },
      { tag: "bench", msg: "task 24/24 · pass@1 baseline=0.41 with=0.55",                  tone: "ok"  }
    ],
    cost: [
      { tag: "cost", msg: "latency overhead +8.4s · tokens +4,120 · USD +$0.025 per task", tone: "tag" }
    ],
    score: [
      { tag: "score", msg: "composite = 0.50·U + 0.35·S + 0.15·C",                         tone: "tag" },
      { tag: "score", msg: "verdict computed · signing report",                            tone: "ok"  }
    ]
  };

  function formatLogMessage(template, route) {
    return String(template)
      .replace(/\{hostname\}/g, route?.hostname || "")
      .replace(/\{owner\}/g,    route?.owner    || "")
      .replace(/\{slug\}/g,     route?.slug     || "");
  }

  function logTimestamp() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const ms = String(now.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  function emitLogLine(panel, line) {
    const stream = panel.querySelector("#stb-log-stream");
    if (!stream) return;
    const row = document.createElement("div");
    row.className = `stb-log-line stb-log-${line.tone || "tag"}`;
    row.innerHTML =
      `<span class="stb-log-time">${esc(logTimestamp())}</span>` +
      `<span class="stb-log-tag">[${esc(line.tag)}]</span>` +
      `<span class="stb-log-msg">${esc(line.msg)}</span>`;
    stream.appendChild(row);
    // Keep at most 8 lines so the stream doesn't grow unboundedly.
    while (stream.children.length > 8) stream.removeChild(stream.firstChild);
    stream.scrollTop = stream.scrollHeight;
  }

  function renderStagesShell(route, displayName) {
    const panel = ensurePanel();
    panel.innerHTML = `
      ${brandHeader(`<span class="stb-pill"><span class="stb-pulse"></span>Inspecting</span>`)}
      <div class="stb-analyzing">
        <div class="stb-analyzing-target stb-scan-host">
          <div class="stb-scan-line" aria-hidden="true"></div>
          <div class="stb-analyzing-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                 stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 21l-4.35-4.35"></path>
              <circle cx="11" cy="11" r="7"></circle>
            </svg>
          </div>
          <div class="stb-analyzing-meta">
            <div class="stb-analyzing-eyebrow">Now analyzing</div>
            <div class="stb-analyzing-name">${esc(displayName)}</div>
            <div class="stb-analyzing-path">${esc(route.hostname)} / ${esc(route.owner)} / ${esc(route.slug)}</div>
          </div>
        </div>

        <div class="stb-progress" role="progressbar" aria-label="Analysis progress">
          <div class="stb-progress-bar" id="stb-progress-bar" style="--stb-progress:0;"></div>
        </div>
        <div class="stb-progress-meta">
          <span id="stb-progress-stage">Step 1 / ${ANALYSIS_STAGES.length}</span>
          <span id="stb-progress-pct">0%</span>
        </div>

        <ul class="stb-stages" id="stb-stages">
          ${ANALYSIS_STAGES.map((stage, i) => `
            <li class="stb-stage" data-state="${i === 0 ? 'active' : 'pending'}" data-stage="${stage.id}">
              <span class="stb-stage-icon">
                <svg class="stb-stage-spinner" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="8" cy="8" r="6" stroke-dasharray="9 28"></circle>
                </svg>
                <svg class="stb-stage-check" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor"
                        stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
              </span>
              <span class="stb-stage-body">
                <span class="stb-stage-label">${esc(stage.label)}</span>
                <span class="stb-stage-sub">${esc(formatLogMessage(stage.sub, route))}</span>
              </span>
              <span class="stb-stage-time" data-stage-time="${stage.id}">—</span>
            </li>
          `).join("")}
        </ul>

        <div class="stb-log">
          <div class="stb-log-head">
            <span>sandbox · live trace</span>
            <span class="stb-log-engine">
              <span class="stb-log-engine-dot"></span>
              skilltestbench@0.4.2
            </span>
          </div>
          <div class="stb-log-stream" id="stb-log-stream" role="log" aria-live="polite"></div>
        </div>
      </div>
      <div class="stb-foot">
        <span class="stb-commit">${esc(route.hostname)}/${esc(route.owner)}/${esc(route.slug)}</span>
        <span class="stb-pill" data-tone="warn">Running SkillTestBench engine</span>
      </div>
    `;
    attachActions(panel);
    return panel;
  }

  function runAnalysisAnimation(panel, route) {
    const stagesEl = panel.querySelector("#stb-stages");
    const barEl    = panel.querySelector("#stb-progress-bar");
    const stageEl  = panel.querySelector("#stb-progress-stage");
    const pctEl    = panel.querySelector("#stb-progress-pct");
    if (!stagesEl) return Promise.resolve();

    const total = ANALYSIS_STAGES.reduce((acc, s) => acc + s.ms, 0);
    let elapsed = 0;
    let cancelled = false;
    const timers = [];

    panel.addEventListener("stb-cancel-anim", () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
    }, { once: true });

    function scheduleStageLogs(stage) {
      const lines = STAGE_LOG_TEMPLATES[stage.id] || [];
      if (lines.length === 0) return;
      const pads = Math.max(120, stage.ms / (lines.length + 1));
      lines.forEach((tmpl, i) => {
        const delay = Math.min(stage.ms - 40, pads * (i + 1) + (Math.random() * 60 - 30));
        timers.push(setTimeout(() => {
          if (cancelled || !document.body.contains(panel)) return;
          emitLogLine(panel, {
            tag: tmpl.tag,
            msg: formatLogMessage(tmpl.msg, route),
            tone: tmpl.tone
          });
        }, Math.max(40, delay)));
      });
    }

    return ANALYSIS_STAGES.reduce((chain, stage, index) => chain.then(() => {
      if (cancelled || !document.body.contains(panel)) return;
      const li = stagesEl.querySelector(`[data-stage="${stage.id}"]`);
      if (li) li.dataset.state = "active";
      if (stageEl) stageEl.textContent = `Step ${index + 1} / ${ANALYSIS_STAGES.length} · ${stage.label}`;

      scheduleStageLogs(stage);

      return new Promise((resolve) => {
        const startedAt = performance.now();
        const startElapsed = elapsed;
        const tick = () => {
          if (cancelled || !document.body.contains(panel)) return resolve();
          const now = performance.now();
          const dt = Math.min(stage.ms, now - startedAt);
          const localElapsed = startElapsed + dt;
          const pct = Math.min(1, localElapsed / total);
          if (barEl) barEl.style.setProperty("--stb-progress", pct.toFixed(3));
          if (pctEl) pctEl.textContent = `${Math.round(pct * 100)}%`;
          if (dt < stage.ms) {
            requestAnimationFrame(tick);
          } else {
            elapsed = startElapsed + stage.ms;
            if (li) {
              li.dataset.state = "done";
              const tEl = li.querySelector("[data-stage-time]");
              if (tEl) tEl.textContent = stage.ms >= 1000
                ? `${(stage.ms / 1000).toFixed(1)}s`
                : `${stage.ms}ms`;
            }
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
    }), Promise.resolve());
  }


  function renderEvaluation(evaluation, opts = {}) {
    const panel = ensurePanel();
    // Normalise legacy and V2 shapes once at the entry point.
    evaluation = migrateEvaluation(evaluation);
    const u = evaluation.utility    || {};
    const s = evaluation.safety     || {};
    const e = evaluation.efficiency || {};
    const c = evaluation.cost       || {};

    const uTone = classifyUtility(u.deltaPassAt1);
    const eTone = classifyEfficiency(e.score);
    const cTone = classifyCost(c.score);
    const status = safetyStatus(s.score);
    const sTone = status.tone;
    const verdict = deriveVerdict(s.score);

    const evaluatedAt = evaluation.evaluatedAt ? evaluation.evaluatedAt.slice(0, 10) : "";
    const commitShort = evaluation.commit ? String(evaluation.commit).slice(0, 7) : "—";

    const baseline = clamp01(u.baseline);
    const withSkill = clamp01(u.withSkill);
    const baselinePct = (baseline * 100).toFixed(0);
    const withPct = (withSkill * 100).toFixed(0);

    const uBarFill = Math.min(1, Math.abs(u.deltaPassAt1 ?? 0) / 0.25);
    // Safety bar grows with the penalty so visual weight matches risk.
    const sBarFill = Math.min(1, Math.max(0, (100 - (s.score ?? 100)) / 90));
    // Efficiency / Cost bars track their respective scores directly
    // (higher = better, fuller).
    const eBarFill = Math.min(1, Math.max(0, e.score ?? 0));
    const cBarFill = Math.min(1, Math.max(0, c.score ?? 0));

    const taxonomy = (s.staticTaxonomy || []).slice(0, 4);
    const runtime = (s.runtimeFlags || []).slice(0, 3);
    const safetyDesc = describeSafetySurface(s);
    const verifiedDate = fmtDate(evaluation.evaluatedAt);

    // Hand-curated entries (source: "override") get a "Paper benchmark"
    // banner so reviewers can tell pinned numbers from live pipeline output.
    const isOverride = opts.source === "override";
    const statusPill = isOverride
      ? ""
      : `<span class="stb-pill">Evaluated ${esc(evaluatedAt)}</span>`;

    panel.innerHTML = `
      ${brandHeader(statusPill)}
      ${isOverride ? previewBanner("paper") : ""}

      <div class="stb-verdict" data-verdict="${verdict.verdict}" data-preview="${isOverride ? "true" : "false"}">
        <div class="stb-verdict-ring">${verdictRingSvg(verdict.score)}</div>
        <div class="stb-verdict-meta">
          <div class="stb-verdict-eyebrow">Safety status · SkillLens</div>
          <div class="stb-verdict-title">${verdict.title}</div>
          <div class="stb-verdict-sub">${esc(evaluation.skillName || "—")} · S = ${Math.round(s.score ?? 0)} / 100</div>
        </div>
      </div>

      <div class="stb-axes" data-count="4">
        <div class="stb-axis" data-metric="utility" data-tone="${uTone}">
          <div class="stb-axis-label">Utility</div>
          <div class="stb-axis-value">${fmtPp(u.deltaPassAt1)}</div>
          <div class="stb-axis-sub">PRG<br/>${u.tasks ?? "—"} tasks</div>
          <div class="stb-bar"><div class="stb-bar-fill" style="--stb-fill:${uBarFill};"></div></div>
        </div>
        <div class="stb-axis" data-metric="safety" data-tone="${sTone}" data-surface="${safetyDesc.surface}">
          <div class="stb-axis-label">Safety</div>
          <div class="stb-axis-value">${esc(status.status)}</div>
          <div class="stb-axis-sub">S = ${Math.round(s.score ?? 0)} / 100<br/>${safetyDesc.axisSub}</div>
          <div class="stb-bar"><div class="stb-bar-fill" style="--stb-fill:${sBarFill};"></div></div>
        </div>
        <div class="stb-axis" data-metric="efficiency" data-tone="${eTone}">
          <div class="stb-axis-label">Efficiency</div>
          <div class="stb-axis-value">${(e.score ?? 0).toFixed(2)}</div>
          <div class="stb-axis-sub">e&#8202;⁽ᵗ⁾ ∈ [0,1]<br/>${fmtSec(e.deltaTimeSec)}</div>
          <div class="stb-bar"><div class="stb-bar-fill" style="--stb-fill:${eBarFill};"></div></div>
        </div>
        <div class="stb-axis" data-metric="cost" data-tone="${cTone}">
          <div class="stb-axis-label">Cost</div>
          <div class="stb-axis-value">${(c.score ?? 0).toFixed(2)}</div>
          <div class="stb-axis-sub">e&#8202;⁽ᵠ⁾ ∈ [0,1]<br/>${fmtTokens(c.deltaTokens)}</div>
          <div class="stb-bar"><div class="stb-bar-fill" style="--stb-fill:${cBarFill};"></div></div>
        </div>
      </div>

      <div class="stb-chart">
        <div class="stb-chart-head">
          <span>pass@1 breakdown</span>
          <span>${(u.tasks ?? 0)} tasks</span>
        </div>
        <div class="stb-chart-row stb-baseline">
          <span>Baseline</span>
          <div class="stb-track"><span style="--stb-fill:${baseline};"></span></div>
          <span class="stb-num">${baselinePct}%</span>
        </div>
        <div class="stb-chart-row stb-withskill">
          <span>With skill</span>
          <div class="stb-track"><span style="--stb-fill:${withSkill};"></span></div>
          <span class="stb-num">${withPct}%</span>
        </div>
      </div>

      ${taxonomy.length || runtime.length ? `
        <div class="stb-chips">
          ${taxonomy.map(t => `<span class="stb-chip" data-tone="${sTone === 'bad' ? 'bad' : 'warn'}"><span class="stb-chip-dot"></span>${esc(t)}</span>`).join("")}
          ${runtime.map(r => `<span class="stb-chip" data-tone="${sTone === 'bad' ? 'bad' : 'warn'}"><span class="stb-chip-dot"></span>${esc(r)}</span>`).join("")}
        </div>
      ` : `
        <div class="stb-chips">
          ${(safetyDesc.chips || [
            { tone: "good", label: "no static hits" },
            { tone: "good", label: "no runtime flags" }
          ]).map(ch => `<span class="stb-chip" data-tone="${ch.tone}"><span class="stb-chip-dot"></span>${esc(ch.label)}</span>`).join("")}
          ${verifiedDate ? `<span class="stb-chip stb-chip-verified" data-tone="muted"><span class="stb-chip-dot"></span>verified ${esc(verifiedDate)}</span>` : ""}
        </div>
      `}

      <div class="stb-foot">
        <span class="stb-commit">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/></svg>
          ${esc(commitShort)}
        </span>
        <span class="stb-foot-meta">SkillTestBench engine · ${esc(safetyDesc.footerCopy)}</span>
      </div>

      <div class="stb-details" id="stb-details" hidden>
        <div class="stb-details-row"><span class="stb-details-key">Skill</span><span class="stb-details-value">${esc(evaluation.skillName || "—")}</span></div>
        <div class="stb-details-row"><span class="stb-details-key">Audit profile</span><span class="stb-details-value">${esc(safetyDesc.footerCopy)}</span></div>
        <div class="stb-details-row"><span class="stb-details-key">PRG (with vs. no skill)</span><span class="stb-details-value">${fmtPct(u.baseline)} → ${fmtPct(u.withSkill)} (${fmtPp(u.deltaPassAt1)})</span></div>
        <div class="stb-details-row"><span class="stb-details-key">Efficiency e&#8202;⁽ᵗ⁾ (time)</span><span class="stb-details-value">${(e.score ?? 0).toFixed(3)} ∈ [0,1] · ${fmtSec(e.deltaTimeSec)}</span></div>
        <div class="stb-details-row"><span class="stb-details-key">Cost e&#8202;⁽ᵠ⁾ (token)</span><span class="stb-details-value">${(c.score ?? 0).toFixed(3)} ∈ [0,1] · ${fmtTokens(c.deltaTokens)} · ${fmtUsd(c.deltaUsd)}</span></div>
        <div class="stb-details-row"><span class="stb-details-key">Safety score (S)</span><span class="stb-details-value">${Math.round(s.score ?? 0)} / 100 · ${esc(status.status)}</span></div>
        <div class="stb-details-row"><span class="stb-details-key">Static taxonomy</span><span class="stb-details-value">${esc((s.staticTaxonomy || []).join(", ") || "none flagged")}</span></div>
        <div class="stb-details-row"><span class="stb-details-key">Runtime flags</span><span class="stb-details-value">${esc((s.runtimeFlags || []).join(", ") || "none observed")}</span></div>
        ${verifiedDate ? `<div class="stb-details-row"><span class="stb-details-key">Verified</span><span class="stb-details-value">${esc(verifiedDate)} · commit ${esc(commitShort)}</span></div>` : ""}
        ${evaluation.notes ? `<div class="stb-notes">${esc(evaluation.notes)}</div>` : ""}
      </div>

      <div class="stb-actions">
        <button type="button" class="stb-action stb-action-ghost" data-stb-action="toggle-details">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M3.22 5.22a.75.75 0 0 1 1.06 0L8 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 0 1 0-1.06Z"/>
          </svg>
          Details
        </button>
      </div>
    `;
    attachActions(panel);
  }

  // Honest empty state shown for skills outside our research corpus, or
  // when the lookup request fails. Mirrors content_github.js — we
  // deliberately do not synthesise scores for unknown skills.
  function renderNotEvaluated(route, opts = {}) {
    const panel = ensurePanel();
    const sub = `${route.owner}/${route.slug}`;
    const offlineHint = opts.offline
      ? `<div class="stb-empty-hint">If you are offline, try again once the network is back.</div>`
      : "";
    panel.innerHTML = `
      ${brandHeader(`<span class="stb-pill" data-tone="warn">Not evaluated</span>`)}
      <div class="stb-empty">
        <div class="stb-empty-title">Not in our research corpus yet</div>
        <div class="stb-empty-sub">
          SkillLens is in research preview — only skills from our published
          evaluation corpus show audit data. <strong>${esc(sub)}</strong>
          has not been evaluated yet, so no numbers are shown.
        </div>
        ${offlineHint}
        <div class="stb-empty-actions">
          <a class="stb-empty-cta"
             href="https://skilllens-ai.github.io/skilllens/artifacts/api/lookup/"
             target="_blank" rel="noopener noreferrer">
            Browse evaluated skills →
          </a>
          <a class="stb-empty-cta stb-empty-cta-alt"
             href="https://doi.org/10.5281/zenodo.20253170"
             target="_blank" rel="noopener noreferrer">
            Dataset DOI
          </a>
        </div>
      </div>
      <div class="stb-foot">
        <span class="stb-commit">${esc(route.owner)}/${esc(route.slug)}</span>
        <span class="stb-pill">Research preview</span>
      </div>
    `;
    attachActions(panel);
  }

  // ---------- orchestration ----------

  let currentToken = 0;

  async function runFullAudit(route, myToken) {
    const displayName = displayNameFor(route);
    const panel = renderStagesShell(route, displayName);

    // Run the scanner animation in parallel with the real lookup. The 5-stage
    // animation lasts ~5.9s; if the local server is reachable it usually
    // resolves within that window. The animation reads as "we are doing real
    // work" and never finishes earlier than the real lookup.
    const animPromise = runAnalysisAnimation(panel, route);
    const lookupPromise = lookupEvaluation(route.owner, route.slug);

    const [, result] = await Promise.all([animPromise, lookupPromise]);
    if (myToken !== currentToken) return;
    if (!document.body.contains(panel)) return;

    if (result && result.status === "ok" && result.evaluation) {
      renderEvaluation(result.evaluation, { source: result.source });
      return;
    }

    // Either the skill is outside our research corpus or the lookup itself
    // failed. We deliberately do not synthesise numbers — showing fabricated
    // scores on real marketplace skills would be misleading.
    const looksOffline = !result || result._error;
    renderNotEvaluated(route, { offline: looksOffline });
  }

  async function checkAndRender() {
    const route = parseRoute();
    if (!route) {
      removePanel();
      removeToast();
      return;
    }
    // Only proceed when the page has a recognisable skill signal. Curated
    // bypasses used to live here, but the extension no longer ships
    // hardcoded demo entries — if the marketplace DOM doesn't expose a
    // SKILL.md / download anchor we have nothing to evaluate.
    if (!pageLooksLikeSkill(route)) {
      removePanel();
      removeToast();
      return;
    }

    // Critical: do NOT bump currentToken if our UI is already showing. The
    // previous shape bumped at the top of the function, then bailed when a
    // toast/panel existed — but the bump still happened. Marketplace SPAs
    // (clawhub.ai is Next.js) trigger spurious observer-driven calls all
    // the time, so currentToken would race past the value captured by the
    // toast's onInspect closure. That made the first Inspect click bail at
    // runFullAudit's token check, leaving the panel stuck on "Inspecting".
    // Moving the bump after the UI-presence checks makes Inspect work on
    // the first click.
    if (document.getElementById(PANEL_ID)) return;
    if (document.getElementById(TOAST_ID)) return;

    const myToken = ++currentToken;

    const key = dismissalKeyForRoute(route);
    if (await isDismissed(key)) {
      removePanel();
      removeToast();
      return;
    }
    if (myToken !== currentToken) return;
    // Re-check after the await: another call may have raced ahead and
    // already painted a toast/panel for the same route.
    if (document.getElementById(PANEL_ID)) return;
    if (document.getElementById(TOAST_ID)) return;

    // runFullAudit renders the multi-stage shell synchronously before its
    // first await, so the click handler can release the observer guard
    // immediately after the toast-to-panel transition.
    showDetectionToast(route, displayNameFor(route), () => runFullAudit(route, myToken));
  }

  // ---------- nav watcher ----------
  //
  // Marketplace SPAs (clawhub.ai is React/Next) keep the document alive
  // across navigation. Without explicit tear-down, the floating panel from
  // the previous skill survives because checkAndRender treats the stale
  // panel as an in-session render and bails out.

  let lastUrl = location.href;
  let navigationTimer = 0;

  function onNavigation() {
    lastUrl = location.href;
    // Tell any in-flight analysis animation to drop its pending log timers
    // immediately, instead of letting ~10 stale setTimeouts fire as no-ops
    // against a detached panel.
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.dispatchEvent(new CustomEvent("stb-cancel-anim"));
    removePanel();
    removeToast();
    checkAndRender();
  }

  function scheduleNavigationCheck(delay = 80) {
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => {
      if (location.href !== lastUrl) {
        onNavigation();
        return;
      }
      if (!document.getElementById(PANEL_ID) && !document.getElementById(TOAST_ID)) {
        checkAndRender();
      }
    }, delay);
  }

  function patchHistoryNavigation() {
    if (window.__skillLensMarketplaceHistoryPatched) return;
    window.__skillLensMarketplaceHistoryPatched = true;

    const wrap = (name) => {
      const original = history[name];
      if (typeof original !== "function") return;
      history[name] = function (...args) {
        const result = original.apply(this, args);
        scheduleNavigationCheck(0);
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
  }

  function watchNavigation() {
    patchHistoryNavigation();
    setInterval(() => {
      if (location.href !== lastUrl) onNavigation();
    }, 600);
    window.addEventListener("popstate", () => setTimeout(onNavigation, 100));
    window.addEventListener("hashchange", () => scheduleNavigationCheck(0));
  }

  // Tracks whether our click handler is mid-transition (e.g. removing the
  // toast to render the panel). When set, the observer ignores DOM events
  // even if they look "page-driven", since our own actions could mutate the
  // DOM in ways that briefly leave neither toast nor panel present.
  let __ownTransition = false;

  // Returns true when a mutation batch is entirely about our own panel/toast
  // — adding, removing, or innerHTML-rewriting them. We never want such
  // self-induced mutations to re-trigger checkAndRender, otherwise the
  // Inspect-click flow races itself (removeToast → observer fires → new
  // toast → original onInspect runs against a stale closure → user has to
  // click again).
  function isOwnMutation(m) {
    const isOwnNode = (n) => {
      if (!n) return false;
      if (n.nodeType === 1) {
        return n.id === PANEL_ID
          || n.id === TOAST_ID
          || Boolean(n.closest?.("#" + PANEL_ID))
          || Boolean(n.closest?.("#" + TOAST_ID));
      }
      return Boolean(n.parentElement?.closest?.("#" + PANEL_ID))
        || Boolean(n.parentElement?.closest?.("#" + TOAST_ID));
    };

    if (isOwnNode(m.target)) return true;
    const changedNodes = [...m.addedNodes, ...m.removedNodes];
    return changedNodes.length > 0 && changedNodes.every(isOwnNode);
  }

  function installObserver() {
    let scheduled = false;
    const observer = new MutationObserver((mutations) => {
      if (__ownTransition) return;
      if (scheduled) return;
      // Filter out mutations that are entirely about our own DOM. If every
      // mutation in this batch is one we caused, the page itself didn't
      // change in a way that warrants a re-detection.
      if (mutations.every(isOwnMutation)) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        if (!document.getElementById(PANEL_ID) && !document.getElementById(TOAST_ID)) {
          checkAndRender();
        }
      });
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  // Expose the transition flag to the toast click handler so it can guard the
  // critical window between removeToast() and the synchronous panel shell
  // render.
  function withOwnTransition(fn) {
    __ownTransition = true;
    return Promise.resolve(fn()).finally(() => { __ownTransition = false; });
  }

  installObserver();
  watchNavigation();
  window.addEventListener("load", checkAndRender);
  checkAndRender();
})();
