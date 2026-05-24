const PAPER_HREF = "";

const state = {
  examplesDir: "",
  dashboard: null,
  selectedSkillName: "",
  searchTerm: "",
  scannerFindings: {},     // { [skillName]: payload | "loading" | "error" }
};

function el(id) {
  return document.getElementById(id);
}

function formatNumber(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return `${formatNumber(Number(value) * 100, 1)}%`;
}

function formatSignedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  const numeric = Number(value) * 100;
  if (Math.abs(numeric) < 0.05) return "0pp";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${formatNumber(numeric, 1)}pp`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
    return "-";
  }
  const total = Math.round(Number(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m ${secs}s`;
  }
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatSignedDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) {
    return "-";
  }
  const numeric = Number(seconds);
  if (Math.abs(numeric) < 0.5) return "0s";
  const sign = numeric > 0 ? "+" : "−";
  return `${sign}${formatDuration(Math.abs(numeric))}`;
}

function formatSignedTokens(tokens) {
  if (tokens === null || tokens === undefined || Number.isNaN(Number(tokens))) {
    return "-";
  }
  const numeric = Number(tokens);
  if (numeric === 0) return "0";
  const sign = numeric > 0 ? "+" : "−";
  return `${sign}${formatNumber(Math.abs(numeric))}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function buildQuery(basePath, params) {
  const url = new URL(basePath, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function withExamplesDir(path, extra = {}) {
  const url = new URL(path, window.location.origin);
  if (state.examplesDir) {
    url.searchParams.set("examplesDir", state.examplesDir);
  }
  Object.entries(extra).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return `${url.pathname}${url.search}`;
}

function updateStatus(label, tone) {
  const pill = el("status-pill");
  pill.textContent = label;
  pill.dataset.tone = tone;
}

function applyStaticLinks() {
  const paperLink = el("paper-nav");
  if (paperLink && PAPER_HREF) {
    paperLink.href = PAPER_HREF;
    paperLink.removeAttribute("aria-disabled");
    if (/^https?:\/\//i.test(PAPER_HREF)) {
      paperLink.target = "_blank";
      paperLink.rel = "noreferrer";
    }
  }

  document.querySelectorAll('a[href="/examples"]').forEach((node) => {
    node.href = withExamplesDir("/examples");
  });
  document.querySelectorAll('a[href="/examples/skills"]').forEach((node) => {
    node.href = withExamplesDir("/examples/skills");
  });
}

function syncSelectedSkillToUrl() {
  const url = new URL(window.location.href);
  if (state.examplesDir) {
    url.searchParams.set("examplesDir", state.examplesDir);
  } else {
    url.searchParams.delete("examplesDir");
  }
  if (state.selectedSkillName) {
    url.searchParams.set("skill", state.selectedSkillName);
  } else {
    url.searchParams.delete("skill");
  }
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

function getVisibleExamples() {
  const examples = state.dashboard?.examples || [];
  if (!state.searchTerm) {
    return examples;
  }
  return examples.filter((item) => {
    const haystack = [
      item.skillName,
      item.owner,
      item.category,
      item.categoryLabel,
      ...(item.taskUtilityType?.items || []).map((entry) => entry.label),
    ].join(" ").toLowerCase();
    return haystack.includes(state.searchTerm);
  });
}

function renderOverview(dashboard) {
  const root = dashboard?.root || {};
  document.title = `SkillTestBench - ${root.nExamples || 0} Skills`;
}

// ---------- Utility / Cost / Safety derivations ----------

function utilityVerdict(example) {
  const eff = example.effectiveness || {};
  const wi = Number(eff.wiPassRate ?? 0);
  const wo = Number(eff.woPassRate ?? 0);
  const delta = wi - wo;
  const ceilingFlag = Math.abs(wi - 1) < 1e-6 && Math.abs(wo - 1) < 1e-6;
  const tieFlag = Math.abs(delta) < 1e-6;

  // uplift_score per methodology: clamp((wi - wo) / max(1 - wo, eps), 0, 1)
  const denom = Math.max(1 - wo, 1e-6);
  const uplift = Math.max(0, Math.min(1, delta / denom));

  let tone = "tie";
  let label = "Tied";
  if (delta > 1e-6) {
    tone = "positive";
    label = "Skill helps";
  } else if (delta < -1e-6) {
    tone = "negative";
    label = "Skill hurts";
  } else if (ceilingFlag) {
    tone = "ceiling";
    label = "Ceiling";
  }

  return { wi, wo, delta, uplift, ceilingFlag, tieFlag, tone, label };
}

function costVerdict(example) {
  const time = example.executionTime || {};
  const tokens = example.costApiUsage || {};
  const wiTime = Number(time.wiSeconds ?? 0);
  const woTime = Number(time.woSeconds ?? 0);
  const dt = wiTime - woTime;

  const wiTokenTotal = Number(tokens.wiTokens?.total ?? 0);
  const woTokenTotal = Number(tokens.woTokens?.total ?? 0);
  const wiInput = Number(tokens.wiTokens?.input ?? 0);
  const woInput = Number(tokens.woTokens?.input ?? 0);
  const wiCache = Number(tokens.wiTokens?.cache ?? 0);
  const woCache = Number(tokens.woTokens?.cache ?? 0);
  const wiEff = Math.max(wiInput - wiCache, 0);
  const woEff = Math.max(woInput - woCache, 0);
  const dEff = wiEff - woEff;

  return {
    wiTime,
    woTime,
    deltaTime: dt,
    wiTokenTotal,
    woTokenTotal,
    deltaTokens: wiTokenTotal - woTokenTotal,
    wiEff,
    woEff,
    deltaEff: dEff,
    saves: dt < 0 && dEff < 0,
    overheads: dt > 0 && dEff > 0,
  };
}

function safetyVerdict(example, scannerPayload) {
  if (scannerPayload && scannerPayload !== "loading" && scannerPayload !== "error" && scannerPayload.found) {
    const score = Number(scannerPayload.securityScore ?? 100);
    const sev = scannerPayload.severityCounts || { H: 0, M: 0, L: 0 };
    const high = Number(sev.H || 0);
    const med = Number(sev.M || 0);
    if (high >= 3 || score < 60) {
      return { tone: "danger", label: `${high}H · ${med}M · score ${score.toFixed(0)}`, score };
    }
    if (high > 0 || score < 80) {
      return { tone: "warn", label: `${high}H · ${med}M · score ${score.toFixed(0)}`, score };
    }
    return { tone: "ok", label: `Clean · score ${score.toFixed(0)}`, score };
  }
  // fallback while loading or scanner data unavailable
  const reliability = example.reliabilityError || {};
  const exceptions = Number(reliability.wiExceptionScenarios ?? 0) + Number(reliability.woExceptionScenarios ?? 0);
  if (exceptions === 0) {
    return { tone: "ok", label: "Awaiting scanner data", exceptions };
  }
  if (exceptions <= 1) {
    return { tone: "warn", label: `${exceptions} runtime exception`, exceptions };
  }
  return { tone: "danger", label: `${exceptions} runtime exceptions`, exceptions };
}

function recommendation(utility, cost, safety) {
  if (safety.tone === "danger") {
    return {
      decidedBy: "safety",
      verdict: "skip",
      rationale: `${safety.label} — investigate before enabling`,
    };
  }
  if (utility.tone === "positive") {
    return {
      decidedBy: "utility",
      verdict: "enable",
      rationale: `Pass-rate uplift ${formatSignedPercent(utility.delta)} (uplift score ${formatNumber(utility.uplift, 2)})`,
    };
  }
  if (utility.tone === "negative") {
    return {
      decidedBy: "utility",
      verdict: "skip",
      rationale: `With-skill condition under-performs by ${formatSignedPercent(utility.delta)}`,
    };
  }
  // tie or ceiling — defer to cost
  if (cost.saves) {
    return {
      decidedBy: "cost_tie_break",
      verdict: "enable",
      rationale: `Utility tied${utility.ceilingFlag ? " at ceiling" : ""}; saves ${formatSignedDuration(cost.deltaTime)} and ${formatSignedTokens(cost.deltaEff)} effective tokens`,
    };
  }
  if (cost.overheads) {
    return {
      decidedBy: "cost_tie_break",
      verdict: "skip",
      rationale: `Utility tied${utility.ceilingFlag ? " at ceiling" : ""}; adds ${formatSignedDuration(cost.deltaTime)} and ${formatSignedTokens(cost.deltaEff)} effective tokens`,
    };
  }
  return {
    decidedBy: "cost_tie_break",
    verdict: "trade_off",
    rationale: `Utility tied${utility.ceilingFlag ? " at ceiling" : ""}; cost trade-off (Δt ${formatSignedDuration(cost.deltaTime)}, Δtokens ${formatSignedTokens(cost.deltaEff)})`,
  };
}

// ---------- Render helpers ----------

function renderBlockTitle(title, subtitle = "") {
  return `
    <div class="panel-header" style="padding:0; margin-bottom:12px;">
      <h3>${escapeHtml(title)}</h3>
      <div class="muted">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

function renderCompareCard(label, side, value, meta) {
  return `
    <div class="compare-card" data-side="${escapeHtml(side)}">
      <div class="compare-label">${escapeHtml(label)}</div>
      <div class="compare-value">${escapeHtml(value)}</div>
      <div class="compare-meta">${escapeHtml(meta)}</div>
    </div>
  `;
}

function renderScenarioCards(example, utility) {
  return (example.scenarios || []).map((scenario) => {
    const wiPass = scenario.totalItems ? scenario.wiPassedItems / scenario.totalItems : 0;
    const woPass = scenario.totalItems ? scenario.woPassedItems / scenario.totalItems : 0;
    const ceiling = wiPass >= 1 - 1e-6 && woPass >= 1 - 1e-6;
    const tied = Math.abs(wiPass - woPass) < 1e-6;
    let chipTone = scenario.winner;
    let chipLabel = scenario.winner === "wi" ? "WI wins" : scenario.winner === "wo" ? "WO wins" : "Tie";
    if (tied && ceiling) {
      chipTone = "tie";
      chipLabel = "Ceiling";
    }
    return `
      <article class="scenario-card">
        <div class="scenario-topline">
          <h4>${escapeHtml(`${scenario.scenarioId} - ${scenario.label}`)}</h4>
          <span class="winner-chip" data-winner="${escapeHtml(chipTone)}">${escapeHtml(chipLabel)}</span>
        </div>
        <div class="muted section-spacer">${escapeHtml(scenario.instructionPreview || "")}</div>
        <div class="scenario-chip-row section-spacer">
          <span class="tag">${escapeHtml(`${scenario.wiPassedItems}/${scenario.totalItems} WI`)}</span>
          <span class="tag">${escapeHtml(`${scenario.woPassedItems}/${scenario.totalItems} WO`)}</span>
          <span class="tag">${escapeHtml(`Δ ${formatSignedPercent(wiPass - woPass)}`)}</span>
          <span class="tag">${escapeHtml(`WI ${scenario.wiRun.status}`)}</span>
          <span class="tag">${escapeHtml(`WO ${scenario.woRun.status}`)}</span>
        </div>
        <div class="detail-pair-grid section-spacer">
          <div class="detail-pair">
            <strong>Utility Note</strong>
            <span>${escapeHtml(scenario.utilitySummary || "-")}</span>
          </div>
          <div class="detail-pair">
            <strong>Judge Error / Note</strong>
            <span>${escapeHtml(scenario.judgeError || "-")}</span>
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function renderTaskUtilityCards(example) {
  return (example.taskUtilityType?.items || []).map((item) => `
    <article class="scenario-card">
      <h4>${escapeHtml(`${item.scenarioId} - ${item.label}`)}</h4>
      <div class="muted section-spacer">${escapeHtml(item.headline || "-")}</div>
      <div class="scenario-chip-row section-spacer">
        ${item.level ? `<span class="tag">${escapeHtml(item.level)}</span>` : ""}
        ${(item.outputTargets || []).map((target) => `<span class="tag">${escapeHtml(target)}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function renderReliabilityCards(example) {
  return (example.scenarios || []).map((scenario) => `
    <div class="detail-pair">
      <strong>${escapeHtml(`${scenario.scenarioId} reliability`)}</strong>
      <span>${escapeHtml(`WI ${scenario.wiRun.status}${scenario.wiRun.exceptionType ? ` / ${scenario.wiRun.exceptionType}` : ""}`)}</span>
      <span>${escapeHtml(`WO ${scenario.woRun.status}${scenario.woRun.exceptionType ? ` / ${scenario.woRun.exceptionType}` : ""}`)}</span>
      <span>${escapeHtml(scenario.judgeError || "-")}</span>
    </div>
  `).join("");
}

function renderRecommendationCard(rec, utility, cost) {
  const verdictTone = rec.verdict === "enable" ? "wi"
    : rec.verdict === "skip" ? "wo"
    : "tie";
  const verdictLabel = rec.verdict === "enable" ? "Enable"
    : rec.verdict === "skip" ? "Skip"
    : "Trade-off";

  return `
    <section class="dimension-card recommendation-card">
      ${renderBlockTitle("Recommendation", "Utility decides first; cost is the tie-breaker; safety can override.")}
      <div class="scenario-chip-row">
        <span class="winner-chip" data-winner="${escapeHtml(verdictTone)}">${escapeHtml(verdictLabel)}</span>
        <span class="tag">${escapeHtml(`Decided by: ${rec.decidedBy.replace(/_/g, " ")}`)}</span>
      </div>
      <div class="dimension-copy section-spacer">${escapeHtml(rec.rationale)}</div>
    </section>
  `;
}

function renderUtilitySection(example, utility) {
  const eff = example.effectiveness || {};
  const upliftLabel = utility.tieFlag
    ? (utility.ceilingFlag ? "0.00 (ceiling)" : "0.00 (tied)")
    : formatNumber(utility.uplift, 3);

  return `
    <section class="dimension-card axis-utility">
      <div class="axis-eyebrow" data-axis="utility">Axis I &middot; Utility</div>
      <h3 class="dimension-title">Pass-rate Uplift</h3>
      <div class="dimension-copy">Utility is the marginal task-completion improvement skill provides over the no-skill baseline. Uplift score normalises by the remaining gap so ceiling scenarios are not unfairly penalised.</div>
      <div class="mini-stat-grid">
        <div class="mini-stat">
          <span class="label">Uplift Score</span>
          <span class="value">${escapeHtml(upliftLabel)}</span>
          <span class="meta">${escapeHtml(`Δ ${formatSignedPercent(utility.delta)}${utility.ceilingFlag ? " · ceiling_flag" : utility.tieFlag ? " · tie_flag" : ""}`)}</span>
        </div>
        <div class="mini-stat">
          <span class="label">Verdict</span>
          <span class="value">${escapeHtml(utility.label)}</span>
          <span class="meta">${escapeHtml(`${eff.wiWins ?? 0} WI wins · ${eff.woWins ?? 0} WO wins · ${eff.ties ?? 0} ties`)}</span>
        </div>
      </div>
      <div class="compare-grid">
        ${renderCompareCard("With Skill", "wi", `${eff.wiPassedItems ?? 0}/${eff.totalItems ?? 0}`, `${formatPercent(eff.wiPassRate)} pass rate`)}
        ${renderCompareCard("Without Skill", "wo", `${eff.woPassedItems ?? 0}/${eff.totalItems ?? 0}`, `${formatPercent(eff.woPassRate)} pass rate`)}
      </div>
      <div class="scenario-line">${renderScenarioCards(example, utility)}</div>
    </section>
  `;
}

function renderCostSection(example, cost, utility) {
  const tokens = example.costApiUsage || {};
  const note = utility.tieFlag
    ? "Utility tied — cost is the tie-breaker."
    : "Reported as standalone overhead; does not change the utility verdict.";

  return `
    <section class="dimension-card axis-cost">
      <div class="axis-eyebrow" data-axis="cost">Axis II &middot; Cost</div>
      <h3 class="dimension-title">Operational Overhead</h3>
      <div class="dimension-copy">${escapeHtml(note)} Effective tokens count only the input the model actually had to process (cache hits excluded), so they reflect the real per-call computation the skill adds.</div>
      <div class="mini-stat-grid">
        <div class="mini-stat">
          <span class="label">Δ Time (WI − WO)</span>
          <span class="value">${escapeHtml(formatSignedDuration(cost.deltaTime))}</span>
          <span class="meta">${escapeHtml(`${formatDuration(cost.wiTime)} WI · ${formatDuration(cost.woTime)} WO`)}</span>
        </div>
        <div class="mini-stat">
          <span class="label">Δ Effective Tokens</span>
          <span class="value">${escapeHtml(formatSignedTokens(cost.deltaEff))}</span>
          <span class="meta">${escapeHtml(`${formatNumber(cost.wiEff)} WI · ${formatNumber(cost.woEff)} WO`)}</span>
        </div>
      </div>
      <div class="compare-grid">
        ${renderCompareCard("WI Tokens", "wi", formatNumber(tokens.wiTokens?.total ?? 0), `${formatNumber(tokens.wiTokens?.input ?? 0)} input · ${formatNumber(tokens.wiTokens?.cache ?? 0)} cache · ${formatNumber(tokens.wiTokens?.output ?? 0)} output`)}
        ${renderCompareCard("WO Tokens", "wo", formatNumber(tokens.woTokens?.total ?? 0), `${formatNumber(tokens.woTokens?.input ?? 0)} input · ${formatNumber(tokens.woTokens?.cache ?? 0)} cache · ${formatNumber(tokens.woTokens?.output ?? 0)} output`)}
      </div>
    </section>
  `;
}

function renderFindingCard(finding) {
  const sev = String(finding.severity || "").toUpperCase();
  const exist = Number(finding.existence_confidence ?? 0);
  const exploit = Number(finding.exploitability ?? 0);
  const ded = Number(finding.deduction ?? 0);
  const existSrc = String(finding.existence_confidence_src || "default");
  const exploitSrc = String(finding.exploitability_src || "default");
  const co = finding.co_occurrence;

  const existPct = `${(exist * 100).toFixed(0)}%`;
  const exploitPct = `${(exploit * 100).toFixed(0)}%`;
  const evidence = String(finding.evidence || "").slice(0, 360);
  const truncated = String(finding.evidence || "").length > 360;

  return `
    <article class="finding-card" data-severity="${escapeHtml(sev)}">
      <header class="finding-head">
        <div class="finding-id-row">
          <span class="sev-badge sev-${escapeHtml(sev || "L")}">${escapeHtml(sev || "?")}</span>
          <span class="pattern-chip">${escapeHtml(finding.pattern_id || "?")}</span>
          <span class="finding-id">${escapeHtml(finding.finding_id || "")}</span>
          ${co ? `<span class="co-chip" title="${escapeHtml(co.note || "")}">${escapeHtml(co.rule || "CO")}</span>` : ""}
        </div>
        <div class="finding-deduction">−${escapeHtml(ded.toFixed(2))}</div>
      </header>
      <div class="finding-pattern-line">
        <strong>${escapeHtml(finding.pattern_name || "")}</strong>
        <span class="muted"> · ${escapeHtml(finding.category || "")}</span>
      </div>
      <div class="finding-meter-grid">
        <div class="finding-meter" data-kind="existence">
          <div class="meter-label">existence_confidence <span class="meter-src" data-src="${escapeHtml(existSrc)}">${escapeHtml(existSrc)}</span></div>
          <div class="meter-bar"><span style="width:${existPct}"></span></div>
          <div class="meter-value">${escapeHtml(existPct)}</div>
        </div>
        <div class="finding-meter" data-kind="exploit">
          <div class="meter-label">exploitability <span class="meter-src" data-src="${escapeHtml(exploitSrc)}">${escapeHtml(exploitSrc.replace("_", " "))}</span></div>
          <div class="meter-bar"><span style="width:${exploitPct}"></span></div>
          <div class="meter-value">${escapeHtml(exploitPct)}</div>
        </div>
      </div>
      <div class="finding-loc muted">${escapeHtml(finding.file || "")}${finding.location ? ` · ${escapeHtml(finding.location)}` : ""}</div>
      ${evidence ? `<pre class="finding-evidence"><code>${escapeHtml(evidence)}${truncated ? "…" : ""}</code></pre>` : ""}
      ${finding.description ? `<div class="finding-description">${escapeHtml(finding.description)}</div>` : ""}
      ${finding.confidence_rationale ? `<div class="finding-rationale muted"><em>Confidence rationale:</em> ${escapeHtml(finding.confidence_rationale)}</div>` : ""}
    </article>
  `;
}

function renderSafetySection(example, safety, scannerPayload) {
  if (scannerPayload === "loading" || !scannerPayload) {
    return `
      <section class="dimension-card axis-safety">
        <div class="axis-eyebrow" data-axis="safety">Axis III &middot; Safety</div>
        <h3 class="dimension-title">Permission &amp; Runtime Risk</h3>
        <div class="dimension-copy">Loading static-scan findings…</div>
      </section>
    `;
  }

  if (scannerPayload === "error" || !scannerPayload.found) {
    const reliability = example.reliabilityError || {};
    return `
      <section class="dimension-card axis-safety">
        <div class="axis-eyebrow" data-axis="safety">Axis III &middot; Safety</div>
        <h3 class="dimension-title">Permission &amp; Runtime Risk</h3>
        <div class="dimension-copy">No static-scan findings keyed to this skill. Showing runtime exceptions as a fallback.</div>
        <div class="mini-stat-grid">
          <div class="mini-stat">
            <span class="label">WI Exceptions</span>
            <span class="value">${escapeHtml(formatNumber(reliability.wiExceptionScenarios))}</span>
            <span class="meta">${escapeHtml(JSON.stringify(reliability.wiStatusCounts || {}))}</span>
          </div>
          <div class="mini-stat">
            <span class="label">WO Exceptions</span>
            <span class="value">${escapeHtml(formatNumber(reliability.woExceptionScenarios))}</span>
            <span class="meta">${escapeHtml(JSON.stringify(reliability.woStatusCounts || {}))}</span>
          </div>
        </div>
      </section>
    `;
  }

  const sev = scannerPayload.severityCounts || { H: 0, M: 0, L: 0 };
  const findingsHtml = (scannerPayload.findings || []).map(renderFindingCard).join("");
  const score = Number(scannerPayload.securityScore ?? 100);
  const ded = Number(scannerPayload.deductionTotal ?? 0);
  const co = Number(scannerPayload.coOccurrenceCount ?? 0);

  const scoreTone = score >= 80 ? "ok" : score >= 60 ? "warn" : "danger";

  return `
    <section class="dimension-card axis-safety">
      <div class="axis-eyebrow" data-axis="safety">Axis III &middot; Safety</div>
      <h3 class="dimension-title">Permission &amp; Runtime Risk</h3>
      <div class="dimension-copy">Score = max(10, 100 − Σ deduction), where <code>deduction = base × existence_confidence × exploitability</code>. Exploitability defaults to 0.6 until the dynamic security judge is wired in.</div>

      <div class="security-score-row">
        <div class="security-score-card" data-tone="${escapeHtml(scoreTone)}">
          <div class="score-label">security_score</div>
          <div class="score-value">${escapeHtml(score.toFixed(1))}</div>
          <div class="score-meta">Σ deduction = ${escapeHtml(ded.toFixed(2))}</div>
        </div>
        <div class="severity-pill-row">
          <span class="sev-pill sev-H">${escapeHtml(`${sev.H || 0} High`)}</span>
          <span class="sev-pill sev-M">${escapeHtml(`${sev.M || 0} Medium`)}</span>
          <span class="sev-pill sev-L">${escapeHtml(`${sev.L || 0} Low`)}</span>
          ${co > 0 ? `<span class="sev-pill sev-CO">${escapeHtml(`${co} CO-occurrence`)}</span>` : ""}
        </div>
      </div>

      <div class="findings-list">
        ${findingsHtml || '<div class="empty-list">No findings reported by the static scanner for this skill.</div>'}
      </div>
    </section>
  `;
}

function renderConditionSection(example) {
  const cond = example.skillCondition || {};
  return `
    <section class="dimension-card">
      ${renderBlockTitle("Experiment Validity", "Each scenario is only counted when wi_skill_matched=True and wo_skill_matched=False.")}
      <div class="mini-stat-grid">
        <div class="mini-stat">
          <span class="label">WI Matched</span>
          <span class="value">${escapeHtml(`${cond.wiMatchedCount ?? 0}/${example.scenarioCount}`)}</span>
          <span class="meta">${escapeHtml(`expected ${cond.wiExpectedCount ?? 0} · used ${cond.wiUsedCount ?? 0}`)}</span>
        </div>
        <div class="mini-stat">
          <span class="label">WO Matched</span>
          <span class="value">${escapeHtml(`${cond.woMatchedCount ?? 0}/${example.scenarioCount}`)}</span>
          <span class="meta">${escapeHtml(`expected ${cond.woExpectedCount ?? 0} · used ${cond.woUsedCount ?? 0}`)}</span>
        </div>
      </div>
    </section>
  `;
}

function renderStubBanner(example) {
  return `
    <section class="detail-card stub-banner">
      <div class="stub-banner-inner">
        <span class="stub-eyebrow">Safety only</span>
        <h3>This skill has been audited for safety, not yet for utility.</h3>
        <p>Utility and Cost require paired with-skill / without-skill runs, which have not been collected for this skill. The Safety findings below are based on real static analysis of the skill package.</p>
      </div>
    </section>
  `;
}

function renderDetail(example) {
  el("detail-caption").textContent = `${example.skillName} / ${example.categoryLabel}`;

  const scannerPayload = state.scannerFindings[example.skillName] ?? null;
  const isStub = example.source === "safety_only";

  const utility = utilityVerdict(example);
  const cost = costVerdict(example);
  const safety = safetyVerdict(example, scannerPayload);
  const rec = recommendation(utility, cost, safety);

  const capabilityMarkup = (example.domainCoverage?.capabilityHighlights || []).map((item) => `
    <div class="dimension-list-item">${escapeHtml(item)}</div>
  `).join("");

  const utilityCostBlock = isStub
    ? ""
    : `
        ${renderRecommendationCard(rec, utility, cost)}
      `;

  const utilityCostCards = isStub
    ? ""
    : `
        ${renderUtilitySection(example, utility)}
        ${renderCostSection(example, cost, utility)}
      `;

  const conditionCard = isStub ? "" : renderConditionSection(example);

  el("detail-content").innerHTML = `
    <div class="detail-stack">
      <section class="detail-card hero-detail">
        ${renderBlockTitle(example.skillName, `${example.categoryLabel} / ${example.owner}`)}
        <div class="scenario-chip-row">
          ${isStub ? '<span class="tag stub-tag">Safety audited</span>' : ""}
          ${!isStub ? `<span class="tag">${escapeHtml(`${example.scenarioCount} scenarios`)}</span>` : ""}
          ${!isStub ? `<span class="tag">${escapeHtml(`${example.effectiveness?.totalItems ?? 0} judged items`)}</span>` : ""}
          <span class="tag">${escapeHtml(`${example.domainCoverage?.coverageCount ?? 0} coverage points`)}</span>
        </div>
        <div class="muted section-spacer">${escapeHtml(example.skillPath || "—")}</div>
      </section>

      ${isStub ? renderStubBanner(example) : ""}

      ${utilityCostBlock}

      <div class="dimension-grid">
        ${utilityCostCards}
        ${renderSafetySection(example, safety, scannerPayload)}
        ${conditionCard}

        <section class="dimension-card">
          <h3 class="dimension-title">Skill / Domain Coverage</h3>
          <div class="dimension-copy">Domain context for the skill, with capability highlights drawn from the underlying scenarios.</div>
          <div class="mini-stat-grid">
            <div class="mini-stat">
              <span class="label">Domain</span>
              <span class="value">${escapeHtml(example.categoryLabel || "-")}</span>
              <span class="meta">${escapeHtml(example.category || "")}</span>
            </div>
            <div class="mini-stat">
              <span class="label">Coverage Points</span>
              <span class="value">${escapeHtml(formatNumber(example.domainCoverage?.coverageCount))}</span>
              <span class="meta">${escapeHtml((example.scenarioIds || []).join(", "))}</span>
            </div>
          </div>
          <div class="dimension-list">${capabilityMarkup || '<div class="muted">No capability data found.</div>'}</div>
        </section>

        <section class="dimension-card">
          <h3 class="dimension-title">Task Utility Type</h3>
          <div class="dimension-copy">Each scenario is labelled by its concrete utility pattern so the detail panel reflects what the Example is actually testing.</div>
          <div class="scenario-line">${renderTaskUtilityCards(example)}</div>
        </section>
      </div>
    </div>
  `;
}

function renderEmptyDetail(message = "Pick a skill from Included Skills to inspect its Utility, Cost, and Safety evaluation.") {
  el("detail-caption").textContent = "Select a skill";
  el("detail-content").innerHTML = `
    <div class="empty-state skillmark-empty">
      <div class="empty-kicker">No skill selected</div>
      <p>${escapeHtml(message)}</p>
    </div>
  `;
}

function renderSkillList() {
  const visible = getVisibleExamples();
  const total = state.dashboard?.examples?.length || 0;
  el("skills-meta").textContent = `${visible.length} visible / ${total} total | Source: ${state.dashboard?.root?.examplesDir || "-"}`;

  if (!visible.length) {
    el("skill-list").innerHTML = '<div class="empty-list">No Example skill matches the current search.</div>';
    return;
  }

  el("skill-list").innerHTML = visible.map((item) => {
    const selected = state.selectedSkillName === item.skillName;
    const utility = utilityVerdict(item);
    const cost = costVerdict(item);

    let leader = "tie";
    let leaderLabel = utility.ceilingFlag ? "Ceiling" : "Tied";
    if (utility.tone === "positive") {
      leader = "wi";
      leaderLabel = `Skill +${formatSignedPercent(utility.delta).replace(/^[+−]/, "")}`;
    } else if (utility.tone === "negative") {
      leader = "wo";
      leaderLabel = `Skill ${formatSignedPercent(utility.delta)}`;
    }

    const utilityLabels = (item.taskUtilityType?.items || []).map((entry) => entry.label).join(" | ");

    return `
      <article class="skill-card ${selected ? "is-selected" : ""}" data-skill-name="${escapeHtml(item.skillName)}">
        <div class="skill-card-head">
          <div>
            <h3 class="skill-card-title">${escapeHtml(item.skillName)}</h3>
            <div class="skill-card-subtitle muted">${escapeHtml(item.categoryLabel)} / ${escapeHtml(item.owner)}</div>
          </div>
          <span class="winner-chip" data-winner="${escapeHtml(leader)}">${escapeHtml(leaderLabel)}</span>
        </div>
        <div class="skill-card-tags section-spacer">
          <span class="tag">${escapeHtml(`${item.scenarioCount} scenarios`)}</span>
          <span class="tag">${escapeHtml(`WI ${formatPercent(item.effectiveness?.wiPassRate)}`)}</span>
          <span class="tag">${escapeHtml(`WO ${formatPercent(item.effectiveness?.woPassRate)}`)}</span>
          <span class="tag">${escapeHtml(`Δt ${formatSignedDuration(cost.deltaTime)}`)}</span>
        </div>
        <div class="detail-pair-grid section-spacer">
          <div class="detail-pair">
            <strong>Task Utility Type</strong>
            <span>${escapeHtml(utilityLabels || "-")}</span>
          </div>
          <div class="detail-pair">
            <strong>Δ Effective Tokens</strong>
            <span>${escapeHtml(formatSignedTokens(cost.deltaEff))}</span>
          </div>
        </div>
      </article>
    `;
  }).join("");

  Array.from(document.querySelectorAll("[data-skill-name]")).forEach((node) => {
    node.addEventListener("click", () => {
      const skillName = node.getAttribute("data-skill-name") || "";
      selectSkill(skillName);
    });
  });
}

async function ensureScannerFindings(skillName) {
  if (!skillName) return;
  const cached = state.scannerFindings[skillName];
  if (cached && cached !== "error") return;
  state.scannerFindings[skillName] = "loading";
  try {
    const payload = await fetchJson(buildQuery("/api/scanner/findings", { skill: skillName }));
    state.scannerFindings[skillName] = payload;
  } catch (error) {
    state.scannerFindings[skillName] = "error";
  }
}

function selectSkill(skillName) {
  state.selectedSkillName = skillName;
  renderSkillList();
  const example = (state.dashboard?.examples || []).find((item) => item.skillName === skillName);
  if (!example) return;
  syncSelectedSkillToUrl();
  renderDetail(example);

  if (!state.scannerFindings[skillName]) {
    ensureScannerFindings(skillName).then(() => {
      if (state.selectedSkillName === skillName) {
        renderDetail(example);
      }
    });
  }
}

async function loadDashboard() {
  updateStatus("Loading", "working");
  const dashboard = await fetchJson(buildQuery("/api/examples/summary", { examplesDir: state.examplesDir }));
  state.dashboard = dashboard;
  renderOverview(dashboard);
  renderSkillList();
  updateStatus("Ready", "success");

  const visible = getVisibleExamples();
  const selectedVisible = visible.some((item) => item.skillName === state.selectedSkillName);
  const next = selectedVisible ? state.selectedSkillName : (visible[0]?.skillName || "");
  if (next) {
    selectSkill(next);
    return;
  }
  renderEmptyDetail("The current search removed every Example skill from the list.");
}

function installControls() {
  el("reload-button").addEventListener("click", () => {
    state.examplesDir = el("examples-dir-input").value.trim();
    applyStaticLinks();
    syncSelectedSkillToUrl();
    loadDashboard().catch((error) => updateStatus(error.message, "error"));
  });

  el("search-input").addEventListener("input", (event) => {
    state.searchTerm = event.target.value.trim().toLowerCase();
    renderSkillList();

    const visible = getVisibleExamples();
    if (!visible.some((item) => item.skillName === state.selectedSkillName)) {
      if (visible[0]) {
        selectSkill(visible[0].skillName);
      } else {
        renderEmptyDetail("The current search removed every Example skill from the list.");
      }
    }
  });

  el("focus-detail-button").addEventListener("click", () => {
    el("evaluation-details").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function initializeStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.examplesDir = params.get("examplesDir") || "";
  state.selectedSkillName = params.get("skill") || "";
  document.body.classList.toggle("modal-detail", params.get("modal") === "1");
  el("examples-dir-input").value = state.examplesDir;
}

async function main() {
  initializeStateFromUrl();
  applyStaticLinks();
  installControls();
  await loadDashboard();
}

main().catch((error) => {
  updateStatus(error.message, "error");
});
