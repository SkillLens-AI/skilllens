# SkillLens — Local Mock Server

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)

A self-contained Python HTTP server that serves the data the
[SkillLens browser extension](../browser_extension/README.md) consumes during a
demo or against a local SkillLens corpus. It implements the same `/lookup`
contract a hosted SkillLens deployment would, so you can develop and demo the
extension end-to-end without standing up the full evaluation pipeline.

> The mock server is what the extension talks to over `http://127.0.0.1:8765`
> by default. Swap in your own SkillLens backend by changing the URL in the
> extension popup — the API contract is identical.

---

## Quick start

```bash
# From the repo root
cd local_mock_server
python mock_skill_server.py

# Server listens on http://127.0.0.1:8765
curl -s http://127.0.0.1:8765/health
# {"ok": true, "version": "..."}
```

The server has no third-party dependencies — only the Python standard library
(`http.server`, `json`, `urllib`, `pathlib`). Tested on CPython 3.10, 3.11, and
3.12 on macOS, Linux, and Windows.

---

## Command-line flags

```text
--host           Bind host. Default: 127.0.0.1
--port           Bind port. Default: 8765
--downloads-dir  Path to the browser Downloads folder. Default: ~/Downloads
--results-dir    Harbor-style results directory. Powers /task-results viewer.
--examples-dir   Path to the Example/ directory. Powers /examples viewer.
--overrides      Hand-curated JSON entries keyed by owner/repo that override
                 the baked artifacts (typically empty).
                 Default: ./overrides.json
--manifest       skill_manifest.json (skill_name -> owner/repo + provenance).
                 Default: ./skill_manifest.json
--pricing        model_pricing.json (per-million-token USD rates).
                 Default: ./model_pricing.json
--admin-token    Optional shared secret required as X-Admin-Token on /admin/*
                 endpoints. Empty (default) accepts any loopback request.
```

Pointing the server at a full SkillLens corpus is a matter of supplying
`--examples-dir /path/to/Example/` — the adapter discovers any
`<skill>/skill_report.json` underneath and indexes it on startup.

---

## API endpoints

### Public

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness probe used by the extension popup. |
| `GET`  | `/lookup?owner=<o>&repo=<r>` | Primary endpoint the extension calls. Returns a cached SkillLens report (utility, safety, cost) or `{"ok": false, "reason": "..."}`. |
| `GET`  | `/api/examples/summary` | Bulk summary used by the `/examples` viewer. |
| `GET`  | `/api/scanner/skills` | Static-scan finding rollup by skill. |
| `GET`  | `/api/scanner/findings` | Static-scan findings detail. |
| `GET`  | `/api/scanner/qa` | Static-scanner QA payload. |
| `GET`  | `/api/task-results/summary` | Per-task rollup from a Harbor results tree. |
| `GET`  | `/api/task-results/trial` | Single Harbor trial detail. |

### Admin

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/admin/refresh` | Re-scan `examples-dir` + reload `overrides`, `manifest`, `pricing`. No data is lost. |

If `--admin-token` is set, admin requests must include
`X-Admin-Token: <token>`. The default (empty) accepts any loopback request
without a token — this is fine for local development and the bundled demo, but
set a token before exposing the server.

### Browser-facing pages

| Path | Description |
|------|-------------|
| `/examples` | Demo home page (matches the screenshots in the paper). |
| `/examples/skills` | Skill registry with utility / safety / cost columns. |
| `/examples/details` | Per-skill report (`skill_report.json` rendered). |
| `/examples/report` | Static-scanner findings explorer. |
| `/task-results` | Harbor trial / verifier viewer. |

These are convenient for demos and screenshots and are independent of the
extension — none of them are required for the extension to function.

---

## Data sources

The `/lookup` handler resolves owner / repo in this order (lowercased):

1. **`overrides.json`** — optional hand-curated dictionary in this directory.
   Empty by default; populate with paper-final entries you want to pin in
   the UI on top of the baked artifacts.
2. **Baked API** — `docs/artifacts/api/lookup/<owner>__<repo>.json`, generated
   by `scripts/build_lookup_index.py` from the published artifacts under
   `docs/artifacts/data/skills/`. This is where the real evaluation data
   lives.
3. **Adapter index** — legacy path, derived at startup from
   `examples-dir/<skill_name>/skill_report.json` plus `skill_manifest.json`.
4. If nothing matches, returns `{"ok": true, "status": "not_evaluated"}`.

`skill_manifest.json` is only used by the legacy adapter (step 3); the
baked API is self-describing. `model_pricing.json` enriches adapter output
with a USD-cost column computed from token counts.

---

## Refresh without restart

```bash
curl -X POST http://127.0.0.1:8765/admin/refresh
# {"ok": true, "indexedSkills": ...}
```

Use this after regenerating any `skill_report.json` under `examples-dir/`. The
server re-reads `overrides.json`, `skill_manifest.json`, and
`model_pricing.json` on the same call.

---

## Project layout

```
local_mock_server/
├── mock_skill_server.py           ← entrypoint; HTTP handlers + CLI
├── adapter.py                     ← skill_report.json → /lookup payload adapter
├── scanner_data.py                ← static-scan findings aggregator
├── validate.py                    ← payload-shape validator (CLI usable)
├── schema.json                    ← JSON Schema for /lookup responses
├── overrides.json                 ← optional hand-curated entries (empty by default)
├── skill_manifest.json            ← skill_name ↔ owner/repo mapping
├── model_pricing.json             ← per-million-token USD rates
├── demo_examples.json             ← curated examples list for /examples/*
├── example_home.html / .css       ← /examples landing
├── example_skills.html / .css /.js← /examples/skills registry view
├── example_view.html / .css / .js ← /examples/details report view
├── scanner_qa.html / .css / .js   ← /examples/report scanner view
├── task_results_view.html /.css/.js ← /task-results viewer
└── README.md                      ← this file
```

---

## Payload validation

`validate.py` lints any JSON file against `schema.json` (the
shape `/lookup` returns):

```bash
python validate.py overrides.json
# OK: 0 entries pass schema.json   (or however many overrides you've added)
```

Run this in CI before publishing a new `overrides.json`.

---

## Security notes

- Bind to `127.0.0.1` only (the default). Do **not** expose `0.0.0.0` without
  a reverse proxy + auth in front of it.
- Set `--admin-token` if anything other than the loopback can reach the
  server.
- The server reads files from `--examples-dir`, `--results-dir`, and
  `--downloads-dir` at startup and on `/admin/refresh`. Restrict those paths
  to directories you control.

---

## License

Apache License 2.0; see [`../LICENSE`](../LICENSE). The baked
`docs/artifacts/api/` payloads and the per-skill reports under
`docs/artifacts/data/` are released under CDLA-Permissive-2.0 as part of
the SkillLens dataset
([Zenodo `10.5281/zenodo.20253170`](https://doi.org/10.5281/zenodo.20253170)).
