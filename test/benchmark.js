#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  THREAD_PRESETS, calculateThreadBudget,
  buildAomFlags, buildSvtFlags, buildAbAv1SvtFlags,
} = require('../src/shared/encoderFlags');
const {
  buildVsDownscaleLines, buildAv1anVmafResArgs, buildAbAv1DownscaleArgs,
} = require('../src/shared/downscale');
const { mapSigmaToGrainParam } = require('../src/shared/grainSynth');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONTAINER = process.env.TDARR_CONTAINER || 'tdarr-node';
const SAMPLES_DIR = path.join(__dirname, 'samples');
const BENCH_TEMP = '/tmp/bench';

const PRESETS = ['safe', 'balanced', 'aggressive', 'max', 'auto'];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const cliArgs = process.argv.slice(2);

if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
  console.log(`Usage: npm run benchmark -- [options]

Options:
  --encoder <name>      Encoder to benchmark: aom (default), svt-av1, or ab-av1
  --cpu-used <N>        Encoder preset/cpu-used value (default: 3)
  --vmaf <N>            Target VMAF score (default: 93)
  --downscale <res>     Downscale before encoding: 720p, 1080p, or 1440p (off by default)
  --duration <sec>      How long to run each test in seconds (default: 120)
  --preset <name>       Preset(s) to test (repeatable): safe, balanced, aggressive, max, legacy
  --custom <json>       Custom config (repeatable): '{"workers":12,"threadsPerWorker":6,"vmafThreads":16}'
  --reality <sec>       Trim sample to N seconds (from middle) and encode to completion
  --grain               Enable VapourSynth grain estimation (auto-detects film grain level)
  --no-warmup           Skip scene cache warmup, each run does fresh scene detection + encode
                        (default; use --warmup to force cached scene detection)
  --warmup              Use shared scene cache warmup (faster but may skew results)
  --grid                Test a custom worker×thread grid instead of presets
  --sample <name>       Filter sample files by name substring
  --help, -h            Show this help

Environment:
  TDARR_CONTAINER     Docker container name (default: tdarr-node)

Examples:
  npm run benchmark                                    # test all 4 presets with aom
  npm run benchmark -- --encoder aom --cpu-used 3      # aomenc at preset 3
  npm run benchmark -- --encoder svt-av1 --cpu-used 4  # SVT-AV1 at preset 4
  npm run benchmark -- --encoder ab-av1 --cpu-used 3   # ab-av1 (single-process)
  npm run benchmark -- --preset aggressive             # test one preset only
  npm run benchmark -- --grid --encoder aom            # custom worker×thread grid
  npm run benchmark -- --downscale 720p                 # benchmark with downscale pre-filter
  npm run benchmark -- --sample jurassic               # only use matching samples
  npm run benchmark -- --grain                          # benchmark with grain synthesis
  npm run benchmark -- --reality 30 --preset legacy --preset max --encoder aom

Encoder flags match the plugin defaults (buildAomFlags/buildSvtFlags from encoderFlags.js).
Sample files go in test/samples/ (.mkv, .mp4, .ts).`);
  process.exit(0);
}

const gridMode = cliArgs.includes('--grid');
const presetFilter = (() => {
  const presets = [];
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === '--preset' && cliArgs[i + 1]) presets.push(cliArgs[++i]);
  }
  return presets.length > 0 ? presets : null;
})();
const customConfigs = (() => {
  const configs = [];
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === '--custom' && cliArgs[i + 1]) {
      try {
        const c = JSON.parse(cliArgs[++i]);
        const w = c.workers;
        const t = c.threadsPerWorker || c.tpw || 1;
        const v = c.vmafThreads || 16;
        configs.push({ workers: w, tpw: t, svtLp: t, vmafThreads: v, label: `${w}w×${t}t` });
      } catch (e) {
        console.error(`ERROR: invalid --custom JSON: ${e.message}`);
        process.exit(1);
      }
    }
  }
  return configs;
})();
const sampleFilter = (() => {
  const idx = cliArgs.indexOf('--sample');
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : null;
})();
const encoderArg = (() => {
  const idx = cliArgs.indexOf('--encoder');
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : 'aom';
})();
const cpuUsed = (() => {
  const idx = cliArgs.indexOf('--cpu-used');
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : '3';
})();
const targetVmaf = (() => {
  const idx = cliArgs.indexOf('--vmaf');
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : '93';
})();
const downscaleRes = (() => {
  const idx = cliArgs.indexOf('--downscale');
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : null;
})();
const testDuration = (() => {
  const idx = cliArgs.indexOf('--duration');
  return idx !== -1 && cliArgs[idx + 1] ? Number(cliArgs[idx + 1]) : 120;
})();

const realitySeconds = (() => {
  const idx = cliArgs.indexOf('--reality');
  return idx !== -1 && cliArgs[idx + 1] ? Number(cliArgs[idx + 1]) : null;
})();
const grainEnabled = cliArgs.includes('--grain');
const noWarmup = cliArgs.includes('--no-warmup') || !cliArgs.includes('--warmup');

