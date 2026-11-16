'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let passed = 0;
let failed = 0;

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('--- session-end-scheduler.test.js ---');

const {
  scheduleSessionEnd,
  cancelSessionEnd,
  getTimerFilePath
} = require('../../../scripts/hooks/agy/session-end-scheduler');

const testDir = path.join(__dirname, 'test-env-scheduler');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

async function waitForFile(filePath, timeoutMs = 5000, intervalMs = 25) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.trim()) {
        return content;
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

function setupFakePlugin(pluginDir, markerFile) {
  const fakeHooksDir = path.join(pluginDir, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });
  const fakeHooksJson = {
    hooks: {
      SessionEnd: [
        {
          hooks: [
            {
              type: 'command',
              command: `node -e 'require("fs").appendFileSync(${JSON.stringify(markerFile)}, "fired\\n");'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));
}

(async () => {
  // Test 1: Delayed execution fires after delayMs
  await asyncTest('scheduleSessionEnd fires SessionEnd hooks after delayMs', async () => {
    const pluginDir = path.join(testDir, 'fake-plugin-1');
    const markerFile = path.join(testDir, 'session-end-hit-1.txt');
    setupFakePlugin(pluginDir, markerFile);
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-delayed-1';
    const payload = { conversationId: convId, workspacePaths: [testDir] };
    const claudeEndInput = { session_id: convId, hook_event_name: 'SessionEnd' };
    const env = { claudePluginRoot: pluginDir };

    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 150 });

    const timerFile = getTimerFilePath(convId);
    assert(fs.existsSync(timerFile), 'Timer file should be created');

    // Before delay, marker should not exist
    assert(!fs.existsSync(markerFile), 'SessionEnd should not have fired immediately');

    // Wait for hook to fire using polling
    const result = await waitForFile(markerFile, 5000);
    assert(result, 'SessionEnd hook should have fired after delay');
    const hits = result.trim().split('\n').filter(Boolean);
    assert.strictEqual(hits.length, 1, 'Should have fired exactly once');

    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
    cancelSessionEnd(convId);
  });

  // Test 2: Cancel pending timer prevents SessionEnd execution
  await asyncTest('cancelSessionEnd prevents SessionEnd execution', async () => {
    const pluginDir = path.join(testDir, 'fake-plugin-2');
    const markerFile = path.join(testDir, 'session-end-hit-2.txt');
    setupFakePlugin(pluginDir, markerFile);
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-cancel-2';
    const payload = { conversationId: convId, workspacePaths: [testDir] };
    const claudeEndInput = { session_id: convId, hook_event_name: 'SessionEnd' };
    const env = { claudePluginRoot: pluginDir };

    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });

    // Cancel after 50ms (well before 200ms)
    await new Promise(r => setTimeout(r, 50));
    cancelSessionEnd(convId);

    // Wait past the original 200ms delay to verify it does not fire
    await new Promise(r => setTimeout(r, 300));

    assert(!fs.existsSync(markerFile), 'SessionEnd should NOT have fired when cancelled');
    cancelSessionEnd(convId);
  });

  // Test 3: Sequential calls debounce and fire at most once
  await asyncTest('sequential scheduleSessionEnd calls debounce and do not fire multiple times', async () => {
    const pluginDir = path.join(testDir, 'fake-plugin-3');
    const markerFile = path.join(testDir, 'session-end-hit-3.txt');
    setupFakePlugin(pluginDir, markerFile);
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-debounce-3';
    const payload = { conversationId: convId, workspacePaths: [testDir] };
    const claudeEndInput = { session_id: convId, hook_event_name: 'SessionEnd' };
    const env = { claudePluginRoot: pluginDir };

    // Rapid sequential inputs
    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });
    await new Promise(r => setTimeout(r, 50));
    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });
    await new Promise(r => setTimeout(r, 50));
    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });

    // Wait for final debounced hook to fire
    const result = await waitForFile(markerFile, 5000);
    assert(result, 'SessionEnd should fire after final debounce');
    const hits = result.trim().split('\n').filter(Boolean);
    assert.strictEqual(hits.length, 1, 'Should fire exactly once despite 3 sequential calls');

    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
    cancelSessionEnd(convId);
  });

  // Test 4: Worker recovers and fires when timer wakes up with slight clock jitter
  await asyncTest('worker handles early timer wake-up / clock jitter without prematurely exiting', async () => {
    const pluginDir = path.join(testDir, 'fake-plugin-4');
    const markerFile = path.join(testDir, 'session-end-hit-4.txt');
    setupFakePlugin(pluginDir, markerFile);
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-jitter-4';
    const timerFile = getTimerFilePath(convId);
    const token = 'test-jitter-token';
    const now = Date.now();
    // initial.fireAt is now (waitTime = 0, so setTimeout(0) fires immediately)
    // but current.fireAt is 300ms in the future.
    // The buggy code will see Date.now() < current.fireAt and immediately process.exit(0), dropping the hook!
    const state = {
      conversationId: convId,
      token,
      scheduledAt: now,
      fireAt: now + 300,
      delayMs: 300,
      status: 'pending',
      claudeEndInput: { session_id: convId, hook_event_name: 'SessionEnd' },
      claudePluginRoot: pluginDir,
      env: {}
    };
    fs.writeFileSync(timerFile, JSON.stringify(state, null, 2), 'utf8');

    // We invoke worker with a state where waitTime will be 0 on initial read (because fireAt <= now),
    // but right after launch we update fireAt to now + 300ms.
    // Actually, even simpler: worker setTimeout fires and Date.now() < current.fireAt:
    state.fireAt = now;
    fs.writeFileSync(timerFile, JSON.stringify(state, null, 2), 'utf8');

    const workerScript = path.join(__dirname, '../../../scripts/hooks/agy/session-end-worker.js');
    const child = require('child_process').spawn(process.execPath, [workerScript, timerFile, token], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    // While worker is launching with waitTime = 0, update fireAt to be in the future
    state.fireAt = Date.now() + 250;
    fs.writeFileSync(timerFile, JSON.stringify(state, null, 2), 'utf8');

    const result = await waitForFile(markerFile, 3000);
    assert(result, 'Worker should fire hook even when waking up slightly before fireAt');

    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
    cancelSessionEnd(convId);
  });

  // Cleanup
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (_err) {
    // ignore
  }

  console.log(`\nPassed: ${passed} | Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
