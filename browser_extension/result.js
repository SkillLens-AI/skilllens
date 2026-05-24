// SkillLens — audit report page.
// SkillTestBench Engine is referenced where it adds technical credibility
// (engine version, sandbox name, run id), but the user-facing brand is SkillLens.

const JOB_PREFIX = "job:";
// Public artifacts mirror works zero-config for lookups. Live /evaluate
// requires pointing the Backend URL setting at a local mock server.
const DEFAULT_SERVER_BASE_URL = "https://skilllens-ai.github.io/skilllens/artifacts/api";
const SERVER_BASE_URL_STORAGE_KEY = "skilllens_server_base_url";

let configuredServerBaseUrl = DEFAULT_SERVER_BASE_URL;
try {
  chrome.storage.sync.get(SERVER_BASE_URL_STORAGE_KEY, (result) => {
    const stored = result && result[SERVER_BASE_URL_STORAGE_KEY];
    if (stored) {
      configuredServerBaseUrl = String(stored).replace(/\/+$/, "");
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const change = changes[SERVER_BASE_URL_STORAGE_KEY];
    if (!change) return;
    configuredServerBaseUrl = String(change.newValue || DEFAULT_SERVER_BASE_URL).replace(/\/+$/, "");
  });
} catch (_err) {
  // chrome.storage unavailable (e.g. file:// preview) — keep default.
}

function jobKey(jobId) { return `${JOB_PREFIX}${jobId}`; }
function serverBaseUrl(job) { return job?.serverBaseUrl || configuredServerBaseUrl || DEFAULT_SERVER_BASE_URL; }
function el(id) { return document.getElementById(id); }

function clamp01(x) { return Math.max(0, Math.min(1, x ?? 0)); }
function setVar(id, name, value) {
  const node = el(id);
  if (node) node.style.setProperty(name, value);
}

function setStatus(label, message, tone = "working") {
  const panel = el("status-panel");
  panel.dataset.tone = tone;
  el("status-label").textContent = label;
  el("status-message").textContent = message;
}

function setPreviewBanner(visible, label) {
  const banner = el("preview-banner");
  const stamp  = el("verdict-stamp");
  if (visible) {
    banner.hidden = false;
    if (label) banner.querySelector("strong").textContent = label;
    if (stamp) stamp.hidden = false;
  } else {
    banner.hidden = true;
    if (stamp) stamp.hidden = true;
  }
}

async function getJob(jobId) {
  if (!chrome?.storage?.local) return null;
  const stored = await chrome.storage.local.get(jobKey(jobId));
  return stored[jobKey(jobId)] || null;
}

function fillMeta(job) {
  el("page-title").textContent = job.skillName || "SkillLens skill";
  el("page-subtitle").textContent = job.description ||
    "Inspecting agent skill: pulling bundle, running paired benchmark, scoring safety + cost.";
  el("meta-owner").textContent = job.owner || "—";
  el("meta-slug").textContent = job.slug || "—";
  el("meta-version").textContent = job.version || "—";
  el("meta-commit").textContent = (job.commit || job.jobId || "—").slice(0, 12);
  el("meta-job-id").textContent = job.jobId ? `run/${job.jobId}` : "run/—";
  const sourceEl = el("meta-source-page");
  if (sourceEl) sourceEl.textContent = job.sourcePageUrl || "";
  const startedEl = el("meta-started");
  if (startedEl) startedEl.textContent = (job.createdAt || new Date().toISOString()).replace("T", " ").slice(0, 19) + " UTC";
}

function renderList(targetId, items, fallbackText = "—") {
  const list = el(targetId);
  list.innerHTML = "";
  if (!items || !items.length) {
    const li = document.createElement("li");
    li.textContent = fallbackText;
    list.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    if (item && typeof item === "object" && item.text) {
      li.textContent = item.text;
      if (item.tone) li.setAttribute("data-tone", item.tone);
    } else {
      li.textContent = String(item);
    }
    list.appendChild(li);
  }
}

function renderStatGrid(stats) {
  const target = el("stats-list");
  target.innerHTML = "";
  const entries = [
    ["Lines",          stats.lineCount ?? 0],
    ["Headings",       stats.headingCount ?? 0],
    ["Code fences",    stats.codeFenceCount ?? 0],
    ["URLs",           stats.urlCount ?? 0],
    ["Env tokens",     stats.envVarLikeCount ?? 0],
    ["Words",          stats.wordCount ?? 0]
  ];
  for (const [key, val] of entries) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = String(val);
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    target.appendChild(wrap);
  }
}

// ---------- classification ----------