if (realitySeconds != null && cliArgs.includes('--duration')) {
  console.error('ERROR: --reality and --duration are mutually exclusive');
  process.exit(1);
}
if (realitySeconds != null && realitySeconds <= 0) {
  console.error('ERROR: --reality must be a positive number of seconds');
  process.exit(1);
}
if (realitySeconds != null && encoderArg === 'ab-av1') {
  console.error('ERROR: --reality is not supported with ab-av1 (only av1an encoders)');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Grid generation
// ---------------------------------------------------------------------------
function generateGrid(threads) {
  const workerOptions = [2, 4, 6, 8, 10, 12, 16, 20, 24].filter((w) => w <= threads);
  const tpwOptions = [1, 2, 3, 4, 6, 8].filter((t) => t <= threads);
  const combos = [];
  for (const w of workerOptions) {
    for (const t of tpwOptions) {
      if (w * t <= threads * 1.25) {
        combos.push({
          workers: w,
          tpw: t,
          svtLp: t,
          vmafThreads: Math.min(16, Math.floor(threads / 2)),
          label: `${w}w×${t}t`,
        });
      }
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Cleanup on interrupt
// ---------------------------------------------------------------------------
let activeProc = null;

function cleanup() {
  console.log('\n\nInterrupted — killing encode processes in container...');
  if (activeProc) activeProc.kill('SIGKILL');
  // Kill av1an, ab-av1, aomenc, SvtAv1EncApp, and ffmpeg inside the container
  spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
    'pkill -9 -f "av1an|ab-av1|aomenc|SvtAv1EncApp|ffmpeg|vspipe" 2>/dev/null; true',
  ]);
  spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
    `rm -rf ${BENCH_TEMP} /samples 2>/dev/null; true`,
  ]);
  console.log('Cleanup done.');
  process.exit(1);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------
function dockerExec(cmd, { timeout = 600000, live = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', CONTAINER, 'bash', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (live) activeProc = proc;

    let stdout = '';
    let stderr = '';

    // av1an uses \r for progress bars — split on both \n and \r
    const splitLines = (str) => str.split(/[\r\n]+/).filter(Boolean);
    // Skip noisy/empty lines from av1an/encoder output
    const SKIP = /^\s*$|Creating lwi index file|^Encoding:\s|^Svt\[|^source pipe|^ffmpeg pipe|SUMMARY|Total Frames|Frame Rate|Byte Count|Bitrate|Average Speed|Total Encoding|Total Execution|Average Latency|Max Latency|FRAME MISMATCH|frame.mismatch|Don't force output FPS/;

    proc.stdout.on('data', (d) => {
      stdout += d;
      if (live) {
        for (const line of splitLines(d.toString())) {
          const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trimEnd();
          if (clean && !SKIP.test(clean)) process.stdout.write(`    ${clean}\n`);
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (live) {
        for (const line of splitLines(d.toString())) {
          const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trimEnd();
          if (clean && !SKIP.test(clean)) process.stdout.write(`    ${clean}\n`);
        }
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`docker exec timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (live) activeProc = null;
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
  });
}

function parseMemGiB(str) {
  const match = str.match(/([\d.]+)\s*(GiB|MiB|KiB|B)/i);
  if (!match) return NaN;
  const val = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 'gib': return val;
    case 'mib': return val / 1024;
    case 'kib': return val / (1024 * 1024);
    default: return val / (1024 * 1024 * 1024);
  }
}

// ---------------------------------------------------------------------------
// Benchmark runners
// ---------------------------------------------------------------------------
async function benchAv1an(samplePath, config, { realityMode = false, activeSample = null, totalFrames = 0, grainParam = 0 } = {}) {
  const containerSample = activeSample || `/samples/${path.basename(samplePath)}`;
  const warmupDir = `${BENCH_TEMP}/warmup`;

  let encFlags;
  if (config.auto) {
    // Auto mode: build flags without thread params, let av1an/encoder decide
    encFlags = encoderArg === 'aom'
      ? buildAomFlags(Number(cpuUsed), 0, '', grainParam).replace(/--threads=\d+\s*/, '')
      : buildSvtFlags(Number(cpuUsed), 0, '', grainParam).replace(/--lp \d+\s*/, '');
  } else {
    encFlags = encoderArg === 'aom'
      ? buildAomFlags(Number(cpuUsed), config.tpw, '', grainParam)
      : buildSvtFlags(Number(cpuUsed), config.svtLp, '', grainParam);
  }

  const av1anEncoder = encoderArg === 'aom' ? 'aom' : 'svt-av1';
  console.log(`    Encoder flags: ${encFlags}`);

  const workerArgs = config.auto
    ? ''
    : `--workers ${config.workers} --vmaf-threads ${config.vmafThreads}`;

  let av1anCmdParts;
  if (noWarmup) {
    // Fresh run: no scene cache, av1an does scene detection + encode from scratch
    const runDir = `${BENCH_TEMP}/run-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    av1anCmdParts = [
      `rm -rf ${runDir} 2>/dev/null;`,
      `mkdir -p ${runDir}/work &&`,
      `av1an -i "${containerSample}" -o ${runDir}/out.mkv --temp ${runDir}/work`,
      `-c mkvmerge -e ${av1anEncoder}`,
      workerArgs,
      `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
      `--sc-downscale-height 540 --chunk-order long-to-short --chunk-method hybrid --ignore-frame-mismatch`,
      `--target-quality ${targetVmaf} --qp-range 10-50 --probes 6`,
      `--verbose`,
    ];
  } else {
    // Reuse warmup's scene cache — clean encode output between runs
    // av1an requires scenes.json + done.json with {"frames": N, "done": {}} + --resume
    av1anCmdParts = [
      `rm -rf ${warmupDir}/work ${warmupDir}/out.mkv 2>/dev/null;`,
      `mkdir -p ${warmupDir}/work &&`,
      `cp ${warmupDir}/scenes_backup.json ${warmupDir}/work/scenes.json &&`,
      `cp ${warmupDir}/chunks_backup.json ${warmupDir}/work/chunks.json &&`,
      `echo '{"frames":0,"done":{},"audio_done":false}' > ${warmupDir}/work/done.json &&`,
      `av1an -i ${warmupDir}/vs/bench.vpy -o ${warmupDir}/out.mkv --temp ${warmupDir}/work`,
      `-c mkvmerge -e ${av1anEncoder}`,
      workerArgs,
      `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
      `--sc-downscale-height 540 --chunk-order long-to-short --chunk-method hybrid --ignore-frame-mismatch`,
      `--target-quality ${targetVmaf} --qp-range 10-50 --probes 6`,
      `--verbose --resume`,
    ];
  }
  if (downscaleRes) {
    const vmafResArgs = buildAv1anVmafResArgs(downscaleRes);
    if (vmafResArgs.length) av1anCmdParts.push(vmafResArgs.join(' '));
  }
  av1anCmdParts.push(`-v "${encFlags}"`);
  const cmd = av1anCmdParts.join(' ');

  const startMs = Date.now();
  let encodeStartMs = null;  // timestamp when av1an starts encoding chunks
  const runDir = noWarmup
    ? `${BENCH_TEMP}/run-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : warmupDir;
  const workDir = `${runDir}/work`;
  const cpuSamples = [];
  const memSamples = [];

  // Measure encoded bytes — av1an writes chunks to work/encode/ but target-quality
  // probes write to other subdirs first; check the whole work dir for activity
  const readBytesScript = `du -sb ${workDir} 2>/dev/null | cut -f1 || echo 0`;

  // Progress + stats monitor, kills encode when duration reached.
  // Polls every 2s until encoding starts (to catch the exact start time),
  // then switches to 10s intervals for the rest.
  let timedOut = false;
  let monitorTimer = null;

  const monitorTick = async () => {
    try {
      // One-shot docker stats
      const ds = spawnSync('docker', [
        'stats', CONTAINER, '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}',
      ], { timeout: 5000 });
      if (ds.stdout) {
        const parts = ds.stdout.toString().trim().split('\t');
        if (parts.length >= 2) {
          const cpu = parseFloat(parts[0]);
          const mem = parseMemGiB(parts[1].split('/')[0].trim());
          if (!isNaN(cpu)) cpuSamples.push(cpu);
          if (!isNaN(mem)) memSamples.push(mem);
        }
      }

      // Read actual bytes on disk minus baseline
      const bytesCheck = await dockerExec(readBytesScript, { timeout: 5000 });
      const encBytes = parseInt(bytesCheck.stdout.trim(), 10) || 0;
      const encMiB = (encBytes / (1024 * 1024)).toFixed(1);

      // Track when encoding actually starts (first bytes appear)
      if (encodeStartMs === null && encBytes > 0) {
        encodeStartMs = Date.now();
        // Switch from fast polling (2s) to normal interval (10s)
        clearInterval(monitorTimer);
        monitorTimer = setInterval(monitorTick, 10000);
      }

      const elapsed = formatMs(Date.now() - startMs);
      const cpuStr = cpuSamples.length > 0 ? cpuSamples[cpuSamples.length - 1].toFixed(0) + '%' : '-';
      const memStr = memSamples.length > 0 ? memSamples[memSamples.length - 1].toFixed(1) + ' GiB' : '-';

      // Duration timer starts from first encoded bytes, not from command start
      const encElapsedSec = encodeStartMs ? (Date.now() - encodeStartMs) / 1000 : 0;

      if (realityMode) {
        process.stdout.write(`\r    [${elapsed}] workers: ${config.workers} | encoded: ${encMiB} MiB | cpu: ${cpuStr} | ram: ${memStr}    `);
      } else if (encodeStartMs) {
        const remaining = Math.max(0, testDuration - encElapsedSec);
        process.stdout.write(`\r    [${elapsed}] workers: ${config.workers} | encoded: ${encMiB} MiB | ${formatMs(remaining * 1000)} left | cpu: ${cpuStr} | ram: ${memStr}    `);
      } else {
        process.stdout.write(`\r    [${elapsed}] workers: ${config.workers} | scene detection... | cpu: ${cpuStr} | ram: ${memStr}    `);
      }

      // Time limit — only count time since encoding started
      if (!realityMode && encodeStartMs && encElapsedSec >= testDuration) {
        timedOut = true;
        process.stdout.write(`    Encode time limit reached (${testDuration}s) — stopping\n`);
        spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
          'pkill -f "av1an|aomenc|SvtAv1EncApp" 2>/dev/null; true',
        ]);
      }
    } catch (_) {}
  };

  // Start with fast 1s polling to catch encode start precisely
  monitorTimer = setInterval(monitorTick, 1000);

  // Extra time for scene detection when no warmup, plus encode duration, plus muxing buffer
  const sceneDetectionBuffer = noWarmup ? 300 : 60;
  const execTimeout = realityMode ? 7200000 : (testDuration + sceneDetectionBuffer) * 1000;
  const result = await dockerExec(cmd, { timeout: execTimeout, live: true });

  clearInterval(monitorTimer);
  process.stdout.write('\n');

  if (result.code !== 0 && !timedOut) {
    const errTail = (result.stderr || result.stdout || '').trim().slice(-500);
    if (errTail) console.error(`    Encode failed (exit ${result.code}):\n    ${errTail.split('\n').join('\n    ')}`);
  }

  const chunkFps = await parseChunkFps(workDir);
  const encodeTimeMs = Date.now() - startMs;

  const avgCpu = cpuSamples.length > 0
    ? cpuSamples.reduce((s, v) => s + v, 0) / cpuSamples.length : 0;
  const peakMem = memSamples.length > 0 ? Math.max(...memSamples) : 0;

  // Read final output file size
  let encBytes = 0;
  try {
    const outFileScript = `stat -c%s ${runDir}/out.mkv 2>/dev/null || echo 0`;
    const outResult = await dockerExec(outFileScript, { timeout: 8000 });
    encBytes = parseInt(outResult.stdout.trim(), 10) || 0;
    if (encBytes > 0) {
      console.log(`    Output file: ${runDir}/out.mkv (${(encBytes / (1024 * 1024)).toFixed(1)} MiB)`);
    } else {
      // Fall back to encode dir for in-progress measurement
      const bytesResult = await dockerExec(readBytesScript, { timeout: 8000 });
      encBytes = parseInt(bytesResult.stdout.trim(), 10) || 0;
      console.log(`    Output file not found, using encode dir: ${(encBytes / (1024 * 1024)).toFixed(1)} MiB`);
    }
  } catch (_) {}

  const encodeTimeSec = encodeTimeMs / 1000;
  const encodeOnlyMs = encodeStartMs ? (Date.now() - startMs) - (encodeStartMs - startMs) : null;
  const encodeOnlySec = encodeOnlyMs ? encodeOnlyMs / 1000 : null;
  const mibPerMin = encBytes > 0 && encodeTimeSec > 0
    ? (encBytes / (1024 * 1024)) / (encodeTimeSec / 60) : 0;

  const fps = realityMode && totalFrames > 0 && encodeTimeSec > 0
    ? (totalFrames / encodeTimeSec).toFixed(1) : null;
  const encodeFps = realityMode && totalFrames > 0 && encodeOnlySec > 0
    ? (totalFrames / encodeOnlySec).toFixed(1) : null;

  return {
    label: config.label,
    workers: config.workers,
    threads: config.tpw,
    vmafThreads: config.vmafThreads,
    mibPerMin: mibPerMin.toFixed(1),
    totalMiB: (encBytes / (1024 * 1024)).toFixed(1),
    avgCpu: avgCpu.toFixed(0),
    peakMem: peakMem.toFixed(1),
    time: formatMs(encodeTimeMs),
    encodeTime: encodeOnlyMs ? formatMs(encodeOnlyMs) : null,
    exitCode: timedOut ? 0 : result.code,
    oom: peakMem > 0 && result.code !== 0 && !timedOut && peakMem > 50,
    fps,
    encodeFps,
    totalFrames: realityMode ? totalFrames : null,
    chunkFps,
  };
}

async function benchAbAv1(samplePath, config, crf, grainParam = 0) {
  const containerSample = `/samples/${path.basename(samplePath)}`;
  const tempDir = `${BENCH_TEMP}/ab-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const svtFlags = buildAbAv1SvtFlags(config.svtLp, grainParam);
  console.log(`    SVT flags: ${svtFlags}`);
  const abCmdParts = [
    `mkdir -p ${tempDir} &&`,
    `ab-av1 encode`,
    `-i "${containerSample}" -o ${tempDir}/out.mkv`,
    `--encoder libsvtav1 --preset ${cpuUsed}`,
    `--crf ${crf}`,
  ];
  if (downscaleRes) {
    const dsArgs = buildAbAv1DownscaleArgs(downscaleRes);
    if (dsArgs.length) abCmdParts.push(dsArgs.join(' '));
  }
  abCmdParts.push(svtFlags);
  const cmd = abCmdParts.join(' ');

  const startMs = Date.now();
  const cpuSamples = [];
  const memSamples = [];
  let timedOut = false;

  // Read total bytes written by ab-av1 (output file + any temp files)
  const readSizeScript = `du -sb ${tempDir} 2>/dev/null | cut -f1 || echo 0`;

  const statsInterval = setInterval(async () => {
    try {
      const ds = spawnSync('docker', [
        'stats', CONTAINER, '--no-stream', '--format', '{{.CPUPerc}}\t{{.MemUsage}}',
      ], { timeout: 5000 });
      if (ds.stdout) {
        const parts = ds.stdout.toString().trim().split('\t');
        if (parts.length >= 2) {
          const cpu = parseFloat(parts[0]);
          const mem = parseMemGiB(parts[1].split('/')[0].trim());
          if (!isNaN(cpu)) cpuSamples.push(cpu);
          if (!isNaN(mem)) memSamples.push(mem);
        }
      }

      const sizeCheck = await dockerExec(readSizeScript, { timeout: 5000 });
      const encBytes = parseInt(sizeCheck.stdout.trim(), 10) || 0;
      const encMiB = (encBytes / (1024 * 1024)).toFixed(1);

      const elapsedSec = (Date.now() - startMs) / 1000;
      const elapsed = formatMs(Date.now() - startMs);
      const cpuStr = cpuSamples.length > 0 ? cpuSamples[cpuSamples.length - 1].toFixed(0) + '%' : '-';
      const memStr = memSamples.length > 0 ? memSamples[memSamples.length - 1].toFixed(1) + ' GiB' : '-';
      const remaining = Math.max(0, testDuration - elapsedSec);
      process.stdout.write(`\r    [${elapsed}] encoded: ${encMiB} MiB | ${formatMs(remaining * 1000)} left | cpu: ${cpuStr} | ram: ${memStr}    `);

      if (elapsedSec >= testDuration) {
        timedOut = true;
        process.stdout.write(`    Time limit reached (${testDuration}s) — stopping encode\n`);
        spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
          'pkill -f "ab-av1|SvtAv1EncApp|ffmpeg" 2>/dev/null; true',
        ]);
      }
    } catch (_) {}
  }, 10000);

  const result = await dockerExec(cmd, { timeout: (testDuration + 60) * 1000, live: false });

  clearInterval(statsInterval);
  process.stdout.write('\n');
  const encodeTimeMs = Date.now() - startMs;
  const avgCpu = cpuSamples.length > 0
    ? cpuSamples.reduce((s, v) => s + v, 0) / cpuSamples.length : 0;
  const peakMem = memSamples.length > 0 ? Math.max(...memSamples) : 0;

  let encBytes = 0;
  try {
    const final = await dockerExec(readSizeScript, { timeout: 5000 });
    encBytes = parseInt(final.stdout.trim(), 10) || 0;
  } catch (_) {}

  const encodeTimeSec = encodeTimeMs / 1000;
  const mibPerMin = encBytes > 0 && encodeTimeSec > 0
    ? (encBytes / (1024 * 1024)) / (encodeTimeSec / 60) : 0;

  return {
    label: config.label,
    workers: '-',
    threads: config.svtLp,
    vmafThreads: '-',
    mibPerMin: mibPerMin.toFixed(1),
    totalMiB: (encBytes / (1024 * 1024)).toFixed(1),
    avgCpu: avgCpu.toFixed(0),
    peakMem: peakMem.toFixed(1),
    time: formatMs(encodeTimeMs),
    exitCode: timedOut ? 0 : result.code,
    oom: peakMem > 0 && result.code !== 0 && !timedOut && peakMem > 50,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------
function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function printTable(results) {
  const hasReality = results.some((r) => r.fps != null);
  const hasChunkFps = results.some((r) => r.chunkFps != null);
  const hasEncodeTime = results.some((r) => r.encodeTime != null);
  const hasEncodeFps = results.some((r) => r.encodeFps != null);

  const headers = ['Config', 'Workers', 'Threads', 'VMAF-T'];
  if (hasEncodeFps) headers.push('Enc FPS');
  if (hasChunkFps) headers.push('Chunk FPS (min/med/max)');
  if (!hasReality) headers.push('MiB/min');
  headers.push('Total MiB', 'CPU %', 'Peak RAM');
  if (hasEncodeTime) headers.push('Enc Time');
  headers.push('Time', 'Status');

  const rows = results.map((r) => {
    const row = [
      r.label,
      r.workers != null ? String(r.workers) : 'auto',
      r.threads != null ? String(r.threads) : 'auto',
      r.vmafThreads != null ? String(r.vmafThreads) : 'auto',
    ];
    if (hasEncodeFps) {
      row.push(r.encodeFps || '-');
    }
    if (hasChunkFps) {
      row.push(r.chunkFps
        ? `${r.chunkFps.min.toFixed(1)} / ${r.chunkFps.median.toFixed(1)} / ${r.chunkFps.max.toFixed(1)}`
        : '-');
    }
    if (!hasReality) row.push(r.mibPerMin);
    row.push(
      r.totalMiB,
      `${r.avgCpu}%`,
      `${r.peakMem} GiB`,
    );
    if (hasEncodeTime) row.push(r.encodeTime || '-');
    row.push(
      r.time,
      r.oom ? 'OOM' : r.exitCode === 0 ? 'OK' : `exit ${r.exitCode}`,
    );
    return row;
  });

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmt = (cells) => '|' + cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|') + '|';

  console.log(sep);
  console.log(fmt(headers));
  console.log(sep);
  rows.forEach((r) => console.log(fmt(r)));
  console.log(sep);

  // Recommendation — encode FPS is the primary metric in reality mode
  const ok = results.filter((r) => !r.oom && r.exitCode === 0);
  const best = hasEncodeFps
    ? ok.filter((r) => r.encodeFps != null).sort((a, b) => parseFloat(b.encodeFps) - parseFloat(a.encodeFps))[0]
    : ok.sort((a, b) => parseFloat(b.mibPerMin) - parseFloat(a.mibPerMin))[0];

  if (best) {
    const metric = hasEncodeFps ? `${best.encodeFps} encode fps` : `${best.mibPerMin} MiB/min`;
    const isPreset = PRESETS.includes(best.label);
    console.log(`\nRecommended: ${best.label} (${metric})`);
    if (isPreset) {
      console.log(`Set Thread Strategy to "${best.label}" in the plugin settings.`);
    } else if (best.workers !== '-') {
      console.log(`Set Thread Strategy to "custom" and paste into Thread Overrides:`);
      console.log(`{"workers":${best.workers},"threadsPerWorker":${best.threads},"vmafThreads":${best.vmafThreads}}`);
    } else {
      console.log(`Set Thread Strategy to "custom" and paste into Thread Overrides:`);
      console.log(`{"threadsPerWorker":${best.threads}}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy thread budget (replicates old plugin formula — oversubscribed)
// ---------------------------------------------------------------------------
function legacyThreadBudget(availableThreads) {
  const budget = availableThreads * 2;
  const maxWorkers = Math.max(1, Math.floor(availableThreads / 4));
  const threadsPerWorker = Math.min(
    availableThreads,
    Math.max(4, Math.floor(budget / (maxWorkers / 2)))
  );
  return { maxWorkers, threadsPerWorker, svtLp: threadsPerWorker, vmafThreads: 8 };
}

// ---------------------------------------------------------------------------
// Reality mode helpers
// ---------------------------------------------------------------------------
async function trimSampleForReality(containerSample, seconds) {
  const tag = `reality_${seconds}s`;
  const ext = path.extname(containerSample);
  const base = containerSample.replace(ext, '');
  const trimmedPath = `${base}_${tag}${ext}`;

  // Check cache
  const cacheCheck = await dockerExec(`test -f "${trimmedPath}" && echo yes || echo no`, { timeout: 5000 });
  if (cacheCheck.stdout.trim() === 'yes') {
    console.log(`  Using cached trimmed sample: ${path.basename(trimmedPath)}`);
    return trimmedPath;
  }

  // Probe duration
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${containerSample}"`;
  const probeResult = await dockerExec(probeCmd, { timeout: 15000 });
  const duration = parseFloat(probeResult.stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    console.error('ERROR: could not probe sample duration');
    process.exit(1);
  }

  const start = Math.max(0, (duration / 2) - (seconds / 2));
  console.log(`  Trimming ${seconds}s from middle (start=${start.toFixed(1)}s of ${duration.toFixed(1)}s)...`);

  const trimCmd = `ffmpeg -y -ss ${start.toFixed(3)} -i "${containerSample}" -t ${seconds} -c copy "${trimmedPath}"`;
  const trimResult = await dockerExec(trimCmd, { timeout: 60000 });
  if (trimResult.code !== 0) {
    console.error('ERROR: ffmpeg trim failed:', trimResult.stderr.slice(-300));
    process.exit(1);
  }

  return trimmedPath;
}

async function probeFrameCount(containerPath) {
  const cmd = `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "${containerPath}"`;
  const result = await dockerExec(cmd, { timeout: 60000 });
  const frames = parseInt(result.stdout.trim(), 10);
  return isNaN(frames) ? 0 : frames;
}

async function parseChunkFps(workDir) {
  const logDir = `${workDir}/log`;
  const lsResult = await dockerExec(`ls ${logDir}/ 2>/dev/null`, { timeout: 5000 });
  if (lsResult.code !== 0) return null;

  const logFiles = lsResult.stdout.trim().split('\n').filter((f) => f.startsWith('av1an.log'));
  if (logFiles.length === 0) return null;

  const allFps = [];
  for (const lf of logFiles) {
    const catResult = await dockerExec(`cat ${logDir}/${lf}`, { timeout: 10000 });
    if (catResult.code !== 0) continue;

    const lines = catResult.stdout.split('\n');
    for (const line of lines) {
      if (/finished/i.test(line)) {
        const m = line.match(/(\d+(?:\.\d+)?)\s*fps/i);
        if (m) allFps.push(parseFloat(m[1]));
      }
    }
  }

  if (allFps.length === 0) return null;

  const sorted = [...allFps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

// ---------------------------------------------------------------------------
// Grain estimation (runs inside container via VapourSynth)
// ---------------------------------------------------------------------------
async function estimateGrainInContainer(containerSample) {
  console.log('  Estimating grain level via VapourSynth...');

  // Probe frame count and duration
  const probeCmd = [
    'ffprobe -v error -select_streams v:0',
    '-show_entries stream=nb_frames,duration',
    `-of csv=p=0 "${containerSample}"`,
  ].join(' ');
  const probeResult = await dockerExec(probeCmd, { timeout: 30000 });
  const [framesStr, durStr] = probeResult.stdout.trim().split(',');
  let totalFrames = parseInt(framesStr, 10) || 0;
  let durationSec = parseFloat(durStr) || 0;

  // Fallback: count frames if nb_frames unavailable
  if (totalFrames === 0) {
    totalFrames = await probeFrameCount(containerSample);
  }
  if (durationSec === 0) {
    const durProbe = await dockerExec(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${containerSample}"`,
      { timeout: 15000 },
    );
    durationSec = parseFloat(durProbe.stdout.trim()) || 0;
  }

  if (totalFrames < 60) {
    console.log('  Grain estimation skipped (too few frames)');
    return 0;
  }

  // Build VapourSynth noise estimation script (same logic as grainSynth.js)
  const positions = [0.15, 0.35, 0.55, 0.75];
  const fpr = 50; // FRAMES_PER_REGION
  const maxStart = totalFrames - fpr - 1;
  const starts = positions.map((p) => Math.min(Math.max(0, Math.floor(p * totalFrames)), maxStart));

  const vpyLines = [
    'import vapoursynth as vs',
    'import sys',
    'core = vs.core',
    `clip = core.lsmas.LWLibavSource(source='${containerSample}')`,
    'luma = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)',
  ];
  for (let i = 0; i < starts.length; i++) {
    vpyLines.push(`r${i} = luma[${starts[i]}:${starts[i] + fpr}]`);
    vpyLines.push(`d${i} = core.std.Expr([r${i}[:-1], r${i}[1:]], expr=['x y - abs'])`);
    vpyLines.push(`d${i} = core.std.PlaneStats(d${i})`);
  }
  const parts = starts.map((_, i) => `d${i}`);
  vpyLines.push(`out = ${parts[0]}${parts.slice(1).map((p) => ' + ' + p).join('')}`);
  vpyLines.push('');
  vpyLines.push('def emit_sigma(n, f):');
  vpyLines.push('    avg = f.props["PlaneStatsAverage"]');
  vpyLines.push('    sigma = avg * 255.0 * 1.2533 / 1.4142');
  vpyLines.push('    sys.stderr.write("SIGMA:{:.6f}\\n".format(sigma))');
  vpyLines.push('    sys.stderr.flush()');
  vpyLines.push('    return f');
  vpyLines.push('');
  vpyLines.push('out = core.std.ModifyFrame(out, out, emit_sigma)');
  vpyLines.push('out.set_output()');

  const grainDir = `${BENCH_TEMP}/grain`;
  const vpyContent = vpyLines.join('\n');

  // Write the .vpy script via base64 to avoid heredoc/escaping issues in bash -c
  const vpyB64 = Buffer.from(vpyContent, 'utf8').toString('base64');
  const writeCmd = `mkdir -p ${grainDir} && echo '${vpyB64}' | base64 -d > ${grainDir}/noise.vpy`;
  await dockerExec(writeCmd, { timeout: 10000 });

  // Run vspipe separately so we get clean exit code and stderr
  const result = await dockerExec(`vspipe -p ${grainDir}/noise.vpy --`, { timeout: 180000 });

  if (result.code !== 0) {
    const errTail = (result.stderr || result.stdout || '').trim().slice(-500);
    console.log(`  Grain estimation failed (exit ${result.code}):`);
    if (errTail) console.log(`    ${errTail.split('\n').join('\n    ')}`);
    return 0;
  }

  const output = (result.stderr || '') + (result.stdout || '');

  // Parse SIGMA values
  const sigmaRegex = /SIGMA:([\d.]+)/g;
  const values = [];
  let match;
  while ((match = sigmaRegex.exec(output)) !== null) {
    const v = parseFloat(match[1]);
    if (isFinite(v)) values.push(v);
  }

  if (values.length === 0) {
    console.log('  Grain estimation: no SIGMA values detected, using grain=0');
    return 0;
  }

  // Median
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const sigma = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  const grainParam = mapSigmaToGrainParam(sigma);
  console.log(`  Grain estimation: sigma=${sigma.toFixed(2)} -> film-grain=${grainParam} (from ${values.length} frames)`);
  return grainParam;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const threads = os.cpus().length;
  console.log(`System: ${threads} threads`);
  console.log(`Container: ${CONTAINER}`);
  console.log(`Encoder: ${encoderArg}, cpu-used/preset: ${cpuUsed}, target-vmaf: ${targetVmaf}`)
  if (realitySeconds) {
    console.log(`Mode: reality (${realitySeconds}s trimmed from middle, encode to completion)`);
  } else {
    console.log(`Mode: duration (${testDuration}s per config, kill after limit)`);
  }
  if (grainEnabled) {
    console.log('Grain: enabled (VapourSynth noise estimation per sample)');
  }
  console.log('');

  // Verify container is running
  const check = await dockerExec('echo ok', { timeout: 10000 });
  if (check.code !== 0) {
    console.error(`ERROR: cannot reach container "${CONTAINER}". Is it running?`);
    process.exit(1);
  }

  // Find sample files
  if (!fs.existsSync(SAMPLES_DIR)) {
    console.error('ERROR: test/samples/ directory not found');
    process.exit(1);
  }
  const samples = fs.readdirSync(SAMPLES_DIR)
    .filter((f) => /\.(mkv|mp4|ts)$/i.test(f))
    .filter((f) => !sampleFilter || f.includes(sampleFilter))
    .map((f) => path.join(SAMPLES_DIR, f));

  if (samples.length === 0) {
    console.error('ERROR: no sample files found in test/samples/ (looking for .mkv, .mp4, .ts)');
    process.exit(1);
  }

  // Ensure /samples dir exists in container and copy samples
  await dockerExec('mkdir -p /samples');
  for (const s of samples) {
    const basename = path.basename(s);
    console.log(`Copying ${basename} to container...`);
    const cp = spawnSync('docker', ['cp', s, `${CONTAINER}:/samples/`]);
    if (cp.status !== 0) {
      console.error(`ERROR: failed to copy ${basename} to container`);
      process.exit(1);
    }
  }

  // Build configs to test
  let configs;
  const isAbAv1 = encoderArg === 'ab-av1';

  if (gridMode) {
    configs = generateGrid(threads);
    console.log(`\nGrid mode: ${configs.length} configurations to test\n`);
  } else {
    const presets = presetFilter || (customConfigs.length > 0 ? [] : PRESETS);
    configs = presets.map((name) => {
      if (name === 'auto') {
        return { workers: null, tpw: null, svtLp: null, vmafThreads: null, label: 'auto', auto: true };
      }
      if (name === 'legacy') {
        const b = legacyThreadBudget(threads);
        return { workers: b.maxWorkers, tpw: b.threadsPerWorker, svtLp: b.svtLp, vmafThreads: b.vmafThreads, label: 'legacy' };
      }
      const p = THREAD_PRESETS[name];
      if (!p) {
        console.error(`ERROR: unknown preset "${name}". Available: ${PRESETS.join(', ')}, legacy`);
        process.exit(1);
      }
      const encoder = encoderArg === 'ab-av1' ? 'svt-av1' : encoderArg;
      const singleProcess = encoderArg === 'ab-av1';
      const b = calculateThreadBudget(threads, encoder, false, { strategy: name, singleProcess, encPreset: Number(cpuUsed) });
      return { workers: b.maxWorkers, tpw: b.threadsPerWorker, svtLp: b.svtLp, vmafThreads: b.vmafThreads, label: name };
    });
    if (customConfigs.length > 0) configs.push(...customConfigs);
    console.log(`\nPreset mode: testing ${configs.map((c) => c.label).join(', ')}\n`);
  }

  // Run benchmarks per sample
  for (const sample of samples) {
    console.log('='.repeat(60));
    console.log(`Sample: ${path.basename(sample)}`);
    console.log('='.repeat(60));

    let activeSample = `/samples/${path.basename(sample)}`;
    if (realitySeconds) {
      activeSample = await trimSampleForReality(activeSample, realitySeconds);
    }

    // Grain estimation (once per sample, reused across all configs)
    let grainParam = 0;
    if (grainEnabled) {
      grainParam = await estimateGrainInContainer(activeSample);
    }

    // Warmup: run scene detection once so all benchmark runs use cached scenes
    if (!isAbAv1 && !noWarmup) {
      console.log('\nWarmup: running scene detection (will be cached for all configs)...');
      const containerSample = activeSample;
      const warmupDir = `${BENCH_TEMP}/warmup`;
      const vpyParts = [
        'import vapoursynth as vs',
        'core = vs.core',
        `src = core.lsmas.LWLibavSource(source=\\"${containerSample}\\")`,
      ];
      if (downscaleRes) {
        for (const line of buildVsDownscaleLines(downscaleRes)) {
          vpyParts.push(line);
        }
      }
      vpyParts.push('src.set_output()');
      const vpyLines = vpyParts.join('\\n');

      // Run av1an just long enough to complete scene detection, then kill
      const av1anEncoder = encoderArg === 'aom' ? 'aom' : 'svt-av1';
      const warmupEncFlags = encoderArg === 'aom'
        ? '--cpu-used=8 --threads=1'
        : '--preset 8 --lp 1';
      const warmupCmd = [
        `mkdir -p ${warmupDir}/work ${warmupDir}/vs &&`,
        `printf '${vpyLines}\\n' > ${warmupDir}/vs/bench.vpy &&`,
        `av1an -i ${warmupDir}/vs/bench.vpy -o ${warmupDir}/out.mkv --temp ${warmupDir}/work`,
        `-c mkvmerge -e ${av1anEncoder}`,
        `--workers 1 --sc-downscale-height 540`,
        `--target-quality ${targetVmaf} --qp-range 10-50`,
        `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
        `--verbose`,
        `-v "${warmupEncFlags}"`,
      ].join(' ');

      // Wait for scenes.json AND chunks.json to appear, then kill
      // av1an --resume requires both files plus done.json
      const warmupProc = dockerExec(warmupCmd, { timeout: 300000, live: true });
      let cacheReady = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const check = await dockerExec(
          `test -f ${warmupDir}/work/scenes.json && test -f ${warmupDir}/work/chunks.json && echo yes || echo no`,
          { timeout: 5000 },
        );
        if (check.stdout.trim() === 'yes') {
          cacheReady = true;
          process.stdout.write('    Scene detection + chunking complete — killing warmup encode\n');
          spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
            'pkill -f "av1an|aomenc|SvtAv1EncApp" 2>/dev/null; true',
          ]);
          break;
        }
      }
      await warmupProc.catch(() => {});
      if (!cacheReady) {
        console.error('ERROR: warmup timed out (5 min) — scenes.json or chunks.json not produced');
        process.exit(1);
      }
      // Back up cache files — av1an may clean work/ after a completed encode
      await dockerExec(`cp ${warmupDir}/work/scenes.json ${warmupDir}/scenes_backup.json`);
      await dockerExec(`cp ${warmupDir}/work/chunks.json ${warmupDir}/chunks_backup.json`);
      console.log('    Scenes cached.\n');
    }

    // ab-av1 warmup: run crf-search once, then use the found CRF for all encode tests
    let abAv1Crf = null;
    if (isAbAv1) {
      console.log('\nWarmup: running CRF search (will use found CRF for all configs)...');
      const containerSample = activeSample;
      const warmupDir = `${BENCH_TEMP}/ab-warmup`;

      // Use first config's svtLp for the search (doesn't affect CRF result much)
      const warmupLp = configs[0].svtLp;
      const warmupSvtFlags = buildAbAv1SvtFlags(warmupLp, 0);
      const crfSearchParts = [
        `mkdir -p ${warmupDir} &&`,
        `ab-av1 crf-search`,
        `-i "${containerSample}"`,
        `--encoder libsvtav1 --preset ${cpuUsed}`,
        `--min-vmaf ${targetVmaf} --min-crf 10 --max-crf 50`,
        `--vmaf "n_threads=4:model=path=/usr/local/share/vmaf/vmaf_v0.6.1.json"`,
      ];
      if (downscaleRes) {
        const dsArgs = buildAbAv1DownscaleArgs(downscaleRes);
        if (dsArgs.length) crfSearchParts.push(dsArgs.join(' '));
      }
      crfSearchParts.push(warmupSvtFlags, `--verbose`);
      const crfSearchCmd = crfSearchParts.join(' ');

      const crfResult = await dockerExec(crfSearchCmd, { timeout: 600000, live: true });
      const combined = crfResult.stdout + crfResult.stderr;

      // Parse CRF from ab-av1 output: "crf N" or "using crf N"
      const crfMatch = combined.match(/(?:crf|using crf)\s+(\d+)/i);
      if (crfMatch) {
        abAv1Crf = parseInt(crfMatch[1], 10);
        console.log(`    CRF search complete: crf=${abAv1Crf}\n`);
      } else {
        console.error('    ERROR: could not parse CRF from ab-av1 crf-search output');
        console.error('    Output:', combined.slice(-500));
        process.exit(1);
      }
    }

    let totalFrames = 0;
    if (realitySeconds && !isAbAv1) {
      totalFrames = await probeFrameCount(activeSample);
      if (totalFrames === 0) {
        console.error('ERROR: could not determine frame count of trimmed sample');
        process.exit(1);
      }
      console.log(`  Trimmed sample: ${totalFrames} frames\n`);
    }

    const results = [];
    for (const config of configs) {
      const detail = config.auto
        ? 'av1an auto'
        : isAbAv1
          ? `lp=${config.svtLp}`
          : `workers=${config.workers} threads=${config.tpw} vmaf=${config.vmafThreads}`;
      const modeStr = realitySeconds ? `reality ${realitySeconds}s` : `${testDuration}s`;
      console.log(`\nRunning: ${config.label} (${detail}) — ${modeStr}...`);

      // Kill any lingering encode processes and clean up between configs
      spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
        'pkill -9 -f "av1an|aomenc|SvtAv1EncApp|mkvmerge|ffmpeg|vspipe" 2>/dev/null; true',
      ]);
      await new Promise((r) => setTimeout(r, 5000));
      await dockerExec(`rm -rf ${BENCH_TEMP}/*/work/done.json ${BENCH_TEMP}/*/work/encode/ ${BENCH_TEMP}/*/out.mkv ${BENCH_TEMP}/ab-*/out.mkv 2>/dev/null; true`);

      const result = isAbAv1
        ? await benchAbAv1(sample, config, abAv1Crf, grainParam)
        : await benchAv1an(sample, config, {
            realityMode: !!realitySeconds,
            activeSample,
            totalFrames,
            grainParam,
          });

      results.push(result);
      const fpsStr = result.fps ? `, ${result.fps} fps` : '';
      const encFpsStr = result.encodeFps ? ` (encode-only: ${result.encodeFps} fps)` : '';
      const encTimeStr = result.encodeTime ? `, encode: ${result.encodeTime}` : '';
      const chunkStr = result.chunkFps
        ? `, chunks: ${result.chunkFps.min.toFixed(1)}/${result.chunkFps.median.toFixed(1)}/${result.chunkFps.max.toFixed(1)} fps`
        : '';
      console.log(`  -> ${result.mibPerMin} MiB/min (${result.totalMiB} MiB)${fpsStr}${encFpsStr}${chunkStr}${encTimeStr}, ${result.avgCpu}% CPU, ${result.peakMem} GiB RAM${result.oom ? ' [OOM]' : ''}`);
    }

    console.log('');
    printTable(results);
  }

  // Final cleanup — remove temp files and copied samples from container
  await dockerExec(`rm -rf ${BENCH_TEMP} /samples`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
