// src/shared/pathMapper.js
'use strict';

/**
 * Creates a bidirectional path mapper from a JSON array of "from:to" strings.
 * "from" is the Tdarr-side mount, "to" is the Arr-side mount.
 *
 * @param {string} mappingsJson - JSON array like '["/media:/mnt/media"]', or empty string
 * @returns {{ toArr: (p: string) => string, fromArr: (p: string) => string }}
 */
function createPathMapper(mappingsJson) {
  const mappings = [];

  if (mappingsJson && mappingsJson.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(mappingsJson);
    } catch (err) {
      throw new Error(`Invalid path_mappings JSON: ${err.message}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('path_mappings must be a JSON array of "from:to" strings');
    }

    for (const entry of parsed) {
      const parts = String(entry).split(':');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid path mapping "${entry}" — expected "from:to" format`);
      }
      mappings.push({ from: parts[0], to: parts[1] });
    }
  }

  function toArr(p) {
    for (const m of mappings) {
      if (p.startsWith(m.from)) {
        return m.to + p.slice(m.from.length);
      }
    }
    return p;
  }

  function fromArr(p) {
    for (const m of mappings) {
      if (p.startsWith(m.to)) {
        return m.from + p.slice(m.to.length);
      }
    }
    return p;
  }

  return { toArr, fromArr };
}

module.exports = { createPathMapper };
