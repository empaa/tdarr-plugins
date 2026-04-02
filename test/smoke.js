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
  const raw = await api.searchFlowPlugins('Local');
  const plugins = raw.flat().filter((p) => p && typeof p === 'object' && p.pluginName);

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
