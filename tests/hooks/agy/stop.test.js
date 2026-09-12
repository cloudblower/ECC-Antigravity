'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('--- stop.test.js ---');

const testDir = path.join(__dirname, 'test-env-stop');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

test('stop skips execution when fullyIdle is false', () => {
  const payload = {
    conversationId: 'test-conv-not-idle',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: false,
    terminationReason: 'model_stop'
  };

  const mockDispatcher = path.join(testDir, 'mock-stop-fail.js');
  fs.writeFileSync(mockDispatcher, `
    console.log(JSON.stringify({ decision: "block", reason: "Should not run" }));
  `);

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, MOCK_ECC_DISPATCHER: mockDispatcher }
  });

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString().trim() || '{}');
  // When fullyIdle is false, stop should not block or run stop hooks
  assert.deepStrictEqual(output, {});

  fs.unlinkSync(mockDispatcher);
});

test('stop shim proxies Stop payload and maps decision when fullyIdle is true', () => {
  const payload = {
    conversationId: 'test-conv-3',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: true,
    terminationReason: 'MAX_STEPS'
  };
  
  const mockDispatcher = path.join(testDir, 'mock-stop.js');
  fs.writeFileSync(mockDispatcher, `
    console.log(JSON.stringify({ decision: "block", reason: "Wait, do one more thing" }));
  `);
  
  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, MOCK_ECC_DISPATCHER: mockDispatcher }
  });
  
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString());
  
  // Claude Code decision: "block" -> Antigravity decision: "continue"
  assert.strictEqual(output.decision, 'continue');
  assert.strictEqual(output.reason, 'Wait, do one more thing');
  
  fs.unlinkSync(mockDispatcher);
});

test('stop shim maps exit status 2 from mock dispatcher to decision continue when fullyIdle is true', () => {
  const payload = {
    conversationId: 'test-conv-stop-exit2',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: true,
    terminationReason: 'model_stop'
  };
  
  const mockDispatcher = path.join(testDir, 'mock-stop-exit2.js');
  fs.writeFileSync(mockDispatcher, `
    process.stderr.write("Delivery checks failed!\\n");
    process.exit(2);
  `);
  
  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, MOCK_ECC_DISPATCHER: mockDispatcher }
  });
  
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString());
  
  assert.strictEqual(output.decision, 'continue');
  assert.strictEqual(output.reason, 'Delivery checks failed!');
  
  fs.unlinkSync(mockDispatcher);
});

test('stop runs hooks from hooks.json with exit status 2 and does NOT duplicate-buffer stderr when fullyIdle is true', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin-stop');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const fakeHooksJson = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `node -e 'process.stderr.write("Stop prevented by quality gate!\\n"); process.exit(2);'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-stop-hooksjson',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: true,
    terminationReason: 'model_stop'
  };

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString());

  assert.strictEqual(output.decision, 'continue');
  assert.strictEqual(output.reason, 'Stop prevented by quality gate!');

  // Warning buffer must NOT contain the continuation reason to avoid duplicate injection in PreInvocation
  const warningBufPath = path.join(testDir, 'agy-warning-buffer.jsonl');
  const bufferExists = fs.existsSync(warningBufPath) && fs.readFileSync(warningBufPath, 'utf8').trim().length > 0;
  assert.strictEqual(bufferExists, false, 'Warning buffer should be empty when Stop hook returns continue');

  // Clean up
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);
  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

test('stop handles continue: false with stopReason from hook stdout when fullyIdle is true', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin-stopreason');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const fakeHooksJson = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `node -e 'console.log(JSON.stringify({ continue: false, stopReason: "Verification incomplete" }));'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-stopreason',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: true,
    terminationReason: 'model_stop'
  };

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString());

  assert.strictEqual(output.decision, 'continue');
  assert.strictEqual(output.reason, 'Verification incomplete');

  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

test('stop disables and skips stop:desktop-notify hook for Antigravity', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin-desktop-notify');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const notifySentinel = path.join(testDir, 'desktop-notify-ran.txt');
  const otherSentinel = path.join(testDir, 'other-stop-ran.txt');
  if (fs.existsSync(notifySentinel)) fs.unlinkSync(notifySentinel);
  if (fs.existsSync(otherSentinel)) fs.unlinkSync(otherSentinel);

  const fakeHooksJson = {
    hooks: {
      Stop: [
        {
          id: 'stop:desktop-notify',
          hooks: [
            {
              type: 'command',
              command: `node -e 'require("fs").writeFileSync(${JSON.stringify(notifySentinel)}, "notified", "utf8");'`
            }
          ]
        },
        {
          id: 'stop:some-other-hook',
          hooks: [
            {
              type: 'command',
              command: `node -e 'require("fs").writeFileSync(${JSON.stringify(otherSentinel)}, "ran", "utf8");'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-stop-desktop-notify',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: true,
    terminationReason: 'model_stop'
  };

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0);

  // Assert stop:desktop-notify did NOT run
  assert.strictEqual(fs.existsSync(notifySentinel), false, 'stop:desktop-notify must be skipped for Antigravity');
  // Assert other Stop hook DID run
  assert.strictEqual(fs.existsSync(otherSentinel), true, 'Other Stop hooks must continue to run');

  // Clean up
  if (fs.existsSync(notifySentinel)) fs.unlinkSync(notifySentinel);
  if (fs.existsSync(otherSentinel)) fs.unlinkSync(otherSentinel);
  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
