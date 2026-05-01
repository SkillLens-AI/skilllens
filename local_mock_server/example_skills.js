const PAPER_HREF = "";

const state = {
  dashboard: null,
  searchTerm: "",
  source: "all",
  verdict: "all",
  safety: "all",
  sort: "name-asc",
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

function formatSignedPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  const numeric = Number(value) * 100;
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${formatNumber(numeric, 1)}pp`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function examplesDir() {
  const params = new URLSearchParams(window.location.search);
  return params.get("examplesDir") || "";
}

function withExamplesDir(path, extra = {}) {
  const url = new URL(path, window.location.origin);
  const value = examplesDir();
  if (value) {
    url.searchParams.set("examplesDir", value);
  }
  Object.entries(extra).forEach(([key, item]) => {
    if (item) {
      url.searchParams.set(key, item);
    }
  });
  return `${url.pathname}${url.search}`;
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
  document.querySelectorAll('a[href="/examples/report"]').forEach((node) => {
    node.href = withExamplesDir("/examples/report");
  });
}

function reportHref(skillName) {
  return withExamplesDir("/examples/report", { skill: skillName });
}

function isScannerStub(item) {
  return item.source === "safety_only";
}

/* -------------------------------------------------------------------------- */
/* Metric derivation                                                          */
/* -------------------------------------------------------------------------- */

function utilityChip(item) {
  const delta = Number(item.effectiveness?.passDeltaRate ?? 0);
  const wi = Number(item.effectiveness?.wiPassRate ?? 0);
  const wo = Number(item.effectiveness?.woPassRate ?? 0);
  if (Math.abs(delta) < 1e-6) {
    const ceiling = wi >= 1 - 1e-6 && wo >= 1 - 1e-6;
    return {
      tone: "tie",
      label: ceiling ? "Tied at ceiling" : "Utility tied",
      magnitude: 0,
    };
  }
  return {
    tone: delta < 0 ? "negative" : "positive",
    label: `${formatSignedPercent(delta)} utility`,
    magnitude: Math.min(Math.abs(delta) * 100 / 25, 1), // scale: 25pp = full bar
  };
}

function safetyStatus(item) {
  const safety = item.safety;
  if (safety && (safety.highCount !== undefined || safety.score !== undefined)) {
    const high = Number(safety.highCount || 0);
    const med = Number(safety.mediumCount || 0);
    const low = Number(safety.lowCount || 0);
    const total = high + med + low;
    let tone = "safe";
    let label = "Clean";
    if (high > 0) {
      tone = "risky";
      label = total === 1 ? "1 finding" : `${total} findings`;
    } else if (med > 0) {
      tone = "caution";
      label = total === 1 ? "1 finding" : `${total} findings`;
    } else if (low > 0) {
      tone = "caution";
      label = total === 1 ? "1 low note" : `${total} low notes`;
    }
    return { tone, label, high, medium: med, low, score: Number(safety.score || 0) };
  }
  // Fallback for entries without explicit safety: derive from reliability exceptions
  const exc = Number(item.reliabilityError?.wiExceptionScenarios || 0)
            + Number(item.reliabilityError?.woExceptionScenarios || 0);
  if (exc >= 3) {
    return { tone: "risky",   label: `${exc} exceptions`, high: exc, medium: 0, low: 0, score: 50 };
  }
  if (exc > 0) {
    return { tone: "caution", label: exc === 1 ? "1 exception" : `${exc} exceptions`, high: 0, medium: exc, low: 0, score: 75 };
  }
  return { tone: "safe", label: "No issues", high: 0, medium: 0, low: 0, score: 95 };
}

function recommendationLabel(item) {
  const delta = Number(item.effectiveness?.passDeltaRate ?? 0);
  const exceptions = Number(item.reliabilityError?.wiExceptionScenarios ?? 0);
  if (exceptions > 0) {
    return { tone: "review", label: "Needs review" };
  }
  if (delta > 0.05) {
    return { tone: "enable", label: "Promising" };
  }
  if (delta < -0.05) {
    return { tone: "skip", label: "No gain" };
  }
  return { tone: "review", label: "Inconclusive" };
}

/* -------------------------------------------------------------------------- */
/* Filtering / sorting                                                        */
/* -------------------------------------------------------------------------- */

function sortItems(items) {
  const arr = items.slice();
  switch (state.sort) {
    case "name-desc":
      return arr.sort((a, b) => b.skillName.localeCompare(a.skillName));
    case "utility-desc":
      return arr.sort((a, b) =>
        Number(b.effectiveness?.passDeltaRate ?? -Infinity) -
        Number(a.effectiveness?.passDeltaRate ?? -Infinity)
      );
    case "utility-asc":
      return arr.sort((a, b) =>
        Number(a.effectiveness?.passDeltaRate ?? Infinity) -
        Number(b.effectiveness?.passDeltaRate ?? Infinity)
      );
    case "safety-desc":
      return arr.sort((a, b) => safetyStatus(b).score - safetyStatus(a).score);
    case "safety-asc":
      return arr.sort((a, b) => safetyStatus(a).score - safetyStatus(b).score);
    case "name-asc":
    default:
      return arr.sort((a, b) => a.skillName.localeCompare(b.skillName));
  }
}

function visibleExamples() {
  let items = state.dashboard?.examples || [];
  if (state.searchTerm) {
    const q = state.searchTerm;
    items = items.filter((item) => {
      const haystack = [
        item.skillName,
        item.owner,
        item.category,
        item.categoryLabel,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }
  if (state.source !== "all") {
    items = items.filter((item) => {
      const stub = isScannerStub(item);
      return state.source === "scanner" ? stub : !stub;
    });
  }
  if (state.verdict !== "all") {
    items = items.filter((item) => recommendationLabel(item).tone === state.verdict);
  }
  if (state.safety !== "all") {
    items = items.filter((item) => safetyStatus(item).tone === state.safety);
  }
  return sortItems(items);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderSubtitle(shown) {
  const subtitle = el("page-subtitle");
  if (!subtitle) return;
  const total = state.dashboard?.examples?.length || 0;
  if (shown === total) {
    subtitle.textContent = `${total} skills evaluated against the WI/WO benchmark, scored on utility and safety.`;
  } else {
    subtitle.textContent = `Showing ${shown} of ${total} skills.`;
  }
}

function renderUtilityCell(utility) {
  const widthPct = Math.max(2, Math.round(utility.magnitude * 50)); // half-bar centered
  return `
    <div class="row__metric" data-tone="${escapeHtml(utility.tone)}">
      <span class="row__metric-text">${escapeHtml(utility.label)}</span>
      <div class="row__bar" aria-hidden="true">
        <div class="row__bar-fill" style="width: ${widthPct}%"></div>
      </div>
    </div>
  `;
}

function renderSafetyCell(safety) {
  const sevBits = [];
  if (safety.high > 0) sevBits.push(`<span class="sev-h">H<strong>${safety.high}</strong></span>`);
  if (safety.medium > 0) sevBits.push(`<span class="sev-m">M<strong>${safety.medium}</strong></span>`);
  if (safety.low > 0) sevBits.push(`<span class="sev-l">L<strong>${safety.low}</strong></span>`);
  const meta = sevBits.length
    ? `<span class="row__safety-meta">${sevBits.join("")}</span>`
    : `<span class="row__safety-meta"><span class="sev-l">score<strong>${escapeHtml(String(safety.score))}</strong></span></span>`;
  return `
    <div class="row__safety">
      <span class="safety-pill" data-tone="${escapeHtml(safety.tone)}">
        <span class="safety-pill__dot" aria-hidden="true"></span>
        ${escapeHtml(safety.label)}
      </span>
      ${meta}
    </div>
  `;
}

function renderVerdictCell(verdict) {
  return `
    <div class="row__verdict-cell">
      <span class="row__verdict" data-tone="${escapeHtml(verdict.tone)}">
        <span class="row__verdict-dot" aria-hidden="true"></span>
        ${escapeHtml(verdict.label)}
      </span>
      <span class="row__chevron" aria-hidden="true">&rarr;</span>
    </div>
  `;
}

function renderSkills() {
  const items = visibleExamples();
  const grid = el("skills-grid");
  if (!grid) return;

  if (!items.length) {
    grid.innerHTML = '<li class="empty-skill-state">No skills match the current filters.</li>';
    renderSubtitle(0);
    return;
  }

  grid.innerHTML = items.map((item) => {
    const stub = isScannerStub(item);
    const domain = item.categoryLabel || item.category || "Uncategorized";
    const sourceLabel = stub ? "Scanner stub" : "Paper-final";
    const utility = utilityChip(item);
    const safety = safetyStatus(item);
    const verdict = recommendationLabel(item);
    return `
      <li class="row${stub ? " is-stub" : ""}">
        <a class="row__link" href="${escapeHtml(reportHref(item.skillName))}">
          <div class="row__main">
            <h2 class="row__title">${escapeHtml(item.skillName)}</h2>
            <p class="row__meta">
              ${escapeHtml(domain)}
              <span class="row__meta-sep">&middot;</span>
              ${escapeHtml(sourceLabel)}
            </p>
          </div>
          ${renderUtilityCell(utility)}
          ${renderSafetyCell(safety)}
          ${renderVerdictCell(verdict)}
        </a>
      </li>
    `;
  }).join("");

  renderSubtitle(items.length);
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

function setActiveChip(filterName, value) {
  document
    .querySelectorAll(`.chip[data-filter="${filterName}"]`)
    .forEach((chip) => {
      chip.setAttribute("aria-pressed", chip.dataset.value === value ? "true" : "false");
    });
}

async function load() {
  const summary = await fetchJson(buildQuery("/api/examples/summary", { examplesDir: examplesDir() }));
  state.dashboard = summary;
  renderSkills();
}

function install() {
  applyStaticLinks();

  const search = el("search-input");
  if (search) {
    search.addEventListener("input", (event) => {
      state.searchTerm = event.target.value.trim().toLowerCase();
      renderSkills();
    });
  }

  const sort = el("filter-sort");
  if (sort) {
    sort.addEventListener("change", (event) => {
      state.sort = event.target.value;
      renderSkills();
    });
  }

  document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const filter = chip.dataset.filter;
      const value = chip.dataset.value;
      if (!filter || !value || state[filter] === value) return;
      state[filter] = value;
      setActiveChip(filter, value);
      renderSkills();
    });
  });
}

install();
load().catch((error) => {
  const grid = el("skills-grid");
  if (grid) {
    grid.innerHTML = `<li class="empty-skill-state">Failed to load skills: ${escapeHtml(error.message || error)}</li>`;
  }
});
