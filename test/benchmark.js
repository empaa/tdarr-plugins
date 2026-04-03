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
  --preset <name>       Test a single preset: safe, balanced, aggressive, or max
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

Encoder flags match the plugin defaults (buildAomFlags/buildSvtFlags from encoderFlags.js).
Sample files go in test/samples/ (.mkv, .mp4, .ts).`);
  process.exit(0);
}

const gridMode = cliArgs.includes('--grid');
const presetFilter = (() => {
  const idx = cliArgs.indexOf('--preset');
  return idx !== -1 && cliArgs[idx + 1] ? cliArgs[idx + 1] : null;
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
let activeStats = null;

function cleanup() {
  console.log('\n\nInterrupted — killing encode processes in container...');
  if (activeStats) activeStats.stop();
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

function startDockerStats(startMs) {
  const samples = [];
  const proc = spawn('docker', [
    'stats', CONTAINER, '--no-trunc',
    '--format', '{{.CPUPerc}}\t{{.MemUsage}}',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const cpu = parseFloat(parts[0]);
        const memStr = parts[1].split('/')[0].trim();
        const mem = parseMemGiB(memStr);
        if (!isNaN(cpu) && !isNaN(mem)) {
          samples.push({ cpu, mem });
        }
      }
    }
  });

  // Print periodic stats every 15s
  const statsInterval = setInterval(() => {
    if (samples.length === 0) return;
    const latest = samples[samples.length - 1];
    const elapsed = formatMs(Date.now() - startMs);
    const peak = Math.max(...samples.map((x) => x.mem));
    process.stdout.write(`    [${elapsed}] CPU: ${latest.cpu.toFixed(0)}%  RAM: ${latest.mem.toFixed(1)} GiB (peak ${peak.toFixed(1)} GiB)\n`);
  }, 15000);

  return {
    stop() {
      clearInterval(statsInterval);
      proc.kill('SIGTERM');
      if (samples.length === 0) return { avgCpu: 0, peakCpu: 0, peakMem: 0 };
      const avgCpu = samples.reduce((s, x) => s + x.cpu, 0) / samples.length;
      const peakCpu = Math.max(...samples.map((x) => x.cpu));
      const peakMem = Math.max(...samples.map((x) => x.mem));
      return { avgCpu, peakCpu, peakMem };
    },
  };
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
async function benchAv1an(samplePath, config) {
  const containerSample = `/samples/${path.basename(samplePath)}`;
  const tempDir = `${BENCH_TEMP}/${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

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

  const encFlags = encoderArg === 'aom'
    ? buildAomFlags(Number(cpuUsed), config.tpw, '')
    : buildSvtFlags(Number(cpuUsed), config.svtLp, '');

  const av1anEncoder = encoderArg === 'aom' ? 'aom' : 'svt-av1';

  const av1anCmdParts = [
    `mkdir -p ${tempDir} &&`,
    `printf '${vpyLines}\\n' > ${tempDir}/bench.vpy &&`,
    `av1an -i ${tempDir}/bench.vpy -o ${tempDir}/out.mkv --temp ${tempDir}/work`,
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
  const stats = startDockerStats(startMs);
  activeStats = stats;

  const result = await dockerExec(cmd, { timeout: 1800000, live: true });

  const elapsed = Date.now() - startMs;
  const { avgCpu, peakMem } = stats.stop();
  activeStats = null;

  // Parse FPS from av1an verbose output (stderr typically)
  const combined = result.stdout + result.stderr;
  const fpsMatches = combined.match(/([\d.]+)\s*fps/gi);
  const fps = fpsMatches
    ? fpsMatches.map((m) => parseFloat(m)).reduce((a, b) => a + b, 0) / fpsMatches.length
    : 0;

  return {
    label: config.label,
    workers: config.workers,
    threads: config.tpw,
    vmafThreads: config.vmafThreads,
    fps: fps.toFixed(1),
    avgCpu: avgCpu.toFixed(0),
    peakMem: peakMem.toFixed(1),
    time: formatMs(elapsed),
    exitCode: result.code,
    oom: peakMem > 0 && result.code !== 0 && peakMem > 50,
  };
}

async function benchAbAv1(samplePath, config) {
  const containerSample = `/samples/${path.basename(samplePath)}`;
  const tempDir = `${BENCH_TEMP}/ab-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const svtFlags = buildAbAv1SvtFlags(config.svtLp, 24);
  const abCmdParts = [
    `mkdir -p ${tempDir} &&`,
    `ab-av1 auto-encode`,
    `-i ${containerSample} -o ${tempDir}/out.mkv`,
    `--encoder libsvtav1 --preset ${cpuUsed}`,
    `--min-vmaf ${targetVmaf} --min-crf 10 --max-crf 50`,
    `--vmaf "n_threads=${config.vmafThreads || 4}:model=path=/usr/local/share/vmaf/vmaf_v0.6.1.json"`,
  ];
  if (downscaleRes) {
    const dsArgs = buildAbAv1DownscaleArgs(downscaleRes);
    if (dsArgs.length) abCmdParts.push(dsArgs.join(' '));
  }
  abCmdParts.push(svtFlags, `--verbose`);
  const cmd = abCmdParts.join(' ');

  const startMs = Date.now();
  const stats = startDockerStats(startMs);
  activeStats = stats;

  const result = await dockerExec(cmd, { timeout: 1800000, live: true });

  const elapsed = Date.now() - startMs;
  const { avgCpu, peakMem } = stats.stop();
  activeStats = null;

  const combined = result.stdout + result.stderr;
  const fpsMatches = combined.match(/([\d.]+)\s*fps/gi);
  const fps = fpsMatches
    ? fpsMatches.map((m) => parseFloat(m)).reduce((a, b) => a + b, 0) / fpsMatches.length
    : 0;

  return {
    label: config.label,
    workers: '-',
    threads: config.svtLp,
    vmafThreads: '-',
    fps: fps.toFixed(1),
    avgCpu: avgCpu.toFixed(0),
    peakMem: peakMem.toFixed(1),
    time: formatMs(elapsed),
    exitCode: result.code,
    oom: peakMem > 0 && result.code !== 0 && peakMem > 50,
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
  const headers = ['Config', 'Workers', 'Threads', 'VMAF-T', 'FPS', 'CPU %', 'Time', 'Peak RAM', 'Status'];
  const rows = results.map((r) => [
    r.label,
    String(r.workers),
    String(r.threads),
    String(r.vmafThreads),
    r.fps,
    `${r.avgCpu}%`,
    r.time,
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
    .sort((a, b) => parseFloat(b.fps) - parseFloat(a.fps))[0];

  if (best) {
    console.log(`\nRecommended: ${best.label}`);
    if (best.workers !== '-') {
      console.log(`Paste into plugin: {"workers":${best.workers},"threadsPerWorker":${best.threads},"vmafThreads":${best.vmafThreads}}`);
    } else {
      console.log(`Paste into plugin: {"threadsPerWorker":${best.threads}}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const threads = os.cpus().length;
  console.log(`System: ${threads} threads`);
  console.log(`Container: ${CONTAINER}`);
  console.log(`Encoder: ${encoderArg}, cpu-used/preset: ${cpuUsed}, target-vmaf: ${targetVmaf}`);
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
    const presets = presetFilter ? [presetFilter] : PRESETS;
    configs = presets.map((name) => {
      const p = THREAD_PRESETS[name];
      if (!p) {
        console.error(`ERROR: unknown preset "${name}". Available: ${PRESETS.join(', ')}`);
        process.exit(1);
      }
      const encoder = encoderArg === 'ab-av1' ? 'svt-av1' : encoderArg;
      const b = calculateThreadBudget(threads, encoder, false, { strategy: name });
      return { workers: b.maxWorkers, tpw: b.threadsPerWorker, svtLp: b.svtLp, vmafThreads: b.vmafThreads, label: name };
    });
    console.log(`\nPreset mode: testing ${configs.map((c) => c.label).join(', ')}\n`);
  }

  // Run benchmarks per sample
  for (const sample of samples) {
    console.log('='.repeat(60));
    console.log(`Sample: ${path.basename(sample)}`);
    console.log('='.repeat(60));

    const results = [];
    for (const config of configs) {
      const detail = isAbAv1
        ? `lp=${config.svtLp}`
        : `workers=${config.workers} threads=${config.tpw} vmaf=${config.vmafThreads}`;
      console.log(`\nRunning: ${config.label} (${detail})...`);

      // Clean temp between runs
      await dockerExec(`rm -rf ${BENCH_TEMP}`);

      const result = isAbAv1
        ? await benchAbAv1(sample, config)
        : await benchAv1an(sample, config);

      results.push(result);
      console.log(`  -> ${result.fps} fps, ${result.avgCpu}% CPU, ${result.peakMem} GiB RAM, ${result.time}${result.oom ? ' [OOM]' : ''}`);
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
