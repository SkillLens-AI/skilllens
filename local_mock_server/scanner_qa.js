const demoSkills = [
  {
    id: "academic-paper-review",
    skill: "academic-paper-review",
    domain: "Research review",
    utility: { score: 0.48, validScenarios: 3, wiPass: 0.84, woPass: 0.69, uplift: 0.48, ceiling: false, tie: false },
    safety: {
      score: 96.4,
      riskLevel: "low",
      deductions: [
        { category: "Prompt injection", severity: "L", deduction: 1.2 },
        { category: "File operation", severity: "L", deduction: 2.4 },
      ],
    },
    cost: { deltaTimeS: 42.5, timeGain: -0.08, deltaEffectiveTokens: 2180, tokenGain: -0.04 },
    recommendation: { verdict: "enable", decidedBy: "utility", rationale: "Clear review-quality uplift with low safety deductions." },
  },
  {
    id: "academic-researcher",
    skill: "academic-researcher",
    domain: "Research synthesis",
    utility: { score: 0.62, validScenarios: 3, wiPass: 0.91, woPass: 0.76, uplift: 0.62, ceiling: false, tie: false },
    safety: {
      score: 94.1,
      riskLevel: "low",
      deductions: [
        { category: "Network use", severity: "L", deduction: 2.1 },
        { category: "Robustness", severity: "L", deduction: 3.8 },
      ],
    },
    cost: { deltaTimeS: -31.4, timeGain: 0.12, deltaEffectiveTokens: -1680, tokenGain: 0.07 },
    recommendation: { verdict: "enable", decidedBy: "utility", rationale: "Large utility gain and lower effective token load." },
  },
  {
    id: "advogado-criminal",
    skill: "advogado-criminal",
    domain: "Brazilian criminal law",
    utility: { score: 0.0, validScenarios: 3, wiPass: 0.16, woPass: 0.26, uplift: 0.0, ceiling: false, tie: false },
    safety: {
      score: 88.0,
      riskLevel: "medium",
      deductions: [
        { category: "Legal reliability", severity: "M", deduction: 6.0 },
        { category: "Execution robustness", severity: "M", deduction: 6.0 },
      ],
    },
    cost: { deltaTimeS: 18.1, timeGain: -0.04, deltaEffectiveTokens: 87225, tokenGain: -0.09 },
    recommendation: { verdict: "review", decidedBy: "utility", rationale: "The sample evidence is mixed and affected by incomplete executions, so this skill needs review before enabling." },
  },
  {
    id: "spreadsheet-modeling",
    skill: "spreadsheet-modeling",
    domain: "Office automation",
    utility: { score: 0.55, validScenarios: 4, wiPass: 0.88, woPass: 0.73, uplift: 0.55, ceiling: false, tie: false },
    safety: {
      score: 89.7,
      riskLevel: "low",
      deductions: [
        { category: "File operation", severity: "M", deduction: 4.2 },
        { category: "Supply chain", severity: "L", deduction: 2.7 },
        { category: "Robustness", severity: "L", deduction: 3.4 },
      ],
    },
    cost: { deltaTimeS: 18.8, timeGain: -0.05, deltaEffectiveTokens: 910, tokenGain: -0.03 },
    recommendation: { verdict: "enable", decidedBy: "utility", rationale: "Reliable task improvement; overhead is small relative to utility." },
  },
  {
    id: "browser-qa",
    skill: "browser-qa",
    domain: "Browser testing",
    utility: { score: 0.41, validScenarios: 3, wiPass: 0.79, woPass: 0.64, uplift: 0.41, ceiling: false, tie: false },
    safety: {
      score: 82.6,
      riskLevel: "medium",
      deductions: [
        { category: "Network use", severity: "M", deduction: 5.4 },
        { category: "File operation", severity: "M", deduction: 4.8 },
        { category: "Robustness", severity: "L", deduction: 7.2 },
      ],
    },
    cost: { deltaTimeS: 74.2, timeGain: -0.16, deltaEffectiveTokens: 4320, tokenGain: -0.09 },
    recommendation: { verdict: "review", decidedBy: "safety", rationale: "Useful, but browser and network permissions need review." },
  },
  {
    id: "docs-summarizer",
    skill: "docs-summarizer",
    domain: "Documentation",
    utility: { score: 0.23, validScenarios: 3, wiPass: 0.78, woPass: 0.71, uplift: 0.23, ceiling: false, tie: false },
    safety: {
      score: 97.8,
      riskLevel: "low",
      deductions: [
        { category: "Prompt injection", severity: "L", deduction: 1.1 },
        { category: "Robustness", severity: "L", deduction: 1.1 },
      ],
    },
    cost: { deltaTimeS: -12.1, timeGain: 0.06, deltaEffectiveTokens: -780, tokenGain: 0.04 },
    recommendation: { verdict: "enable", decidedBy: "utility", rationale: "Moderate utility gain with low operational risk." },
  },
  {
    id: "data-cleaning-agent",
    skill: "data-cleaning-agent",
    domain: "Data work",
    utility: { score: 0.36, validScenarios: 4, wiPass: 0.81, woPass: 0.70, uplift: 0.36, ceiling: false, tie: false },
    safety: {
      score: 78.9,
      riskLevel: "medium",
      deductions: [
        { category: "File operation", severity: "M", deduction: 8.1 },
        { category: "Robustness", severity: "M", deduction: 6.0 },
        { category: "Supply chain", severity: "L", deduction: 7.0 },
      ],
    },
    cost: { deltaTimeS: 27.6, timeGain: -0.07, deltaEffectiveTokens: 1380, tokenGain: -0.05 },
    recommendation: { verdict: "review", decidedBy: "safety", rationale: "Utility is measurable, but broad file writes require review." },
  },
  {
    id: "terminal-automation",
    skill: "terminal-automation",
    domain: "Developer tools",
    utility: { score: 0.29, validScenarios: 3, wiPass: 0.72, woPass: 0.61, uplift: 0.29, ceiling: false, tie: false },
    safety: {
      score: 69.4,
      riskLevel: "high",
      deductions: [
        { category: "Privilege escalation", severity: "H", deduction: 10.8 },
        { category: "File operation", severity: "M", deduction: 7.2 },
        { category: "Supply chain", severity: "M", deduction: 6.0 },
        { category: "Network use", severity: "L", deduction: 6.6 },
      ],
    },
    cost: { deltaTimeS: 58.9, timeGain: -0.13, deltaEffectiveTokens: 3720, tokenGain: -0.08 },
    recommendation: { verdict: "skip", decidedBy: "safety", rationale: "Observed utility does not justify high-risk command surface." },
  },
  {
    id: "presentation-builder",
    skill: "presentation-builder",
    domain: "Office automation",
    utility: { score: 0.44, validScenarios: 4, wiPass: 0.83, woPass: 0.69, uplift: 0.44, ceiling: false, tie: false },
    safety: {
      score: 91.8,
      riskLevel: "low",
      deductions: [
        { category: "File operation", severity: "M", deduction: 4.8 },
        { category: "Robustness", severity: "L", deduction: 3.4 },
      ],
    },
    cost: { deltaTimeS: 33.7, timeGain: -0.09, deltaEffectiveTokens: 2050, tokenGain: -0.06 },
    recommendation: { verdict: "enable", decidedBy: "utility", rationale: "Strong output-quality lift with contained file-scope risk." },
  },
  {
    id: "rag-indexing",
    skill: "rag-indexing",
    domain: "Retrieval",
    utility: { score: 0.51, validScenarios: 3, wiPass: 0.86, woPass: 0.71, uplift: 0.51, ceiling: false, tie: false },
    safety: {
      score: 85.3,
      riskLevel: "medium",
      deductions: [
        { category: "Network use", severity: "M", deduction: 4.2 },
        { category: "Data exfiltration", severity: "M", deduction: 5.7 },
        { category: "File operation", severity: "L", deduction: 4.8 },
      ],
    },
    cost: { deltaTimeS: 21.4, timeGain: -0.05, deltaEffectiveTokens: -450, tokenGain: 0.01 },
    recommendation: { verdict: "review", decidedBy: "safety", rationale: "High utility, but retrieval and egress paths need policy checks." },
  },
  {
    id: "lightweight-formatter",
    skill: "lightweight-formatter",
    domain: "Developer tools",
    utility: { score: 0.0, validScenarios: 3, wiPass: 0.96, woPass: 0.96, uplift: 0.0, ceiling: true, tie: true },
    safety: {
      score: 98.6,
      riskLevel: "low",
      deductions: [
        { category: "File operation", severity: "L", deduction: 1.4 },
      ],
    },
    cost: { deltaTimeS: -19.7, timeGain: 0.18, deltaEffectiveTokens: -1260, tokenGain: 0.11 },
    recommendation: { verdict: "enable", decidedBy: "cost_tie_break", rationale: "Utility ties at ceiling; skill saves time and effective tokens." },
  },
  {
    id: "social-media-scheduler",
    skill: "social-media-scheduler",
    domain: "Workflow automation",
    utility: { score: 0.18, validScenarios: 3, wiPass: 0.70, woPass: 0.64, uplift: 0.18, ceiling: false, tie: false },
    safety: {
      score: 72.2,
      riskLevel: "high",
      deductions: [
        { category: "Data exfiltration", severity: "H", deduction: 9.6 },
        { category: "Network use", severity: "M", deduction: 7.8 },
        { category: "Prompt injection", severity: "M", deduction: 5.4 },
        { category: "Supply chain", severity: "L", deduction: 5.0 },
      ],
    },
    cost: { deltaTimeS: 61.8, timeGain: -0.17, deltaEffectiveTokens: 4820, tokenGain: -0.12 },
    recommendation: { verdict: "skip", decidedBy: "safety", rationale: "Low utility and high outbound-data risk." },
  },
  {
    id: "cost-aware-coder",
    skill: "cost-aware-coder",
    domain: "Developer tools",
    utility: { score: 0.35, validScenarios: 4, wiPass: 0.80, woPass: 0.69, uplift: 0.35, ceiling: false, tie: false },
    safety: {
      score: 90.6,
      riskLevel: "low",
      deductions: [
        { category: "File operation", severity: "M", deduction: 4.2 },
        { category: "Robustness", severity: "L", deduction: 5.2 },
      ],
    },
    cost: { deltaTimeS: -24.5, timeGain: 0.09, deltaEffectiveTokens: -2410, tokenGain: 0.13 },
    recommendation: { verdict: "enable", decidedBy: "utility", rationale: "Useful coding uplift and lower effective-token cost." },
  },
];

