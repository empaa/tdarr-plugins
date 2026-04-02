// src/shared/logger.js
'use strict';

const fs = require('fs');
const path = require('path');

const createLogger = (tdarrJobLog, workDir) => {
  const debugLogPath = path.join(workDir, 'av1-debug.log');

  const jobLog = (msg) => {
    if (typeof tdarrJobLog === 'function') tdarrJobLog(msg);
    else console.log(`[AV1] ${msg}`);
  };

  const dbg = (msg) => {
    const line = `[DBG ${new Date().toISOString()}] ${msg}\n`;
    try { fs.appendFileSync(debugLogPath, line); } catch (_) {}
  };

  const flush = () => {};

  return { jobLog, dbg, debugLogPath, flush };
};

const humanSize = (bytes) => {
  if (bytes <= 0) return '0 B';
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(2)} GiB`;
  return `${(bytes / (1024 ** 2)).toFixed(1)} MiB`;
};

module.exports = { createLogger, humanSize };
