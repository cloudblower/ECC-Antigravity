'use strict';
const fs = require('fs');
const { runSessionEndHooks } = require('./session-end-scheduler');

function main() {
  const timerFile = process.argv[2];
  const expectedToken = process.argv[3];
  if (!timerFile || !expectedToken) {
    process.exit(0);
  }

  function readState(retries = 5) {
    for (let i = 0; i < retries; i++) {
      try {
        if (!fs.existsSync(timerFile)) return null;
        const raw = fs.readFileSync(timerFile, 'utf8');
        if (!raw.trim()) {
          if (i < retries - 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            continue;
          }
          return null;
        }
        return JSON.parse(raw);
      } catch (_error) {
        if (!fs.existsSync(timerFile)) return null;
        if (i < retries - 1) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
        return null;
      }
    }
    return null;
  }

  const initial = readState();
  if (!initial || initial.token !== expectedToken || initial.status !== 'pending') {
    process.exit(0);
  }

  function scheduleExecution(targetFireAt) {
    const waitTime = Math.max(0, targetFireAt - Date.now());

    setTimeout(() => {
      const current = readState();
      if (!current || current.token !== expectedToken || current.status !== 'pending') {
        process.exit(0);
      }
      const remaining = current.fireAt - Date.now();
      if (remaining > 50) {
        // If timer fired substantially early or fireAt was adjusted, re-arm for remaining time
        scheduleExecution(current.fireAt);
        return;
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

  scheduleExecution(initial.fireAt);
}

main();
