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

console.log('--- pre-invocation.test.js ---');

const testDir = path.join(__dirname, 'test-env-preinv');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

test('pre-invocation shim drains warnings to ephemeralMessage', () => {
  const warningBufPath = path.join(testDir, 'agy-warning-buffer.jsonl');
  fs.writeFileSync(warningBufPath, JSON.stringify({ message: "Warning 1" }) + '\n' + JSON.stringify({ message: "Warning 2" }) + '\n');
  
  const payload = {
    conversationId: 'test-conv-2',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    invocationNum: 1
  };
  
  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/pre-invocation.js')], {
    input: JSON.stringify(payload),
    env: process.env
  });
  
  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString());
  
  assert.ok(output.injectSteps, 'Should have injectSteps');
  assert.strictEqual(output.injectSteps.length, 1);
  assert.ok(output.injectSteps[0].ephemeralMessage.includes('Warning 1'));
  assert.ok(output.injectSteps[0].ephemeralMessage.includes('Warning 2'));
  
  // Buffer should be drained
  assert.ok(!fs.existsSync(warningBufPath) || fs.readFileSync(warningBufPath, 'utf8').trim() === '', 'Buffer should be empty');
});

test('pre-invocation runs SessionStart hooks on invocationNum 0 from hooks/hooks.json', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin-preinv');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const fakeHooksJson = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node -e 'console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "Loaded Project Context" } }));'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-sessionstart',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    invocationNum: 0
  };

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/pre-invocation.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout.toString());

  assert.ok(output.injectSteps, 'Should have injectSteps');
  assert.strictEqual(output.injectSteps.length, 1);
  assert.strictEqual(output.injectSteps[0].ephemeralMessage, 'Loaded Project Context');

  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
