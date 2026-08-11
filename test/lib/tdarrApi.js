'use strict';

const BASE_URL = process.env.TDARR_URL || 'http://localhost:8265';

// Per-request timeout: without it a single hung request freezes callers
// (pollJobStatus) forever with no error and no teardown.
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_RETRIES = 3;

async function fetchWithRetry(url, options = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      lastErr = err;
      if (attempt < REQUEST_RETRIES) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw new Error(`${url} failed after ${REQUEST_RETRIES} attempts: ${lastErr.message}`);
}

async function post(path, body) {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tdarr API ${path} returned ${res.status}: ${text}`);
  }
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('json') ? res.json() : res.text();
}

async function searchFlowPlugins(pluginType) {
  return post('/api/v2/search-flow-plugins', {
    data: { string: '', pluginType },
  });
}

async function cruddb(collection, mode, docID, obj) {
  const data = { collection, mode };
  if (docID) data.docID = docID;
  if (obj) data.obj = obj;
  return post('/api/v2/cruddb', { data });
}

async function scanFile(libraryId, filePath) {
  return post('/api/v2/scan-individual-file', {
    data: {
      file: { file: filePath, DB: libraryId },
      scanTypes: { exifToolScan: false, mediaInfoScan: false, closedCaptionScan: false },
    },
  });
}

async function requeueFile(fileId) {
  return post('/api/v2/bulk-update-files', {
    data: {
      fileIds: [fileId],
      updatedObj: { TranscodeDecisionMaker: 'Queued' },
    },
  });
}

async function getNodes() {
  const res = await fetchWithRetry(`${BASE_URL}/api/v2/get-nodes`);
  if (!res.ok) throw new Error(`get-nodes returned ${res.status}`);
  return res.json();
}

async function syncPlugins() {
  const res = await fetchWithRetry(`${BASE_URL}/api/v2/sync-plugins`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`sync-plugins returned ${res.status}`);
  return res.text();
}

async function alterWorkerLimit(nodeID, workerType, process) {
  return post('/api/v2/alter-worker-limit', {
    data: { nodeID, workerType, process },
  });
}

// Activity-aware wait. A fixed wall-clock budget can undershoot a real encode
// (aom on the 1 GB sample runs ~19 min), so the deadline only advances while
// the node shows no worker on this run's files: idleTimeoutMs of continuous
// inactivity fails the wait, hardTimeoutMs caps a runaway job. Returns
// { status: 'timeout' } instead of throwing so one slow scenario cannot abort
// the whole suite.
async function pollJobStatus(libraryId, opts = {}) {
  const idleTimeoutMs = opts.idleTimeoutMs || 600000;
  const hardTimeoutMs = opts.hardTimeoutMs || 3600000;
  const runId = opts.runId || libraryId.replace(/^lib-/, '');
  const start = Date.now();
  const poll = 3000;
  let lastActive = Date.now();
  let lastHeartbeat = 0;

  while (Date.now() - start < hardTimeoutMs) {
    const files = await cruddb('FileJSONDB', 'getAll');
    const file = Array.isArray(files) ? files.find((f) => f.DB === libraryId) : null;
    if (file) {
      if (file.TranscodeDecisionMaker === 'Not required') return { status: 'skipped', file };
      if (file.TranscodeDecisionMaker === 'Transcode success') return { status: 'success', file };
      if (file.TranscodeDecisionMaker === 'Transcode error') return { status: 'error', file };
    }

    // Worker file paths embed the runId; stringify-scan survives get-nodes
    // schema drift across Tdarr versions.
    let active = false;
    try {
      active = JSON.stringify(await getNodes()).includes(runId);
    } catch { /* transient get-nodes failure — treat as inactive this tick */ }
    if (active) lastActive = Date.now();

    const now = Date.now();
    if (now - lastHeartbeat >= 60000) {
      lastHeartbeat = now;
      console.log(
        `  [poll] ${libraryId} elapsed=${Math.round((now - start) / 1000)}s`
        + ` state=${file ? file.TranscodeDecisionMaker : 'no-record'}`
        + ` workerActive=${active} idle=${Math.round((now - lastActive) / 1000)}s`,
      );
    }

    if (now - lastActive > idleTimeoutMs) {
      return { status: 'timeout', reason: `no worker activity for ${idleTimeoutMs / 1000}s` };
    }

    await new Promise((r) => setTimeout(r, poll));
  }
  return { status: 'timeout', reason: `hard cap ${hardTimeoutMs / 1000}s reached` };
}

module.exports = {
  searchFlowPlugins,
  cruddb,
  scanFile,
  requeueFile,
  getNodes,
  syncPlugins,
  alterWorkerLimit,
  pollJobStatus,
  BASE_URL,
};
