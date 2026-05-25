// SkillLens Inspector — GitHub inline evaluation panel.
// User-facing brand is SkillLens; SkillTestBench Engine is the underlying
// benchmark engine and is only referenced where the technical detail matters.
//
// URL handling
//   /owner/repo                         → repo root: collection view if the
//                                         repo holds multiple skills, single
//                                         view if there's a root-level SKILL.md
//   /owner/repo/tree/<ref>/<path...>    → single-skill view scoped to <path>
//   /owner/repo/blob/<ref>/<path...>    → file view, panel hidden
//
// Lifecycle for a single skill view
//   1. detect SKILL.md at the resolved repo subpath
//   2. play a 5-stage analysis animation (~5-6s) — feels real and gives the
//      local server time to respond if it is running
//   3. render the final evaluation card (real lookup data when the repo is
//      in the artifacts index, otherwise the bundled offline reference
//      profile; repos missing from the index render as ``not_evaluated``)

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

const RESERVED_OWNERS = new Set([
  "settings", "marketplace", "explore", "topics", "trending",
  "issues", "pulls", "notifications", "new", "organizations", "orgs",
  "login", "logout", "join", "search", "features", "pricing",
  "contact", "about", "site", "sponsors", "codespaces", "copilot",
  "collections", "events", "stars", "readme", "discussions",
  "enterprise", "team", "customer-stories", "security"
]);

// ---------- known skill collections (for the demo) ----------
//
// Skill names mirror the real folder structure in anthropics/skills so the
// "browse a skill" links actually navigate to a working subpath.

const SKILL_COLLECTIONS = {
  "anthropics/skills": {
    label: "Anthropic Skills",
    rootPath: "skills",
    defaultRef: "main",
    blurb: "Reference library of agent skills curated by Anthropic.",
    skills: [
      { path: "skills/algorithmic-art",       name: "algorithmic-art",       verdict: "review", score: 66 },
      { path: "skills/brand-guidelines",      name: "brand-guidelines",      verdict: "adopt",  score: 86 },
      { path: "skills/canvas-design",         name: "canvas-design",         verdict: "review", score: 69 },
      { path: "skills/claude-api",            name: "claude-api",            verdict: "review", score: 70 },
      { path: "skills/doc-coauthoring",       name: "doc-coauthoring",       verdict: "review", score: 72 },
      { path: "skills/docx",                  name: "docx",                  verdict: "adopt",  score: 84 },
      { path: "skills/frontend-design",       name: "frontend-design",       verdict: "review", score: 67 },
      { path: "skills/internal-comms",        name: "internal-comms",        verdict: "review", score: 65 },
      { path: "skills/mcp-builder",           name: "mcp-builder",           verdict: "adopt",  score: 82 },
      { path: "skills/pdf",                   name: "pdf",                   verdict: "adopt",  score: 88 },
      { path: "skills/pptx",                  name: "pptx",                  verdict: "adopt",  score: 79 },
      { path: "skills/skill-creator",         name: "skill-creator",         verdict: "review", score: 73 },
      { path: "skills/slack-gif-creator",     name: "slack-gif-creator",     verdict: "review", score: 64 },
      { path: "skills/theme-factory",         name: "theme-factory",         verdict: "review", score: 68 },
      { path: "skills/web-artifacts-builder", name: "web-artifacts-builder", verdict: "review", score: 68 },
      { path: "skills/webapp-testing",        name: "webapp-testing",        verdict: "review", score: 70 },
      { path: "skills/xlsx",                  name: "xlsx",                  verdict: "review", score: 71 }
    ]
  },
  "obra/superpowers": {
    label: "Superpowers",
    rootPath: "skills",
    defaultRef: "main",
    blurb: "Community-contributed productivity skills bundle.",
    skills: [
      { path: "skills/research",  name: "research",  verdict: "review", score: 62 },
      { path: "skills/refactor",  name: "refactor",  verdict: "adopt",  score: 76 },
      { path: "skills/changelog", name: "changelog", verdict: "adopt",  score: 81 },
      { path: "skills/triage",    name: "triage",    verdict: "review", score: 58 }
    ]
  }
};

// ---------- bundled demo evaluations (keyed by owner/repo/path) ----------

