#!/usr/bin/env node
// Drives the xav plugins as REAL TDARR JOBS on the JOB5 throwaway, so a run
// exercises the whole integration -- flow wiring, sanitizeFile staging, worker
// dashboard updates, output ports, replaceOriginalFile -- and not just the
// encoder. The direct-bundle functest is faster but proves none of that.
//
// Reuses test/lib/tdarrApi.js so document shapes stay in sync with the e2e suite.
//
//   TDARR_URL=http://10.0.0.3:8275 node tools/job5-tdarr-bench.js \
//     --clips westworld,harrypotter --arms auto,none \
//     --binary /opt/xav/xav-mainline --target 69.8-70.2 --preset 6 \
//     --out /tmp/results.tsv
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const api = require('../test/lib/tdarrApi');

const SSH = ['ssh', '-i', `${process.env.HOME}/.ssh/tower`,
  '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', 'root@10.0.0.3'];

// Host-side paths. The VM's own view of these is virtiofs and lags 30+ minutes,
// so every read and write goes over SSH to the host.
const HOST_LIB = '/mnt/cache_nvme_two/vm_data/xav-work/job5/library';
const HOST_CLIPS = '/mnt/cache_nvme_two/vm_data/xav-work/job5/clips';
const CONTAINER_LIB = '/mnt/library';
const REPORTS = '/mnt/cache_nvme_two/vm_data/xav-work/job5/server/Tdarr/DB2/JobReports/undefined';

const sh = (command) => cp.execFileSync(SSH[0], [...SSH.slice(1), command],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const CLIPS = arg('clips', 'westworld').split(',');
// Arm spec: "label|paramSet|extraParams". Bare "auto" still means auto/no extra.
// Isolating one knob through extra_params beats forcing a whole set across
// binaries -- tune numbering differs between mainline and the hdr fork, so a
// bulk port would move several variables at once.
const ARMS = arg('arms', 'auto,none').split(',').map((a) => {
  const [label, paramSet, extraParams] = a.split('|');
  return { label, paramSet: paramSet || label, extraParams: extraParams || '' };
});
const BINARY = arg('binary', '/opt/xav/xav-mainline');
const TARGET = arg('target', '69.8-70.2');
const PRESET = arg('preset', '6');
const PCT = arg('pct', '100');   // <100 arms the size gate; 100 disables it
const OUT = arg('out', '/tmp/job5-tdarr-bench.tsv');

const uniqueId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const row = (cols) => {
  fs.appendFileSync(OUT, cols.join('\t') + '\n');
  console.log(cols.join('\t'));
};

// The plugin's own log lines survive only in the job report, so that is where
// the achieved score and the applied parameter string have to be read from.
function readReport(runId) {
  let file = '';
  try {
    file = sh(`grep -l '${runId}' ${REPORTS}/*transcode*.txt 2>/dev/null | head -1`).trim();
  } catch { /* no match */ }
  if (!file) return {};
  const text = sh(`cat '${file}'`);
  const score = /achieved SSIMULACRA2: mean ([\d.]+), worst ([\d.]+) across (\d+)/.exec(text);
  const params = /params\s+:\s*(.+)/.exec(text);
  const applied = /^\s+(--preset .+)$/m.exec(text.replace(/^.*Worker\[[^\]]+\]:/gm, ''));
  return {
    mean: score ? Number(score[1]) : 0,
    worst: score ? Number(score[2]) : 0,
    chunks: score ? Number(score[3]) : 0,
    paramSet: params ? params[1].trim() : '',
    applied: applied ? applied[1].trim() : '',
    gate: /projected output exceeded the size limit/.test(text) ? 'passthrough' : '',
    reportFile: path.basename(file),
  };
}

