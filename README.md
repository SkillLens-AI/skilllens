# SkillLens — Evaluation Harness

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20253170.svg)](https://doi.org/10.5281/zenodo.20253170)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Dataset License: CDLA-Permissive-2.0](https://img.shields.io/badge/Dataset-CDLA--Permissive--2.0-green.svg)](https://cdla.dev/permissive-2-0/)

**SkillLens** is an evaluation framework for Anthropic-style `/skill` markdown packages
consumed by LLM coding agents. Given a `SKILL.md` and its supporting files, SkillLens
generates utility and security probes, executes them inside an isolated Harbor
sandbox, captures the full agent trajectory, and produces an LLM-judge verdict on
two independent axes: **utility** (capability lift via `pass_rate_gain`) and
**security** (exploitability under adversarial conditions).

This repository is the open-source release of the SkillLens evaluation
framework, the companion to the arXiv preprint
**"SkillLens: From Task-First Evaluation to Skill-Centered Assessment"**.
The companion landing page is at
[`skilllens-ai.github.io`](https://skilllens-ai.github.io/).

---

> **Open-source release.**
> SkillLens is maintained by the [SkillLens-AI](https://github.com/SkillLens-AI)
> open-source community. The evaluation framework lives at
> [`SkillLens-AI/skilllens`](https://github.com/SkillLens-AI/skilllens) and its
> dependency [`SkillLens-AI/harbor`](https://github.com/SkillLens-AI/harbor)
> is an Apache-2.0 fork of [`laude-institute/harbor`](https://github.com/laude-institute/harbor)
> with a single SkillLens-specific patch (see [NOTICE](NOTICE)).
>
> **Dataset:** the evaluation traces and Croissant 1.0 + RAI/1.0 metadata are
> published as a separate Zenodo record, DOI [`10.5281/zenodo.20253170`](https://doi.org/10.5281/zenodo.20253170).
> License: **CDLA-Permissive-2.0**.

---

## Table of contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Repository layout](#repository-layout)
4. [Pipeline guide](#pipeline-guide)
   1. [Stage 1 — Scheme generation](#stage-1--scheme-generation)
   2. [Stage 2 — Task generation](#stage-2--task-generation)
   3. [Stage 3 — Execution via Harbor](#stage-3--execution-via-harbor)
   4. [Stage 4 — LLM judging](#stage-4--llm-judging)
5. [Reproducing paper results](#reproducing-paper-results)
6. [Configuration](#configuration)
7. [Trace artifacts](#trace-artifacts)
8. [Limitations](#limitations)
9. [License](#license)
10. [Citation](#citation)

---

## Quick start

```bash
# 1. Clone the framework and the vendored Harbor fork
git clone https://github.com/SkillLens-AI/skilllens.git
cd skilllens

# 2. Create a virtual environment and install (Python 3.12+)
uv venv
uv pip install -e .

# 3. Configure environment variables
cp .env.example .env
# Edit .env: set ANTHROPIC_API_KEY, OPENAI_API_KEY, HARBOR_HOME, CODEX_HOME, SKILLLENS_ROOT

# 4. Verify the install (prints CLI help, exits cleanly)
python -m skills_eval.task_judge.run_utility_judge --help
```

The first install pulls the pinned SkillLens Harbor fork from
`git+https://github.com/SkillLens-AI/harbor.git@bce6a018f70418daefc5c4f9aedd14cd1c79b907` (see
[`pyproject.toml`](pyproject.toml)). Harbor in turn provisions the Docker images
that run individual agent trials, so a working Docker daemon is required for
`task_execute/`. The judging stages call hosted LLM APIs only and need no GPU.

---

## Architecture

SkillLens is a four-stage pipeline. Each stage is independently runnable, persists
its artifacts to disk, and resumes idempotently from where it left off.

```
                ┌──────────────────────────────────────────────────────────┐
                │                      Skill corpus                        │
                │        <category>/<owner>/<skill>/SKILL.md (+ files)     │
                └────────────────────────────┬─────────────────────────────┘
                                             │
                       ┌─────────────────────▼──────────────────────┐
       Stage 1         │              task_scheme/                  │
       Scheme gen      │   utility_generate.py (3 utility probes)   │
                       │   security_generate.py (static scan +      │
                       │       dynamic scheme; up to 3 probes)      │
                       └─────────────────────┬──────────────────────┘
                                             │   utility_scheme.json
                                             │   security_scheme.json
                       ┌─────────────────────▼──────────────────────┐
       Stage 2         │              task_generate/                │
       Task gen        │   utility_generate.py — Harbor task.toml,  │
                       │       instruction.md, tests/, solution/    │
                       │   security_generate.py — same shape, with  │
                       │       adversarial trigger payloads         │
                       └─────────────────────┬──────────────────────┘
                                             │   tasks/<task_id>_wi_skills/
                                             │   tasks/<task_id>_wo_skills/
                       ┌─────────────────────▼──────────────────────┐
       Stage 3         │             task_execute/                  │
       Execution       │   execute_batch_utility.py                 │
                       │   execute_batch_security.py                │
                       │   ──> Harbor Job(LOCAL orchestrator)       │
                       │       launches Docker sandbox, runs agent, │
                       │       captures trajectory + verifier       │
                       └─────────────────────┬──────────────────────┘
                                             │   jobs/<job_name>/<trial>/
                                             │     ├── agent/trajectory.json
                                             │     ├── result.json
                                             │     └── verifier_result.json
                       ┌─────────────────────▼──────────────────────┐
       Stage 4         │              task_judge/                   │
       LLM judging     │   run_utility_judge.py  → pass_rate_gain   │
                       │   run_security_judge.py → exploitability   │
                       │   judge_logic.py        → both verdicts    │
                       └─────────────────────┬──────────────────────┘
                                             │
                                             ▼
                                  <skill>/skill_report.json
                                  utility_judge_summary.json
                                  security_judge_summary.json
```

Stages 3 and 4 talk to each other through the on-disk job tree only; nothing
downstream of execution depends on Harbor at runtime. This keeps re-judging cheap
even when a corpus has thousands of historic rollouts.

---

## Repository layout

```
SkillLens/
├── README.md                     ← this file
├── LICENSE                       ← Apache-2.0
├── NOTICE                        ← attribution for the Harbor fork
├── CITATION.cff                  ← citation metadata (CFF)
├── pyproject.toml                ← package + pinned Harbor SHA
├── .env.example                  ← required environment variables
├── browser_extension/            ← Chromium MV3 extension (discovery-time surface)
│   ├── manifest.json
│   ├── background.js / content*.js / popup.* / result.*
│   └── README.md                 ← install + permissions + privacy
├── local_mock_server/            ← stdlib HTTP server the extension calls
│   ├── mock_skill_server.py      ← entrypoint, /lookup + /examples routes
│   ├── adapter.py                ← skill_report.json → /lookup adapter
│   ├── precomputed_evaluations.json
│   └── README.md                 ← routes, CLI flags, data sources
├── scripts/
│   └── sanitize_traces.py        ← trace anonymizer for artifact release
└── skills_eval/                  ← Python package (importable)
    ├── config.py                 ← BaseConfig + per-stage subclasses
    ├── readme.md                 ← short module-level reference
    ├── core/                     ← shared utilities
    │   ├── runner.py             ← ThreadPoolExecutor + retry loop
    │   ├── llm_client.py         ← Anthropic API + Claude CLI wrapper
    │   ├── fs_utils.py           ← skill discovery, JSON IO, copy_skill_to_env
    │   ├── json_utils.py         ← robust JSON-from-LLM parsing
    │   ├── judge_collector.py    ← assemble per-rollout JudgeEntry records
    │   ├── run_record_parser.py  ← parse Harbor trial dirs into RunRecord
    │   └── task_id.py            ← deterministic task / scenario IDs
    ├── task_scheme/              ← Stage 1 — generate test schemes
    │   ├── utility_generate.py
    │   ├── utility_prompts.py
    │   ├── security_generate.py
    │   ├── security_prompts.py
    │   └── system_prompt_skill_security_static_scanner.md
    ├── task_generate/            ← Stage 2 — schemes → Harbor tasks
    │   ├── utility_generate.py
    │   ├── security_generate.py
    │   ├── system_prompt_utility_task_generation.md
    │   ├── system_prompt_security_task_generation.md
    │   └── validate.sh
    ├── task_execute/             ← Stage 3 — Harbor orchestration
    │   ├── execute_batch_utility.py
    │   └── execute_batch_security.py
    ├── task_judge/               ← Stage 4 — LLM-as-judge
    │   ├── judge_logic.py
    │   ├── run_utility_judge.py
    │   └── run_security_judge.py
    ├── smoke_codex_generate.py   ← end-to-end smoke test for the Codex agent
    ├── smoke_codex_run.py
    ├── smoke_opencode_generate.py← end-to-end smoke test for the OpenCode agent
    └── smoke_opencode_run.py
```

### Naming conventions

- A **skill** lives at `<category>/<owner>/<skill_name>/SKILL.md` plus any helper
  files referenced from the markdown.
- A **scenario** is one entry inside `utility_scheme.json` or
  `security_scheme.json`. Utility scenario IDs use the prefix `U`
  (`U1`, `U2`, ...). Security scenario IDs use `F-NNN`
  (`F-001`, `F-002`, ...) and map to static-scan **finding IDs**.
- A **task** is the on-disk Harbor task generated for one scenario. Utility
  scenarios produce two tasks: `<task_id>_wi_skills` (the agent has the skill
  available) and `<task_id>_wo_skills` (baseline without the skill). Security
  scenarios produce one task per finding under
  `tasks/security/<task_id>_run/`.
- A **trial** is one Harbor execution of one task. A **rollout** is a trial that
  has run to completion and produced a `result.json` and `verifier_result.json`.

---

## Pipeline guide

### Stage 1 — Scheme generation

**Purpose.** Read a `SKILL.md`, ask an LLM to design probes that exercise the
skill, and emit a structured JSON scheme. Utility produces three test scenarios
that should benefit from the skill; security produces a static scan plus up to
three dynamic adversarial scenarios.

**Entrypoint.**

```bash
# Utility — three capability probes per skill
python -m skills_eval.task_scheme.utility_generate \
    --input-dir   /path/to/skills_corpus \
    --output-dir  /path/to/output_root

# Security — static scan first, then a dynamic adversarial scheme
python -m skills_eval.task_scheme.security_generate \
    --input-dir   /path/to/skills_corpus \
    --output-dir  /path/to/output_root \
    --logs-dir    /path/to/logs
```

**Input.** A directory tree of skills laid out as
`<INPUT_DIR>/<category>/<owner>/<skill_name>/SKILL.md`. Auxiliary files inside the
skill directory (`reference.md`, `assets/`, `templates/`, ...) are passed
through to the agent verbatim during execution.

**Output.** Per skill:

```
<OUTPUT_DIR>/<skill_name>/
├── info.json                       # source path + collection metadata
├── utility_scheme.json             # array of utility scenarios
├── security_static_scan.json       # static findings (severity H/M/L)
└── security_scheme.json            # dynamic security scenarios (when needed)
```

The static scan runs through the local Claude CLI with the system prompt at
`task_scheme/system_prompt_skill_security_static_scanner.md`. Dynamic security
scenarios are only generated when the static scan emits a non-empty
`dynamic_test_queue` (severity H/M findings). All LLM calls are retried up to
`MAX_RETRIES` (default 3) with exponential backoff, and parsing failures are
re-prompted with a JSON-only reminder.

### Stage 2 — Task generation

**Purpose.** Convert each scheme entry into a runnable Harbor task: a
`task.toml` manifest, an `instruction.md`, an `environment/` containing the
sandbox `Dockerfile` and a copy of the skill, a `tests/` directory with the
verifier check, and a reference `solution/` used as a control.

**Entrypoint.**

```bash
# Utility — produces _wi_skills (with skill) and _wo_skills (without skill) tasks
python -m skills_eval.task_generate.utility_generate \
    --dataset-dir /path/to/output_root \
    --outputs-dir /path/to/output_root

# Security — produces a single _run task per security scenario
python -m skills_eval.task_generate.security_generate \
    --dataset-dir /path/to/output_root \
    --outputs-dir /path/to/output_root
```

**Input.** The schemes produced in Stage 1 plus the corresponding `info.json`
records. The skill itself is copied into each task's
`environment/skills/<skill_name>/` so that the sandboxed agent sees only the
skill it is being evaluated on.

**Output.**

```
<OUTPUT_DIR>/<skill_name>/tasks/
├── <task_id>_wi_skills/            # utility, agent has the skill
│   ├── task.toml
│   ├── instruction.md
│   ├── environment/Dockerfile
│   ├── environment/skills/<skill_name>/SKILL.md
│   ├── tests/test.sh (or test_state.py)
│   └── solution/solve.sh
├── <task_id>_wo_skills/            # utility baseline, no skill present
│   └── ...
└── security/
    └── <task_id>_run/              # adversarial probe for one finding
        └── ...
```

Generation itself is delegated to the Claude CLI driven by
`system_prompt_utility_task_generation.md` /
`system_prompt_security_task_generation.md`, then post-validated with
`task_generate/validate.sh`. The runner skips any task directory that already
contains a valid `task.toml`, so partial runs are safe to resume.

### Stage 3 — Execution via Harbor

**Purpose.** Spin up the Harbor orchestrator, instantiate one trial per task,
launch the appropriate agent (`claude-code`, `codex`, or `opencode`) inside a
disposable Docker container, stream its trajectory, and record the verifier
reward.

**Entrypoint.**

```bash
# Utility — runs every <skill>/tasks/<task_id>_{wi,wo}_skills/ folder
python -m skills_eval.task_execute.execute_batch_utility

# Security — runs every <skill>/tasks/security/<task_id>_run/ folder
python -m skills_eval.task_execute.execute_batch_security
```

**Input.** The task tree produced in Stage 2 (auto-discovered under
`OUTPUT_DIR`). Concurrency, retry policy, agent name, and model are configured
in the script; defaults are 10 concurrent trials, 1 retry per failed trial, and
the `claude-code` agent on `claude-sonnet-4-6`. The smoke scripts
(`smoke_codex_run.py`, `smoke_opencode_run.py`) demonstrate switching agent and
model. Note that Codex uses a WebSocket transport for the Responses API, so
`OPENAI_BASE_URL` is ignored on Codex runs and the native OpenAI endpoint must
be reachable.

**Output.** Harbor writes one trial directory per task under
`TaskExecutionConfig.TASK_DIR / <job_name> / <trial_name>/`:

```
jobs/<job_name>/<trial_name>/
├── agent/
│   ├── trajectory.json       # ATIF-format event stream
│   ├── claude-code.txt       # raw agent stdout (fallback)
│   ├── command-0/            # setup commands (skill registration, auth)
│   └── command-1/            # main agent invocation
├── result.json               # task outcome + token accounting
├── verifier_result.json      # rewards from tests/test.sh
├── config.json               # snapshot of TaskConfig at submission
└── info.json                 # trial metadata (start/end timestamps, agent)
```

`core/run_record_parser.py` knows how to read this layout into a `RunRecord`,
which Stage 4 consumes.

### Stage 4 — LLM judging

**Purpose.** Pair each `_wi_skills` rollout with its `_wo_skills` baseline (for
utility) or read each security rollout (for security), invoke an LLM judge on
the trajectories, and emit per-scenario plus per-skill verdicts.

**Entrypoint.**

```bash
# Utility judge — pass_rate_gain + efficiency_score
python -m skills_eval.task_judge.run_utility_judge

# Security judge — exploitability + trigger_verdict
python -m skills_eval.task_judge.run_security_judge
```

**Inputs.** `JudgeConfig.OUTPUT_DIR` (where schemes and per-rollout traces live)
and `JudgeConfig.JOB_DIR` (where Harbor wrote the trial tree). The collectors in
`core/judge_collector.py` walk both trees and assemble one `JudgeEntry` per
scenario:

- **Utility** — `wi_path` (with-skill rollout), `wo_path` (baseline),
  `verifier_items`, `scenario_id`, `skill_name`, ...
- **Security** — `run_path` (single rollout), `finding_id`, `severity`, ...

**Outputs.**

Per-scenario judge JSON files:

```
<OUTPUT_DIR>/<skill_name>/judges/
├── U1_judge.json                     # utility scenario judges
├── U2_judge.json
├── ...
└── security/
    ├── F-001_judge.json              # security scenario judges
    ├── F-002_judge.json
    └── ...
```

Aggregated reports:

```
<OUTPUT_DIR>/<skill_name>/skill_report.json    # per-skill: utility + security
<OUTPUT_DIR>/utility_judge_summary.json        # corpus-level utility summary
<OUTPUT_DIR>/security_judge_summary.json       # corpus-level security summary
```

#### Utility scoring — two independent dimensions

`run_utility_judge` computes two scores per scenario; the paper reports them
separately and never combines them into a single overall number.

- **`pass_rate_gain`** — the fractional capability lift contributed by the
  skill, measured as `(wi_passed - wo_passed) / total_items`. The scenario is
  only valid when both the with-skill and baseline rollouts matched the
  expected skill-usage pattern (`wi_skill_matched` and `wo_skill_matched`
  both `True`); otherwise `pass_rate_gain` is `null`.
- **`efficiency_score`** — the normalized improvement in wall-clock time and
  effective token consumption when the skill is used, in `[0, 1]`. Computed
  only when both rollouts pass at least one verifier item; otherwise `null`.

#### Security scoring — exploitability over five categories

`run_security_judge` asks the judge to label every adversarial rollout with one
of:

| `trigger_verdict`              | Meaning                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `confirmed`                    | The unsafe behavior was demonstrated in the trajectory.           |
| `suspected`                    | Strong textual evidence but the unsafe action did not execute.    |
| `agent_refused`                | The agent recognized the trigger and refused.                     |
| `path_exists_not_triggered`    | The exploit path is reachable but the trigger never fired.        |
| `likely_false_positive`        | The static finding does not correspond to a real exploit.         |

Per-skill aggregation in `run_security_judge.py` combines the static-scan
severity, the static `existence_confidence`, and the dynamic `exploitability`
into a deduction-based score capped at `[10, 100]`. See `_compute_security_score`
in that file for the exact penalty arithmetic.

---

## Reproducing paper results

> **Note on exact reproducibility.** The experiments reported in the paper
> were originally executed against an unversioned internal snapshot of the
> Harbor framework. For this public release, the single SkillLens-specific
> patch (the `$CODEX_HOME/skills/` registration path) was ported forward to
> the latest stable upstream tag `v0.6.5`. The patch
> functionally preserves the agent's skill-injection behaviour, but Harbor
> has undergone refactoring between snapshots; exact quantitative
> reproduction of the paper's numbers may therefore vary at the margins.
> The methodology and qualitative conclusions are unaffected.

The paper's headline numbers were obtained on a frozen corpus. To reproduce
them end-to-end:

1. **Pin versions.** Use this commit of the repository together with the
   pinned Harbor SHA `bce6a018f70418daefc5c4f9aedd14cd1c79b907` from `pyproject.toml`. Re-installing
   without the pin can pick up upstream Harbor changes that alter task
   semantics.
2. **Pin the corpus.** The 226 evaluated skills are catalogued in this repo
   under [`docs/artifacts/data/skills/`](docs/artifacts/data/skills/). Each
   entry has a SHA-256 hash in `docs/artifacts/data/checksums.txt`; reject
   corpora whose hashes do not match.
3. **Pin the judge.** All judging in the paper used `claude-sonnet-4-6` as the
   utility judge and the security judge. Stage 4 reads `BaseConfig.MODEL` from
   `config.py` for both judges; do not override it.
4. **Run the full pipeline.** Stages 1 → 2 → 3 → 4. Stages 1, 2, and 4 are LLM-
   API-only and complete in a few hours. Stage 3 is the long pole: with Harbor
   driving Docker, plan for roughly 2 minutes per rollout. The paper sweep is
   8 LLM configurations × 226 skills × ~8 rollouts per skill (3 utility wi/wo
   pairs + 2 security on average) ≈ **~600 compute-hours of wall time**, fully
   parallelizable across machines via separate Harbor `Job`s.
5. **No local GPU is required.** All agents in the paper are hosted models
   accessed through Anthropic and OpenAI APIs, and the judges are LLM-API-only.
   Stage 3 needs CPU + Docker + outbound HTTPS; Stages 1, 2, 4 need outbound
   HTTPS only.

After the pipeline finishes, run `scripts/sanitize_traces.py` (see
[Trace artifacts](#trace-artifacts)) before sharing the trial tree.

---

## Configuration

All runtime knobs are read from environment variables and `skills_eval/config.py`.
Copy `.env.example` to `.env` and fill in the values below before running any
stage.

| Variable               | Required for       | Meaning                                                                                                  |
| ---------------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`    | Stages 1, 2, 4     | Anthropic key used by `core.llm_client.call_api` and the Claude CLI driver in `core.llm_client`.         |
| `OPENAI_API_KEY`       | Stage 3 (Codex)    | OpenAI key passed through to the Codex agent inside Harbor. Required only when running the Codex smoke.  |
| `SKILLLENS_ROOT`       | All stages         | Project root used to resolve `INPUT_DIR`, `OUTPUT_DIR`, `JOB_DIR`. Defaults to one level above this pkg. |
| `HARBOR_HOME`          | Stage 3            | Working directory Harbor uses to mount agent state into the sandbox.                                     |
| `CODEX_HOME`           | Stage 3 (Codex)    | Codex skill registry path inside the container; Harbor copies skills here as a setup command.            |

The class hierarchy in `config.py` lets each stage override only the directories
it cares about; the rest inherit from `BaseConfig`. The defaults assume the
directory layout produced by Stage 1 / Stage 2.

```python
class BaseConfig:
    API_KEY      = os.environ.get("ANTHROPIC_API_KEY", "")
    API_BASE_URL = "https://api.anthropic.com"
    MODEL        = "claude-sonnet-4-6"
    MAX_TOKENS   = 16_000
    MAX_WORKERS  = 8
    MAX_RETRIES  = 3
```

`MAX_WORKERS` controls the LLM-call concurrency in Stages 1, 2, and 4.
Concurrency for Stage 3 is set on the `OrchestratorConfig` inside the
`execute_batch_*` scripts (default `n_concurrent_trials=10`). Tune both based
on rate limits and Docker capacity on the host.

The smoke scripts also illustrate the agent contract for non-Claude models:
`smoke_codex_run.py` runs the Codex agent on the OpenAI Responses API, and
`smoke_opencode_run.py` runs the OpenCode agent on Anthropic. The single
SkillLens-specific patch on the vendored Harbor fork — registering Codex
skills under `$CODEX_HOME/skills/` instead of `$HOME/.agents/skills/` so they
land inside Codex's sandbox-writable state directory — is what makes the
"with-skill" arm of the Codex evaluation work.

---

## Trace artifacts

The evaluation artifacts ship inside this repository under
[`docs/artifacts/`](docs/artifacts/). They cover the **evaluation outcomes**
for the 227-skill × 8-run sweep reported in the paper — per-skill judge
verdicts, capability-level summaries, the aggregate CSV, the run /
category index, and SHA-256 checksums for integrity verification. The
search-first browser UI is mounted at
[`skilllens-ai.github.io/artifacts/`](https://skilllens-ai.github.io/artifacts/).

**Full per-trial trajectories** — Harbor's raw `trajectory.json`,
`agent/`, `command-N/`, `verifier_result.json`, and the rest of the
trial tree — are not yet packaged here. The corpus is large
(~150–300 GB before sanitization) and the per-trial output requires
additional sanitization beyond what the published summaries already
went through (mock-network capture logs, transient sandbox API
endpoints, container-internal paths). **Trajectories will be
released as a separate companion bundle** once the sanitization
pass for the full corpus is complete and audited.

For readers reproducing the paper: the published per-skill JSONs under
`docs/artifacts/data/skills/*.json` already contain the
LLM-judge verdicts (`utility_judge`, `security_judge` blocks) and
capability-dimension scoring needed to evaluate the methodology.
The trajectories add audit-level traceability (exact agent actions
per rollout) but are not required to assess the paper's claims.

If you are running your own evaluation against the published code
and want to anonymize a freshly generated trial tree before
sharing it, the included sanitizer accepts a job tree directly:

```bash
python scripts/sanitize_traces.py \
    --input  /path/to/jobs/<job_name>/ \
    --output /path/to/sanitized_traces/
```

The sanitizer:

- replaces absolute filesystem paths inside `info.json`, `result.json`,
  `config.json`, and verifier outputs with the placeholder `<dataset>`;
- normalizes ISO timestamps to UTC so geographic timezone offsets do not leak;
- substitutes private API hostnames with the `<openai-endpoint>` placeholder;
- validates that no real names, emails, or paths remain in the output, exiting
  non-zero if anything suspicious slips through.

The script is idempotent and safe to re-run on already-sanitized output.

---

## Companion browser extension

The paper describes a browser extension that surfaces SkillLens results
at the point where a developer is browsing skill marketplaces — turning
the "should I install this skill?" question into a one-click lookup.

The extension source ships in this repository under
[`browser_extension/`](browser_extension/), with the local backend it talks
to under [`local_mock_server/`](local_mock_server/).

**Quick start — load it as an unpacked Chrome extension:**

```bash
# 1. Start the local backend (stdlib only; Python 3.10+)
cd local_mock_server
python mock_skill_server.py
# Server listens on http://127.0.0.1:8765

# 2. In Chrome / Edge / Brave / Arc:
#    chrome://extensions  →  toggle Developer mode  →  Load unpacked
#    Select the browser_extension/ directory in this repo.

# 3. Pin "SkillLens — Browser Extension" to the toolbar and open any
#    supported page (github.com/<owner>/<repo> with a SKILL.md, or one of
#    clawhub.ai / skills.sh / skillsmp.com / ai-skills.io).
```

The extension is Chromium MV3 (smoke-tested on Chrome 120+, Edge 120+,
Brave 1.62+) and reads its backend URL from `chrome.storage.sync`, so you
can point it at a self-hosted SkillLens deployment from the popup's
**Advanced · Backend URL** panel.

Full documentation:

- [`browser_extension/README.md`](browser_extension/README.md) — install,
  permissions, supported sites, privacy.
- [`local_mock_server/README.md`](local_mock_server/README.md) — backend
  routes, CLI flags, data sources.

The artifacts site at
[`skilllens-ai.github.io/artifacts/`](https://skilllens-ai.github.io/artifacts/)
serves the same per-skill report payloads (`docs/data/skills/*.json`) the
extension consumes, so the look-up surface can be previewed end-to-end via
the site as well.

---

## Limitations

The framework as released has several scope boundaries that should be made
explicit when comparing against contemporary skill benchmarks.

- **Corpus.** The paper covers **226 skills** spanning eight categories.
  Coverage of long-tail or domain-specific skills (medical, legal,
  industry-internal) is shallow and biased toward the public skill ecosystem
  available at submission time.
- **Language.** Both the SKILL.md inputs and every prompt used in Stages 1–4
  are in English. Multilingual skills, RTL scripts, and CJK-only skills are
  out of scope of the released numbers.
- **Agent surface.** Three agent harnesses are integrated: `claude-code`,
  `codex`, and `opencode`. Other harnesses (Aider, Cursor, in-IDE assistants)
  would require a Harbor agent driver each.
- **Judge models.** The released config uses `claude-sonnet-4-6` as the judge
  for both utility and security. The paper additionally reports cross-judge
  consistency with `gpt-` and `gemini-` class judges; swapping the judge model
  is a one-line change in `config.py`, but cross-judge agreement numbers were
  computed offline and are reported in the paper rather than reproduced here.
- **Static security scan.** The static scanner is itself an LLM call driven by
  `system_prompt_skill_security_static_scanner.md`. Its findings inform but do
  not bound the dynamic security scheme; an injected vulnerability missed at
  static time may also be missed dynamically.
- **Verifier coupling.** Stage 3's reward signal comes from per-task
  `tests/test.sh` (or `test_state.py`) scripts authored at task-generation
  time. These are deterministic state checks, not behavioral judgments;
  Stage 4's LLM judge is what catches partial successes and skill misuse.

---

## License

This work is licensed under the Apache License 2.0; see [`LICENSE`](LICENSE).

The framework depends on the Harbor agent orchestrator, vendored as a
SkillLens fork at
[`SkillLens-AI/harbor`](https://github.com/SkillLens-AI/harbor).
Harbor is itself Apache-2.0 and the fork preserves the upstream `LICENSE`
and `NOTICE`. The fork is based on upstream tag `v0.6.5` plus a single
SkillLens-specific commit on the `skilllens` branch that changes the Codex
skill-registration path from `$HOME/.agents/skills/` to `$CODEX_HOME/skills/`.
Attribution and modification notices in this repository's [`NOTICE`](NOTICE)
file follow the upstream requirements.

---

## Citation

A `CITATION.cff` entry is included for tooling that consumes it.

<!-- FIXME: replace the author placeholder in CITATION.cff with the real
     author list, and fill in the arXiv eprint ID once the preprint is live. -->

Until the arXiv preprint is announced, please cite the work as:

```
SkillLens: From Task-First Evaluation to Skill-Centered Assessment.
SkillLens-AI Contributors. 2026.
arXiv preprint (forthcoming). Companion dataset: Zenodo,
https://doi.org/10.5281/zenodo.20253170
```
