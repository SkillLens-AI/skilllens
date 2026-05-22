/* SkillLens project page — runtime
 *
 * Loads:
 *   data/skills.json     (227 skills index)
 *   data/stats.json      (totals + categories)
 *   data/inbox.json      (12 curated high-impact findings)
 *   data/skill/<name>.json  (lazy: full evidence per skill)
 *
 * Renders:
 *   Hero stats + lookup with autocomplete
 *   Lens view (replaces "verdict card") with 5 tabs:
 *     summary · evidence · compare wi/wo · findings · raw json
 *   Evidence Inbox (12 curated, expandable to 227)
 */
(function () {
  "use strict";

  const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
  const DEFAULT_SKILL = "docx";

  /* ----------------------------------------------------- helpers */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class")        node.className = attrs[k];
        else if (k === "html")    node.innerHTML = attrs[k];
        else if (k === "text")    node.textContent = attrs[k];
        else if (k === "style")   node.setAttribute("style", attrs[k]);
        else if (k === "data") {
          Object.keys(attrs.data).forEach(function (dk) { node.dataset[dk] = attrs.data[dk]; });
        } else if (typeof attrs[k] === "boolean") {
          if (attrs[k]) node.setAttribute(k, "");
        } else {
          node.setAttribute(k, attrs[k]);
        }
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function fmtPP(v, digits) {
    if (v == null || isNaN(v)) return "—";
    const sign = v > 0 ? "+" : "";
    return sign + (v * 100).toFixed(digits == null ? 1 : digits);
  }

  function fmtFraction(v, digits) {
    if (v == null || isNaN(v)) return "—";
    return v.toFixed(digits == null ? 2 : digits);
  }

  function categoryLabel(id) {
    if (!id) return "—";
    return id.split("-").map(function (s) { return s.charAt(0).toUpperCase() + s.slice(1); }).join(" ");
  }

  function safeText(s, max) {
    if (!s) return "";
    if (max && s.length > max) return s.slice(0, max - 1) + "…";
    return s;
  }

  /* Highlight quoted spans in trace text. Detects single-quoted strings,
   * backtick spans, and assignment-shaped tokens. */
  function highlightTrace(text) {
    if (!text) return [document.createTextNode("")];
    const out = [];
    // Match: 'text' or "text" or `text` or token=value or /etc/path
    const pattern = /'[^']{2,80}'|"[^"]{2,80}"|`[^`]{2,80}`|\b[A-Z_]{3,}=[\w\/.\-:]+|\/(etc|tmp|var|home|root)\/[\w\/.\-]+|<[^>]{2,40}>/g;
    let last = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
      out.push(el("mark", null, m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(document.createTextNode(text.slice(last)));
    return out;
  }

  function loadJson(url) {
    return fetch(url, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("fetch " + url + " => " + r.status);
      return r.json();
    });
  }

  /* ----------------------------------------------- 1. tier classification */

  function effectivenessTier(g) {
    if (g == null || isNaN(g))    return { tone: "neutral", word: "Unknown" };
    if (g >= 0.20)                return { tone: "good",    word: "High gain" };
    if (g >= 0.05)                return { tone: "good",    word: "Modest gain" };
    if (g > 0)                    return { tone: "warn",    word: "Marginal" };
    if (g === 0)                  return { tone: "neutral", word: "No gain" };
    return { tone: "bad", word: "Regression" };
  }
  function efficiencyTier(e) {
    if (e == null || isNaN(e))    return { tone: "neutral", word: "Unknown" };
    if (e >= 0.30)                return { tone: "good",    word: "Faster" };
    if (e > 0)                    return { tone: "warn",    word: "Mixed" };
    return { tone: "neutral", word: "Overhead" };
  }
  function safetyTier(s, findings) {
    if (s == null) return { tone: "neutral", word: "Untested" };
    const triggered = (findings || []).filter(function (f) { return f.risk_triggered === true; }).length;
    if (s >= 95)                  return { tone: "good", word: "Clean" };
    if (s >= 80 && triggered === 0) return { tone: "good", word: "Low risk" };
    if (s >= 65)                  return { tone: "warn", word: "Use with care" };
    if (s >= 40)                  return { tone: "bad",  word: "High risk" };
    return { tone: "bad", word: "Do not install" };
  }

  /* The headline plain-English verdict — what the user really wants to see. */
  function overallVerdict(u, s) {
    const g = u && u.pass_rate_gain;
    const score = s && s.score;
    const findings = (s && s.findings) || [];
    const triggered = findings.filter(function (f) { return f.risk_triggered === true; }).length;

    // Catastrophic safety wins
    if (score != null && score < 50) {
      return {
        tone: "bad",
        word: "DO NOT INSTALL",
        glyph: "⛔",
        reason: triggered + " confirmed exploit" + (triggered === 1 ? "" : "s") +
                " in the runtime sandbox" + (g != null && g > 0.10 ? "  ·  even though it shows " + (g * 100).toFixed(0) + "&nbsp;pp gain over baseline." : "."),
      };
    }
    // Performance regression
    if (g != null && g < -0.05) {
      return {
        tone: "bad",
        word: "SKIP",
        glyph: "✗",
        reason: "Installing this skill makes the agent " + (Math.abs(g) * 100).toFixed(1) + " pp worse than the no-skill baseline.",
      };
    }
    // Real risks but useful — sandbox required
    if (score != null && score < 65) {
      return {
        tone: "bad",
        word: "SANDBOX ONLY",
        glyph: "⚠",
        reason: "Useful (" + (g != null ? ((g >= 0 ? "+" : "") + (g * 100).toFixed(0) + " pp") : "—") +
                ") but " + triggered + " confirmed exploit" + (triggered === 1 ? "" : "s") +
                " — only adopt behind a hardened sandbox.",
      };
    }
    // Borderline safety — test first
    if (score != null && score < 90) {
      const wording = (g != null && g >= 0.05)
        ? "Useful (+" + (g * 100).toFixed(0) + " pp) with weak findings; pilot before rollout."
        : "Marginal value with weak findings; prefer alternatives if you have any.";
      return {
        tone: "warn",
        word: "TEST FIRST",
        glyph: "⊘",
        reason: wording,
      };
    }
    // Safe — but is it useful?
    if (g != null && g >= 0.05) {
      return {
        tone: "good",
        word: "ADOPT",
        glyph: "✓",
        reason: "Safe to install — " + (g * 100).toFixed(0) + " pp gain over the no-skill baseline with no triggered risks.",
      };
    }
    if (g != null && g <= 0) {
      return {
        tone: "neutral",
        word: "NO MEASURED VALUE",
        glyph: "◎",
        reason: "Safe to install but does not measurably improve task completion above the no-skill baseline.",
      };
    }
    return {
      tone: "warn",
      word: "MARGINAL",
      glyph: "○",
      reason: "Small effectiveness gain with no triggered risks. Worth installing if it solves a specific task.",
    };
  }

  /* ------------------------------------------------- 2. Lens view render */

  function renderLensView(detail) {
    const view = document.getElementById("lens-view");
    if (!view) return;
    view.dataset.state = "loaded";

    const u = detail.utility || {};
    const s = detail.safety || {};

    const effT = effectivenessTier(u.pass_rate_gain);
    const eff2 = efficiencyTier(u.efficiency_score);
    const safT = safetyTier(s.score, s.findings);
    const verdict = overallVerdict(u, s);

    view.innerHTML = "";

    // ---- HEAD: which skill we're inspecting ----
    const head = el("div", { class: "lens-head fade-in" });
    const who = el("div", { class: "who" });
    who.appendChild(el("span", { class: "now" }, "Inspecting"));
    who.appendChild(el("h2", null, detail.name));
    const owner = detail.owner && detail.owner !== "unknown" ? detail.owner : null;
    const sourceParts = [];
    sourceParts.push(document.createTextNode(owner ? "by " : "source "));
    sourceParts.push(el("b", { style: "color: var(--fg-2);" }, owner || "unknown"));
    if (owner) {
      sourceParts.push(document.createTextNode("  ·  github.com/" + owner + "/" + detail.name));
    }
    who.appendChild(el("span", { class: "skill-cat" }, sourceParts));
    head.appendChild(who);
    view.appendChild(head);

    // ---- BIG VERDICT PILL (the headline answer) ----
    const verdictBlock = el("div", { class: "lens-verdict fade-in" });
    const pill = el("div", { class: "lens-verdict-pill tone-" + verdict.tone });
    pill.appendChild(el("span", { class: "word" }, [
      el("span", { class: "glyph" }, verdict.glyph || ""),
      document.createTextNode(verdict.word),
    ]));
    const reason = el("span", { class: "reason" });
    reason.innerHTML = verdict.reason; // contains an &nbsp; escape sequence
    pill.appendChild(reason);
    verdictBlock.appendChild(pill);
    const actions = el("div", { class: "lens-verdict-actions" });
    actions.appendChild(el("span", { class: "replay-tag" }, "replay · frozen 2026-05-04"));
    actions.appendChild(el("span", { class: "id" }, "run_" + Math.abs(hashCode(detail.name)).toString(16).slice(0, 6)));
    verdictBlock.appendChild(actions);
    view.appendChild(verdictBlock);

    // ---- METRICS ----
    const metrics = el("div", { class: "lens-metrics fade-in" }, [
      metricTile("Effectiveness", fmtPP(u.pass_rate_gain), "pp", effT,
        u.total_items ? "wi  " + (u.wi_passed_items || 0) + "  vs  wo  " + (u.wo_passed_items || 0) + "   ·  " + u.total_items + " judge items" : ""),
      metricTile("Efficiency", u.efficiency_score == null ? "—" : fmtFraction(u.efficiency_score, 2), null, eff2, "time + token savings"),
      metricTile("Safety", s.score == null ? "—" : Number(s.score).toFixed(1), "/100", safT,
        ((s.findings || []).length === 0) ? "no findings" : (s.findings || []).filter(function (f) { return f.risk_triggered === true; }).length + " of " + (s.findings || []).length + " triggered"),
    ]);
    view.appendChild(metrics);

    // ---- TABS ----
    const tabs = [
      { id: "summary",  label: "Summary",         count: null },
      { id: "evidence", label: "Evidence",        count: (s.findings || []).length },
      { id: "compare",  label: "Compare wi/wo",   count: (u.judge_scenarios || [])[0] ? (u.judge_scenarios[0].items || []).length : null },
      { id: "findings", label: "Findings",        count: (s.findings || []).length },
      { id: "json",     label: "Raw JSON",        count: null },
    ];
    const tabsRow = el("div", { class: "lens-tabs", role: "tablist" });
    tabs.forEach(function (t, i) {
      const btn = el("button", {
        class: "lens-tab" + (i === 0 ? " is-active" : ""),
        type: "button", role: "tab", "data-tab": t.id,
      }, [
        document.createTextNode(t.label),
        t.count != null ? el("span", { class: "ct" }, String(t.count)) : null,
      ]);
      tabsRow.appendChild(btn);
    });
    view.appendChild(tabsRow);

    // ---- PANES ----
    const panes = el("div", { class: "lens-panes fade-in" });
    panes.appendChild(paneSummary(detail, effT, safT));
    panes.appendChild(paneEvidence(detail));
    panes.appendChild(paneCompare(detail));
    panes.appendChild(paneFindings(detail));
    panes.appendChild(paneJson(detail));
    view.appendChild(panes);

    tabsRow.addEventListener("click", function (e) {
      const t = e.target.closest(".lens-tab");
      if (!t) return;
      $$(".lens-tab", view).forEach(function (b) { b.classList.toggle("is-active", b === t); });
      $$(".lens-pane", view).forEach(function (p) { p.classList.toggle("hidden", p.dataset.tab !== t.dataset.tab); });
    });
    $$(".lens-pane", view).forEach(function (p, i) { p.classList.toggle("hidden", i !== 0); });
  }

  function hashCode(s) {
    let h = 0;
    if (!s) return 0;
    for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
    return h;
  }

  function metricTile(lbl, val, unit, tier, sub) {
    const tile = el("div", { class: "lens-metric tone-" + tier.tone });
    tile.appendChild(el("span", { class: "lbl" }, lbl));
    tile.appendChild(el("span", { class: "val" }, [
      document.createTextNode(val),
      unit ? el("span", { class: "unit" }, unit) : null,
    ]));
    tile.appendChild(el("span", { class: "verdict-pill" }, tier.word));
    if (sub) {
      tile.appendChild(el("span", { class: "lbl", style: "margin-top: 12px; text-transform: none; letter-spacing: 0.04em;" }, sub));
    }
    return tile;
  }

  /* ----- summary pane ----- */
  function paneSummary(detail, effT, safT) {
    const u = detail.utility || {};
    const s = detail.safety || {};
    const wrap = el("div", { class: "lens-pane", "data-tab": "summary" });
    const inner = el("div", { class: "lens-summary" });

    const totalItems = u.total_items || 0;
    const wi = u.wi_passed_items || 0;
    const wo = u.wo_passed_items || 0;
    const findings = s.findings || [];
    const triggered = findings.filter(function (f) { return f.risk_triggered === true; }).length;

    inner.appendChild(el("p", null,
      "Across " + ((u.scenarios || []).length) + " scenarios the agent passed " +
      wi + " of " + totalItems + " judge items with the skill, and " + wo + " of " + totalItems +
      " without. The security judge produced " + findings.length + " finding" + (findings.length === 1 ? "" : "s") +
      "; " + triggered + " " + (triggered === 1 ? "was" : "were") + " end-to-end triggered in the sandbox."
    ));

    if ((u.scenarios || []).length) {
      const row = el("div", { class: "scenarios-row" });
      (u.scenarios || []).forEach(function (sc) {
        if (sc.valid) {
          const valCls = (sc.pass_rate_gain != null && sc.pass_rate_gain > 0) ? "gain-pos" : (sc.pass_rate_gain === 0 ? "gain-zero" : "");
          row.appendChild(el("div", { class: "scenario-cell" }, [
            el("span", { class: "lab" }, sc.id + " · valid"),
            el("span", { class: "val " + valCls }, sc.pass_rate_gain == null ? "—" :
              ((sc.pass_rate_gain >= 0 ? "+" : "") + (sc.pass_rate_gain * 100).toFixed(1) + " pp")),
            el("span", { class: "sub" }, "wi " + sc.wi_passed + " / wo " + sc.wo_passed + " of " + sc.total_items),
          ]));
        } else {
          row.appendChild(el("div", { class: "scenario-cell invalid" }, [
            el("span", { class: "lab" }, sc.id + " · skipped"),
            el("span", { class: "val" }, "invalid"),
            el("span", { class: "sub" }, ((sc.invalid_reason || "—").split(":")[0])),
          ]));
        }
      });
      inner.appendChild(row);
    }

    inner.appendChild(el("div", { class: "reading" }, [
      document.createTextNode("Read effectiveness and safety as "),
      el("strong", null, "two independent axes"),
      document.createTextNode(". A skill can be highly effective and unsafe; a safe skill can have zero gain. The lens reports both verbatim."),
    ]));

    wrap.appendChild(inner);
    return wrap;
  }

  /* ----- evidence pane (Sentry-style finding cards with highlighted traces) ----- */
  function paneEvidence(detail) {
    const s = detail.safety || {};
    const wrap = el("div", { class: "lens-pane", "data-tab": "evidence" });
    const findings = s.findings || [];
    if (!findings.length) {
      wrap.appendChild(el("p", { style: "color: var(--fg-4); font-family: var(--font-mono); font-size: 13px;" },
        "No findings — the static scanner reported no risks for this skill."));
      return wrap;
    }
    const list = el("div", { class: "evidence-list" });
    findings.forEach(function (f) { list.appendChild(findingCard(f)); });
    wrap.appendChild(list);
    return wrap;
  }

  function findingCard(f) {
    const sev = (f.severity || "L").toLowerCase();
    const card = el("div", { class: "evidence-card sev-" + sev });
    card.appendChild(el("div", { class: "severity-strip" }));
    const body = el("div", { class: "evidence-card-body" });

    const v = (f.trigger_verdict || "—");
    const head = el("div", { class: "evidence-card-head" });
    head.appendChild(el("div", { class: "id-row" }, [
      document.createTextNode(f.finding_id || ""),
      el("span", { class: "sev-pill" }, f.severity || "—"),
    ]));
    head.appendChild(el("span", { class: "verdict-mono " + v }, v.replace(/_/g, " ")));
    body.appendChild(head);

    body.appendChild(el("div", { class: "pattern" }, [
      document.createTextNode(f.pattern_name || "—"),
      f.category ? el("span", { class: "cat" }, " · " + f.category) : null,
    ]));

    if (f.rationale) {
      body.appendChild(el("div", { class: "trace" }, highlightTrace(f.rationale)));
    }

    body.appendChild(el("div", { class: "meters" }, [
      meterCell("Existence", f.existence_confidence, ""),
      meterCell("Exploitability", f.exploitability, "exploit"),
    ]));

    card.appendChild(body);
    return card;
  }

  function meterCell(lbl, val, mod) {
    const pct = (val == null) ? 0 : clamp(val, 0, 1) * 100;
    return el("div", { class: "meter " + mod }, [
      el("span", { class: "lab" }, lbl),
      el("span", { class: "track" }, [el("span", { class: "fill", style: "width:" + pct + "%" })]),
      el("span", { class: "num" }, val == null ? "—" : val.toFixed(2)),
    ]);
  }

  /* ----- compare wi/wo pane (GitHub-style split-diff per item) ----- */
  function paneCompare(detail) {
    const u = detail.utility || {};
    const wrap = el("div", { class: "lens-pane", "data-tab": "compare" });

    const total = u.total_items || 0;
    const wi = u.wi_passed_items || 0;
    const wo = u.wo_passed_items || 0;
    const wiPct = total > 0 ? (wi / total * 100) : 0;
    const woPct = total > 0 ? (wo / total * 100) : 0;

    // Top: paired bars summary
    const bars = el("div", { class: "compare-bars" });
    bars.appendChild(el("h4", null, "paired execution summary  ·  " + total + " judge items"));
    bars.appendChild(barRow("WO", "wo", woPct, wo, total));
    bars.appendChild(barRow("WI", "wi", wiPct, wi, total));
    const gainPP = total > 0 ? ((wi - wo) / total * 100) : 0;
    const dEl = el("div", { class: "compare-delta" });
    dEl.appendChild(document.createTextNode("Δ effectiveness "));
    const strong = el("strong", { class: gainPP < 0 ? "neg" : "" }, (gainPP > 0 ? "+" : "") + gainPP.toFixed(1) + " pp");
    dEl.appendChild(strong);
    dEl.appendChild(document.createTextNode("  ·  attributable to the skill, not the model."));
    bars.appendChild(dEl);
    wrap.appendChild(bars);

    // Per-item split blocks (from first scenario)
    const scen = (u.judge_scenarios || [])[0];
    if (!scen || !(scen.items || []).length) {
      wrap.appendChild(el("p", { style: "color: var(--fg-4); font-family: var(--font-mono); font-size: 13px;" },
        "No per-item judge evidence available for this skill."));
      return wrap;
    }

    (scen.items || []).slice(0, 5).forEach(function (item) {
      let deltaTag, deltaCls;
      if (item.wi_score === 1 && item.wo_score === 0) { deltaTag = "wi NEW PASS"; deltaCls = "new-pass"; }
      else if (item.wi_score === 0 && item.wo_score === 1) { deltaTag = "wo REGRESSION"; deltaCls = "regression"; }
      else if (item.wi_score === 1 && item.wo_score === 1) { deltaTag = "BOTH PASS"; deltaCls = "tied"; }
      else { deltaTag = "BOTH FAIL"; deltaCls = "tied"; }

      const block = el("div", { class: "compare-block" });
      const head = el("div", { class: "compare-block-head" });
      head.appendChild(el("span", { class: "id" }, scen.scenario_id + " · " + item.item_id));
      head.appendChild(el("span", { class: "delta-tag " + deltaCls }, deltaTag));
      block.appendChild(head);

      block.appendChild(el("div", { class: "compare-criterion" }, [
        el("span", { class: "id" }, "[" + item.item_id + "]"),
        document.createTextNode(item.criterion || ""),
      ]));

      const split = el("div", { class: "compare-split" });
      // wo
      const woSide = el("div", { class: "compare-side wo" });
      woSide.appendChild(el("div", { class: "side-head" }, [
        el("span", null, "wo · without skill"),
        el("span", { class: "badge " + (item.wo_score === 1 ? "pass" : "fail") }, item.wo_score === 1 ? "PASS" : "FAIL"),
      ]));
      woSide.appendChild(el("p", { style: "margin: 0;" }, item.wo_reason || "—"));
      split.appendChild(woSide);
      split.appendChild(el("div", { class: "compare-divider" }));
      // wi
      const wiSide = el("div", { class: "compare-side wi" });
      wiSide.appendChild(el("div", { class: "side-head" }, [
        el("span", null, "wi · with skill"),
        el("span", { class: "badge " + (item.wi_score === 1 ? "pass" : "fail") }, item.wi_score === 1 ? "PASS" : "FAIL"),
      ]));
      wiSide.appendChild(el("p", { style: "margin: 0;" }, item.wi_reason || "—"));
      split.appendChild(wiSide);

      block.appendChild(split);
      wrap.appendChild(block);
    });

    return wrap;
  }

  function barRow(label, mod, pct, num, total) {
    const fill = el("span", { class: "fill", "data-label": Math.round(pct) + "%", style: "width:" + Math.max(pct, 1) + "%;" });
    return el("div", { class: "compare-bar-row " + mod }, [
      el("span", { class: "lab" }, label),
      el("span", { class: "track" }, fill),
      el("span", { class: "num" }, [document.createTextNode(num + " / " + total), el("small", null, "passed")]),
    ]);
  }

  /* ----- findings pane (full list, not just the first 5) ----- */
  function paneFindings(detail) {
    const wrap = el("div", { class: "lens-pane", "data-tab": "findings" });
    const findings = (detail.safety || {}).findings || [];
    if (!findings.length) {
      wrap.appendChild(el("p", { style: "color: var(--fg-4); font-family: var(--font-mono); font-size: 13px;" }, "No findings."));
      return wrap;
    }
    const list = el("div", { class: "evidence-list" });
    findings.forEach(function (f) { list.appendChild(findingCard(f)); });
    wrap.appendChild(list);
    return wrap;
  }

  /* ----- raw json pane ----- */
  function paneJson(detail) {
    const wrap = el("div", { class: "lens-pane json-pane", "data-tab": "json" });
    const head = el("div", { class: "header-row" });
    head.appendChild(el("h4", null, "skill_report.json"));
    const dl = el("a", {
      class: "download",
      href: "data/skill/" + encodeURIComponent(detail.name) + ".json",
      download: detail.name + ".json",
    }, "↓ download");
    head.appendChild(dl);
    wrap.appendChild(head);
    wrap.appendChild(el("pre", null, JSON.stringify(detail, null, 2)));
    return wrap;
  }

  /* ------------------------------------------------- 3. lookup / autocomplete */

  function setupLookup(idx) {
    const form = document.getElementById("lookup-form");
    const input = document.getElementById("lookup-input");
    const optsBox = document.getElementById("lookup-options");
    const suggestRoot = document.getElementById("lookup-suggest");

    let activeIdx = -1;
    let currentList = [];

    function render(query) {
      const q = (query || "").trim().toLowerCase();
      if (!q) { optsBox.classList.remove("show"); optsBox.innerHTML = ""; currentList = []; return; }
      const matches = idx.skills.filter(function (s) {
        return s.name.toLowerCase().indexOf(q) !== -1
            || (s.owner || "").toLowerCase().indexOf(q) !== -1
            || (s.category || "").toLowerCase().indexOf(q) !== -1;
      }).slice(0, 12);
      optsBox.innerHTML = "";
      currentList = matches;
      activeIdx = -1;
      if (!matches.length) {
        optsBox.appendChild(el("div", { class: "lookup-option", style: "color:var(--fg-4);" },
          "No skills match \"" + q + "\"."));
      } else {
        matches.forEach(function (s) {
          const opt = el("div", { class: "lookup-option", role: "option", "data-skill": s.name });
          opt.appendChild(el("span", { class: "name" }, s.name));
          opt.appendChild(el("span", { class: "meta" }, "safety " + (s.safety_score == null ? "—" : s.safety_score.toFixed(0)) + " · " + categoryLabel(s.category).slice(0, 28)));
          opt.addEventListener("mousedown", function (e) { e.preventDefault(); select(s.name); });
          optsBox.appendChild(opt);
        });
      }
      optsBox.classList.add("show");
    }

    function select(name) {
      input.value = name;
      optsBox.classList.remove("show");
      loadSkill(name);
    }

    input.addEventListener("input", function () { render(input.value); });
    input.addEventListener("focus", function () { if (input.value) render(input.value); });
    input.addEventListener("blur", function () { setTimeout(function () { optsBox.classList.remove("show"); }, 200); });

    input.addEventListener("keydown", function (e) {
      if (!optsBox.classList.contains("show")) return;
      const items = $$(".lookup-option[data-skill]", optsBox);
      if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(items.length - 1, activeIdx + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); }
      else if (e.key === "Enter") {
        if (activeIdx >= 0 && currentList[activeIdx]) { e.preventDefault(); select(currentList[activeIdx].name); return; }
      } else if (e.key === "Escape") { optsBox.classList.remove("show"); return; }
      items.forEach(function (it, i) { it.classList.toggle("is-active", i === activeIdx); });
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      const exact = idx.skills.find(function (s) { return s.name === q; });
      if (exact) { select(exact.name); return; }
      const list = idx.skills.filter(function (s) { return s.name.toLowerCase().indexOf(q.toLowerCase()) !== -1; });
      if (list[0]) { select(list[0].name); }
    });

    if (suggestRoot) {
      suggestRoot.addEventListener("click", function (e) {
        const btn = e.target.closest("button[data-skill]");
        if (!btn) return;
        select(btn.dataset.skill);
      });
    }

    // hero pane "Open full lens view →" button
    document.querySelectorAll("[data-skill-jump]").forEach(function (btn) {
      btn.addEventListener("click", function () { select(btn.dataset.skillJump); });
    });
  }

  function loadSkill(name) {
    const view = document.getElementById("lens-view");
    if (view) {
      view.dataset.state = "loading";
      view.innerHTML = "";
      view.appendChild(el("div", { class: "lens-empty" }, "Loading evidence for " + name + "…"));
    }
    return loadJson("data/skill/" + encodeURIComponent(name) + ".json").then(function (d) {
      renderLensView(d);
      const target = document.getElementById("lens-view");
      if (target) {
        // scroll to a position 80px above the lens-view so the topbar doesn't cover it
        const y = target.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top: y, behavior: "smooth" });
      }
    }).catch(function (err) {
      console.error("[skilllens] failed to load detail for", name, err);
      if (view) {
        view.innerHTML = "";
        view.appendChild(el("div", { class: "lens-empty" }, "Could not load detail for \"" + name + "\"."));
      }
    });
  }

  /* ------------------------------------------------- 4. Evidence Inbox */

  let INBOX_STATE = {
    items: [],
    skillsFull: [],
    filter: "all",
    expanded: false,
  };

  function setupInbox(inbox, idx) {
    INBOX_STATE.items = inbox.items || [];
    INBOX_STATE.skillsFull = idx.skills || [];

    const filterRow = document.getElementById("inbox-filters");
    if (filterRow) {
      filterRow.addEventListener("click", function (e) {
        const btn = e.target.closest(".inbox-chip");
        if (!btn) return;
        INBOX_STATE.filter = btn.dataset.filter || "all";
        $$(".inbox-chip", filterRow).forEach(function (b) { b.classList.toggle("is-active", b === btn); });
        renderInbox();
      });
    }

    const showAll = document.getElementById("inbox-show-all");
    if (showAll) {
      showAll.addEventListener("click", function () {
        INBOX_STATE.expanded = !INBOX_STATE.expanded;
        showAll.textContent = INBOX_STATE.expanded ? "Show curated 12  ↑" : "Show all 227 audits  ↓";
        renderInbox();
      });
    }

    renderInbox();
  }

  function renderInbox() {
    const list = document.getElementById("inbox-list");
    if (!list) return;
    list.innerHTML = "";
    list.removeAttribute("aria-busy");

    if (INBOX_STATE.expanded) {
      // Render all 227 skills as compact inbox items, sorted by safety asc (riskiest first).
      const all = INBOX_STATE.skillsFull.slice().sort(function (a, b) {
        return (a.safety_score || 100) - (b.safety_score || 100);
      });
      all.forEach(function (s) { list.appendChild(skillInboxItem(s)); });
      return;
    }

    const items = INBOX_STATE.items.filter(function (it) {
      if (INBOX_STATE.filter === "all") return true;
      return (it.exploit_class || "").indexOf(INBOX_STATE.filter) !== -1;
    });

    if (!items.length) {
      list.appendChild(el("div", { class: "lens-empty" }, "No findings in this exploit class."));
      return;
    }
    items.forEach(function (it) { list.appendChild(findingInboxItem(it)); });
  }

  function findingInboxItem(it) {
    const sev = (it.severity || "L").toLowerCase();
    const item = el("div", { class: "inbox-item sev-" + sev, "data-skill": it.skill_name });
    item.appendChild(el("div", { class: "severity-strip" }));

    const body = el("div", { class: "inbox-item-body" });
    const head = el("div", { class: "inbox-item-head" });
    head.appendChild(el("span", { class: "skill" }, it.skill_name));
    head.appendChild(el("span", { class: "id" }, it.finding_id || ""));
    head.appendChild(el("span", { class: "sev-pill" }, it.severity || "—"));
    head.appendChild(el("span", { class: "exploit" }, it.exploit_class || "—"));
    body.appendChild(head);

    body.appendChild(el("div", { class: "inbox-item-pattern" }, it.pattern_name || "—"));
    if (it.rationale) {
      body.appendChild(el("div", { class: "inbox-item-trace" }, highlightTrace(it.rationale)));
    }
    item.appendChild(body);

    const meta = el("div", { class: "inbox-item-meta" });
    const sCls = (it.safety_score == null) ? "" : (it.safety_score >= 80 ? "good" : it.safety_score >= 50 ? "warn" : "bad");
    meta.appendChild(el("span", { class: "safety-num " + sCls }, it.safety_score == null ? "—" : it.safety_score.toFixed(0)));
    meta.appendChild(el("span", null, "safety"));
    if (it.pass_rate_gain != null) {
      meta.appendChild(el("span", { style: "margin-top: 8px;" }, fmtPP(it.pass_rate_gain) + " pp gain"));
    }
    item.appendChild(meta);

    item.addEventListener("click", function () { loadSkill(it.skill_name); });
    return item;
  }

  function skillInboxItem(s) {
    const sev = ((s.findings || {}).H ? "h" : (s.findings || {}).M ? "m" : (s.findings || {}).L ? "l" : "");
    const item = el("div", { class: "inbox-item " + (sev ? "sev-" + sev : "") + " fade-in", "data-skill": s.name });
    item.appendChild(el("div", { class: "severity-strip" }));

    const body = el("div", { class: "inbox-item-body" });
    const head = el("div", { class: "inbox-item-head" });
    head.appendChild(el("span", { class: "skill" }, s.name));
    head.appendChild(el("span", { class: "id" }, s.owner || ""));
    head.appendChild(el("span", { class: "exploit" }, categoryLabel(s.category).slice(0, 30)));
    body.appendChild(head);

    body.appendChild(el("div", { class: "inbox-item-pattern" },
      "scenarios " + (s.scenarios || 0) + "  ·  " + (s.wi_passed || 0) + " / " + (s.wo_passed || 0) + " wi/wo passes"));
    body.appendChild(el("div", { class: "inbox-item-trace" },
      "findings  H " + ((s.findings || {}).H || 0) +
      "  M " + ((s.findings || {}).M || 0) +
      "  L " + ((s.findings || {}).L || 0) +
      "  ·  triggered " + (s.findings_triggered || 0) +
      "  ·  effectiveness " + (s.pass_rate_gain == null ? "—" : ((s.pass_rate_gain >= 0 ? "+" : "") + (s.pass_rate_gain * 100).toFixed(1) + " pp"))));
    item.appendChild(body);

    const meta = el("div", { class: "inbox-item-meta" });
    const sc = s.safety_score;
    const sCls = (sc == null) ? "" : (sc >= 80 ? "good" : sc >= 50 ? "warn" : "bad");
    meta.appendChild(el("span", { class: "safety-num " + sCls }, sc == null ? "—" : sc.toFixed(0)));
    meta.appendChild(el("span", null, "safety"));
    item.appendChild(meta);

    item.addEventListener("click", function () { loadSkill(s.name); });
    return item;
  }

  /* ------------------------------------------------- 5. misc */

  function fillHeroStats(stats, idx) {
    const t = stats.totals || {};
    function set(id, v) { const n = document.getElementById(id); if (n && v != null) n.textContent = NUMBER_FORMAT.format(v); }
    set("m-skills",    t.skill_count);
    set("m-scenarios", t.scenario_count);
    set("m-judge",     t.judge_items);
    set("m-findings",  t.total_findings);
    set("m-trig",      t.findings_triggered);

    // Compute "unsafe" = skills with safety_score < 80 OR with any triggered finding.
    if (idx && idx.skills) {
      const unsafe = idx.skills.filter(function (sk) {
        return (sk.safety_score != null && sk.safety_score < 80) || (sk.findings_triggered || 0) > 0;
      }).length;
      set("m-unsafe", unsafe);
    }

    const ti = document.getElementById("inbox-total");
    if (ti && t.findings_triggered != null) ti.textContent = String(t.findings_triggered);
  }

  function setupReveal() {
    const items = $$(".reveal");
    if (!items.length || !("IntersectionObserver" in window)) {
      items.forEach(function (i) { i.classList.add("is-visible"); }); return;
    }
    const obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-visible"); obs.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });
    items.forEach(function (i) { obs.observe(i); });
  }

  function setupNavActive() {
    const links = $$(".topnav a[href^='#']");
    if (!links.length || !("IntersectionObserver" in window)) return;
    const map = {};
    links.forEach(function (a) {
      const id = a.getAttribute("href").slice(1);
      const node = document.getElementById(id);
      if (node) map[id] = a;
    });
    const obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        Object.keys(map).forEach(function (k) { map[k].classList.remove("is-active"); });
        if (map[e.target.id]) map[e.target.id].classList.add("is-active");
      });
    }, { rootMargin: "-30% 0px -55% 0px" });
    Object.keys(map).forEach(function (id) { obs.observe(document.getElementById(id)); });
  }

  function setupCopy() {
    const btn = document.getElementById("copy-bib");
    const pre = document.getElementById("bibtex");
    if (!btn || !pre) return;
    btn.addEventListener("click", function () {
      const text = pre.textContent || "";
      const done = function () {
        btn.textContent = "Copied to clipboard";
        btn.classList.add("is-copied");
        setTimeout(function () { btn.textContent = "Copy BibTeX"; btn.classList.remove("is-copied"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
        done();
      }
    });
  }

  /* --------------------------------------------------------------- boot */

  Promise.all([
    loadJson("data/skills.json"),
    loadJson("data/stats.json"),
    loadJson("data/inbox.json"),
  ]).then(function (results) {
    const idx = results[0];
    const stats = results[1];
    const inbox = results[2];

    fillHeroStats(stats, idx);
    setupLookup(idx);
    setupInbox(inbox, idx);
    setupReveal();
    setupNavActive();
    setupCopy();

    return loadJson("data/skill/" + encodeURIComponent(DEFAULT_SKILL) + ".json").then(function (d) {
      renderLensView(d);
    }).catch(function () {
      const view = document.getElementById("lens-view");
      if (view) {
        view.innerHTML = "";
        view.appendChild(el("div", { class: "lens-empty" }, "Type a skill name above to load its lens view."));
      }
    });
  }).catch(function (err) {
    console.error("[skilllens] boot failed", err);
    const view = document.getElementById("lens-view");
    if (view) {
      view.innerHTML = "";
      view.appendChild(el("div", { class: "lens-empty" }, "Could not load evaluation data. Run the page from a server (file:// blocks fetch on JSON)."));
    }
  });
})();
