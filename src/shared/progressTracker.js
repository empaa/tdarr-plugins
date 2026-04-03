// src/shared/progressTracker.js
'use strict';

const fs = require('fs');
const path = require('path');
const { humanSize } = require('./logger');

const POLL_INTERVAL_MS = 5000;
const LOG_INTERVAL_MS = 10 * 60 * 1000;

const formatEta = (seconds) => {
  if (seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const createAv1anTracker = (opts) => {
  const {
    workBase, maxWorkers, audioSizeGb, sourceSizeGb,
    maxEncodedPercent, updateWorker, jobLog, dbg, onSizeExceeded,
  } = opts;

  let interval = null;
  let smoothedFps = 0;
  let encodeStartMs = 0;
  let lastProgressLogMs = 0;

  const av1anTemp = path.join(workBase, 'work');
  const logDir = path.join(workBase, 'vs', 'logs');
  const scenesFile = path.join(av1anTemp, 'scenes.json');
  const doneFile = path.join(av1anTemp, 'done.json');

  const pushStats = (fields) => {
    updateWorker(fields);
  };

  const poll = () => {
    if (process.connected === false) {
      dbg('[WATCHDOG] IPC disconnected in av1an interval');
      return 'cancelled';
    }

    if (!fs.existsSync(scenesFile) || !fs.existsSync(doneFile)) {
      dbg(`progress: waiting for files | scenes=${fs.existsSync(scenesFile)} done=${fs.existsSync(doneFile)}`);
      return 'waiting';
    }

    let scenes, done;
    try { scenes = JSON.parse(fs.readFileSync(scenesFile, 'utf8')); }
    catch (e) { dbg(`progress: failed to parse scenes.json: ${e.message}`); return 'error'; }
    try { done = JSON.parse(fs.readFileSync(doneFile, 'utf8')); }
    catch (e) { dbg(`progress: failed to parse done.json: ${e.message}`); return 'error'; }

    const totalFrames = scenes.frames || 0;
    const totalChunks = Array.isArray(scenes.scenes) ? scenes.scenes.length : 0;
    if (totalFrames === 0) return 'waiting';

    const doneEntries = done.done || {};
    const doneChunks = Object.keys(doneEntries).length;
    const encodedFrames = Object.values(doneEntries).reduce((s, e) => s + (e.frames || 0), 0);
    const encodedBytes = Object.values(doneEntries).reduce((s, e) => s + (e.size_bytes || 0), 0);

    if (doneChunks >= 1 && encodeStartMs === 0) {
      encodeStartMs = Date.now();
      pushStats({ status: 'Encoding' });
    }

    let workerFps = 0;
    if (fs.existsSync(logDir)) {
      let logFiles;
      try { logFiles = fs.readdirSync(logDir).filter((f) => f.startsWith('av1an.log')); }
      catch (_) { logFiles = []; }

      const allFpsSamples = [];
      for (const lf of logFiles) {
        let lines;
        try { lines = fs.readFileSync(path.join(logDir, lf), 'utf8').split('\n'); }
        catch (_) { continue; }

        const recent = lines.slice(-300);
        for (const line of recent) {
          const m1 = line.match(/(\d+(?:\.\d+)?)\s+fps,/i);
          if (m1) { allFpsSamples.push(parseFloat(m1[1])); continue; }
          if (/finished/i.test(line)) {
            const m2 = line.match(/(\d+(?:\.\d+)?)\s*fps/i);
            if (m2) allFpsSamples.push(parseFloat(m2[1]));
          }
        }
      }

      const samples = Math.max(2, maxWorkers * 2);
      const recentSamples = allFpsSamples.slice(-samples);
      if (recentSamples.length >= 2) {
        const sorted = [...recentSamples].sort((a, b) => a - b);
        const trimmed = sorted.length > 2 ? sorted.slice(1, -1) : sorted;
        workerFps = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
      } else if (recentSamples.length === 1) {
        workerFps = recentSamples[0];
      }
    }

    if (workerFps > 0) {
      smoothedFps = smoothedFps === 0 ? workerFps : smoothedFps * 0.7 + workerFps * 0.3;
    }
    const chunkTotalFps = smoothedFps * maxWorkers;

    let throughputFps = chunkTotalFps;
    if (encodeStartMs > 0 && encodedFrames > 0) {
      const elapsedS = (Date.now() - encodeStartMs) / 1000;
      if (elapsedS > 0) throughputFps = encodedFrames / elapsedS;
    }
    const totalFps = chunkTotalFps > 0 ? (chunkTotalFps + throughputFps) / 2 : throughputFps;

    const pct = Math.min(99, Math.round((encodedFrames / totalFrames) * 100));
    const remainingFrames = totalFrames - encodedFrames;
    const etaS = totalFps > 0 ? Math.round(remainingFrames / totalFps) : 0;
    const etaStr = formatEta(etaS);

    const estVideoBytes = encodedFrames > 0
      ? Math.round((encodedBytes / encodedFrames) * totalFrames) : 0;
    const actualSizeGb = encodedBytes / (1024 ** 3);
    const estFinalSizeGb = (estVideoBytes / (1024 ** 3)) + audioSizeGb;

    if (maxEncodedPercent < 100 && pct >= 10 && sourceSizeGb > 0 && estFinalSizeGb > 0) {
      const estPercent = (estFinalSizeGb / sourceSizeGb) * 100;
      dbg(`size-check: est=${humanSize(estVideoBytes + audioSizeGb * 1024 ** 3)}  src=${humanSize(sourceSizeGb * 1024 ** 3)}  est%=${estPercent.toFixed(1)}  limit=${maxEncodedPercent}%`);
      if (estPercent > maxEncodedPercent) {
        jobLog(`[av1an] ABORT: estimated output ${estPercent.toFixed(1)}% of source exceeds limit of ${maxEncodedPercent}% -- killing encode`);
        onSizeExceeded();
        return 'exceeded';
      }
    }

    pushStats({
      percentage: pct,
      fps: Math.round(totalFps * 10) / 10,
      ETA: etaStr,
      outputFileSizeInGbytes: actualSizeGb,
      estimatedFinalFileSizeInGbytes: estFinalSizeGb,
      estimatedFinalSize: estFinalSizeGb,
      estSize: estFinalSizeGb,
    });

    const now = Date.now();
    if (now - lastProgressLogMs >= LOG_INTERVAL_MS) {
      lastProgressLogMs = now;
      jobLog(
        `[av1an] ${pct}%  ${doneChunks}/${totalChunks} chunks` +
        `  ${totalFps > 0 ? totalFps.toFixed(1) + ' fps' : ''}` +
        (etaStr ? `  ETA ${etaStr}` : '') +
        (estFinalSizeGb > 0 ? `  est ${humanSize(estFinalSizeGb * 1024 ** 3)}` : ''),
      );
    }

    dbg(
      `PROGRESS ${pct}%  chunk ${doneChunks}/${totalChunks}` +
      `  frames ${encodedFrames}/${totalFrames}` +
      `  workerFps=${workerFps.toFixed(1)}  smoothed=${smoothedFps.toFixed(1)}` +
      `  totalFps=${totalFps.toFixed(1)}  actual=${humanSize(encodedBytes)}  est=${humanSize(estFinalSizeGb * 1024 ** 3)}` +
      (etaStr ? `  ETA ${etaStr}` : ''),
    );

    return 'ok';
  };

  return {
    start: () => { interval = setInterval(poll, POLL_INTERVAL_MS); },
    stop: () => {
      if (interval) { clearInterval(interval); interval = null; }
      poll();
    },
  };
};

const createAbAv1Tracker = (opts) => {
  const {
    outputPath, sourceSizeGb, updateWorker, jobLog, dbg, onSizeExceeded,
  } = opts;

  let interval = null;
  let currentPct = 0;
  let currentFps = 0;
  let encodeStarted = false;
  let encodeReached100 = false;
  let reached100AtMs = 0;
  let lastHeartbeatLogMs = 0;
  let lastProgressLogMs = 0;
  let lastEtaSec = 0;
  let lastEtaReceivedMs = 0;
  let encodeStartMs = 0;
  let lastEstPct = 0;
  let cachedEstSizeGb = 0;

  const pushStats = (fields) => {
    updateWorker(fields);
  };

  const onLine = (line) => {
    dbg(`[ab-av1] ${line}`);

    if (!encodeStarted && /command::encode\]\s*encoding/i.test(line)) {
      encodeStarted = true;
      encodeStartMs = Date.now();
      pushStats({ status: 'Encoding' });
      jobLog(line);
      return;
    }

    if (/command::crf_search\]/i.test(line)) {
      jobLog(line);
    }

    const predM = line.match(/predicted video stream size\s+([\d.]+)\s*(GiB|MiB)/i);
    if (predM) {
      const val = parseFloat(predM[1]);
      const videoGb = /MiB/i.test(predM[2]) ? val / 1024 : val;
      pushStats({ estimatedFinalFileSizeInGbytes: videoGb, estimatedFinalSize: videoGb, estSize: videoGb });
      dbg(`[ab-av1] estFinalSize updated: ${videoGb.toFixed(3)} GiB`);
    }

    if (/\b(error|warn|panic|failed|abort)\b/i.test(line)) {
      jobLog(line);
    }

    if (/failed to find a suitable crf/i.test(line)) {
      jobLog('[ab-av1] could not find a suitable CRF -- passing through');
      onSizeExceeded();
    }
    if (/encoded size .* too large|max.encoded.percent|will not be smaller/i.test(line)) {
      jobLog('[ab-av1] estimated output exceeds max-encoded-percent limit');
      onSizeExceeded();
    }

    if (encodeStarted) {
      const pctM = line.match(/\b(\d{1,3})%(?!\d)/);
      if (pctM) {
        const p = parseInt(pctM[1], 10);
        if (p === 100 && !encodeReached100) {
          encodeReached100 = true;
          reached100AtMs = Date.now();
          lastHeartbeatLogMs = Date.now();
          jobLog('[ab-av1] video encode 100% -- post-encode (audio / mux)...');
          pushStats({ status: 'Finalizing' });
          currentPct = 99;
        } else if (p > 0 && p < 100) {
          currentPct = p;
          // Recalculate estimated size only on % ticks to avoid spiraling between ticks
          if (p !== lastEstPct) {
            lastEstPct = p;
            try {
              if (fs.existsSync(outputPath)) {
                const nowSizeGb = fs.statSync(outputPath).size / (1024 ** 3);
                if (nowSizeGb > 0) {
                  cachedEstSizeGb = nowSizeGb / (p / 100);
                }
              }
            } catch (_) {}
          }
        }
      }

      if (!encodeReached100) {
        const fpsM = line.match(/(\d+\.?\d*)\s*fps/i);
        if (fpsM) {
          currentFps = parseFloat(fpsM[1]);
        }

        const etaM = line.match(/\beta\s+(\d+)\s*(minute|second|min|sec)/i);
        if (etaM) {
          const etaVal = parseInt(etaM[1], 10);
          const etaUnit = etaM[2].toLowerCase();
          lastEtaSec = /^s/.test(etaUnit) ? etaVal : etaVal * 60;
          lastEtaReceivedMs = Date.now();
        }
      }
    }
  };

  const intervalTick = () => {
    let actualSizeGb = 0;
    try {
      if (fs.existsSync(outputPath)) {
        actualSizeGb = fs.statSync(outputPath).size / (1024 ** 3);
      }
    } catch (_) {}

    const estFinalSizeGb = encodeReached100 ? 0 : cachedEstSizeGb;

    if (encodeReached100) {
      pushStats({
        percentage: 99,
        fps: 0,
        ETA: '',
        outputFileSizeInGbytes: actualSizeGb,
      });
      const now = Date.now();
      if (now - lastHeartbeatLogMs >= 5 * 60 * 1000) {
        const elapsedMin = Math.round((now - reached100AtMs) / 60000);
        jobLog(`[ab-av1] post-encode still running (${elapsedMin}m since video done)...`);
        lastHeartbeatLogMs = now;
      }
      return;
    }

    if (currentPct === 0) {
      // Still push actual file size during CRF search so dashboard isn't stale
      if (actualSizeGb > 0) {
        pushStats({ outputFileSizeInGbytes: actualSizeGb });
      }
      return;
    }

    let remain;
    if (lastEtaSec > 0) {
      const sinceLastEta = (Date.now() - lastEtaReceivedMs) / 1000;
      remain = Math.max(0, lastEtaSec - sinceLastEta);
    } else if (encodeStartMs > 0) {
      const elapsed = (Date.now() - encodeStartMs) / 1000;
      remain = (elapsed / currentPct) * (100 - currentPct);
    } else {
      remain = 0;
    }
    const eta = formatEta(remain);

    pushStats({
      percentage: currentPct,
      fps: currentFps,
      ETA: eta,
      outputFileSizeInGbytes: actualSizeGb,
      estimatedFinalFileSizeInGbytes: estFinalSizeGb,
      estimatedFinalSize: estFinalSizeGb,
      estSize: estFinalSizeGb,
    });

    const now = Date.now();
    if (now - lastProgressLogMs >= LOG_INTERVAL_MS) {
      lastProgressLogMs = now;
      const etaMin = Math.round(remain / 60);
      jobLog(`[ab-av1] ${currentPct}%  ${currentFps.toFixed(0)} fps  ETA ~${etaMin}m`);
    }
  };

  return {
    onLine,
    startInterval: () => { interval = setInterval(intervalTick, POLL_INTERVAL_MS); },
    stop: () => { if (interval) { clearInterval(interval); interval = null; } },
  };
};

module.exports = { createAv1anTracker, createAbAv1Tracker };
