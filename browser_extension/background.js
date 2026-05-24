const JOB_PREFIX = "job:";
const DOWNLOAD_MAP_PREFIX = "download-job:";
// Default points at the public artifacts mirror so the extension surfaces
// real evaluation data with zero configuration. Users running the local
// mock server can override this in the popup's Advanced settings.
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

function log(...args) {
  console.log("[SkillLens][background]", ...args);
}

function sanitizeSegment(value) {
  return String(value || "unknown")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "unknown";
}

function normalizeVersion(value) {
  return sanitizeSegment(String(value || "unknown-version").replace(/\s+/g, "_"));
}

function buildJobKey(jobId) {
  return `${JOB_PREFIX}${jobId}`;
}

function buildDownloadMapKey(downloadId) {
  return `${DOWNLOAD_MAP_PREFIX}${downloadId}`;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Missing payload.");
  }

  const requiredFields = ["sourcePageUrl", "owner", "slug", "skillName", "version"];
  for (const field of requiredFields) {
    if (!payload[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  if (!payload.downloadUrl && !payload.skillText) {
    throw new Error("Payload must include either downloadUrl or skillText.");
  }

  return payload;
}

function buildRelativeDownloadPath(payload, jobId) {
  const owner = sanitizeSegment(payload.owner);
  const slug = sanitizeSegment(payload.slug);
  const version = normalizeVersion(payload.version);
  return `SkillLens/${owner}__${slug}__${version}__${jobId}.zip`;
}

chrome.runtime.onInstalled.addListener(() => {
  log("Extension installed.");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "RUN_SKILL_TEST") {
    return;
  }

  (async () => {
    const payload = validatePayload(message.payload);
    const jobId = `${Date.now()}_${sanitizeSegment(payload.owner)}_${sanitizeSegment(payload.slug)}`;
    const relativeDownloadPath = payload.downloadUrl ? buildRelativeDownloadPath(payload, jobId) : "";
    const downloadId = payload.downloadUrl
      ? await chrome.downloads.download({
        url: payload.downloadUrl,
        filename: relativeDownloadPath,
        saveAs: false,
        conflictAction: "uniquify"
      })
      : null;

    const job = {
      ...payload,
      jobId,
      relativeDownloadPath,
      downloadId,
      downloadState: payload.downloadUrl ? "in_progress" : "not_applicable",
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      serverBaseUrl: LOCAL_SERVER_BASE_URL,
      sourceTabId: sender?.tab?.id ?? null,
      sourceWindowId: sender?.tab?.windowId ?? null
    };

    const storageUpdate = {
      [buildJobKey(jobId)]: job
    };

    if (downloadId !== null) {
      storageUpdate[buildDownloadMapKey(downloadId)] = jobId;
    }

    await chrome.storage.local.set(storageUpdate);

    const popupUrl = chrome.runtime.getURL(`result.html?jobId=${encodeURIComponent(jobId)}`);
    await chrome.windows.create({
      url: popupUrl,
      type: "popup",
      width: 1120,
      height: 880,
      focused: true
    });

    log("Created job", jobId, "downloadId", downloadId);
    sendResponse({
      ok: true,
      jobId,
      downloadId
    });
  })().catch((error) => {
    console.error("[SkillLens][background]", error);
    sendResponse({
      ok: false,
      error: error?.message || String(error)
    });
  });

  return true;
});

chrome.downloads.onChanged.addListener(async (delta) => {
  if (typeof delta.id !== "number") {
    return;
  }

  const downloadMapKey = buildDownloadMapKey(delta.id);
  const downloadMapData = await chrome.storage.local.get(downloadMapKey);
  const jobId = downloadMapData[downloadMapKey];

  if (!jobId) {
    return;
  }

  const jobKey = buildJobKey(jobId);
  const stored = await chrome.storage.local.get(jobKey);
  const job = stored[jobKey];

  if (!job) {
    return;
  }

  if (delta.state?.current) {
    job.downloadState = delta.state.current;
  }

  if (delta.error?.current) {
    job.downloadError = delta.error.current;
  }

  if (delta.filename?.current) {
    job.finalDownloadPath = delta.filename.current;
  }

  job.lastUpdatedAt = new Date().toISOString();

  await chrome.storage.local.set({
    [jobKey]: job
  });
});