function buildFlow(flowId, arm) {
  return {
    _id: flowId,
    name: `job5 bench ${arm.label}`,
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
        // Mandatory: xav writes its temp dir next to the input file, and
        // xavEncode refuses to run unless the working file is already in workDir.
        name: 'Sanitize File',
        sourceRepo: 'Local',
        pluginName: 'sanitizeFile',
        version: '1.0.0',
        id: 'node-sanitize',
        position: { x: 500, y: 250 },
        inputsDB: {},
      },
      {
        name: 'AV1 Encode (xav)',
        sourceRepo: 'Local',
        pluginName: 'xavEncode',
        version: '1.0.0',
        id: 'node-encode',
        position: { x: 500, y: 400 },
        inputsDB: {
          xav_path: BINARY,
          target_quality: TARGET,
          tq_mode: 'mean',
          crf_range: '5-63',
          preset: PRESET,
          workers: '2',
          vship: '1',
          param_set: arm.paramSet,
          extra_params: arm.extraParams,
          max_encoded_percent: PCT,
        },
      },
      {
        name: 'Replace Original',
        sourceRepo: 'Community',
        pluginName: 'replaceOriginalFile',
        version: '1.0.0',
        id: 'node-replace',
        position: { x: 500, y: 550 },
        inputsDB: {},
      },
    ],
    flowEdges: [
      { id: 'e1', source: 'node-input', sourceHandle: '1', target: 'node-sanitize', targetHandle: null },
      // BOTH sanitizeFile outputs must reach the encoder or already-clean files dead-end.
      { id: 'e2', source: 'node-sanitize', sourceHandle: '1', target: 'node-encode', targetHandle: null },
      { id: 'e3', source: 'node-sanitize', sourceHandle: '2', target: 'node-encode', targetHandle: null },
      { id: 'e4', source: 'node-encode', sourceHandle: '1', target: 'node-replace', targetHandle: null },
      // Port 2 is the size-gate passthrough, where the working file IS the
      // original. It must still reach a terminal node: left dangling, a correct
      // passthrough ends the flow with nowhere to go and Tdarr records
      // "Transcode error" even though the plugin behaved exactly as designed.
      // Verified 2026-08-13 -- closeenc tripped the gate at 116.2%, preserved the
      // original byte-for-byte, and still reported as an error until this edge
      // existed. Replacing the original with itself is a no-op.
      { id: 'e5', source: 'node-encode', sourceHandle: '2', target: 'node-replace', targetHandle: null },
    ],
  };
}

(async () => {
  if (!fs.existsSync(OUT)) {
    row(['clip', 'arm', 'status', 'src_bytes', 'out_bytes', 'pct_of_src',
      'achieved_mean', 'achieved_worst', 'chunks', 'wall_s', 'gate', 'param_set', 'applied']);
  }

  for (const clip of CLIPS) {
    for (const arm of ARMS) {
      const runId = uniqueId();
      const flowId = `flow-${runId}`;
      const libId = `lib-${runId}`;
      const hostDir = `${HOST_LIB}/${runId}`;
      const containerFile = `${CONTAINER_LIB}/${runId}/${clip}.mkv`;
      const start = Date.now();

      // Library dirs must be owned 99:100 or the node fails staging with EACCES.
      sh(`mkdir -p '${hostDir}' && cp '${HOST_CLIPS}/${clip}.mkv' '${hostDir}/' && chown -R 99:100 '${hostDir}'`);
      const srcBytes = Number(sh(`stat -c %s '${hostDir}/${clip}.mkv'`).trim());

      let status = 'unknown';
      let outBytes = 0;
      let report = {};
      try {
        await api.cruddb('FlowsJSONDB', 'insert', flowId, buildFlow(flowId, arm));
        await api.cruddb('LibrarySettingsJSONDB', 'insert', libId, {
          _id: libId,
          name: `bench ${runId}`,
          folder: `${CONTAINER_LIB}/${runId}`,
          cache: '/temp',
          createdAt: Date.now(),
          flowId,
          decisionMaker: {
            settingsFlows: true, settingsPlugin: false, settingsVideo: false, settingsAudio: false,
          },
        });

        const fileObj = await api.scanFile(libId, containerFile);
        await api.cruddb('FileJSONDB', 'insert', fileObj._id, fileObj);
        await api.requeueFile(containerFile);

        const result = await api.pollJobStatus(libId, { runId, idleTimeoutMs: 900000 });
        status = result.status;

        // replaceOriginalFile writes back into the library dir, so whatever is
        // there now is the job's real output.
        outBytes = Number(sh(`stat -c %s "$(ls '${hostDir}'/*.mkv | head -1)" 2>/dev/null || echo 0`).trim());
        report = readReport(runId);
      } catch (err) {
        status = `error: ${err.message}`;
      } finally {
        try { await api.cruddb('FlowsJSONDB', 'removeOne', flowId); } catch { /* best effort */ }
        try { await api.cruddb('LibrarySettingsJSONDB', 'removeOne', libId); } catch { /* best effort */ }
      }

      row([clip, arm.label, status, srcBytes, outBytes,
        outBytes ? ((outBytes / srcBytes) * 100).toFixed(2) : '',
        (report.mean || 0).toFixed(2), (report.worst || 0).toFixed(2), report.chunks || 0,
        ((Date.now() - start) / 1000).toFixed(1),
        report.gate || 'encoded',
        report.paramSet || '', report.applied || '']);

      sh(`rm -rf '${hostDir}'`);
    }
  }
  console.log('TDARR BENCH COMPLETE');
})();
