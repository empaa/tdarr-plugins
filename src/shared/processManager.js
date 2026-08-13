// src/shared/processManager.js
'use strict';

const cp = require('child_process');
const path = require('path');

const createProcessManager = (jobLog, dbg) => {
  const activeChildren = new Set();
  const ppidWatchers = [];

  // Snapshot the set at call time. The SIGKILL sweep fires 3 s later, and the
  // plugins keep using this manager after cleanup() -- probeOutput's ffprobe and
  // mkvmerge are spawned afterwards and join activeChildren. Sweeping the live
  // set killed them mid-flight: `ffprobe -count_frames` outlives 3 s, so it died
  // before printing and validation failed with "non-positive dimensions (0x0)"
  // on every xav job. Only children alive when killAll was called are doomed.
  const killAll = () => {
    const doomed = Array.from(activeChildren);
    dbg(`[KILL] killAll called  activeChildren=${doomed.length}`);
    for (const child of doomed) {
      try {
        if (!child.killed) {
          dbg(`[KILL] SIGTERM -> pgid=${child.pid}`);
          try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
          child.kill('SIGTERM');
        }
      } catch (_) {}
    }
    setTimeout(() => {
      for (const child of doomed) {
        try {
          if (!child.killed) {
            dbg(`[KILL] SIGKILL -> pgid=${child.pid}`);
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
            child.kill('SIGKILL');
          }
        } catch (_) {}
      }
    }, 3000);
  };

  const startPpidWatcher = (encoderPid) => {
    const workerPid = process.pid;
    const script = [
      `while kill -0 ${workerPid} 2>/dev/null; do sleep 2; done;`,
      `kill -TERM -${encoderPid} 2>/dev/null;`,
      `sleep 3;`,
      `kill -KILL -${encoderPid} 2>/dev/null`,
    ].join(' ');
    const watcher = cp.spawn('bash', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    });
    watcher.unref();
    ppidWatchers.push(watcher);
    dbg(`[WATCHDOG] ppid-watcher pid=${watcher.pid}  worker=${workerPid}  encoder-pgid=${encoderPid}`);
  };

  const stopPpidWatchers = () => {
    for (const w of ppidWatchers) {
      try { w.kill('SIGTERM'); } catch (_) {}
    }
    ppidWatchers.length = 0;
    dbg('[WATCHDOG] ppid-watchers cancelled');
  };

  const spawnAsync = (bin, spawnArgs, opts) => {
    opts = opts || {};
    return new Promise((resolve) => {
      dbg(`> ${path.basename(bin)} ${spawnArgs.slice(0, 6).join(' ')}${spawnArgs.length > 6 ? ' ...' : ''}`);

      const child = cp.spawn(bin, spawnArgs, {
        env: opts.env || process.env,
        cwd: opts.cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      child.unref();

      activeChildren.add(child);
      if (opts.onSpawn) opts.onSpawn(child.pid);

      const silentBuf = [];
      let lastLine = '';
      const handleData = (data) => {
        const text = data.toString();
        const lines = (lastLine + text).split(/[\r\n]/);
        lastLine = lines.pop();
        for (const line of lines) {
          const l = line.trim();
          if (!l) continue;
          if (opts.onLine) opts.onLine(l);
          if (opts.filter && !opts.filter(l)) continue;
          if (opts.silent) { silentBuf.push(l); } else { jobLog(l); }
        }
      };

      child.stdout.on('data', handleData);
      child.stderr.on('data', handleData);

      child.on('close', (code, signal) => {
        activeChildren.delete(child);
        if (lastLine.trim()) {
          const l = lastLine.trim();
          if (opts.onLine) opts.onLine(l);
          if (!opts.filter || opts.filter(l)) {
            if (opts.silent) { silentBuf.push(l); } else { jobLog(l); }
          }
        }
        const exitCode = code !== null ? code : signal ? 1 : 0;
        if (opts.silent && exitCode !== 0) {
          silentBuf.forEach((l) => jobLog(l));
        }
        dbg(`< ${path.basename(bin)} exited ${exitCode}${signal ? ` (signal ${signal})` : ''}`);
        resolve(exitCode);
      });

      child.on('error', (err) => {
        activeChildren.delete(child);
        jobLog(`ERROR spawning ${path.basename(bin)}: ${err.message}`);
        resolve(1);
      });
    });
  };

  // Register a child spawned outside spawnAsync so cancellation, the ppid
  // watchdog and cleanup cover it too. The pipe encode path spawns ffmpeg and
  // xav directly in order to wire stdout to stdin, and an unregistered child
  // survives a cancelled job as an orphaned encoder.
  const adopt = (child) => {
    if (!child || !child.pid) return child;
    activeChildren.add(child);
    child.once('close', () => activeChildren.delete(child));
    dbg(`[ADOPT] tracking pid=${child.pid}`);
    return child;
  };

  let cancelHandler = null;

  const installCancelHandler = (onCancel) => {
    cancelHandler = () => {
      jobLog('[AV1] job cancelled -- killing encoder children');
      stopPpidWatchers();
      killAll();
      if (onCancel) onCancel();
      process.exit(1);
    };
    process.once('SIGTERM', cancelHandler);
    process.once('SIGINT', cancelHandler);
    process.once('disconnect', cancelHandler);
  };

  const removeCancelHandler = () => {
    if (cancelHandler) {
      process.off('SIGTERM', cancelHandler);
      process.off('SIGINT', cancelHandler);
      process.off('disconnect', cancelHandler);
      cancelHandler = null;
    }
  };

  const cleanup = () => {
    stopPpidWatchers();
    killAll();
    removeCancelHandler();
  };

  return {
    spawnAsync,
    adopt,
    startPpidWatcher,
    stopPpidWatchers,
    killAll,
    installCancelHandler,
    removeCancelHandler,
    cleanup,
  };
};

module.exports = { createProcessManager };
