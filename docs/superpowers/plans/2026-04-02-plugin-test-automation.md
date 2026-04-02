# Plugin Test Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build smoke and e2e test infrastructure that validates plugins against a live Tdarr instance via its REST API.

**Architecture:** A thin API client (`test/lib/tdarrApi.js`) wraps Tdarr's REST endpoints. `smoke.js` verifies plugin metadata loads correctly. `e2e.js` creates temporary flows from per-plugin scenario configs (`src/<plugin>/e2e-tests.json`), encodes a sample file, and validates AV1 output. `genSample.sh` creates a synthetic test clip when no samples exist.

**Tech Stack:** Node.js (built-in fetch), bash (ffmpeg for sample generation), Tdarr REST API

---

## Container Path Mapping

The tdarr-av1 test instance mounts these host paths into both server and node containers:

| Host path | Container path |
|-----------|---------------|
| `../tdarr-av1/test/samples/` | `/media/samples` |
| `../tdarr-av1/test/output/interactive/` | `/media/output` |

The e2e test copies sample files to the host output dir and references `/media/output/...` when talking to the API. The smoke test only uses the API and doesn't need file paths.

---

### Task 1: Tdarr API Client

**Files:**
- Create: `test/lib/tdarrApi.js`

- [ ] **Step 1: Create the API client module**

```js
// test/lib/tdarrApi.js
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
  return post('/api/v2/scan-files', {
    data: {
      scanConfig: {
        dbID: libraryId,
        mode: 'scanFolderWatcher',
        arrayOrPath: [filePath],
      },
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

async function pollJobStatus(fileId, timeoutMs = 300000) {
  const start = Date.now();
  const poll = 3000;
  while (Date.now() - start < timeoutMs) {
    const files = await cruddb('FileJSONDB', 'getAll');
    const file = Array.isArray(files) ? files.find((f) => f._id === fileId) : null;
    if (file) {
      if (file.TranscodeDecisionMaker === 'Not required') return { status: 'skipped', file };
      if (file.TranscodeDecisionMaker === 'Transcode success') return { status: 'success', file };
      if (file.TranscodeDecisionMaker === 'Transcode error') return { status: 'error', file };
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for job on ${fileId}`);
}

module.exports = {
  searchFlowPlugins,
  cruddb,
  scanFile,
  requeueFile,
  getNodes,
  syncPlugins,
  pollJobStatus,
  BASE_URL,
};
```

- [ ] **Step 2: Verify the module loads without errors**

Run: `node -e "const api = require('./test/lib/tdarrApi.js'); console.log(Object.keys(api))"`

Expected: `['searchFlowPlugins', 'cruddb', 'scanFile', 'requeueFile', 'getNodes', 'syncPlugins', 'pollJobStatus', 'BASE_URL']`

- [ ] **Step 3: Verify connectivity to live Tdarr**

Run: `node -e "const api = require('./test/lib/tdarrApi.js'); api.getNodes().then(n => console.log('nodes:', Object.keys(n).length)).catch(e => console.error('FAIL:', e.message))"`

Expected: `nodes: 1` (or however many nodes are connected)

- [ ] **Step 4: Commit**

```bash
git add test/lib/tdarrApi.js
git commit -m "feat: add Tdarr API client for test automation"
```

---

### Task 2: Smoke Test

**Files:**
- Create: `test/smoke.js`

- [ ] **Step 1: Create the smoke test script**

```js
// test/smoke.js
'use strict';

const api = require('./lib/tdarrApi.js');

const PLUGIN_NAMES = ['av1anEncode', 'abAv1Encode'];

