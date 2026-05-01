const state = {
  resultsDir: "",
  summary: null,
  selectedTrialName: "",
  searchTerm: "",
  statusFilter: "all",
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

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) {
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
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatReward(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return formatNumber(value, 2);
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${formatNumber(Number(value) * 100, 1)}%`;
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

function updateStatus(label, tone) {
  const pill = el("status-pill");
  pill.textContent = label;
  pill.dataset.tone = tone;
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

function renderOverview(summary) {
  const { job, overview, agents, config } = summary;
  el("job-title").textContent = job.jobName || "Task results";
  el("job-subtitle").textContent = `${job.nListedTrials} trials parsed from ${job.resultsDir}`;

  el("hero-stats").innerHTML = [
    ["Trials", formatNumber(job.nListedTrials)],
    ["Pass Rate", formatPercent(overview.successRate || 0)],
    ["Mean Reward", formatReward(overview.meanReward)],
    ["Token Total", formatNumber(overview.tokens.total)],
  ].map(([label, value]) => `
    <div class="hero-stat">
      <div class="hero-stat-label">${escapeHtml(label)}</div>
      <div class="hero-stat-value">${escapeHtml(value)}</div>
    </div>
  `).join("");

  const cards = [
    ["Success Rate", formatPercent(overview.successRate || 0), `${overview.statusCounts.passed + overview.statusCounts.warning} pass-like / ${job.nListedTrials} total`],
    ["Mean Reward", formatReward(overview.meanReward), "Average verifier reward across listed trials"],
    ["Mean Duration", formatDuration(overview.meanDurationSec), "Average end-to-end runtime"],
    ["Token Volume", formatNumber(overview.tokens.total), `${formatNumber(overview.tokens.input)} prompt + ${formatNumber(overview.tokens.cache)} cache + ${formatNumber(overview.tokens.output)} output`],
    ["Passed", formatNumber(overview.statusCounts.passed), "Reward/tests completed cleanly"],
    ["Warnings", formatNumber(overview.statusCounts.warning), "Passed but exception also recorded"],
    ["Failed", formatNumber(overview.statusCounts.failed), "Verifier failures without exception"],
    ["Errors", formatNumber(overview.statusCounts.error), "Runtime-level failures"],
  ];

  el("summary-grid").innerHTML = cards.map(([label, value, meta]) => `
    <article class="stat-card">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-meta">${escapeHtml(meta)}</div>
    </article>
  `).join("");

  const metaItems = [
    ["Job ID", job.id || "-"],
    ["Results Dir", job.resultsDir || "-"],
    ["Started", formatTimestamp(job.startedAt)],
    ["Finished", formatTimestamp(job.finishedAt)],
    ["Run Duration", formatDuration(job.durationSec)],
    ["Orchestrator", config.orchestratorType || "-"],
    ["Environment", config.environmentType || "-"],
    ["Concurrency", config.nConcurrentTrials ?? "-"],
  ];

  el("job-meta").innerHTML = metaItems.map(([label, value]) => `
    <div class="meta-item">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value">${escapeHtml(value)}</span>
    </div>
  `).join("");

  el("agent-row").innerHTML = agents.length
    ? agents.map((agent) => `
      <div class="agent-chip">
        ${escapeHtml(agent.agentName || "unknown")} / ${escapeHtml(agent.modelName || "unknown")} / ${escapeHtml(String(agent.nTrials))} trials
      </div>
    `).join("")
    : '<div class="muted">No agent metadata found.</div>';
}

function getFilteredTrials() {
  const trials = state.summary?.trials || [];
  return trials.filter((trial) => {
    if (state.statusFilter !== "all" && trial.status !== state.statusFilter) {
      return false;
    }
    if (!state.searchTerm) {
      return true;
    }
    const haystack = `${trial.taskName} ${trial.trialName} ${trial.agentName} ${trial.modelName} ${trial.exceptionType}`.toLowerCase();
    return haystack.includes(state.searchTerm);
  });
}

function renderTrials() {
  const trials = getFilteredTrials();
  const selected = state.selectedTrialName;
  const total = state.summary?.trials?.length || 0;
  el("trials-meta").textContent = `${trials.length} visible / ${total} total`;

  if (!trials.length) {
    el("trials-body").innerHTML = `
      <tr>
        <td colspan="7" class="muted">No trials match the current filter.</td>
      </tr>
    `;
    return;
  }

  el("trials-body").innerHTML = trials.map((trial) => {
    const notes = trial.hasException
      ? `${trial.exceptionType || "Exception"}: ${trial.exceptionMessage || "See detail"}`
      : `${trial.tests.failed} failed tests`;
    return `
      <tr data-trial-name="${escapeHtml(trial.trialName)}" class="${selected === trial.trialName ? "is-selected" : ""}">
        <td><span class="status-badge" data-status="${escapeHtml(trial.status)}">${escapeHtml(trial.status)}</span></td>
        <td>
          <div class="cell-title">${escapeHtml(trial.taskName)}</div>
          <div class="cell-subtitle">${escapeHtml(trial.trialName)}</div>
        </td>
        <td>${escapeHtml(formatReward(trial.reward))}</td>
        <td>${escapeHtml(`${trial.tests.passed}/${trial.tests.tests}`)}</td>
        <td>${escapeHtml(formatNumber(trial.tokens.total))}</td>
        <td>${escapeHtml(formatDuration(trial.durationSec))}</td>
        <td><div class="cell-subtitle">${escapeHtml(notes)}</div></td>
      </tr>
    `;
  }).join("");

  Array.from(document.querySelectorAll("[data-trial-name]")).forEach((row) => {
    row.addEventListener("click", () => {
      const trialName = row.getAttribute("data-trial-name") || "";
      selectTrial(trialName).catch((error) => updateStatus(error.message, "error"));
    });
  });
}

function renderBlockTitle(title, subtitle = "") {
  return `
    <div class="panel-header" style="padding:0; margin-bottom:12px;">
      <h3>${escapeHtml(title)}</h3>
      <div class="muted">${escapeHtml(subtitle)}</div>
    </div>
  `;
}

function renderVerifierSection(detail) {
  const failedTests = detail.verifier.failedTests || [];
  const summary = detail.verifier.summary || {};
  const failedMarkup = failedTests.length
    ? failedTests.map((test) => `
      <div class="list-item">
        <div class="list-item-title">${escapeHtml(test.name || "failed test")}</div>
        <div class="cell-subtitle">${escapeHtml(test.filePath || "")}</div>
        <div class="section-spacer muted">${escapeHtml(test.message || "")}</div>
        ${test.tracePreview ? `<pre class="mono section-spacer">${escapeHtml(test.tracePreview)}</pre>` : ""}
      </div>
    `).join("")
    : '<div class="muted">No failed test cases captured.</div>';

  return `
    <section class="detail-card">
      ${renderBlockTitle("Verifier", `${summary.passed || 0} passed / ${summary.failed || 0} failed / ${summary.tests || 0} total`)}
      <div class="detail-grid">
        <div class="meta-item"><span class="label">Tests</span><span class="value">${escapeHtml(String(summary.tests || 0))}</span></div>
        <div class="meta-item"><span class="label">Passed</span><span class="value">${escapeHtml(String(summary.passed || 0))}</span></div>
        <div class="meta-item"><span class="label">Failed</span><span class="value">${escapeHtml(String(summary.failed || 0))}</span></div>
        <div class="meta-item"><span class="label">Skipped</span><span class="value">${escapeHtml(String(summary.skipped || 0))}</span></div>
      </div>
      <div class="list-block">${failedMarkup}</div>
      ${detail.verifier.stdoutPreview ? `<pre class="mono section-spacer">${escapeHtml(detail.verifier.stdoutPreview)}</pre>` : ""}
    </section>
  `;
}

function renderOutputsSection(detail) {
  const outputs = detail.outputs || [];
  if (!outputs.length) {
    return `
      <section class="detail-card">
        ${renderBlockTitle("Generated Output")}
        <div class="muted">No files were found under agent/downloads/app/output.</div>
      </section>
    `;
  }

  return `
    <section class="detail-card">
      ${renderBlockTitle("Generated Output", `${outputs.length} file previews`)}
      <div class="list-block">
        ${outputs.map((file) => `
          <div class="list-item">
            <div class="list-item-title">${escapeHtml(file.relativePath)}</div>
            <div class="cell-subtitle">${escapeHtml(`${file.kind} / ${formatNumber(file.sizeBytes)} bytes`)}</div>
            ${file.preview ? `<pre class="mono section-spacer">${escapeHtml(file.preview)}</pre>` : ""}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderTrajectorySection(detail) {
  const steps = detail.trajectory.steps || [];
  return `
    <section class="detail-card">
      ${renderBlockTitle("Trajectory", `${steps.length} steps / ${escapeHtml(detail.trajectory.schemaVersion || "unknown schema")}`)}
      <div class="list-block">
        ${steps.length ? steps.map((step) => `
          <div class="trajectory-step">
            <div class="trajectory-head">
              <div class="list-item-title">Step ${escapeHtml(String(step.stepId ?? "-"))} / ${escapeHtml(step.source || "unknown")}</div>
              <div class="muted">${escapeHtml(formatTimestamp(step.timestamp))}</div>
            </div>
            <div class="trajectory-meta">
              ${step.modelName ? `<span class="tag">${escapeHtml(step.modelName)}</span>` : ""}
              ${step.promptTokens ? `<span class="tag">prompt ${escapeHtml(formatNumber(step.promptTokens))}</span>` : ""}
              ${step.completionTokens ? `<span class="tag">completion ${escapeHtml(formatNumber(step.completionTokens))}</span>` : ""}
              ${step.cachedTokens ? `<span class="tag">cache ${escapeHtml(formatNumber(step.cachedTokens))}</span>` : ""}
              ${(step.toolCalls || []).map((call) => `<span class="tag">${escapeHtml(call.name)}</span>`).join("")}
            </div>
            <div class="step-copy">
              ${step.reasoning ? `<p><strong>Reasoning:</strong> ${escapeHtml(step.reasoning)}</p>` : ""}
              ${step.message ? `<p><strong>Message:</strong> ${escapeHtml(step.message)}</p>` : ""}
              ${step.observationPreview ? `<p><strong>Observation:</strong> ${escapeHtml(step.observationPreview)}</p>` : ""}
            </div>
          </div>
        `).join("") : '<div class="muted">No trajectory data found.</div>'}
      </div>
    </section>
  `;
}

function renderDetail(detail) {
  const trial = detail.trial;
  el("detail-caption").textContent = trial.trialName;

  const topMeta = [
    ["Task", trial.taskName],
    ["Status", trial.status],
    ["Reward", formatReward(trial.reward)],
    ["Duration", formatDuration(trial.durationSec)],
    ["Agent", trial.agentName],
    ["Model", trial.modelName || "-"],
    ["Prompt Tokens", formatNumber(trial.tokens.input)],
    ["Output Tokens", formatNumber(trial.tokens.output)],
  ];

  const detailHero = `
    <section class="detail-card">
      ${renderBlockTitle("Selection", trial.paths?.trialDirRelative || "")}
      <div class="action-row">
        <span class="status-badge" data-status="${escapeHtml(trial.status)}">${escapeHtml(trial.status)}</span>
        <span class="tag">reward ${escapeHtml(formatReward(trial.reward))}</span>
        <span class="tag">tests ${escapeHtml(`${trial.tests.passed}/${trial.tests.tests}`)}</span>
        <span class="tag">duration ${escapeHtml(formatDuration(trial.durationSec))}</span>
      </div>
      <div class="section-spacer muted">${escapeHtml(trial.hasException ? (trial.exceptionType || "Exception captured for this trial.") : "Verifier and trajectory artifacts are available below.")}</div>
    </section>
  `;

  const exceptionSection = detail.exception.info || detail.exception.textPreview
    ? `
      <section class="detail-card">
        ${renderBlockTitle("Exception", detail.exception.info?.exception_type || "Captured")}
        ${detail.exception.info?.exception_message ? `<div class="muted">${escapeHtml(detail.exception.info.exception_message)}</div>` : ""}
        ${detail.exception.textPreview ? `<pre class="mono section-spacer">${escapeHtml(detail.exception.textPreview)}</pre>` : ""}
      </section>
    `
    : "";

  const logSection = detail.logs.trialLogTail || detail.logs.networkLogTail
    ? `
      <section class="detail-card">
        ${renderBlockTitle("Logs")}
        ${detail.logs.trialLogTail ? `<pre class="mono">${escapeHtml(detail.logs.trialLogTail)}</pre>` : ""}
        ${detail.logs.networkLogTail ? `<pre class="mono section-spacer">${escapeHtml(detail.logs.networkLogTail)}</pre>` : ""}
      </section>
    `
    : "";

  el("detail-content").innerHTML = `
    <div class="detail-stack">
      ${detailHero}
      <section class="detail-card">
        ${renderBlockTitle("Trial Summary", trial.paths?.trialDirRelative || "")}
        <div class="detail-grid">
          ${topMeta.map(([label, value]) => `
            <div class="meta-item">
              <span class="label">${escapeHtml(label)}</span>
              <span class="value">${escapeHtml(value)}</span>
            </div>
          `).join("")}
        </div>
      </section>
      ${renderVerifierSection(detail)}
      ${renderOutputsSection(detail)}
      ${renderTrajectorySection(detail)}
      ${exceptionSection}
      ${logSection}
    </div>
  `;
}

async function loadSummary() {
  updateStatus("Loading", "working");
  const summary = await fetchJson(buildQuery("/api/task-results/summary", { resultsDir: state.resultsDir }));
  state.summary = summary;
  renderOverview(summary);
  renderTrials();
  updateStatus("Ready", "success");

  const visibleTrials = getFilteredTrials();
  const stillVisible = visibleTrials.some((trial) => trial.trialName === state.selectedTrialName);
  const nextTrial = stillVisible ? state.selectedTrialName : (visibleTrials[0]?.trialName || "");

  if (nextTrial) {
    await selectTrial(nextTrial);
    return;
  }

  el("detail-caption").textContent = "No trial selected";
  el("detail-content").innerHTML = `
    <div class="empty-state">
      <div class="empty-kicker">No visible rows</div>
      <p>The current filter removed every trial from the table.</p>
    </div>
  `;
}

async function selectTrial(trialName) {
  state.selectedTrialName = trialName;
  renderTrials();
  updateStatus(`Loading ${trialName}`, "working");
  const detail = await fetchJson(buildQuery("/api/task-results/trial", {
    resultsDir: state.resultsDir,
    trialName,
  }));
  renderDetail(detail);
  updateStatus("Ready", "success");
}

function installControls() {
  el("reload-button").addEventListener("click", () => {
    state.resultsDir = el("results-dir-input").value.trim();
    loadSummary().catch((error) => updateStatus(error.message, "error"));
  });

  el("search-input").addEventListener("input", (event) => {
    state.searchTerm = event.target.value.trim().toLowerCase();
    renderTrials();
  });

  el("status-filter").addEventListener("change", (event) => {
    state.statusFilter = event.target.value;
    renderTrials();
  });
}

function initializeStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  state.resultsDir = params.get("resultsDir") || "";
  el("results-dir-input").value = state.resultsDir;
}

async function main() {
  initializeStateFromUrl();
  installControls();
  await loadSummary();
}

main().catch((error) => {
  updateStatus(error.message, "error");
});