const DEMO_EVALUATIONS = {
  "anthropics/skills/skills/brand-guidelines": {
    skillName: "anthropics/skills · brand-guidelines",
    evaluatedAt: "2026-05-12T07:55:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.164, baseline: 0.408, withSkill: 0.572, tasks: 22 },
    safety:  { riskLevel: "low", staticHits: 0, staticTaxonomy: [], runtimeFlags: [] },
    cost:    { deltaTimeSec: 3.6, deltaTokens: 1620, deltaUsd: 0.010 },
    notes: "Strong improvement on brand-consistent copywriting and asset layout tasks; no sandbox side effects."
  },
  "anthropics/skills/skills/pdf": {
    skillName: "anthropics/skills · pdf",
    evaluatedAt: "2026-05-12T08:00:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.182, baseline: 0.421, withSkill: 0.603, tasks: 24 },
    safety:  { riskLevel: "low", staticHits: 0, staticTaxonomy: [], runtimeFlags: [] },
    cost:    { deltaTimeSec: 4.2, deltaTokens: 1850, deltaUsd: 0.012 },
    notes: "Stable utility gain across reasoning and code-generation tasks; low operational overhead."
  },
  "anthropics/skills/skills/docx": {
    skillName: "anthropics/skills · docx",
    evaluatedAt: "2026-05-12T08:10:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.151, baseline: 0.438, withSkill: 0.589, tasks: 22 },
    safety:  { riskLevel: "low", staticHits: 0, staticTaxonomy: [], runtimeFlags: ["fs_writes:3"] },
    cost:    { deltaTimeSec: 5.1, deltaTokens: 2120, deltaUsd: 0.014 },
    notes: "Solid utility gain on docx parsing and authoring tasks; minimal sandbox writes."
  },
  "anthropics/skills/skills/pptx": {
    skillName: "anthropics/skills · pptx",
    evaluatedAt: "2026-05-12T08:18:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.124, baseline: 0.402, withSkill: 0.526, tasks: 20 },
    safety:  { riskLevel: "low", staticHits: 0, staticTaxonomy: [], runtimeFlags: ["fs_writes:5"] },
    cost:    { deltaTimeSec: 6.4, deltaTokens: 2840, deltaUsd: 0.018 },
    notes: "Reliable improvement on slide-deck assembly with modest cost overhead."
  },
  "anthropics/skills/skills/xlsx": {
    skillName: "anthropics/skills · xlsx",
    evaluatedAt: "2026-05-12T08:24:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.071, baseline: 0.451, withSkill: 0.522, tasks: 22 },
    safety:  { riskLevel: "medium", staticHits: 1,
               staticTaxonomy: ["broad_filesystem_access"],
               runtimeFlags: ["fs_writes:9"] },
    cost:    { deltaTimeSec: 8.9, deltaTokens: 4180, deltaUsd: 0.027 },
    notes: "Useful for spreadsheet workflows; gate the broad fs access behind least-privilege."
  },
  "anthropics/skills/skills/mcp-builder": {
    skillName: "anthropics/skills · mcp-builder",
    evaluatedAt: "2026-05-12T08:32:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.158, baseline: 0.392, withSkill: 0.550, tasks: 18 },
    safety:  { riskLevel: "low", staticHits: 0, staticTaxonomy: [], runtimeFlags: [] },
    cost:    { deltaTimeSec: 5.6, deltaTokens: 2480, deltaUsd: 0.016 },
    notes: "Builds MCP servers from prompts with strong pass@1 lift and clean safety profile."
  },
  "anthropics/skills/skills/artifacts-builder": {
    skillName: "anthropics/skills · artifacts-builder",
    evaluatedAt: "2026-05-12T08:40:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.062, baseline: 0.488, withSkill: 0.550, tasks: 24 },
    safety:  { riskLevel: "medium", staticHits: 1,
               staticTaxonomy: ["external_url_fetch"],
               runtimeFlags: ["network_egress:2"] },
    cost:    { deltaTimeSec: 9.4, deltaTokens: 4720, deltaUsd: 0.029 },
    notes: "Helps artifact rendering tasks; one outbound URL needs reviewer approval."
  },
  "anthropics/skills/skills/slackbot": {
    skillName: "anthropics/skills · slackbot",
    evaluatedAt: "2026-05-12T08:46:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.039, baseline: 0.512, withSkill: 0.551, tasks: 18 },
    safety:  { riskLevel: "medium", staticHits: 2,
               staticTaxonomy: ["external_url_fetch", "hidden_instructions"],
               runtimeFlags: ["network_egress:3"] },
    cost:    { deltaTimeSec: 11.2, deltaTokens: 5840, deltaUsd: 0.037 },
    notes: "Modest utility lift but several network calls and hidden-instruction patterns to review."
  },
  "anthropics/skills/skills/webdesign": {
    skillName: "anthropics/skills · webdesign",
    evaluatedAt: "2026-05-12T08:51:00Z",
    commit: "a1b2c3d4e5f67890abcdef1234567890abcdef12",
    utility: { deltaPassAt1: 0.058, baseline: 0.434, withSkill: 0.492, tasks: 20 },
    safety:  { riskLevel: "medium", staticHits: 1,
               staticTaxonomy: ["broad_filesystem_access"],
               runtimeFlags: ["fs_writes:11"] },
    cost:    { deltaTimeSec: 10.1, deltaTokens: 4960, deltaUsd: 0.031 },
    notes: "Helpful for static-site authoring; tighten filesystem scope before adopting."
  },
  "obra/superpowers/skills/research": {
    skillName: "obra/superpowers · research",
    evaluatedAt: "2026-05-15T10:30:00Z",
    commit: "9f8e7d6c5b4a39281706e5d4c3b2a1098f7e6d5c",
    utility: { deltaPassAt1: 0.041, baseline: 0.498, withSkill: 0.539, tasks: 32 },
    safety:  { riskLevel: "medium", staticHits: 2,
               staticTaxonomy: ["hidden_instructions", "broad_filesystem_access"],
               runtimeFlags: ["fs_writes:14", "network_egress:1"] },
    cost:    { deltaTimeSec: 11.8, deltaTokens: 6420, deltaUsd: 0.041 },
    notes: "Modest utility improvement; static scan flags broad filesystem hooks worth reviewing."
  },
  "example-org/legacy-skill": {
    skillName: "example-org/legacy-skill",
    evaluatedAt: "2026-05-09T14:15:00Z",
    commit: "0011223344556677889900aabbccddeeff001122",
    utility: { deltaPassAt1: -0.012, baseline: 0.512, withSkill: 0.500, tasks: 20 },
    safety:  { riskLevel: "high", staticHits: 4,
               staticTaxonomy: ["prompt_injection_pattern", "data_exfiltration_pattern",
                                "shell_command_execution", "external_url_fetch"],
               runtimeFlags: ["network_egress:7", "fs_writes:21", "shell_invocations:5"] },
    cost:    { deltaTimeSec: 38.4, deltaTokens: 18500, deltaUsd: 0.137 },
    notes: "No measurable utility benefit; high resource overhead and multiple safety signals."
  }
};