async function smokeTest(filterPlugin) {
  const targets = filterPlugin
    ? PLUGIN_NAMES.filter((p) => p === filterPlugin)
    : PLUGIN_NAMES;

  if (targets.length === 0) {
    console.error(`Unknown plugin: ${filterPlugin}`);
    process.exit(1);
  }

  console.log('Syncing plugins to nodes...');
  await api.syncPlugins();

  // Brief pause for sync to propagate
  await new Promise((r) => setTimeout(r, 2000));

  console.log('Fetching local plugin list...');
  const plugins = await api.searchFlowPlugins('Local');

  let failures = 0;

  for (const name of targets) {
    const plugin = plugins.find(
      (p) => p.pluginName === name || p.name?.toLowerCase().includes(name.toLowerCase()),
    );

    const checks = [];

    if (!plugin) {
      console.log(`smoke: ${name} .............. FAIL (not found in Tdarr)`);
      failures++;
      continue;
    }

    if (!plugin.name || typeof plugin.name !== 'string') {
      checks.push('name missing or not a string');
    }
    if (!plugin.requiresVersion || typeof plugin.requiresVersion !== 'string') {
      checks.push('requiresVersion missing');
    }
    if (!Array.isArray(plugin.inputs) || plugin.inputs.length === 0) {
      checks.push('inputs empty or missing');
    }
    if (!Array.isArray(plugin.outputs) || plugin.outputs.length === 0) {
      checks.push('outputs empty or missing');
    }

    if (checks.length > 0) {
      console.log(`smoke: ${name} .............. FAIL (${checks.join(', ')})`);
      failures++;
    } else {
      console.log(`smoke: ${name} .............. ok`);
    }
  }

  return failures;
}

// Allow running standalone or imported by test runner
if (require.main === module) {
  const filterPlugin = process.argv[2] || null;
  smokeTest(filterPlugin).then((failures) => {
    process.exit(failures > 0 ? 1 : 0);
  }).catch((err) => {
    console.error('Smoke test error:', err.message);
    process.exit(1);
  });
}

module.exports = { smokeTest };
```

- [ ] **Step 2: Run smoke test against live Tdarr**

Run: `node test/smoke.js`

Expected:
```
Syncing plugins to nodes...
Fetching local plugin list...
smoke: av1anEncode .............. ok
smoke: abAv1Encode .............. ok
```

- [ ] **Step 3: Test single-plugin filter**

Run: `node test/smoke.js av1anEncode`

Expected: Only `av1anEncode` is tested.

- [ ] **Step 4: Commit**

```bash
git add test/smoke.js
git commit -m "feat: add smoke test for plugin metadata verification"
```

---

### Task 3: Sample File Generator

**Files:**
- Create: `test/genSample.sh`
- Modify: `.gitignore`

- [ ] **Step 1: Create the sample generator script**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SAMPLES_DIR="${SCRIPT_DIR}/samples"
OUTPUT="${SAMPLES_DIR}/synthetic.mkv"

mkdir -p "$SAMPLES_DIR"

# Check if any video files already exist
video_count=$(find "$SAMPLES_DIR" -maxdepth 1 -type f \( -name '*.mkv' -o -name '*.mp4' -o -name '*.avi' \) | wc -l)

if [[ "$video_count" -gt 0 ]]; then
  echo "samples/ already has video files — skipping generation"
  exit 0
fi

if ! command -v ffmpeg &> /dev/null; then
  echo "ERROR: ffmpeg not found. Install it to generate test samples." >&2
  exit 1
fi

echo "Generating synthetic test clip -> samples/synthetic.mkv"

ffmpeg -y \
  -f lavfi -i "smptebars=size=1280x720:rate=24:duration=5" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=5" \
  -c:v libx264 -preset ultrafast -crf 18 \
  -c:a aac -b:a 128k \
  "$OUTPUT" 2>/dev/null

echo "Done: $(du -h "$OUTPUT" | cut -f1) -> samples/synthetic.mkv"
```

- [ ] **Step 2: Make it executable and run it**

Run: `chmod +x test/genSample.sh && ./test/genSample.sh`

Expected: Creates `test/samples/synthetic.mkv` (~200KB)

- [ ] **Step 3: Verify it's idempotent (skips when samples exist)**

Run: `./test/genSample.sh`

Expected: `samples/ already has video files — skipping generation`

- [ ] **Step 4: Add test paths to .gitignore**

Append to `.gitignore`:

```
test/samples/
test/output/
```

- [ ] **Step 5: Commit**

```bash
git add test/genSample.sh .gitignore
git commit -m "feat: add synthetic sample generator for e2e tests"
```

