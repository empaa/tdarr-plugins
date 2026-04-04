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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONTAINER = process.env.TDARR_CONTAINER || 'tdarr-node';
const SAMPLES_DIR = path.join(__dirname, 'samples');
const BENCH_TEMP = '/tmp/bench';

const PRESETS = ['safe', 'balanced', 'aggressive', 'max'];

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
  --reality <sec>       Trim sample to N seconds (from middle) and encode to completion
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

if (realitySeconds != null && cliArgs.includes('--duration')) {
  console.error('ERROR: --reality and --duration are mutually exclusive');
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
    'pkill -9 -f "av1an|ab-av1|aomenc|SvtAv1EncApp|ffmpeg" 2>/dev/null; true',
  ]);
  spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
    `rm -rf ${BENCH_TEMP} 2>/dev/null; true`,
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
    // Skip noisy/empty lines
    const SKIP = /^\s*$/;

    proc.stdout.on('data', (d) => {
      stdout += d;
      if (live) {
        for (const line of splitLines(d.toString())) {
          const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
          if (clean && !SKIP.test(clean)) process.stdout.write(`    ${clean}\n`);
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (live) {
        for (const line of splitLines(d.toString())) {
          const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
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
async function benchAv1an(samplePath, config, { realityMode = false, activeSample = null, totalFrames = 0 } = {}) {
  const containerSample = activeSample || `/samples/${path.basename(samplePath)}`;
  const warmupDir = `${BENCH_TEMP}/warmup`;

  const encFlags = encoderArg === 'aom'
    ? buildAomFlags(Number(cpuUsed), config.tpw, '')
    : buildSvtFlags(Number(cpuUsed), config.svtLp, '');

  const av1anEncoder = encoderArg === 'aom' ? 'aom' : 'svt-av1';

  // Reuse warmup's work dir (has cached scenes) — clean encode output between runs
  const av1anCmdParts = [
    `rm -rf ${warmupDir}/work/encode ${warmupDir}/work/done.json ${warmupDir}/out.mkv 2>/dev/null;`,
    `echo '{"frames":0,"done":{},"audio_done":false}' > ${warmupDir}/work/done.json &&`,
    `av1an -i ${warmupDir}/vs/bench.vpy -o ${warmupDir}/out.mkv --temp ${warmupDir}/work`,
    `-c mkvmerge -e ${av1anEncoder}`,
    `--workers ${config.workers} --vmaf-threads ${config.vmafThreads}`,
    `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
    `--sc-downscale-height 540 --chunk-order long-to-short`,
    `--target-quality ${targetVmaf} --qp-range 10-50 --probes 6`,
    `--verbose --resume`,
  ];
  if (downscaleRes) {
    const vmafResArgs = buildAv1anVmafResArgs(downscaleRes);
    if (vmafResArgs.length) av1anCmdParts.push(vmafResArgs.join(' '));
  }
  av1anCmdParts.push(`-v "${encFlags}"`);
  const cmd = av1anCmdParts.join(' ');

  const startMs = Date.now();
  const workDir = `${warmupDir}/work`;
  const cpuSamples = [];
  const memSamples = [];

  // Measure encoded bytes — av1an writes chunks to work/encode/
  const readBytesScript = `du -sb ${workDir}/encode 2>/dev/null | cut -f1 || echo 0`;

  // Progress + stats monitor, kills encode when duration reached
  let timedOut = false;

  const progressMonitor = setInterval(async () => {
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

      const elapsedSec = (Date.now() - startMs) / 1000;
      const remaining = Math.max(0, testDuration - elapsedSec);
      const elapsed = formatMs(Date.now() - startMs);
      const cpuStr = cpuSamples.length > 0 ? `  CPU: ${cpuSamples[cpuSamples.length - 1].toFixed(0)}%` : '';
      const memStr = memSamples.length > 0 ? `  RAM: ${memSamples[memSamples.length - 1].toFixed(1)} GiB` : '';
      process.stdout.write(`    [${elapsed}] ${encMiB} MiB encoded  ${formatMs(remaining * 1000)} left${cpuStr}${memStr}\n`);

      // Time limit
      if (!realityMode && elapsedSec >= testDuration) {
        timedOut = true;
        process.stdout.write(`    Time limit reached (${testDuration}s) — stopping encode\n`);
        spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
          'pkill -f "av1an|aomenc|SvtAv1EncApp" 2>/dev/null; true',
        ]);
      }
    } catch (_) {}
  }, 10000);

  const execTimeout = realityMode ? 7200000 : (testDuration + 60) * 1000;
  const result = await dockerExec(cmd, { timeout: execTimeout, live: !realityMode });

  clearInterval(progressMonitor);
  const encodeTimeMs = Date.now() - startMs;

  const avgCpu = cpuSamples.length > 0
    ? cpuSamples.reduce((s, v) => s + v, 0) / cpuSamples.length : 0;
  const peakMem = memSamples.length > 0 ? Math.max(...memSamples) : 0;

  // Read final encoded bytes from disk (minus baseline)
  let encBytes = 0;
  try {
    const bytesResult = await dockerExec(readBytesScript, { timeout: 8000 });
    encBytes = parseInt(bytesResult.stdout.trim(), 10) || 0;
  } catch (_) {}

  const encodeTimeSec = encodeTimeMs / 1000;
  const mibPerMin = encBytes > 0 && encodeTimeSec > 0
    ? (encBytes / (1024 * 1024)) / (encodeTimeSec / 60) : 0;

  const fps = realityMode && totalFrames > 0 && encodeTimeSec > 0
    ? (totalFrames / encodeTimeSec).toFixed(1) : null;

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
    exitCode: timedOut ? 0 : result.code,
    oom: peakMem > 0 && result.code !== 0 && !timedOut && peakMem > 50,
    fps,
    totalFrames: realityMode ? totalFrames : null,
  };
}

async function benchAbAv1(samplePath, config, crf) {
  const containerSample = `/samples/${path.basename(samplePath)}`;
  const tempDir = `${BENCH_TEMP}/ab-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const svtFlags = buildAbAv1SvtFlags(config.svtLp, 24);
  const abCmdParts = [
    `mkdir -p ${tempDir} &&`,
    `ab-av1 encode`,
    `-i ${containerSample} -o ${tempDir}/out.mkv`,
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
      const remaining = Math.max(0, testDuration - elapsedSec);
      const elapsed = formatMs(Date.now() - startMs);
      const cpuStr = cpuSamples.length > 0 ? `  CPU: ${cpuSamples[cpuSamples.length - 1].toFixed(0)}%` : '';
      const memStr = memSamples.length > 0 ? `  RAM: ${memSamples[memSamples.length - 1].toFixed(1)} GiB` : '';
      process.stdout.write(`    [${elapsed}] ${encMiB} MiB encoded  ${formatMs(remaining * 1000)} left${cpuStr}${memStr}\n`);

      if (elapsedSec >= testDuration) {
        timedOut = true;
        process.stdout.write(`    Time limit reached (${testDuration}s) — stopping encode\n`);
        spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
          'pkill -f "ab-av1|SvtAv1EncApp|ffmpeg" 2>/dev/null; true',
        ]);
      }
    } catch (_) {}
  }, 10000);

  const result = await dockerExec(cmd, { timeout: (testDuration + 60) * 1000, live: true });

  clearInterval(statsInterval);
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
  const headers = ['Config', 'Workers', 'Threads', 'VMAF-T', 'MiB/min', 'Total MiB', 'CPU %', 'Peak RAM', 'Status'];
  const rows = results.map((r) => [
    r.label,
    String(r.workers),
    String(r.threads),
    String(r.vmafThreads),
    r.mibPerMin,
    r.totalMiB,
    `${r.avgCpu}%`,
    `${r.peakMem} GiB`,
    r.oom ? 'OOM' : r.exitCode === 0 ? 'OK' : `exit ${r.exitCode}`,
  ]);

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

  // Recommendation
  const best = results
    .filter((r) => !r.oom && r.exitCode === 0)
    .sort((a, b) => parseFloat(b.mibPerMin) - parseFloat(a.mibPerMin))[0];

  if (best) {
    const isPreset = PRESETS.includes(best.label);
    console.log(`\nRecommended: ${best.label}`);
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
  const cacheCheck = await dockerExec(`test -f ${trimmedPath} && echo yes || echo no`, { timeout: 5000 });
  if (cacheCheck.stdout.trim() === 'yes') {
    console.log(`  Using cached trimmed sample: ${path.basename(trimmedPath)}`);
    return trimmedPath;
  }

  // Probe duration
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 ${containerSample}`;
  const probeResult = await dockerExec(probeCmd, { timeout: 15000 });
  const duration = parseFloat(probeResult.stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    console.error('ERROR: could not probe sample duration');
    process.exit(1);
  }

  const start = Math.max(0, (duration / 2) - (seconds / 2));
  console.log(`  Trimming ${seconds}s from middle (start=${start.toFixed(1)}s of ${duration.toFixed(1)}s)...`);

  const trimCmd = `ffmpeg -y -ss ${start.toFixed(3)} -i ${containerSample} -t ${seconds} -c copy ${trimmedPath}`;
  const trimResult = await dockerExec(trimCmd, { timeout: 60000 });
  if (trimResult.code !== 0) {
    console.error('ERROR: ffmpeg trim failed:', trimResult.stderr.slice(-300));
    process.exit(1);
  }

  return trimmedPath;
}

async function probeFrameCount(containerPath) {
  const cmd = `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 ${containerPath}`;
  const result = await dockerExec(cmd, { timeout: 60000 });
  const frames = parseInt(result.stdout.trim(), 10);
  return isNaN(frames) ? 0 : frames;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const threads = os.cpus().length;
  console.log(`System: ${threads} threads`);
  console.log(`Container: ${CONTAINER}`);
  console.log(`Encoder: ${encoderArg}, cpu-used/preset: ${cpuUsed}, target-vmaf: ${targetVmaf}`)
  console.log(`Test duration: ${testDuration}s per config`);
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
    const presets = presetFilter || PRESETS;
    configs = presets.map((name) => {
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

    // Warmup: run scene detection once so all benchmark runs use cached scenes
    if (!isAbAv1) {
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

      // Wait for scenes.json to appear, then kill
      const warmupProc = dockerExec(warmupCmd, { timeout: 300000, live: true });
      while (true) {
        await new Promise((r) => setTimeout(r, 3000));
        const check = await dockerExec(`test -f ${warmupDir}/work/scenes.json && echo yes || echo no`, { timeout: 5000 });
        if (check.stdout.trim() === 'yes') {
          process.stdout.write('    Scene detection complete — killing warmup encode\n');
          spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
            'pkill -f "av1an|aomenc|SvtAv1EncApp" 2>/dev/null; true',
          ]);
          break;
        }
      }
      await warmupProc.catch(() => {});
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
      const warmupSvtFlags = buildAbAv1SvtFlags(warmupLp, 24);
      const crfSearchParts = [
        `mkdir -p ${warmupDir} &&`,
        `ab-av1 crf-search`,
        `-i ${containerSample}`,
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
      const detail = isAbAv1
        ? `lp=${config.svtLp}`
        : `workers=${config.workers} threads=${config.tpw} vmaf=${config.vmafThreads}`;
      console.log(`\nRunning: ${config.label} (${detail}) for ${testDuration}s...`);

      // Clean encode output but keep cached scenes/warmup
      await dockerExec(`rm -rf ${BENCH_TEMP}/*/work/done.json ${BENCH_TEMP}/*/work/encode/ ${BENCH_TEMP}/*/out.mkv ${BENCH_TEMP}/ab-*/out.mkv 2>/dev/null; true`);

      const result = isAbAv1
        ? await benchAbAv1(sample, config, abAv1Crf)
        : await benchAv1an(sample, config, {
            realityMode: !!realitySeconds,
            activeSample,
            totalFrames,
          });

      results.push(result);
      console.log(`  -> ${result.mibPerMin} MiB/min (${result.totalMiB} MiB total), ${result.avgCpu}% CPU, ${result.peakMem} GiB RAM${result.oom ? ' [OOM]' : ''}`);
    }

    console.log('');
    printTable(results);
  }

  // Final cleanup
  await dockerExec(`rm -rf ${BENCH_TEMP}`);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
