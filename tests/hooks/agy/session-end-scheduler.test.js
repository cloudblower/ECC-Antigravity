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

(async () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const markerFile = path.join(testDir, 'session-end-hit.txt');

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

  // Test 1: Delayed execution fires after delayMs
  await asyncTest('scheduleSessionEnd fires SessionEnd hooks after delayMs', async () => {
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-delayed-1';
    const payload = { conversationId: convId, workspacePaths: [testDir] };
    const claudeEndInput = { session_id: convId, hook_event_name: 'SessionEnd' };
    const env = { claudePluginRoot: fakePluginRoot };

    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 150 });

    const timerFile = getTimerFilePath(convId);
    assert(fs.existsSync(timerFile), 'Timer file should be created');

    // Before delay, marker should not exist
    assert(!fs.existsSync(markerFile), 'SessionEnd should not have fired immediately');

    // Wait for delay + buffer
    await new Promise(r => setTimeout(r, 300));

    assert(fs.existsSync(markerFile), 'SessionEnd hook should have fired after delay');
    const hits = fs.readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(hits.length, 1, 'Should have fired exactly once');

    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
  });

  // Test 2: Cancel pending timer prevents SessionEnd execution
  await asyncTest('cancelSessionEnd prevents SessionEnd execution', async () => {
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-cancel-2';
    const payload = { conversationId: convId, workspacePaths: [testDir] };
    const claudeEndInput = { session_id: convId, hook_event_name: 'SessionEnd' };
    const env = { claudePluginRoot: fakePluginRoot };

    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });

    // Cancel after 50ms (well before 200ms)
    await new Promise(r => setTimeout(r, 50));
    cancelSessionEnd(convId);

    // Wait past the original 200ms
    await new Promise(r => setTimeout(r, 250));

    assert(!fs.existsSync(markerFile), 'SessionEnd should NOT have fired when cancelled');
  });

  // Test 3: Sequential calls debounce and fire at most once
  await asyncTest('sequential scheduleSessionEnd calls debounce and do not fire multiple times', async () => {
    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);

    const convId = 'test-conv-debounce-3';
    const payload = { conversationId: convId, workspacePaths: [testDir] };
    const claudeEndInput = { session_id: convId, hook_event_name: 'SessionEnd' };
    const env = { claudePluginRoot: fakePluginRoot };

    // Rapid sequential inputs
    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });
    await new Promise(r => setTimeout(r, 50));
    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });
    await new Promise(r => setTimeout(r, 50));
    scheduleSessionEnd({ payload, claudeEndInput, env, delayMs: 200 });

    // Total wait 350ms (200ms after last schedule)
    await new Promise(r => setTimeout(r, 350));

    assert(fs.existsSync(markerFile), 'SessionEnd should fire after final debounce');
    const hits = fs.readFileSync(markerFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.strictEqual(hits.length, 1, 'Should fire exactly once despite 3 sequential calls');

    if (fs.existsSync(markerFile)) fs.unlinkSync(markerFile);
  });

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });

  console.log(`\nPassed: ${passed} | Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