---

### Task 4: E2E Test Scenario Configs

**Files:**
- Create: `src/av1anEncode/e2e-tests.json`
- Create: `src/abAv1Encode/e2e-tests.json`

- [ ] **Step 1: Create av1anEncode test scenarios**

```json
[
  {
    "name": "svt-av1 default",
    "inputs": {
      "encoder": "svt-av1",
      "target_vmaf": "93",
      "preset": "8"
    }
  }
]
```

Note: Use preset 8 (fast) for test speed. More scenarios can be added later.

- [ ] **Step 2: Create abAv1Encode test scenarios**

```json
[
  {
    "name": "default",
    "inputs": {
      "target_vmaf": "93",
      "preset": "8"
    }
  }
]
```

- [ ] **Step 3: Commit**

```bash
git add src/av1anEncode/e2e-tests.json src/abAv1Encode/e2e-tests.json
git commit -m "feat: add e2e test scenario configs for both plugins"
```

---

### Task 5: E2E Test Runner

**Files:**
- Create: `test/e2e.js`

- [ ] **Step 1: Create the e2e test runner**

```js
// test/e2e.js
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const api = require('./lib/tdarrApi.js');

const SRC_DIR = path.join(__dirname, '..', 'src');
const SAMPLES_DIR = path.join(__dirname, 'samples');
const TDARR_AV1_DIR = path.join(__dirname, '..', '..', 'tdarr-av1');
const HOST_OUTPUT_DIR = path.join(TDARR_AV1_DIR, 'test', 'output', 'interactive');
const CONTAINER_OUTPUT = '/media/output';

function findSampleFile() {
  if (!fs.existsSync(SAMPLES_DIR)) fs.mkdirSync(SAMPLES_DIR, { recursive: true });

  const videos = fs.readdirSync(SAMPLES_DIR).filter((f) =>
    ['.mkv', '.mp4', '.avi'].includes(path.extname(f).toLowerCase()),
  );

  if (videos.length === 0) {
    console.log('No sample files found — generating synthetic clip...');
    execSync(path.join(__dirname, 'genSample.sh'), { stdio: 'inherit' });
    return findSampleFile();
  }

  return path.join(SAMPLES_DIR, videos[0]);
}

function discoverScenarios(filterPlugin) {
  const scenarios = [];
  const pluginDirs = fs.readdirSync(SRC_DIR).filter((d) => {
    if (d === 'shared') return false;
    if (filterPlugin && d !== filterPlugin) return false;
    return fs.existsSync(path.join(SRC_DIR, d, 'e2e-tests.json'));
  });

  for (const pluginName of pluginDirs) {
    const config = JSON.parse(
      fs.readFileSync(path.join(SRC_DIR, pluginName, 'e2e-tests.json'), 'utf8'),
    );
    for (const scenario of config) {
      scenarios.push({ pluginName, ...scenario });
    }
  }

  return scenarios;
}

function uniqueId() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runScenario(scenario, sampleFile) {
  const { pluginName, name, inputs } = scenario;
  const label = `e2e:   ${pluginName}: ${name}`;
  const start = Date.now();

  const runId = uniqueId();
  const flowId = `flow-${runId}`;
  const libId = `lib-${runId}`;
  const scenarioDir = path.join(HOST_OUTPUT_DIR, runId);
  const containerDir = `${CONTAINER_OUTPUT}/${runId}`;

  try {
    // Copy sample to working dir
    fs.mkdirSync(scenarioDir, { recursive: true });
    const sampleName = path.basename(sampleFile);
    const workingFile = path.join(scenarioDir, sampleName);
    fs.copyFileSync(sampleFile, workingFile);
    const containerFile = `${containerDir}/${sampleName}`;

    // Create flow: inputFile -> plugin -> replaceOriginalFile
    await api.cruddb('FlowsJSONDB', 'insert', flowId, {
      _id: flowId,
      name: `Test: ${pluginName} ${name}`,
      priority: 0,
      isUiLocked: false,
      flowPlugins: [
        {
          name: 'Input File',
          sourceRepo: 'Community',
          pluginName: 'inputFile',
          version: '1.0.0',
          id: 'node-input',
          position: { x: 500, y: 100 },
          inputsDB: { fileAccessChecks: 'false', pauseNodeIfAccessChecksFail: 'false' },
        },
        {
          name: pluginName,
          sourceRepo: 'Local',
          pluginName,
          version: '1.0.0',
          id: 'node-encode',
          position: { x: 500, y: 300 },
          inputsDB: inputs || {},
        },
        {
          name: 'Replace Original',
          sourceRepo: 'Community',
          pluginName: 'replaceOriginalFile',
          version: '1.0.0',
          id: 'node-replace',
          position: { x: 500, y: 500 },
          inputsDB: {},
        },
      ],
      flowEdges: [
        { id: 'edge-1', source: 'node-input', sourceHandle: '1', target: 'node-encode', targetHandle: null },
        { id: 'edge-2', source: 'node-encode', sourceHandle: '1', target: 'node-replace', targetHandle: null },
      ],
    });

    // Create library pointing at scenario dir
    await api.cruddb('LibrarySettingsJSONDB', 'insert', libId, {
      _id: libId,
      name: `Test Library ${runId}`,
      folder: containerDir,
      cache: '/temp',
      createdAt: Date.now(),
      flowId,
      decisionMaker: {
        settingsFlows: true,
        settingsPlugin: false,
        settingsVideo: false,
        settingsAudio: false,
      },
    });

    // Scan and queue file
    await api.scanFile(libId, containerFile);
    await new Promise((r) => setTimeout(r, 2000));
    await api.requeueFile(containerFile);

    // Poll for completion
    const result = await api.pollJobStatus(containerFile, 300000);

    // Assert output
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);

    if (result.status === 'error') {
      console.log(`${label} ... FAIL (transcode error) (${elapsed}s)`);
      return false;
    }

    // Check output file exists and is AV1
    const outputFiles = fs.readdirSync(scenarioDir).filter((f) =>
      ['.mkv', '.mp4'].includes(path.extname(f).toLowerCase()),
    );

    if (outputFiles.length === 0) {
      console.log(`${label} ... FAIL (no output file) (${elapsed}s)`);
      return false;
    }

    // Verify AV1 codec via ffprobe
    try {
      const probe = execSync(
        `ffprobe -v quiet -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${path.join(scenarioDir, outputFiles[0])}"`,
        { encoding: 'utf8' },
      ).trim();

      if (probe !== 'av1') {
        console.log(`${label} ... FAIL (codec=${probe}, expected av1) (${elapsed}s)`);
        return false;
      }
    } catch {
      console.log(`${label} ... FAIL (ffprobe failed on output) (${elapsed}s)`);
      return false;
    }

    console.log(`${label} ... ok (${elapsed}s)`);
    return true;
  } finally {
    // Teardown — always run
    try { await api.cruddb('FlowsJSONDB', 'removeOne', flowId); } catch {}
    try { await api.cruddb('LibrarySettingsJSONDB', 'removeOne', libId); } catch {}
    try { await api.cruddb('FileJSONDB', 'removeOne', `${containerDir}/${path.basename(sampleFile)}`); } catch {}
    try { fs.rmSync(scenarioDir, { recursive: true, force: true }); } catch {}
  }
}