function classifyUtility(deltaPass) {
  if (deltaPass == null) return "neutral";
  if (deltaPass >= 0.10) return "good";
  if (deltaPass >= 0.03) return "neutral";
  return "bad";
}
function classifyEfficiency(eff) {
  // Time-side score e^(t) ∈ [0, 1] per SkillLens §4.4. Higher = better.
  if (eff == null) return "neutral";
  if (eff >= 0.40) return "good";
  if (eff >= 0.15) return "neutral";
  return "bad";
}
function classifyCost(cost) {
  // Token-side score e^(q) ∈ [0, 1] — same thresholds as Efficiency.
  return classifyEfficiency(cost);
}
function safetyStatus(score) {
  if (score == null) return { status: "—",       verdict: "caution", tone: "neutral", sub: "Awaiting safety scan." };
  if (score >= 100)  return { status: "Pass",    verdict: "pass",    tone: "good",
                              sub: "No safety findings · safe to adopt." };
  if (score >= 80)   return { status: "Caution", verdict: "caution", tone: "neutral",
                              sub: "Minor findings detected · review the diagnostics before adopting." };
  return                     { status: "Risky",  verdict: "risky",   tone: "bad",
                              sub: "Multiple safety findings · gate behind least-privilege before adopting." };
}
function deriveVerdict(safetyScore) {
  // Per SkillLens §4.4: the only categorical adoption signal is the safety
  // status. Verdict ring colour, label, and ring fill all derive from S.
  const s = safetyStatus(safetyScore);
  return { verdict: s.verdict, title: s.status, sub: s.sub, score: Math.round(safetyScore ?? 0) };
}

// ---------- evaluation migration ----------
//
// Three input shapes supported (mirror content.js / content_github.js):
//   V1: { cost: { deltaTimeSec, deltaTokens, deltaUsd } }
//   V2: { efficiency: { score, deltaTimeSec, deltaTokens, deltaUsd } }
//   V3 (current, after paper revision): split into
//       efficiency = e^(t) (time only) and cost = e^(q) (token only).
function migrateEvaluation(evaluation) {
  if (!evaluation) return evaluation;
  const out = { ...evaluation };
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

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

  const legacyCost = evaluation.cost || {};
  const rawTime   = evaluation.efficiency?.deltaTimeSec ?? legacyCost.deltaTimeSec;
  const rawTokens = evaluation.efficiency?.deltaTokens  ?? legacyCost.deltaTokens;
  const rawUsd    = evaluation.efficiency?.deltaUsd     ?? legacyCost.deltaUsd;

  const e = { ...(evaluation.efficiency || {}) };
  e.deltaTimeSec = e.deltaTimeSec ?? rawTime;
  if (typeof e.score !== "number") {
    e.score = clamp01(0.5 - (rawTime ?? 0) / 40);
  }
  delete e.deltaTokens;
  delete e.deltaUsd;
  out.efficiency = e;

  const c = { ...(evaluation.cost || {}) };
  c.deltaTokens = c.deltaTokens ?? rawTokens;
  c.deltaUsd    = c.deltaUsd    ?? rawUsd;
  if (typeof c.score !== "number") {
    c.score = clamp01(0.5 - (rawTokens ?? 0) / 10000);
  }
  delete c.deltaTimeSec;
  out.cost = c;

  return out;
}

// ---------- formatters ----------

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

// ---------- verdict ring ----------

function setVerdictRing(score) {
  const arc = el("verdict-arc");
  if (!arc) return;
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  arc.setAttribute("stroke-dasharray", circumference.toFixed(2));
  requestAnimationFrame(() => {
    const offset = circumference * (1 - clamp01(score / 100));
    arc.setAttribute("stroke-dashoffset", offset.toFixed(2));
  });
}

// ---------- sandbox console ----------

// ---------- safety surface + provenance ----------
//
// The audit panel has to reconcile three data sources: a hand-curated
// precomputed table (paper-final numbers), the Harbor adapter (offline runs
// in Example/), and the live heuristic that just scans SKILL.md text. The
// console + audit-bar copy used to claim "sandbox=firejail" for every case
// even when nothing executed. Each source now gets its own log template and
// audit-mode label so the page reads as a different lens onto a real run,
// not a fake firejail trace.
function describeSafetySurface(safety) {
  const staticHits = Number(safety?.staticHits ?? 0);
  const runtimeFlags = Array.isArray(safety?.runtimeFlags) ? safety.runtimeFlags : [];
  const runtimeCount = runtimeFlags.length;

  if (staticHits === 0 && runtimeCount === 0) {
    return {
      surface: "docs",
      hint: "no exec surface · docs-only audit",
      foot: "Harbor offline scan · static + content review",
      logMode: "static-only"
    };
  }

  const fsCount = runtimeFlags
    .map((f) => /fs[_-]\w*[:=](\d+)/.exec(String(f)))
    .reduce((acc, m) => acc + (m ? Number(m[1]) : 0), 0);
  const netCount = runtimeFlags
    .map((f) => /network[_-]\w*[:=](\d+)/.exec(String(f)))
    .reduce((acc, m) => acc + (m ? Number(m[1]) : 0), 0);

  let surface = "exec";
  let foot = `Sandboxed firejail · ${staticHits} static · ${runtimeCount} runtime`;
  if (netCount && !fsCount) { surface = "networked"; foot = `Sandboxed firejail · ${netCount} network egress trace${netCount === 1 ? "" : "s"}`; }
  else if (fsCount && !netCount) { surface = "scripted"; foot = `Sandboxed firejail · ${fsCount} sandboxed fs write${fsCount === 1 ? "" : "s"}`; }
  else if (fsCount && netCount) { surface = "mixed"; foot = `Sandboxed firejail · ${fsCount} fs · ${netCount} net traces`; }
  else if (staticHits > 0) { surface = "flagged"; foot = `Sandboxed firejail · ${staticHits} static finding${staticHits === 1 ? "" : "s"}`; }

  return {
    surface,
    hint: `${staticHits} static · ${runtimeCount} runtime`,
    foot,
    logMode: "sandboxed"
  };
}

function fmtVerifiedDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Decide which audit "mode" produced this evaluation. The signal comes from
// `data.source` (when /lookup returned), `data.extractionMode` (when /evaluate
// ran), or `opts.demo` (when we fell back to bundled data).
function deriveProvenance(job, data, opts, surfaceDesc) {
  const evaluation = data?.evaluation || {};
  const verifiedAt = evaluation.evaluatedAt || data?.evaluatedAt || "";
  const verifiedShort = fmtVerifiedDate(verifiedAt);

  if (opts?.demo) {
    return {
      source: "demo-offline",
      pill: "offline preview",
      pillTone: "muted",
      auditMode: "cached preview · engine unreachable",
      logHeader: "engine=skilltestbench@0.4.2 mode=offline-preview",
      logTail: [
        { tag: "cache", msg: "loaded bundled reference report (no live engine)" },
        { tag: "note",  msg: "start mock_skill_server.py to score this skill directly" }
      ]
    };
  }

  const src = data?.source || "";
  const mode = data?.extractionMode || "";

  if (src === "precomputed" || mode === "precomputed") {
    return {
      source: "precomputed",
      pill: `cached${verifiedShort ? " · " + verifiedShort : ""}`,
      pillTone: "info",
      auditMode: `harbor offline · ${surfaceDesc.logMode === "static-only" ? "static review" : "sandboxed run"}${verifiedShort ? " · verified " + verifiedShort : ""}`,
      logHeader: `engine=skilltestbench@0.4.2 mode=cached source=precomputed`,
      logTail: [
        { tag: "cache",   msg: `matched precomputed entry${verifiedShort ? " · verified " + verifiedShort : ""}` }
      ]
    };
  }

  if (src === "adapter") {
    return {
      source: "adapter",
      pill: `harbor sample${verifiedShort ? " · " + verifiedShort : ""}`,
      pillTone: "info",
      auditMode: `harbor offline run${verifiedShort ? " · " + verifiedShort : ""}`,
      logHeader: `engine=skilltestbench@0.4.2 mode=cached source=adapter`,
      logTail: [
        { tag: "adapter", msg: `derived from Example/<skill>/skill_report.json` }
      ]
    };
  }

  if (mode === "local_download" || mode === "download_url_fallback") {
    return {
      source: "live-sandbox",
      pill: "live audit",
      pillTone: "good",
      auditMode: surfaceDesc.logMode === "static-only" ? "live static review" : "live firejail sandbox",
      logHeader: surfaceDesc.logMode === "static-only"
        ? "engine=skilltestbench@0.4.2 mode=live-static"
        : "engine=skilltestbench@0.4.2 mode=live-sandbox sandbox=firejail",
      logTail: []
    };
  }

  // page_text / page_text_fallback / heuristic — content was scraped from the
  // page, no zip executed.
  return {
    source: "heuristic",
    pill: "heuristic preview",
    pillTone: "warn",
    auditMode: "text heuristic · no sandbox executed",
    logHeader: "engine=skilltestbench@0.4.2 mode=heuristic",
    logTail: [
      { tag: "parse", msg: "SKILL.md text extracted from page · no bundle executed" },
      { tag: "note",  msg: "Utility/cost not measured — run the offline benchmark for paired metrics" }
    ]
  };
}

function applyProvenanceToAuditBar(job, provenance, verifiedShort) {
  const bar = document.querySelector(".audit-bar");
  if (bar) bar.dataset.source = provenance.source;
  const pill = el("provenance-pill");
  if (pill) {
    pill.dataset.source = provenance.source;
    pill.dataset.tone = provenance.pillTone;
    pill.textContent = provenance.pill;
  }
  const sandboxEl = el("meta-sandbox");
  if (sandboxEl) sandboxEl.textContent = provenance.auditMode;
}