const pipelineSteps = [
  {
    step: "01",
    title: "Read skill package",
    body: "The benchmark treats SKILL.md, metadata, scripts, and examples as the evaluation input.",
    artifact: "K = (D, F, M)",
  },
  {
    step: "02",
    title: "Generate targeted tasks",
    body: "The task generator extracts claimed capabilities and writes task schemes with verifier checks.",
    artifact: "utility_scheme.json",
  },
  {
    step: "03",
    title: "Run paired agents",
    body: "Each generated task is executed twice under matched conditions: WI can use the skill, WO cannot.",
    artifact: "task_wi_skills / task_wo_skills",
  },
  {
    step: "04",
    title: "Compare evidence",
    body: "Judges and verifiers compare output quality, skill-use condition, runtime logs, tokens, and execution time.",
    artifact: "skill_report.json",
  },
];

const generatedTasksBySkill = {
  "academic-researcher": [
    {
      title: "Summarize and critique one research paper",
      capability: "Extract research question, methodology, findings, limitations, and implications from a paper.",
      wiPass: 0.92,
      woPass: 0.68,
      evidence: "With the skill, the agent produced a structured methodology critique and field-relative implications; without it, the output was mostly a paper summary.",
    },
    {
      title: "Compare several research papers",
      capability: "Apply the same analysis rubric across several papers and produce a calibrated ranking.",
      wiPass: 0.86,
      woPass: 0.61,
      evidence: "With the skill, the agent used a consistent comparison table; without it, the agent wrote separate summaries with weak synthesis.",
    },
    {
      title: "Draft a research proposal from readings",
      capability: "Turn readings and notes into a gap-motivated research proposal with justified methods.",
      wiPass: 0.89,
      woPass: 0.72,
      evidence: "With the skill, the proposal linked literature gaps to design choices; without it, the plan was plausible but generic.",
    },
  ],
  "academic-paper-review": [
    {
      title: "Write a conference-style paper review",
      capability: "Produce a structured peer review with strengths, weaknesses, methodology assessment, and author questions.",
      wiPass: 0.88,
      woPass: 0.70,
      evidence: "With the skill, the review followed top-venue structure and included targeted author questions; without it, the review was less systematic.",
    },
    {
      title: "Review a theoretical paper",
      capability: "Adapt the review to proof correctness, assumptions, novelty, and scope of claims.",
      wiPass: 0.83,
      woPass: 0.66,
      evidence: "With the skill, the agent focused on assumptions and theorem scope; without it, the review overemphasized empirical concerns.",
    },
    {
      title: "Rank papers for follow-up reading",
      capability: "Compare multiple evaluation papers under a consistent rubric and rank their usefulness.",
      wiPass: 0.81,
      woPass: 0.71,
      evidence: "With the skill, the output had consistent criteria; without it, paper comparisons were less calibrated.",
    },
  ],
  "advogado-criminal": [
    {
      title: "Write a criminal case opinion",
      capability: "Apply the domain workflow to case facts and produce a structured defense opinion.",
      wiPass: 0.42,
      woPass: 0.34,
      evidence: "With the skill, the reasoning followed the intended legal workflow, but execution reliability still needs review.",
    },
    {
      title: "Write victim guidance and a legal note",
      capability: "Generate legally grounded, accessible guidance and an internal legal note from the same case account.",
      wiPass: 0.50,
      woPass: 0.58,
      evidence: "The no-skill run completed more output in this sample; the skill run showed stronger structure but did not finish cleanly.",
    },
    {
      title: "Analyze a prosecution strategy",
      capability: "Apply the updated statutory framework and produce a prosecution strategy memo.",
      wiPass: 0.30,
      woPass: 0.26,
      evidence: "Both runs were weak; the skill run showed better process signals, but the result remains inconclusive.",
    },
  ],
};