async function e2eTest(filterPlugin) {
  const scenarios = discoverScenarios(filterPlugin);

  if (scenarios.length === 0) {
    console.error(
      filterPlugin
        ? `No e2e-tests.json found for plugin: ${filterPlugin}`
        : 'No e2e-tests.json files found in src/',
    );
    process.exit(1);
  }

  const sampleFile = findSampleFile();
  console.log(`Using sample: ${path.basename(sampleFile)}`);
  console.log(`Running ${scenarios.length} scenario(s)...\n`);

  let failures = 0;
  for (const scenario of scenarios) {
    const passed = await runScenario(scenario, sampleFile);
    if (!passed) failures++;
  }

  return failures;
}

if (require.main === module) {
  const filterPlugin = process.argv[2] || null;
  e2eTest(filterPlugin).then((failures) => {
    console.log(failures === 0 ? '\nAll e2e tests passed.' : `\n${failures} e2e test(s) failed.`);
    process.exit(failures > 0 ? 1 : 0);
  }).catch((err) => {
    console.error('E2E test error:', err.message);
    process.exit(1);
  });
}

module.exports = { e2eTest };
```

- [ ] **Step 2: Run e2e test against live Tdarr (requires running instance + deployed plugins)**

Run: `node test/e2e.js`

Expected:
```
Using sample: synthetic.mkv
Running 2 scenario(s)...

