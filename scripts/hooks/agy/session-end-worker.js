'use strict';
const fs = require('fs');
const { runSessionEndHooks } = require('./session-end-scheduler');

function main() {
  const timerFile = process.argv[2];
  const expectedToken = process.argv[3];
  if (!timerFile || !expectedToken) {
    process.exit(0);
  }

  function readState() {
    try {
      if (!fs.existsSync(timerFile)) return null;
      return JSON.parse(fs.readFileSync(timerFile, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  const initial = readState();
  if (!initial || initial.token !== expectedToken || initial.status !== 'pending') {
    process.exit(0);
  }

  const waitTime = Math.max(0, initial.fireAt - Date.now());

  setTimeout(() => {
    const current = readState();
    if (!current || current.token !== expectedToken || current.status !== 'pending') {
      process.exit(0);
    }
    if (Date.now() < current.fireAt) {
      process.exit(0);
    }

    current.status = 'running';
    try {
      fs.writeFileSync(timerFile, JSON.stringify(current, null, 2), 'utf8');
    } catch (_error) {
      // ignore
    }

    try {
      runSessionEndHooks(current.claudeEndInput, {
        claudePluginRoot: current.claudePluginRoot || current.env?.CLAUDE_PLUGIN_ROOT
      });
    } finally {
      try {
        if (fs.existsSync(timerFile)) {
          fs.unlinkSync(timerFile);
        }
      } catch (_error) {
        // ignore
      }
    }
  }, waitTime);
}

main();
