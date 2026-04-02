'use strict';

const BASE_URL = process.env.TDARR_URL || 'http://localhost:8265';

async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
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
  const res = await fetch(`${BASE_URL}/api/v2/get-nodes`);
  if (!res.ok) throw new Error(`get-nodes returned ${res.status}`);
  return res.json();
}

async function syncPlugins() {
  const res = await fetch(`${BASE_URL}/api/v2/sync-plugins`, {
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

async function pollJobStatus(libraryId, timeoutMs = 300000) {
  const start = Date.now();
  const poll = 3000;
  while (Date.now() - start < timeoutMs) {
    const files = await cruddb('FileJSONDB', 'getAll');
    const file = Array.isArray(files) ? files.find((f) => f.DB === libraryId) : null;
    if (file) {
      if (file.TranscodeDecisionMaker === 'Not required') return { status: 'skipped', file };
      if (file.TranscodeDecisionMaker === 'Transcode success') return { status: 'success', file };
      if (file.TranscodeDecisionMaker === 'Transcode error') return { status: 'error', file };
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for job in library ${libraryId}`);
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