e2e:   av1anEncode: svt-av1 default ... ok (45s)
e2e:   abAv1Encode: default ........... ok (50s)

All e2e tests passed.
```

Note: First run may take longer. If a test fails, check Tdarr dashboard logs for details.

- [ ] **Step 3: Test single-plugin filter**

Run: `node test/e2e.js av1anEncode`

Expected: Only `av1anEncode` scenarios run.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.js
git commit -m "feat: add e2e test runner with flow creation and output validation"
```

---

### Task 6: npm Scripts and Test Runner

**Files:**
- Create: `test/run.js`
- Modify: `package.json`

- [ ] **Step 1: Create the combined test runner**

```js
// test/run.js
'use strict';

const { smokeTest } = require('./smoke.js');
const { e2eTest } = require('./e2e.js');

const args = process.argv.slice(2);
let mode = 'all';
let filterPlugin = null;

for (const arg of args) {
  if (arg === '--smoke') mode = 'smoke';
  else if (arg === '--e2e') mode = 'e2e';
  else filterPlugin = arg;
}

async function run() {
  let failures = 0;

  if (mode === 'all' || mode === 'smoke') {
    console.log('=== Smoke Tests ===\n');
    failures += await smokeTest(filterPlugin);
    console.log('');
  }

  if (mode === 'all' || mode === 'e2e') {
    console.log('=== E2E Tests ===\n');
    failures += await e2eTest(filterPlugin);
    console.log('');
  }

  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Add npm scripts to package.json**

Update the `scripts` section in `package.json`:

```json
{
  "scripts": {
    "build": "./build.sh",
    "deploy": "./build.sh --deploy",
    "test": "node test/run.js",
    "test:smoke": "node test/run.js --smoke",
    "test:e2e": "node test/run.js --e2e"
  }
}
```

- [ ] **Step 3: Verify npm scripts work**

Run: `npm run test:smoke`

Expected: Runs smoke tests only.

Run: `npm run test:smoke -- av1anEncode`

Expected: Runs smoke test for av1anEncode only.

- [ ] **Step 4: Commit**

```bash
git add test/run.js package.json
git commit -m "feat: add npm test scripts for smoke, e2e, and combined testing"
```

---

### Task 7: Verify Full Workflow

- [ ] **Step 1: Run the full test suite**

Run: `npm run deploy && npm test`

Expected:
```
=== Smoke Tests ===

Syncing plugins to nodes...
Fetching local plugin list...
smoke: av1anEncode .............. ok
smoke: abAv1Encode .............. ok

=== E2E Tests ===

Using sample: synthetic.mkv
Running 2 scenario(s)...

e2e:   av1anEncode: svt-av1 default ... ok (45s)
e2e:   abAv1Encode: default ........... ok (50s)

All e2e tests passed.
```

- [ ] **Step 2: Verify targeted testing**

Run: `npm test -- av1anEncode`

Expected: Only av1anEncode smoke + e2e runs.

- [ ] **Step 3: Verify teardown works (no leftover flows/libraries in Tdarr)**

Run: `node -e "const api = require('./test/lib/tdarrApi.js'); api.cruddb('FlowsJSONDB', 'getAll').then(f => console.log('flows:', f.length)); api.cruddb('LibrarySettingsJSONDB', 'getAll').then(l => console.log('libs:', l.length))"`

Expected: No test flows or libraries left behind (counts should match pre-test values).

- [ ] **Step 4: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: adjustments from full test workflow verification"
```

Only commit if changes were made. Skip if everything passed clean.
