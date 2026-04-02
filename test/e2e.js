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

    if (result.status === 'skipped') {
      console.log(`${label} ... FAIL (job skipped — check flow/library config) (${elapsed}s)`);
      return false;
    }

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
    try { await api.cruddb('FlowsJSONDB', 'removeOne', flowId); }
    catch (e) { console.warn(`  [teardown] failed to remove flow ${flowId}: ${e.message}`); }
    try { await api.cruddb('LibrarySettingsJSONDB', 'removeOne', libId); }
    catch (e) { console.warn(`  [teardown] failed to remove library ${libId}: ${e.message}`); }
    try { await api.cruddb('FileJSONDB', 'removeOne', `${containerDir}/${path.basename(sampleFile)}`); }
    catch (e) { console.warn(`  [teardown] failed to remove file record: ${e.message}`); }
    try { fs.rmSync(scenarioDir, { recursive: true, force: true }); }
    catch (e) { console.warn(`  [teardown] failed to remove ${scenarioDir}: ${e.message}`); }
  }
}

async function e2eTest(filterPlugin) {
  if (!fs.existsSync(HOST_OUTPUT_DIR)) {
    console.error(`ERROR: Host output dir does not exist: ${HOST_OUTPUT_DIR}`);
    console.error('Is the tdarr-av1 sibling repo at ../tdarr-av1 and the test instance running?');
    process.exit(1);
  }

  const scenarios = discoverScenarios(filterPlugin);

  if (scenarios.length === 0) {
    console.error(
      filterPlugin
        ? `No e2e-tests.json found for plugin: ${filterPlugin}`
        : 'No e2e-tests.json files found in src/',
    );
    process.exit(1);
  }

  // Ensure at least 1 transcode CPU worker is available
  const nodes = await api.getNodes();
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.workerLimits && node.workerLimits.transcodecpu < 1) {
      console.log(`Enabling transcode CPU worker on node: ${node.nodeName || nodeId}`);
      await api.alterWorkerLimit(nodeId, 'transcodecpu', 'increase');
    }
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