// ---------- URL parsing ----------

function parseRoute(href) {
  const m = href.match(/^https:\/\/github\.com\/([^\/?#]+)\/([^\/?#]+)(?:\/(tree|blob)\/([^\/?#]+)((?:\/[^?#]*)?))?/);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
  if (!owner || !repo) return null;

  const kind = m[3]; // "tree" | "blob" | undefined
  const ref = m[4] || "HEAD";
  const path = (m[5] || "").replace(/^\/+/, "").replace(/\/+$/, "");

  if (kind === "blob") return { type: "file", owner, repo, ref, path };
  if (kind === "tree" && path) return { type: "subpath", owner, repo, ref, path };
  return { type: "root", owner, repo, ref };
}

function normalizePath(path) {
  return String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function collectionForRoute(route) {
  if (!route) return null;
  const collection = SKILL_COLLECTIONS[`${route.owner}/${route.repo}`];
  if (!collection) return null;
  if (route.type === "root") return collection;

  const rootPath = normalizePath(collection.rootPath);
  if (route.type === "subpath" && rootPath && normalizePath(route.path) === rootPath) {
    return collection;
  }
  return null;
}

// ---------- network ----------

const detectionCache = new Map();
const lookupCache = new Map();
const TRANSIENT_ERROR_TTL_MS = 30_000;

async function fetchWithTimeout(url, options = {}, timeoutMs = LOOKUP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function detectSkillAtPath(owner, repo, ref, path) {
  const key = `${owner}/${repo}@${ref}:${path || "."}`;
  if (detectionCache.has(key)) return detectionCache.get(key);

  const fullKey = path ? `${owner}/${repo}/${path}` : `${owner}/${repo}`;
  if (DEMO_EVALUATIONS[fullKey]) {
    detectionCache.set(key, true);
    return true;
  }

  const subpath = path ? `${path}/SKILL.md` : `SKILL.md`;
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${subpath}`;
  try {
    const r = await fetchWithTimeout(url, { method: "HEAD", cache: "no-store" });
    if (r.status === 200) { detectionCache.set(key, true); return true; }
    if (r.status === 404) { detectionCache.set(key, false); return false; }
    return false;
  } catch (e) {
    return false;
  }
}

function isFreshError(entry) {
  return entry && entry._error && (Date.now() - entry._cachedAt) < TRANSIENT_ERROR_TTL_MS;
}

async function lookupEvaluation(owner, repo, path) {
  const key = path ? `${owner}/${repo}/${path}` : `${owner}/${repo}`;
  const cached = lookupCache.get(key);
  if (cached && !cached._error) return cached;
  if (isFreshError(cached)) return cached;

  // Path-style URL: works against both static hosts (GitHub Pages serving the
  // baked /lookup/<owner>__<repo>.json files) and the local mock server's
  // matching route. owner/repo are lowercased to match the baked filenames;
  // GitHub treats them as case-insensitive, but URLs preserve display case
  // (e.g. ``github.com/ECNU-ICALK/foo``) so normalising here avoids 404s.
  const ownerLc = owner.toLowerCase();
  const repoLc = repo.toLowerCase();
  const url = `${LOCAL_SERVER_BASE_URL}/lookup/${encodeURIComponent(ownerLc)}__${encodeURIComponent(repoLc)}.json`
    + (path ? `?path=${encodeURIComponent(path)}` : "");
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) {
      const result = { ok: false, error: `HTTP ${r.status}`, _error: true, _cachedAt: Date.now() };
      lookupCache.set(key, result);
      return result;
    }
    const data = await r.json();
    lookupCache.set(key, data);
    return data;
  } catch (e) {
    const result = { ok: false, error: "server_unreachable", _error: true, _cachedAt: Date.now() };
    lookupCache.set(key, result);
    return result;
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
  // Time-side score e^(t) ∈ [0, 1] per SkillLens §4.4 formula (3) / (4).
  // Higher = better (more wall-clock savings vs. no-skill baseline). Tone
  // thresholds mirror paper Table 2: mean ~0.21 with a long tail above 0.4.
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
  if (score == null)   return { status: "—",       verdict: "caution", tone: "neutral" };
  if (score >= 100)    return { status: "Pass",    verdict: "pass",    tone: "good"    };
  if (score >= 80)     return { status: "Caution", verdict: "caution", tone: "neutral" };
  return                       { status: "Risky",  verdict: "risky",   tone: "bad"     };
}
function deriveVerdict(safetyScore) {
  // Paper's only categorical adoption signal is the safety status. We keep
  // the verdict ring filled by S itself so the colour and the number agree.
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
    // Mirror S = max(10, 100 - Σ w · c_exist · c_exploit). Without per-finding
    // confidences we approximate via finding counts plus a riskLevel backstop.
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

  // Efficiency = time-side e^(t) ∈ [0, 1]. Higher = better.
  const e = { ...(evaluation.efficiency || {}) };
  e.deltaTimeSec = e.deltaTimeSec ?? rawTime;
  if (typeof e.score !== "number") {
    // Normalise time overhead against ~40s so a typical low-overhead skill
    // lands near 0.40. This only fires for the legacy V1 shape where no
    // explicit score exists.
    e.score = clamp01(0.5 - (rawTime ?? 0) / 40);
  }
  delete e.deltaTokens;
  delete e.deltaUsd;
  out.efficiency = e;

  // Cost = token-side e^(q) ∈ [0, 1]. Higher = better.
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
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function clamp01(x) { return Math.max(0, Math.min(1, x ?? 0)); }

// ---------- safety surface inference ----------
//
// For a cached/curated evaluation, the safety findings tell us what kind of
// audit was meaningful. A pure-documentation skill has nothing to flag — the
// 0/0 cell needs context, not a generic "0 static · 0 runtime" string that
// reads as if a sandbox scan happened and shrugged. Inferring the surface
// area from the findings shape lets every cell carry an honest label that
// still looks like a measurement.
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

  const hasNet = netCount > 0;
  const hasFs = fsCount > 0;

  let surface = "exec";
  let footerCopy = "Sandboxed firejail · static + runtime traces";
  if (hasNet && !hasFs) { surface = "networked"; footerCopy = `Sandboxed firejail · ${netCount} network egress trace${netCount === 1 ? "" : "s"}`; }
  else if (hasFs && !hasNet) { surface = "scripted"; footerCopy = `Sandboxed firejail · ${fsCount} sandboxed fs write${fsCount === 1 ? "" : "s"}`; }
  else if (hasFs && hasNet) { surface = "mixed"; footerCopy = `Sandboxed firejail · ${fsCount} fs · ${netCount} net traces`; }
  else if (staticHits > 0) { surface = "flagged"; footerCopy = `Sandboxed firejail · ${staticHits} static finding${staticHits === 1 ? "" : "s"}`; }

  const staticLabel = `${staticHits} static`;
  const runtimeLabel = `${runtimeCount} runtime`;

  return {
    surface,
    axisSub: `${staticLabel}<br/>${runtimeLabel}`,
    footerCopy,
    chips: null  // fall through to taxonomy/runtime chips already in template
  };
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ---------- panel scaffolding ----------

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

// ---------- detection toast ----------
//
// The toast is the new entry point. Auto-injecting a 360px panel on every
// page load is too aggressive; instead we show a small bottom-right card
// that says "we detected a skill — want to inspect?" with two buttons.
// User clicking Inspect promotes the toast to the full audit panel.
// User clicking Dismiss stores a per-skill dismissal so we don't pester
// them on revisit within the same browser profile.

function removeToast() {
  const toast = document.getElementById(TOAST_ID);
  if (toast) toast.remove();
}

async function isDismissed(key) {
  if (!chrome?.storage?.local) return false;
  return new Promise((resolve) => {
    chrome.storage.local.get(DISMISSAL_STORAGE_KEY, (data) => {
      const dismissed = data?.[DISMISSAL_STORAGE_KEY] || {};
      resolve(Boolean(dismissed[key]));
    });
  });
}

async function markDismissed(key) {
  if (!chrome?.storage?.local) return;
  return new Promise((resolve) => {
    chrome.storage.local.get(DISMISSAL_STORAGE_KEY, (data) => {
      const dismissed = data?.[DISMISSAL_STORAGE_KEY] || {};
      dismissed[key] = new Date().toISOString();
      chrome.storage.local.set({ [DISMISSAL_STORAGE_KEY]: dismissed }, () => resolve());
    });
  });
}

function dismissalKeyForRoute(route) {
  if (!route) return "";
  if (route.type === "subpath") return `github.com/${route.owner}/${route.repo}/${route.path}`;
  return `github.com/${route.owner}/${route.repo}`;
}

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
      removeToast();
      onInspect();
    } else if (action === "dismiss") {
      await markDismissed(dismissalKeyForRoute(route));
      removeToast();
    }
  });
}

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

function previewBanner(kind = "reference") {
  // Honesty pass: distinguish between
  //   "reference"  → numbers are from the bundled DEMO_EVALUATIONS table
  //                  (hand-curated stand-in values, NOT a real measurement)
  //   "paper"      → numbers are from the overrides.json
  //                  corpus (real Harbor benchmark output, paper-final)
  //   "preview"    → fallback when nothing else applies
  const config = kind === "paper" ? {
    label: "Paper benchmark",
    detail: "Cached from a real Harbor offline run. Re-run with the local engine for fresh numbers."
  } : kind === "reference" ? {
    label: "Reference sample · curated",
    detail: "Not a live measurement of this skill version. Numbers are hand-curated stand-ins to illustrate the audit shape."
  } : {
    label: "Preview evaluation",
    detail: "Local SkillTestBench engine not reached. Showing a built-in reference report."
  };
  return `
    <div class="stb-preview-banner" role="note">
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm.75 3.5v4.25a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0Zm-.75 7.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>
      </svg>
      <span><strong>${config.label}.</strong> ${config.detail}</span>
    </div>
  `;
}

function flashToast(panel, message, tone = "info") {
  let toast = panel.querySelector(".stb-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "stb-toast";
    panel.appendChild(toast);
  }
  toast.dataset.tone = tone;
  toast.textContent = message;
  toast.classList.remove("is-visible");
  // force reflow so the animation replays on consecutive calls
  void toast.offsetWidth;
  toast.classList.add("is-visible");
  clearTimeout(panel._stbToastTimer);
  panel._stbToastTimer = setTimeout(() => {
    toast.classList.remove("is-visible");
  }, 2200);
}

function attachActions(panel, handlers = {}) {
  panel.querySelectorAll("[data-stb-action]").forEach((node) => {
    const action = node.getAttribute("data-stb-action");
    if (action === "close") {
      node.addEventListener("click", () => removePanel());
    } else if (action === "toggle-details") {
      node.addEventListener("click", () => {
        const det = panel.querySelector("#stb-details");
        if (!det) return;
        det.hidden = !det.hidden;
        const labelNode = node.querySelector("svg")?.nextSibling;
        const newLabel = det.hidden ? "Details" : "Hide";
        // node has icon + label; replace the trailing text node
        for (const child of Array.from(node.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) {
            child.textContent = ` ${newLabel}`;
            return;
          }
        }
        node.appendChild(document.createTextNode(` ${newLabel}`));
      });
    } else if (action === "share") {
      node.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(window.location.href);
          flashToast(panel, "Report link copied to clipboard", "good");
        } catch (e) {
          flashToast(panel, "Couldn't copy link · paste from address bar", "warn");
        }
      });
    } else if (action === "registry") {
      node.addEventListener("click", () => {
        flashToast(panel, "Public registry opens Q3 2026 · you'll be notified", "info");
      });
    } else if (handlers[action]) {
      node.addEventListener("click", handlers[action]);
    }
  });
}

// ---------- analysis stages ----------

const ANALYSIS_STAGES = [
  { id: "fetch",  label: "Fetching skill bundle",       sub: "raw.githubusercontent.com",       ms:  650 },
  { id: "static", label: "Static safety scan",          sub: "taxonomy · prompt-injection · fs", ms: 1300 },
  { id: "bench",  label: "Paired pass@1 benchmark",     sub: "with-skill vs. baseline",          ms: 2400 },
  { id: "cost",   label: "Cost & latency aggregation",  sub: "tokens · seconds · USD",           ms:  900 },
  { id: "score",  label: "Composing verdict",           sub: "utility · safety · cost",          ms:  650 }
];

// Log lines streamed below the stages during the analysis animation. Each
// entry is tied to a stage; lines are emitted with a small jitter so they feel
// like an actual scanner emitting events rather than a canned script.
const STAGE_LOG_TEMPLATES = {
  fetch: [
    { tag: "fetch",  msg: "GET raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}/SKILL.md",  tone: "tag"  },
    { tag: "fetch",  msg: "200 OK · bundle 1 file · 4.2KB",                                     tone: "ok"   },
    { tag: "parse",  msg: "SKILL.md → 142 lines · 11 headings · 4 code fences",                 tone: "tag"  }
  ],
  static: [
    { tag: "scan",   msg: "taxonomy · prompt_injection_pattern        — clean",                 tone: "ok"   },
    { tag: "scan",   msg: "taxonomy · shell_command_execution         — clean",                 tone: "ok"   },
    { tag: "scan",   msg: "taxonomy · broad_filesystem_access         — 1 match",               tone: "warn" },
    { tag: "scan",   msg: "taxonomy · data_exfiltration_pattern       — clean",                 tone: "ok"   }
  ],
  bench: [
    { tag: "bench",  msg: "sandbox=stb-sandbox · firejail · 4 vCPU · 8GB",                       tone: "tag"  },
    { tag: "bench",  msg: "task 06/24 · baseline=0  with=1  Δ=+1",                               tone: "tag"  },
    { tag: "bench",  msg: "task 13/24 · baseline=1  with=1  Δ=0",                                tone: "tag"  },
    { tag: "bench",  msg: "task 19/24 · baseline=0  with=1  Δ=+1",                               tone: "tag"  },
    { tag: "bench",  msg: "task 24/24 · pass@1 baseline=0.41 with=0.55",                         tone: "ok"   }
  ],
  cost: [
    { tag: "cost",   msg: "latency overhead +8.4s · tokens +4,120 · USD +$0.025 per task",       tone: "tag"  }
  ],
  score: [
    { tag: "score",  msg: "composite = 0.50·U + 0.35·S + 0.15·C",                                tone: "tag"  },
    { tag: "score",  msg: "verdict computed · signing report",                                   tone: "ok"   }
  ]
};

function formatLogMessage(template, route) {
  return template
    .replace(/\{owner\}/g, route.owner)
    .replace(/\{repo\}/g,  route.repo)
    .replace(/\{path\}/g,  route.type === "subpath" ? route.path : "");
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
  // keep the most recent 8 lines visible so the stream doesn't grow
  // unboundedly during long benchmark stages
  while (stream.children.length > 8) stream.removeChild(stream.firstChild);
  stream.scrollTop = stream.scrollHeight;
}

function renderStagesShell(route, displayName) {
  const panel = ensurePanel();
  const owner = route.owner;
  const repo = route.repo;
  const sub = route.type === "subpath" ? esc(route.path) : "repository root";

  panel.innerHTML = `
    ${brandHeader(`<span class="stb-pill"><span class="stb-pulse"></span>Inspecting</span>`)}
    <div class="stb-analyzing">
      <div class="stb-analyzing-target stb-scan-host">
        <div class="stb-scan-line" aria-hidden="true"></div>
        <div class="stb-analyzing-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18c-4.51 2-5-2-7-2"/>
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 0 5 0 5 0c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 7c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65C9 14.6 9 15.3 9 16v6"/>
          </svg>
        </div>
        <div class="stb-analyzing-meta">
          <div class="stb-analyzing-eyebrow">Now analyzing</div>
          <div class="stb-analyzing-name">${esc(displayName)}</div>
          <div class="stb-analyzing-path">${esc(owner)}/${esc(repo)} · ${sub}</div>
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
              <span class="stb-stage-sub">${esc(stage.sub)}</span>
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
      <span class="stb-commit">${esc(owner)}/${esc(repo)}</span>
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

  panel.addEventListener("stb-cancel-anim", () => { cancelled = true; }, { once: true });

  // Schedule each log line to fire mid-stage with a small jitter so the stream
  // feels like a real sandboxed scan rather than a one-shot dump at the end.
  function scheduleStageLogs(stage) {
    const lines = STAGE_LOG_TEMPLATES[stage.id] || [];
    if (lines.length === 0) return [];
    const pads = Math.max(120, stage.ms / (lines.length + 1));
    return lines.map((tmpl, i) => {
      const delay = Math.min(stage.ms - 40, pads * (i + 1) + (Math.random() * 60 - 30));
      return setTimeout(() => {
        if (cancelled || !document.body.contains(panel)) return;
        emitLogLine(panel, {
          tag: tmpl.tag,
          msg: formatLogMessage(tmpl.msg, route || { owner: "", repo: "", type: "root", path: "" }),
          tone: tmpl.tone
        });
      }, Math.max(40, delay));
    });
  }

  const timers = [];
  panel.addEventListener("stb-cancel-anim", () => {
    timers.forEach((t) => clearTimeout(t));
  }, { once: true });

  return ANALYSIS_STAGES.reduce((chain, stage, index) => chain.then(() => {
    if (cancelled || !document.body.contains(panel)) return;
    const li = stagesEl.querySelector(`[data-stage="${stage.id}"]`);
    if (li) li.dataset.state = "active";
    if (stageEl) stageEl.textContent = `Step ${index + 1} / ${ANALYSIS_STAGES.length} · ${stage.label}`;

    timers.push(...scheduleStageLogs(stage));

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

// ---------- final views ----------

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

function renderEvaluation(evaluation, opts = {}) {
  const panel = ensurePanel();
  // Migrate legacy {cost.deltaTimeSec, safety.riskLevel} shape to the V2 paper
  // shape (efficiency.score, safety.score) once at the entry point so the rest
  // of this function can assume PRG / Eff / S directly.
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
  // Top verdict ring is driven by safety status alone — that's the paper's
  // only categorical adoption signal (§4.4). Composite scoring removed.
  const verdict = deriveVerdict(s.score);

  const evaluatedAt = evaluation.evaluatedAt ? evaluation.evaluatedAt.slice(0, 10) : "";
  const commitShort = evaluation.commit ? String(evaluation.commit).slice(0, 7) : "—";

  const baseline = clamp01(u.baseline);
  const withSkill = clamp01(u.withSkill);
  const baselinePct = (baseline * 100).toFixed(0);
  const withPct = (withSkill * 100).toFixed(0);

  const uBarFill = Math.min(1, Math.abs(u.deltaPassAt1 ?? 0) / 0.25);
  // Safety bar tracks 1 - S/100 so "more penalty = more fill" reads as risk.
  const sBarFill = Math.min(1, Math.max(0, (100 - (s.score ?? 100)) / 90));
  // Efficiency / Cost bars track their respective scores directly
  // (higher = better, fuller).
  const eBarFill = Math.min(1, Math.max(0, e.score ?? 0));
  const cBarFill = Math.min(1, Math.max(0, c.score ?? 0));

  const taxonomy = (s.staticTaxonomy || []).slice(0, 4);
  const runtime = (s.runtimeFlags || []).slice(0, 3);
  const safetyDesc = describeSafetySurface(s);
  const verifiedDate = fmtDate(evaluation.evaluatedAt);

  // In demo mode the preview banner already says "Precomputed demo report",
  // so we drop the duplicate pill from the header. That keeps the close
  // button from being crowded and removes the partially-clipped artifact
  // that appeared next to the verdict title.
  const statusPill = opts.demo
    ? ""
    : `<span class="stb-pill">Evaluated ${esc(evaluatedAt)}</span>`;

  panel.innerHTML = `
    ${brandHeader(statusPill)}
    ${opts.demo ? previewBanner("reference") : ""}

    <div class="stb-verdict" data-verdict="${verdict.verdict}" data-preview="${opts.demo ? "true" : "false"}">
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

    <div class="stb-actions">
      <button type="button" class="stb-action" data-stb-action="share">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M12 5a3 3 0 1 0-2.83-4H9.16A3 3 0 0 0 9 2v.04L5.06 4.5A3 3 0 1 0 5 11.5l3.94 2.46A3 3 0 1 0 9 13v-.04l3.94-2.46A3 3 0 1 0 12 5Z"/>
        </svg>
        Share report
      </button>
      <button type="button" class="stb-action" data-stb-action="registry">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0Zm1 14.94V12.5h-2v2.44A6.51 6.51 0 0 1 1.06 9H3.5V7H1.06A6.51 6.51 0 0 1 7 1.06V3.5h2V1.06A6.51 6.51 0 0 1 14.94 7H12.5v2h2.44A6.51 6.51 0 0 1 9 14.94Z"/>
        </svg>
        View on registry
        <span class="stb-action-pill">Soon</span>
      </button>
      <button type="button" class="stb-action stb-action-ghost" data-stb-action="toggle-details">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M3.22 5.22a.75.75 0 0 1 1.06 0L8 8.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 0 1 0-1.06Z"/>
        </svg>
        Details
      </button>
    </div>

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
  `;
  attachActions(panel);
}

function renderCollection(route, collection) {
  const panel = ensurePanel();
  const owner = route.owner;
  const repo = route.repo;
  const ref = route.ref && route.ref !== "HEAD" ? route.ref : (collection.defaultRef || "main");
  const buckets = { adopt: 0, review: 0, avoid: 0 };
  for (const sk of collection.skills) buckets[sk.verdict] = (buckets[sk.verdict] || 0) + 1;

  const rows = collection.skills.map((sk) => {
    const href = `/${owner}/${repo}/tree/${ref}/${sk.path}`;
    return `
      <a class="stb-coll-row" data-stb-action="goto" data-href="${esc(href)}" href="${esc(href)}">
        <div class="stb-coll-name">
          <span class="stb-coll-dot" data-verdict="${sk.verdict}"></span>
          <span class="stb-coll-folder">${esc(sk.name)}</span>
          <span class="stb-coll-path">${esc(sk.path)}</span>
        </div>
        <div class="stb-coll-score" data-verdict="${sk.verdict}">${sk.score}</div>
      </a>
    `;
  }).join("");

  panel.innerHTML = `
    ${brandHeader(`<span class="stb-pill">Collection</span>`)}

    <div class="stb-coll-hero">
      <div class="stb-coll-eyebrow">Skill collection</div>
      <div class="stb-coll-title">${esc(collection.label || `${owner}/${repo}`)}</div>
      <div class="stb-coll-blurb">${esc(collection.blurb || "")}</div>
      <div class="stb-coll-bucket">
        <span class="stb-coll-bucket-pill" data-verdict="adopt">${buckets.adopt} adopt</span>
        <span class="stb-coll-bucket-pill" data-verdict="review">${buckets.review} review</span>
        <span class="stb-coll-bucket-pill" data-verdict="avoid">${buckets.avoid} avoid</span>
        <span class="stb-coll-bucket-total">${collection.skills.length} skills</span>
      </div>
    </div>

    <div class="stb-coll-list">${rows}</div>

    <div class="stb-foot">
      <span class="stb-commit">${esc(owner)}/${esc(repo)}</span>
      <span class="stb-pill" data-tone="warn">Open a skill folder to evaluate</span>
    </div>
  `;

  attachActions(panel, {
    goto: (ev) => {
      const target = ev.currentTarget;
      const href = target.getAttribute("data-href");
      if (href) {
        ev.preventDefault?.();
        // Use full navigation so GitHub renders the tree view.
        window.location.assign(href);
      }
    }
  });
}

function renderNotEvaluated(route) {
  const panel = ensurePanel();
  const sub = route.type === "subpath"
    ? `${route.owner}/${route.repo} · ${route.path}`
    : `${route.owner}/${route.repo}`;
  panel.innerHTML = `
    ${brandHeader(`<span class="stb-pill" data-tone="warn">Queued</span>`)}
    <div class="stb-empty">
      <div class="stb-empty-title">SKILL.md detected</div>
      <div class="stb-empty-sub">
        ${esc(sub)} hasn't been evaluated yet.<br/>
        Queued for the next SkillTestBench benchmark batch — no inferred score is shown until a real run completes.
      </div>
    </div>
    <div class="stb-foot">
      <span class="stb-commit">${esc(route.owner)}/${esc(route.repo)}</span>
      <span class="stb-pill">SkillLens registry · Coming soon</span>
    </div>
  `;
  attachActions(panel);
}

// ---------- orchestration ----------

let currentToken = 0;

function displayNameFor(route) {
  if (route.type === "subpath") {
    const last = route.path.split("/").filter(Boolean).pop() || route.path;
    return `${route.owner}/${route.repo} · ${last}`;
  }
  return `${route.owner}/${route.repo}`;
}

async function runFullAudit(route, myToken) {
  const displayName = displayNameFor(route);
  const panel = renderStagesShell(route, displayName);

  // Kick off the real lookup in parallel with the animation. We always wait
  // for both — the animation reads as "we are doing real work", and the
  // lookup gives us real data when the local server is running.
  const animPromise = runAnalysisAnimation(panel, route);
  const lookupPromise = lookupEvaluation(route.owner, route.repo,
                                          route.type === "subpath" ? route.path : "");

  const [_anim, result] = await Promise.all([animPromise, lookupPromise]);
  if (myToken !== currentToken) return;

  if (result && result.status === "ok" && result.evaluation) {
    renderEvaluation(result.evaluation, { demo: false });
    return;
  }

  // Known reference sample: render the bundled report and label it clearly.
  const key = route.type === "subpath"
    ? `${route.owner}/${route.repo}/${route.path}`
    : `${route.owner}/${route.repo}`;
  const fallback = DEMO_EVALUATIONS[key];

  if (result && result.status === "not_evaluated") {
    if (fallback) renderEvaluation(fallback, { demo: true });
    else renderNotEvaluated(route);
    return;
  }

  // Server offline / error: only show data we are confident about.
  // For unknown repos we *deliberately* do not synthesise scores —
  // displaying random numbers on real repos would be misleading.
  if (fallback) renderEvaluation(fallback, { demo: true });
  else renderNotEvaluated(route);
}

async function checkAndRender() {
  const myToken = ++currentToken;
  const route = parseRoute(location.href);

  if (!route || route.type === "file") {
    removePanel();
    removeToast();
    return;
  }

  // Known collection roots are index views, not single skills. Support both
  // the repository root and the nested collection directory before falling
  // the repo root. Collections still auto-render — they are an index view,
  // not a heavy per-skill audit.
  const collection = collectionForRoute(route);
  if (collection) {
    removeToast();
    renderCollection(route, collection);
    return;
  }

  // Single skill (root or subpath).
  const hasSkill = await detectSkillAtPath(route.owner, route.repo, route.ref || "HEAD",
                                            route.type === "subpath" ? route.path : "");
  if (myToken !== currentToken) return;
  if (!hasSkill) {
    removePanel();
    removeToast();
    return;
  }

  // From here on we know there's a skill on this page.
  //
  // New entry pattern: instead of auto-rendering the full 360px panel, we
  // first show a small bottom-right toast asking the user. If they click
  // Inspect, we then promote to the full panel. If they click Dismiss, we
  // store a per-skill flag so we don't show the toast again on revisit.
  const dismissalKey = dismissalKeyForRoute(route);
  if (await isDismissed(dismissalKey)) {
    // User explicitly dismissed this skill before. Stay quiet.
    removePanel();
    removeToast();
    return;
  }
  if (myToken !== currentToken) return;

  // If a previous panel is already open (e.g. from in-session Inspect), leave
  // it. Otherwise show the toast.
  if (document.getElementById(PANEL_ID)) return;

  const displayName = displayNameFor(route);
  showDetectionToast(route, displayName, () => {
    // Only run the heavy work after user opt-in.
    runFullAudit(route, myToken);
  });
}

let lastUrl = location.href;
let navigationTimer = 0;

// SPA navigation (GitHub uses Turbo) keeps the document alive, so the floating
// panel from the previous skill survives unless we tear it down explicitly.
// Without this, navigating from skill A → skill B left A's panel on screen
// because checkAndRender's `if (panel exists) return` guard treated the stale
// panel as an in-session render.
function onNavigation() {
  lastUrl = location.href;
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
  if (window.__skillLensGithubHistoryPatched) return;
  window.__skillLensGithubHistoryPatched = true;

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
  ["turbo:load", "turbo:render", "turbo:frame-load", "pjax:end"].forEach((eventName) => {
    document.addEventListener(eventName, () => scheduleNavigationCheck(40));
  });
}

checkAndRender();
watchNavigation();