const state = {
  sort: "utility",
  filter: "all",
  dashboard: null,
};

function el(id) {
  return document.getElementById(id);
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

function buildQuery(basePath, params) {
  const url = new URL(basePath, window.location.origin);
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function compactText(value, max = 190) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3).trim()}...`;
}

function mean(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function fmtPct(value, digits = 1) {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(digits)}%`;
}

function fmtPp(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)} pp`;
}

function fmtScore(value) {
  return Number(value).toFixed(1);
}

function fmtDeltaSeconds(value) {
  const abs = Math.abs(Number(value) || 0);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${abs.toFixed(1)}s`;
}

function fmtDeltaTokens(value) {
  const abs = Math.abs(Number(value) || 0);
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.round(abs).toLocaleString()}`;
}

function verdictLabel(value) {
  if (value === "enable") return "Enable";
  if (value === "review") return "Review";
  return "Skip";
}

function verdictClass(value) {
  if (value === "enable") return "is-enable";
  if (value === "review") return "is-review";
  return "is-skip";
}

function riskClass(value) {
  if (value === "low") return "risk-low";
  if (value === "medium") return "risk-medium";
  return "risk-high";
}

function currentSkillKey() {
  const params = new URLSearchParams(window.location.search);
  return params.get("skill") || "academic-researcher";
}

function currentSkill() {
  const key = currentSkillKey();
  const actual = (state.dashboard?.examples || []).find((row) => row.skillName === key);
  if (actual) {
    const demo = demoSkills.find((row) => row.id === key || row.skill === key) || {};
    const delta = Number(actual.effectiveness?.passDeltaRate ?? 0);
    const exceptions = Number(actual.reliabilityError?.wiExceptionScenarios ?? 0);
    const verdict = exceptions > 0 ? "review" : delta > 0.05 ? "enable" : delta < -0.05 ? "skip" : "review";
    const rationale = verdict === "enable"
      ? "The skill-enabled agent performs better on the generated tasks, with no blocking reliability signal in this sample."
      : verdict === "skip"
        ? "The no-skill baseline performs better on the generated tasks in this sample."
        : "The generated-task evidence is mixed or affected by reliability issues, so this skill needs review before enabling.";

    return {
      id: actual.skillName,
      skill: actual.skillName,
      domain: actual.categoryLabel || actual.category || demo.domain || "Skill evaluation",
      actual,
      utility: {
        score: Math.max(0, delta),
        validScenarios: actual.scenarioCount || 0,
        wiPass: actual.effectiveness?.wiPassRate,
        woPass: actual.effectiveness?.woPassRate,
      },
      safety: demo.safety || { score: 90.0, riskLevel: "not shown", deductions: [] },
      cost: demo.cost || {
        deltaTimeS: Number(actual.executionTime?.deltaSeconds ?? 0),
        deltaEffectiveTokens: Number(actual.costApiUsage?.tokenDelta ?? 0),
      },
      recommendation: { verdict, rationale },
    };
  }
  return demoSkills.find((row) => row.id === key || row.skill === key) ||
    demoSkills.find((row) => row.id === "academic-researcher") ||
    demoSkills[0];
}

function currentTasks() {
  const skill = currentSkill();
  const actualScenarios = skill.actual?.scenarios || [];
  if (actualScenarios.length) {
    return actualScenarios.map((scenario) => {
      const capability = scenario.coreCapabilities?.[0] ||
        scenario.testMechanismPreview ||
        scenario.instructionPreview ||
        "Generated from this skill's documented capability.";
      return {
        title: scenario.label || "Generated evaluation task",
        capability: compactText(capability, 170),
        wiPass: Number(scenario.wiPassRate ?? 0),
        woPass: Number(scenario.woPassRate ?? 0),
        evidence: compactText(scenario.utilitySummary || scenario.judgeError || "Paired WI/WO execution evidence collected for this task.", 220),
      };
    });
  }
  return generatedTasksBySkill[skill.id] || generatedTasksBySkill["academic-researcher"];
}

function taskUtilityScore(tasks) {
  return mean(tasks.map((task) => {
    const gap = Math.max(1 - task.woPass, 0.0001);
    return Math.max(0, (task.wiPass - task.woPass) / gap);
  }));
}

function renderReportIdentity() {
  const skill = currentSkill();
  el("report-title").textContent = `Report for ${skill.skill}`;
  el("report-subtitle").textContent =
    `${skill.domain}. This report compares generated tasks with the skill enabled against the same tasks without the skill.`;
  el("candidate-skill-name").textContent = skill.skill;
}

function summarize() {
  const skill = currentSkill();
  const tasks = currentTasks();
  const avgWi = mean(tasks.map((s) => s.wiPass));
  const avgWo = mean(tasks.map((s) => s.woPass));
  const avgUtility = taskUtilityScore(tasks);

  return {
    taskCount: tasks.length,
    avgWi,
    avgWo,
    avgUtility,
    safety: skill.safety.score,
    verdict: verdictLabel(skill.recommendation.verdict),
  };
}

function renderPipeline() {
  el("pipeline-steps").innerHTML = pipelineSteps.map((item) => `
    <article class="pipeline-step">
      <div class="pipeline-index">${escapeHtml(item.step)}</div>
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.body)}</p>
      <code>${escapeHtml(item.artifact)}</code>
    </article>
  `).join("");
}

function renderOverview() {
  const s = summarize();
  const cards = [
    { label: "Input skill", value: "1", hint: "candidate skill package" },
    { label: "Generated tasks", value: s.taskCount.toString(), hint: "from skill capabilities" },
    {
      label: "Task executions",
      value: String(s.taskCount * 2),
      hint: `${s.taskCount} tasks × WI / WO conditions`,
      matrix: s.taskCount,
    },
    { label: "Mean utility", value: fmtScore(s.avgUtility), hint: `${fmtPp(s.avgWi - s.avgWo)} WI over WO`, tone: "good" },
    { label: "Safety", value: fmtScore(s.safety), hint: "deployment risk score", tone: s.safety >= 85 ? "good" : "warn" },
    { label: "Verdict", value: s.verdict, hint: "recommendation for this skill", tone: "good" },
  ];

  el("overview-cards").innerHTML = cards.map((card) => {
    const matrixHtml = card.matrix ? renderMetricMatrix(card.matrix) : "";
    const variant = card.matrix ? " metric-card--matrix" : "";
    return `
      <article class="metric-card${variant}">
        <div class="metric-label">${escapeHtml(card.label)}</div>
        <div class="metric-value ${escapeHtml(card.tone || "")}">${escapeHtml(card.value)}</div>
        ${matrixHtml}
        <div class="metric-hint">${escapeHtml(card.hint)}</div>
      </article>
    `;
  }).join("");
}

function renderMetricMatrix(taskCount) {
  const safe = Math.max(0, Math.min(20, Number(taskCount) || 0));
  const cells = (cond) =>
    Array.from({ length: safe }, () => `<span data-cond="${cond}"></span>`).join("");
  return `
    <div class="metric-matrix" aria-hidden="true">
      <div class="metric-matrix__row" data-cond="wi">${cells("wi")}</div>
      <div class="metric-matrix__row" data-cond="wo">${cells("wo")}</div>
    </div>
  `;
}

function renderTaskMatrix() {
  el("task-tbody").innerHTML = currentTasks().map((task) => {
    const delta = task.wiPass - task.woPass;
    const winner = delta > 0.01 ? "WI leads" : delta < -0.01 ? "WO leads" : "Tie";
    return `
      <tr>
        <td>
          <div class="skill-name">${escapeHtml(task.title)}</div>
        </td>
        <td>${escapeHtml(task.capability)}</td>
        <td class="numeric strong">${fmtPct(task.wiPass)}</td>
        <td class="numeric">${fmtPct(task.woPass)}</td>
        <td>
          <span class="verdict-pill ${delta >= 0 ? "is-enable" : "is-skip"}">${escapeHtml(winner)} ${fmtPp(delta)}</span>
        </td>
        <td class="skill-note">${escapeHtml(task.evidence)}</td>
      </tr>
    `;
  }).join("");
}

function renderDecision() {
  const skill = currentSkill();
  const tasks = currentTasks();
  const avgWi = mean(tasks.map((task) => task.wiPass));
  const avgWo = mean(tasks.map((task) => task.woPass));
  const utilityScore = taskUtilityScore(tasks);

  el("decision-panel").innerHTML = `
    <div class="decision-grid">
      <div>
        <span>Task gain</span>
        <strong>${escapeHtml(fmtScore(utilityScore))}</strong>
        <small>WI ${escapeHtml(fmtPct(avgWi))} vs WO ${escapeHtml(fmtPct(avgWo))}</small>
      </div>
      <div>
        <span>Safety</span>
        <strong>${escapeHtml(fmtScore(skill.safety.score))}</strong>
        <small>${escapeHtml(skill.safety.riskLevel.toUpperCase())} observed risk</small>
      </div>
      <div>
        <span>Cost</span>
        <strong>${escapeHtml(fmtDeltaSeconds(skill.cost.deltaTimeS))}</strong>
        <small>${escapeHtml(fmtDeltaTokens(skill.cost.deltaEffectiveTokens))} effective tokens</small>
      </div>
    </div>
    <div class="decision-verdict">${escapeHtml(verdictLabel(skill.recommendation.verdict))} this skill</div>
    <p>${escapeHtml(skill.recommendation.rationale)}</p>
  `;
}

function groupedByDomain() {
  return currentTasks().map((task, index) => ({
    domain: `Task ${index + 1}`,
    wi: task.wiPass,
    wo: task.woPass,
  }));
}

function safetyByCategory() {
  const out = new Map();
  for (const row of demoSkills) {
    for (const item of row.safety.deductions) {
      const bucket = out.get(item.category) || { category: item.category, H: 0, M: 0, L: 0 };
      bucket[item.severity] += item.deduction;
      out.set(item.category, bucket);
    }
  }
  return [...out.values()]
    .map((d) => ({ ...d, total: d.H + d.M + d.L }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 7);
}

function dpiCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function drawPassChart() {
  const canvas = el("pass-chart");
  const { ctx, w, h } = dpiCanvas(canvas);
  const rows = groupedByDomain();
  ctx.clearRect(0, 0, w, h);

  const padL = 142;
  const padR = 26;
  const padT = 24;
  const padB = 32;
  const plotW = w - padL - padR;
  const rowH = (h - padT - padB) / rows.length;

  ctx.font = '12px "SFMono-Regular", Consolas, monospace';
  ctx.fillStyle = "rgba(8, 47, 59, 0.46)";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 5; i++) {
    const v = i / 5;
    const x = padL + plotW * v;
    ctx.strokeStyle = "rgba(8, 47, 59, 0.08)";
    ctx.beginPath();
    ctx.moveTo(x, padT - 4);
    ctx.lineTo(x, h - padB + 8);
    ctx.stroke();
    ctx.fillText(`${Math.round(v * 100)}%`, x, h - padB + 12);
  }

  rows.forEach((row, idx) => {
    const y = padT + idx * rowH + 8;
    const barH = Math.max(9, rowH * 0.24);
    ctx.fillStyle = "#0c5f72";
    ctx.fillRect(padL, y, plotW * row.wi, barH);
    ctx.fillStyle = "rgba(201, 139, 35, 0.72)";
    ctx.fillRect(padL, y + barH + 6, plotW * row.wo, barH);

    ctx.fillStyle = "#082f3b";
    ctx.font = "12px Inter, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(row.domain, padL - 12, y + barH + 4);

    ctx.font = '11px "SFMono-Regular", Consolas, monospace';
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(8, 47, 59, 0.58)";
    ctx.fillText(fmtPp(row.wi - row.wo), padL + plotW * Math.max(row.wi, row.wo) + 8, y + barH + 4);
  });
}

function renderAll() {
  renderReportIdentity();
  renderPipeline();
  renderOverview();
  renderTaskMatrix();
  renderDecision();
  drawPassChart();
}

function install() {
  window.addEventListener("resize", () => {
    drawPassChart();
  });
}

async function load() {
  try {
    state.dashboard = await fetchJson(buildQuery("/api/examples/summary", { examplesDir: examplesDir() }));
  } catch (error) {
    state.dashboard = null;
  }
  renderAll();
}

install();
load();