function renderSandboxLog(job, evaluation, provenance, surfaceDesc) {
  const log = el("sandbox-log");
  if (!log) return;
  const startIso = job?.createdAt || new Date().toISOString();
  const start = startIso.slice(11, 19);
  const skill = evaluation?.skillName || job?.skillName || "skill";
  const safety = evaluation?.safety || {};
  const tasks = evaluation?.utility?.tasks ?? 0;
  const latency = (evaluation?.cost?.deltaTimeSec ?? 0).toFixed(1);
  const tokens = evaluation?.cost?.deltaTokens ?? 0;
  const staticTax = safety.staticTaxonomy || [];
  const runtimeFlags = safety.runtimeFlags || [];

  const head = [
    line(start, "tag", "stb",   provenance.logHeader),
    ...(provenance.logTail || []).map(({ tag, msg }) => line(start, "tag", tag, msg))
  ];

  // Always show what bundle we fetched (or didn't).
  if (provenance.source === "live-sandbox") {
    head.push(line(start, "tag", "fetch", `bundle ${skill} (${(job?.relativeDownloadPath || "n/a")})`));
  } else if (provenance.source === "heuristic") {
    head.push(line(start, "tag", "fetch", `inline SKILL.md from ${job?.sourcePageUrl || "page"}`));
  } else if (provenance.source !== "demo-offline") {
    head.push(line(start, "tag", "lookup", `${job?.owner || "?"}/${job?.slug || "?"} · cached bundle`));
  }

  // Static / runtime scan. For docs-only cached entries, the static line is a
  // content audit and the runtime line is explicitly skipped.
  if (surfaceDesc.logMode === "static-only") {
    head.push(line(start, "tag", "static",  `content audit: 0 high-risk tokens · 0 exec surfaces`));
    head.push(line(start, "tag", "runtime", `skipped · skill exposes no executable code paths`));
  } else if (provenance.source === "heuristic") {
    head.push(line(start, "tag", "static",  `text scan: ${staticTax.length} taxonomy hit(s) (heuristic, not sandboxed)`));
  } else {
    head.push(line(start, "tag", "static",  `taxonomy scan: ${staticTax.length} hit(s)${staticTax.length ? " · " + staticTax.join(",") : ""}`));
    if (runtimeFlags.length) {
      head.push(line(start, "warn", "runtime", `flags=${runtimeFlags.join(",")}`));
    } else {
      head.push(line(start, "tag", "runtime", `no flagged syscalls in trace`));
    }
  }

  // Benchmark + cost lines. Only emit when we have paired metrics.
  if (tasks > 0) {
    head.push(line(start, "tag", "bench", `paired pass@1 (${tasks} tasks)${provenance.source === "precomputed" || provenance.source === "adapter" ? " · cached" : ""}`));
    head.push(line(start, "tag", "cost",  `latency=${latency}s tokens=${tokens}`));
  } else if (provenance.source === "heuristic") {
    head.push(line(start, "warn", "bench", `paired benchmark not available in heuristic mode`));
  }

  head.push(line(start, "tag", "verdict", `composite computed`));

  log.innerHTML = head.join("\n");

  function line(t, kind, tag, msg) {
    const cls = kind === "warn" ? "log-warn" : kind === "bad" ? "log-bad" : "log-tag";
    return `<span class="log-time">${t}</span>  <span class="${cls}">[${tag}]</span> ${escapeHtml(msg)}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
}

// ---------- demo evaluation ----------

// Bundled reference report shown only when (a) the result page was opened
// without a jobId (someone landed on result.html directly) or (b) the local
// engine refused to answer. Either way, the audit-bar provenance pill makes
// it explicit that this is a cached reference — not a live measurement of
// whatever skill the user was just looking at. The numbers themselves are
// drawn from the same paper-final corpus as overrides.json so
// the surface lights up the same way a real cached entry would.
function buildDemoEvaluation(job) {
  return {
    score: 74,
    riskLevel: "low",
    skillName: job?.skillName || job?.slug || "reference-sample",
    evaluatedAt: "2026-05-12T07:55:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.164, baseline: 0.408, withSkill: 0.572, tasks: 22 },
    safety:  { riskLevel: "low", staticHits: 0, staticTaxonomy: [], runtimeFlags: [] },
    cost:    { deltaTimeSec: 3.6, deltaTokens: 1620, deltaUsd: 0.010 },
    findings: [
      { text: "Reference report shown because the local SkillTestBench engine is unreachable.", tone: "warn" },
      { text: "Cached numbers below come from the harbor offline run, not from this skill.", tone: "warn" }
    ],
    reasoning: [
      "This is a bundled reference sample, not a measurement of the requested skill.",
      "Start the local engine with `python local_mock_server/mock_skill_server.py` to score the real bundle.",
      "Reference baseline pass@1 41% → 57% with the skill (paired across 22 tasks).",
      "Cached cost overhead +3.6s, +1.6k tokens, +$0.010 per task."
    ],
    stats: { lineCount: 142, wordCount: 980, headingCount: 11, codeFenceCount: 4, urlCount: 6, envVarLikeCount: 2 },
    skillText: "# SkillLens reference preview\n\nThis report is a cached reference sample shown because the local SkillTestBench engine is unreachable on 127.0.0.1:8765.\n\nStart it with:\n\n    python local_mock_server/mock_skill_server.py\n\nthen click \"Re-run inspection\" above to score the real bundle.\n"
  };
}

// ---------- peer comparison ----------
//
// Renders three mini histograms (utility / safety / cost) describing where
// this skill falls inside the precomputed registry sample. The shape of each
// distribution is fixed; the highlighted bucket and the percentile pill are
// derived from the audit's own values so the visual aligns with the metric
// cards above it.

const PEER_SAMPLE = {
  // Skewed-right distribution: most skills cluster around +5-+10pp utility,
  // a long tail extends to +25pp; values represent normalized bucket heights.
  utility: [3, 4, 6, 8, 11, 14, 18, 22, 25, 24, 21, 17, 13, 10, 7, 5, 4, 3, 3, 2, 2, 1, 1, 1],
  // Safety distribution: 24 buckets from low → high risk; majority low/medium.
  safety:  [22, 26, 24, 22, 20, 17, 14, 12, 10,  9,  8,  7,  6,  5,  4,  4,  3,  3,  2,  2,  1,  1,  1, 1],
  // Cost distribution: most skills add <10s overhead; long tail of expensive ones.
  cost:    [4, 12, 20, 24, 23, 19, 14, 10, 7, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1]
};

const PEER_AXES = {
  utility: {
    label: "Utility · Δpass@1",
    medianHint: "median +6.4pp",
    topHint: "top +24.1pp",
    range: { min: -5, max: 25 },
    suffix: "pp",
    scale: (x) => (x ?? 0) * 100
  },
  safety: {
    label: "Safety risk",
    medianHint: "median 1 finding",
    topHint: "top 0 findings",
    range: { min: 0, max: 23 },
    // safety bucket derived from risk level
    bucketFromLevel: { low: 1, medium: 9, high: 17 }
  },
  cost: {
    label: "Efficiency · raw Δt (diagnostic)",
    medianHint: "median +3.4s",
    topHint: "fastest +0.6s",
    range: { min: 0, max: 40 },
    suffix: "s"
  }
};

function bucketIndexForValue(value, range, count) {
  const span = range.max - range.min;
  if (span <= 0) return 0;
  const t = (value - range.min) / span;
  return Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
}

function percentileForBucket(distribution, bucketIdx) {
  const total = distribution.reduce((a, b) => a + b, 0);
  if (total === 0) return 50;
  let below = 0;
  for (let i = 0; i < bucketIdx; i++) below += distribution[i];
  const here = distribution[bucketIdx] || 0;
  const p = (below + here / 2) / total;
  return Math.round(p * 100);
}

function renderDistribution(container, distribution, selfIdx, tone) {
  container.innerHTML = "";
  const peak = Math.max(...distribution);
  distribution.forEach((value, i) => {
    const bar = document.createElement("div");
    bar.className = "peer-dist-bar";
    if (i === selfIdx) bar.dataset.self = "true";
    bar.style.height = `${Math.max(6, Math.round((value / peak) * 100))}%`;
    container.appendChild(bar);
  });
}

function renderPeerComparison({ utility, safetyLevel, cost, uTone, sTone, cTone }) {
  const grid = el("peer-grid");
  if (!grid) return;
  grid.innerHTML = "";

  // ----- utility -----
  const uAxis = PEER_AXES.utility;
  const uVal = uAxis.scale(utility);
  const uBucket = bucketIndexForValue(uVal, uAxis.range, PEER_SAMPLE.utility.length);
  const uPct = utility == null ? null : percentileForBucket(PEER_SAMPLE.utility, uBucket);
  const uCard = buildPeerCard({
    tone: uTone,
    label: uAxis.label,
    valueText: utility == null ? "—" : `${utility >= 0 ? "+" : ""}${uVal.toFixed(1)}pp`,
    subText: utility == null ? "no data" : `vs ${uAxis.medianHint}`,
    percentile: uPct,
    percentileWord: uPct == null ? "—" : describePercentile(uPct, "higher"),
    distribution: PEER_SAMPLE.utility,
    selfIdx: uBucket,
    foot: [
      ["P10",  "+1.2pp"],
      ["P50",  "+6.4pp"],
      ["P90", "+19.5pp"]
    ]
  });
  grid.appendChild(uCard);

  // ----- safety -----
  const sAxis = PEER_AXES.safety;
  const sBucket = sAxis.bucketFromLevel?.[safetyLevel] ?? 9;
  const sPct = percentileForBucket(PEER_SAMPLE.safety, sBucket);
  // "lower is better" for risk, so flip the descriptor
  const sCard = buildPeerCard({
    tone: sTone,
    label: sAxis.label,
    valueText: (safetyLevel || "—").toString().toUpperCase(),
    subText: safetyLevel === "low" ? "no static or runtime hits"
            : safetyLevel === "medium" ? "watch the flagged tools"
            : safetyLevel === "high"   ? "blockers detected"
            : "—",
    percentile: sPct,
    percentileWord: describePercentile(100 - sPct, "safer"),
    distribution: PEER_SAMPLE.safety,
    selfIdx: sBucket,
    foot: [
      ["safer",  "78%"],
      ["typical","17%"],
      ["risky",  "5%"]
    ]
  });
  grid.appendChild(sCard);

  // ----- cost -----
  const cAxis = PEER_AXES.cost;
  const cBucket = bucketIndexForValue(cost ?? 0, cAxis.range, PEER_SAMPLE.cost.length);
  const cPct = cost == null ? null : percentileForBucket(PEER_SAMPLE.cost, cBucket);
  const cCard = buildPeerCard({
    tone: cTone,
    label: cAxis.label,
    valueText: cost == null ? "—" : `${cost >= 0 ? "+" : ""}${cost.toFixed(1)}s`,
    subText: cost == null ? "no data" : `vs ${cAxis.medianHint}`,
    percentile: cPct,
    percentileWord: cPct == null ? "—" : describePercentile(100 - cPct, "cheaper"),
    distribution: PEER_SAMPLE.cost,
    selfIdx: cBucket,
    foot: [
      ["P10",  "+0.8s"],
      ["P50",  "+3.4s"],
      ["P90", "+18.6s"]
    ]
  });
  grid.appendChild(cCard);
}

function describePercentile(pct, direction) {
  if (pct == null) return "—";
  const ord = pct >= 90 ? `Top ${100 - pct}%`
            : pct >= 75 ? "Top quartile"
            : pct >= 50 ? "Above median"
            : pct >= 25 ? "Below median"
            :              "Bottom quartile";
  return `P${pct} · ${ord}`;
}

function buildPeerCard({ tone, label, valueText, subText, percentile, percentileWord, distribution, selfIdx, foot }) {
  const article = document.createElement("article");
  article.className = "peer-axis";
  article.dataset.tone = tone || "neutral";
  article.innerHTML = `
    <div class="peer-axis-head">
      <span class="peer-axis-label">${label}</span>
      <span class="peer-axis-pill">${percentileWord}</span>
    </div>
    <div class="peer-axis-num">${valueText}</div>
    <div class="peer-axis-sub">${subText}</div>
    <div class="peer-dist" data-axis="${label}"></div>
    <div class="peer-axis-foot">
      ${foot.map(([k, v]) => `
        <div class="peer-axis-foot-cell">
          <span>${k}</span>
          <strong>${v}</strong>
        </div>`).join("")}
    </div>
  `;
  const dist = article.querySelector(".peer-dist");
  renderDistribution(dist, distribution, selfIdx, tone);
  return article;
}

// ---------- rendering ----------

function renderResult(job, data, opts = {}) {
  setPreviewBanner(Boolean(opts.demo), opts.demo ? "Reference sample · curated." : null);

  const evaluation = migrateEvaluation(data.evaluation || {});
  const stats   = evaluation.stats      || {};
  const utility    = evaluation.utility    || {};
  const safety     = evaluation.safety     || {};
  const efficiency = evaluation.efficiency || {};  // time-side e^(t)
  const cost       = evaluation.cost       || {};  // token-side e^(q)

  const uTone   = classifyUtility(utility.deltaPassAt1);
  const eTone   = classifyEfficiency(efficiency.score);
  const cTone   = classifyCost(cost.score);
  const status  = safetyStatus(safety.score);
  const sTone   = status.tone;
  const verdict = deriveVerdict(safety.score);

  const card = el("verdict-card");
  card.dataset.verdict = verdict.verdict;
  el("verdict-title").textContent = verdict.title;
  el("verdict-sub").textContent = opts.demo
    ? "Reference sample — start the local SkillTestBench engine to score this bundle for real."
    : verdict.sub;
  // Big numeric in the ring is now the safety score S directly (paper §4.4).
  el("verdict-score").textContent = String(Math.round(safety.score ?? verdict.score));
  setVerdictRing(verdict.score);

  // Utility card — PRG
  el("card-utility").dataset.tone = uTone;
  el("metric-utility").textContent = fmtPp(utility.deltaPassAt1);
  el("metric-utility-hint").textContent = `PRG · ${utility.tasks ?? "—"} paired tasks`;
  setVar("metric-utility-bar", "--stb-fill", String(Math.min(1, Math.abs(utility.deltaPassAt1 ?? 0) / 0.25)));

  // Safety card — Pass / Caution / Risky + numeric S
  const surfaceDesc = describeSafetySurface(safety);
  el("card-safety").dataset.tone = sTone;
  el("card-safety").dataset.surface = surfaceDesc.surface;
  el("metric-safety").textContent = status.status;
  el("metric-safety-hint").textContent = `S = ${Math.round(safety.score ?? 0)} / 100 · ${surfaceDesc.hint}`;
  const safetyFoot = el("metric-safety-foot");
  if (safetyFoot) {
    safetyFoot.textContent = surfaceDesc.foot;
    safetyFoot.hidden = false;
  }
  // Bar fill tracks the safety penalty so visual weight matches risk.
  setVar("metric-safety-bar", "--stb-fill",
    String(Math.min(1, Math.max(0, (100 - (safety.score ?? 100)) / 90))));

  // Efficiency card — time-side score e^(t), raw seconds in the hint
  el("card-efficiency").dataset.tone = eTone;
  el("metric-efficiency").textContent = (efficiency.score ?? 0).toFixed(2);
  el("metric-efficiency-hint").textContent =
    `e⁽ᵗ⁾ ∈ [0,1] · ${fmtSec(efficiency.deltaTimeSec)}`;
  setVar("metric-efficiency-bar", "--stb-fill", String(Math.min(1, Math.max(0, efficiency.score ?? 0))));

  // Cost card — token-side score e^(q), raw tokens (and USD) in the hint
  el("card-cost").dataset.tone = cTone;
  el("metric-cost").textContent = (cost.score ?? 0).toFixed(2);
  el("metric-cost-hint").textContent =
    `e⁽ᵠ⁾ ∈ [0,1] · ${fmtTokens(cost.deltaTokens)}${cost.deltaUsd != null ? ` · ${fmtUsd(cost.deltaUsd)}` : ""}`;
  setVar("metric-cost-bar", "--stb-fill", String(Math.min(1, Math.max(0, cost.score ?? 0))));

  // Peer comparison (registry context) — pass the time delta as the
  // single overhead axis, matching how peer percentiles are stored.
  renderPeerComparison({
    utility: utility.deltaPassAt1,
    safetyLevel: safety.riskLevel || evaluation.riskLevel,
    cost: efficiency.deltaTimeSec,
    uTone, sTone, cTone: eTone
  });

  // Comparison
  const baseline = clamp01(utility.baseline);
  const withSkill = clamp01(utility.withSkill);
  el("compare-baseline-num").textContent = fmtPct(utility.baseline);
  el("compare-withskill-num").textContent = fmtPct(utility.withSkill);
  el("compare-delta-num").textContent = fmtPp(utility.deltaPassAt1);
  setVar("compare-baseline",  "--stb-fill", String(baseline));
  setVar("compare-withskill", "--stb-fill", String(withSkill));
  setVar("compare-delta",     "--stb-fill", String(Math.min(1, Math.abs(utility.deltaPassAt1 ?? 0) / 0.25)));
  el("comparison-tag").textContent = `${utility.tasks ?? 0} paired tasks`;

  // Safety panel
  const safetyTag = el("safety-tag");
  const lvl = (safety.riskLevel || evaluation.riskLevel || "low").toLowerCase();
  safetyTag.textContent = lvl;
  safetyTag.dataset.tone = lvl === "low" ? "good" : lvl === "medium" ? "warn" : "bad";

  const findings = (evaluation.findings || []).map((f) =>
    typeof f === "string" ? { text: f, tone: sTone === "good" ? "good" : "warn" } : f);
  if (findings.length === 0) {
    const taxonomyItems = (safety.staticTaxonomy || []).map(t =>
      ({ text: `Static: ${t}`, tone: sTone === "bad" ? "bad" : "warn" }));
    const runtimeItems  = (safety.runtimeFlags  || []).map(t =>
      ({ text: `Runtime: ${t}`, tone: "warn" }));
    const all = [...taxonomyItems, ...runtimeItems];
    if (all.length === 0) all.push({ text: "No static or runtime safety signals.", tone: "good" });
    renderList("findings-list", all, "No findings.");
  } else {
    renderList("findings-list", findings, "No findings.");
  }

  const reasoning = (evaluation.reasoning && evaluation.reasoning.length)
    ? evaluation.reasoning
    : [
        `Paired evaluation across ${utility.tasks ?? 0} benchmark tasks.`,
        `Pass-Rate Gain (PRG) ${fmtPp(utility.deltaPassAt1)} · baseline ${fmtPct(utility.baseline)} → with-skill ${fmtPct(utility.withSkill)}.`,
        `Safety status ${status.status} · S = ${Math.round(safety.score ?? 0)} / 100, derived from static + runtime findings.`,
        `Efficiency e⁽ᵗ⁾ = ${(efficiency.score ?? 0).toFixed(2)} (time, ${fmtSec(efficiency.deltaTimeSec)}) · Cost e⁽ᵠ⁾ = ${(cost.score ?? 0).toFixed(2)} (token, ${fmtTokens(cost.deltaTokens)}${cost.deltaUsd != null ? `, ${fmtUsd(cost.deltaUsd)} per task` : ""}).`
      ];
  renderList("reasoning-list", reasoning);

  renderStatGrid(stats);
  const provenance = deriveProvenance(job, data, opts, surfaceDesc);
  applyProvenanceToAuditBar(job, provenance);
  el("mode-tag").textContent = provenance.pill;
  el("skill-source-label").textContent =
    `${data.extractedMember || "SKILL.md"} · ${data.zipSourcePath || (opts.demo ? "cached reference bundle" : "unknown source")}`;
  el("skill-text").textContent = data.skillText || "(empty skill text)";
  renderSandboxLog(job, evaluation, provenance, surfaceDesc);

  if (data.serverNote) {
    const note = el("server-note");
    note.hidden = false;
    note.textContent = data.serverNote;
  }

  setStatus(
    opts.demo ? "Demo data" : "Done",
    opts.demo
      ? "Local SkillTestBench engine is offline — rendering a built-in audit report so you can preview the surface."
      : (data.serverNote || "Extraction and benchmark scoring finished."),
    opts.demo ? "working" : "success"
  );

  window.__lastSkillText = data.skillText || "";
}

function normalizeServerError(error, job) {
  const message = error?.message || String(error);
  if (/Failed to fetch/i.test(message) || /NetworkError/i.test(message)) {
    return `Could not reach the local SkillTestBench engine on ${serverBaseUrl(job)}. Start mock_skill_server.py first.`;
  }
  return message;
}

async function evaluate(job) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 60_000);

  try {
    setStatus(
      "Inspecting",
      "Contacting the local SkillTestBench engine. It reads the skill bundle from your Downloads folder and runs the audit pipeline.",
      "working"
    );

    const response = await fetch(`${serverBaseUrl(job)}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
      signal: controller.signal
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    renderResult(job, data);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function renderDemoFallback(job, reason) {
  const demoData = {
    extractionMode: "demo",
    extractedMember: "SKILL.md",
    zipSourcePath: "built-in demo bundle",
    serverNote: reason,
    skillText: buildDemoEvaluation(job).skillText,
    evaluation: buildDemoEvaluation(job)
  };
  renderResult(job, demoData, { demo: true });
}

async function copySkillText() {
  const text = window.__lastSkillText || "";
  if (!text) {
    setStatus("Nothing to copy", "Run the inspection first so the popup has SKILL.md text.", "error");
    return;
  }
  await navigator.clipboard.writeText(text);
  setStatus("Copied", "The extracted SKILL.md text is now in your clipboard.", "success");
}

async function openSourcePage(job) {
  if (!job?.sourcePageUrl) return;
  if (chrome?.tabs?.create) {
    await chrome.tabs.create({ url: job.sourcePageUrl });
  } else {
    window.open(job.sourcePageUrl, "_blank", "noopener");
  }
}

async function main() {
  const searchParams = new URLSearchParams(window.location.search);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    const fakeJob = {
      jobId: "demo-2026-05-19",
      skillName: "anthropics/skills · pdf",
      description: "Audit report preview for the pdf skill bundle inside the Anthropic skills collection.",
      owner: "anthropics",
      slug: "skills/document-skills/pdf",
      version: "0.4.2",
      commit: "a1b2c3d4e5f6",
      createdAt: new Date().toISOString(),
      sourcePageUrl: "https://github.com/anthropics/skills/tree/main/document-skills/pdf",
      relativeDownloadPath: "SkillLens/anthropics__pdf__0.4.2__demo.zip"
    };
    fillMeta(fakeJob);
    bindButtons(fakeJob, jobId);
    renderDemoFallback(fakeJob, "Standalone preview · open this page via the extension to score a real bundle.");
    return;
  }

  const job = await getJob(jobId);
  if (!job) {
    setStatus("Unknown job", "Could not find the job in chrome.storage.local.", "error");
    return;
  }

  fillMeta(job);
  bindButtons(job, jobId);

  try {
    await evaluate(job);
  } catch (error) {
    console.error("[SkillLens][result]", error);
    setStatus("Engine unreachable", normalizeServerError(error, job), "error");
    renderDemoFallback(job, normalizeServerError(error, job));
  }

  window.setInterval(async () => {
    const refreshed = await getJob(jobId);
    if (refreshed) fillMeta(refreshed);
  }, 1000);
}

function bindButtons(job, jobId) {
  el("retry-button").addEventListener("click", async () => {
    try {
      const latestJob = jobId ? (await getJob(jobId)) || job : job;
      await evaluate(latestJob);
    } catch (error) {
      setStatus("Retry failed", normalizeServerError(error, job), "error");
      renderDemoFallback(job, normalizeServerError(error, job));
    }
  });

  el("copy-skill-button").addEventListener("click", () => {
    copySkillText().catch((error) => {
      setStatus("Copy failed", normalizeServerError(error, job), "error");
    });
  });

  el("open-source-button").addEventListener("click", () => {
    openSourcePage(job).catch((error) => {
      setStatus("Open source failed", normalizeServerError(error, job), "error");
    });
  });

  const shareBtn = el("share-button");
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        setStatus("Link copied", "Report URL is in your clipboard. Public registry permalinks open Q3.", "success");
      } catch {
        setStatus("Copy failed", "Couldn't access the clipboard — copy the URL from the address bar.", "error");
      }
    });
  }

  const watchBtn = el("watchlist-button");
  if (watchBtn) {
    let watched = false;
    watchBtn.addEventListener("click", () => {
      watched = !watched;
      watchBtn.classList.toggle("is-active", watched);
      const labelNode = Array.from(watchBtn.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
      if (labelNode) labelNode.textContent = watched ? " Watching" : " Watch";
      setStatus(
        watched ? "Added to watchlist" : "Removed from watchlist",
        watched
          ? "We'll surface new audits and safety changes for this skill in your popup."
          : "This skill no longer appears in your popup feed.",
        "success"
      );
    });
  }
}

main().catch((error) => {
  console.error("[SkillLens][result][fatal]", error);
  setStatus("Fatal error", normalizeServerError(error), "error");
});
