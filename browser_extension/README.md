# SkillLens — Browser Extension

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-success.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Companion paper](https://img.shields.io/badge/paper-SkillLens-blue.svg)](https://skilllens-ai.github.io/paper/)

A Chromium browser extension that surfaces **SkillLens** evaluation results — utility
lift, safety findings, and resource cost — directly on GitHub repositories and the
major skill marketplaces. The extension is the discovery-time surface for the
[SkillLens evaluation framework](../README.md): it turns the "should I install this
skill?" question into a one-click lookup against a SkillLens report.

> The paper introduces this surface as a *"lightweight browser extension for
> skill-hosting platforms ... that turns SkillLens from an offline evaluation
> pipeline into a discovery-time decision aid."*
> ([SkillLens §2.7](https://skilllens-ai.github.io/paper/))

---

## Screenshots

The four states a user sees on a supported page, from detection to expanded
audit report. Captured against a mock `clawhub.ai` skill page; the GitHub and
other marketplace surfaces use the same in-page panel.

<p align="center">
  <img src="screenshots/demo_01_detection_toast.png"
       alt="Detection toast — opt-in card appears bottom-right after the content script identifies a SKILL.md candidate"
       width="720"><br>
  <em>1. Detection toast — opt-in card appears in the bottom-right after the
  content script identifies a <code>SKILL.md</code> candidate on the page.</em>
</p>

<p align="center">
  <img src="screenshots/demo_02_analyzing.png"
       alt="Inspection in progress — panel streams the five evaluation stages"
       width="720"><br>
  <em>2. Inspection in progress — the panel expands and streams the five
  evaluation stages while the backend computes utility, safety, and cost.</em>
</p>

<p align="center">
  <img src="screenshots/demo_03_audit_report.png"
       alt="Audit report — verdict ring, three SkillLens axes, paper-backed benchmark counts"
       width="720"><br>
  <em>3. Audit report — verdict ring, the three SkillLens axes
  (<code>pass_rate_gain</code> / safety score / cost overhead), paper-backed
  benchmark counts, and pinned findings.</em>
</p>

<p align="center">
  <img src="screenshots/demo_04_audit_report_details.png"
       alt="Report details expanded — static + runtime findings, exploit evidence, provenance"
       width="720"><br>
  <em>4. Report details expanded — full static-scan + runtime findings,
  exploit evidence, supply-chain provenance, and a per-task pass-rate
  breakdown.</em>
</p>

---

## Table of contents

1. [What it does](#what-it-does)
2. [Install (developer mode)](#install-developer-mode)
3. [Run the backend](#run-the-backend)
4. [Configure the backend URL](#configure-the-backend-url)
5. [Supported sites](#supported-sites)
6. [Permissions](#permissions)
7. [Privacy](#privacy)
8. [Project layout](#project-layout)
9. [Development](#development)
10. [License](#license)

---

## What it does

When you visit a supported page that hosts a `SKILL.md` package, the extension:

1. **Detects** the candidate skill by parsing the URL plus the rendered DOM (the
   GitHub repo header for `github.com/<owner>/<repo>`, or the marketplace's own
   route for `clawhub.ai`, `skills.sh`, `skillsmp.com`, `ai-skills.io`).
2. **Queries** the SkillLens backend at
   `GET /lookup?owner=<owner>&repo=<slug>` for a cached report.
3. **Injects** a compact panel into the page showing the three axes the paper
   defines: utility (`pass_rate_gain`, `efficiency`), safety (static-scan
   findings + dynamic exploitability), and resource cost (token / wall-time
   overhead vs. the no-skill baseline).
4. **Falls back** to a bundled reference profile when the backend is
   unreachable, so the extension always has something to show during a demo
   or while you spin the server up.

The toolbar popup adds a quick-inspect bar, a feed of recent featured audits,
and the per-extension settings panel (see [Configure the backend URL](#configure-the-backend-url)).

A full-page report opens in its own window (`result.html`) whenever you click
**Inspect** or **Re-run inspection** — that view is what the paper's Figure 7
screenshots are taken from.

---

## Install (developer mode)

The extension is not yet published to the Chrome Web Store. Load it as an
unpacked extension:

1. Clone the repository:

   ```bash
   git clone https://github.com/SkillLens-AI/skilllens.git
   cd skilllens
   ```

2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`,
   `arc://extensions`) in a Chromium-based browser.
3. Toggle **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `browser_extension/` directory.
5. Pin the **SkillLens — Browser Extension** icon to the toolbar so the popup is
   one click away.

The extension is built against Chrome Manifest V3 and has been smoke-tested on
Chrome 120+, Edge 120+, and Brave 1.62+. Firefox is not supported in this
release (the MV3 service-worker shape differs).

---

## Run the backend

Most of what the extension shows comes from the bundled local server in
[`../local_mock_server/`](../local_mock_server/). It serves cached SkillLens
reports, the `/lookup` endpoint the content scripts call, and a small set of
demo pages.

```bash
cd local_mock_server
python mock_skill_server.py
```

The server listens on `http://127.0.0.1:8765` by default. Verify it is up:

```bash
curl -s http://127.0.0.1:8765/health
# {"ok": true, "version": "..."}
```

Then click any skill on `https://github.com/anthropics/skills/tree/main/...` and
the panel should switch from **Preview mode** to **Engine ready**.

For details on the routes and data sources see
[`../local_mock_server/README.md`](../local_mock_server/README.md).

---

## Configure the backend URL

The extension reads the backend URL from `chrome.storage.sync` under the key
`skilllens_server_base_url`. The default is `http://127.0.0.1:8765`.

To change it (e.g. you run the server on a different port, or you point the
extension at a self-hosted SkillLens deployment):

1. Click the SkillLens toolbar icon to open the popup.
2. Scroll to **Advanced · Backend URL** and click to expand.
3. Enter the new URL (`http://host:port`, no trailing slash) and click **Save**.
4. **Reset** restores the default.

When you point the extension at a host that is not in the manifest's
`host_permissions`, Chrome will prompt for `optional_host_permissions` the
first time a content script attempts to fetch it.

The setting is synced through your Chrome profile, so it follows you across
machines if Chrome sync is enabled. No part of the configuration is sent to
SkillLens or any third party.

---

## Supported sites

| Site | What gets detected | Source file |
|------|--------------------|-------------|
| `github.com/<owner>/<repo>` | Repos whose root contains `SKILL.md` | `content_github.js` |
| `clawhub.ai/<owner>/<slug>` | Marketplace skill detail pages | `content.js` |
| `skills.sh/<owner>/<slug>` | Marketplace skill detail pages | `content.js` |
| `skillsmp.com/<owner>/<slug>` | Marketplace skill detail pages | `content.js` |
| `ai-skills.io/<owner>/<slug>` | Marketplace skill detail pages | `content.js` |

Adding a new marketplace requires extending the `matches` block in
`manifest.json` and adding a route parser in `content.js`. PRs welcome.

---

## Permissions

The manifest declares a deliberately narrow set:

| Permission | Why |
|------------|-----|
| `downloads` | Fetches the candidate skill bundle to a unique path under `~/Downloads/SkillLens/` before submitting it for inspection. |
| `storage` | Persists the configured backend URL and per-page dismissal flags. |
| `host_permissions` for the supported sites | Lets the content scripts read the rendered DOM and call `raw.githubusercontent.com` for `SKILL.md` previews. |
| `optional_host_permissions` (`http://*/*`, `https://*/*`) | Granted on demand when the user points the extension at a custom backend URL. |

The extension never requests `tabs`, `cookies`, `webRequest`, `<all_urls>`
content-script matches, or any history / bookmarks API.

---

## Privacy

- **No telemetry, no analytics, no remote logging.** Every code path runs
  locally in the extension or against the backend URL the user configures.
- **Backend lookups** include only `owner` and `repo` (or marketplace owner /
  slug). They are sent to the configured backend URL only — by default this is
  `127.0.0.1`, i.e. the user's own machine.
- **Skill bundles** are downloaded into the user's local Downloads directory
  before inspection. They are not uploaded anywhere.
- **Storage** is `chrome.storage.sync` for the backend URL setting and
  `chrome.storage.local` for in-flight jobs and per-page dismissal flags.
- The extension makes **no network calls on install or on browser start**.

---

## Project layout

```
browser_extension/
├── manifest.json            ← MV3 manifest, permissions, content-script matches
├── background.js            ← service worker: job creation, download tracking
├── content_github.js        ← GitHub repo detection + injected panel
├── content.js               ← marketplace detection + injected panel
├── content_github.css       ← shared injected-panel styles
├── content.css              ← marketplace-specific overrides
├── popup.html / popup.js / popup.css      ← toolbar popup
├── result.html / result.js / result.css   ← full audit report window
├── icons/                   ← 16/32/48/128 px PNGs + source SVG
├── screenshots/             ← README screenshots (4 PNGs)
└── README.md                ← this file
```

---

## Development

There is no build step — the extension ships the source files directly. After
editing any file, click the reload icon for the SkillLens entry on
`chrome://extensions` to pick up the change. Content scripts re-inject on the
next full page load (or `location.reload()`).

The mock server is independently runnable and idempotent; restarting it does
not invalidate any extension state.

Contributions welcome via pull request against
[`SkillLens-AI/skilllens`](https://github.com/SkillLens-AI/skilllens).

---

## License

Apache License 2.0; see [`../LICENSE`](../LICENSE). The companion SkillLens
evaluation framework, the dataset, and the mock server are released under the
same license. The bundled reference data shown in offline / preview mode is
derived from `Example/<skill>/skill_report.json` and inherits the
CDLA-Permissive-2.0 license of the SkillLens dataset.
