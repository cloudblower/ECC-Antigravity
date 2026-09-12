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

console.log('--- pre-tool-use.test.js ---');

const testDir = path.join(__dirname, 'test-env');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

test('pre-tool-use shim passes through output and buffers warnings', () => {
  const payload = {
    conversationId: 'test-conv-1',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    stepIdx: 1,
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'echo "hello"' }
    }
  };

  const warningBufPath = path.join(testDir, 'agy-warning-buffer.jsonl');
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);

  // We'll set an env var to point the shim to a mock dispatcher
  const mockDispatcher = path.join(testDir, 'mock-dispatcher.js');
  fs.writeFileSync(mockDispatcher, `
    console.error('This is a warning from ECC');
    console.log(JSON.stringify({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: 'Mock denial'
      }
    }));
  `);
  
  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/pre-tool-use.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, MOCK_ECC_DISPATCHER: mockDispatcher }
  });
  
  assert.strictEqual(result.status, 0, 'Shim should exit 0');
  const output = JSON.parse(result.stdout.toString());
  
  assert.strictEqual(output.decision, 'deny');
  assert.strictEqual(output.reason, 'Mock denial');
  
  // Verify non-blocking stderr is written to parent process stderr, NOT warning buffer
  assert.ok(result.stderr.toString().includes('This is a warning from ECC'), 'Parent process stderr should receive hook stderr');
  const bufferContainsStderr = fs.existsSync(warningBufPath) && fs.readFileSync(warningBufPath, 'utf8').includes('This is a warning from ECC');
  assert.strictEqual(bufferContainsStderr, false, 'Warning buffer must NOT contain stderr');
  
  // Clean up
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);
  if (fs.existsSync(mockDispatcher)) fs.unlinkSync(mockDispatcher);
});

test('pre-tool-use runs hooks from hooks.json with wildcard matcher: writes stderr to parent stderr and buffers additionalContext', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const fakeHooksJson = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node -e 'process.stderr.write("stderr-from-hook\\n"); console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: "additional-context-from-hook" } }));'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-wildcard',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    stepIdx: 2,
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'echo "test-wildcard"' }
    }
  };

  const warningBufPath = path.join(testDir, 'agy-warning-buffer.jsonl');
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/pre-tool-use.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0, 'Shim should exit 0');
  const output = JSON.parse(result.stdout.toString());
  assert.strictEqual(output.decision, 'allow');

  // Verify non-blocking stderr was written to parent process stderr
  assert.ok(result.stderr.toString().includes('stderr-from-hook'), 'Parent process stderr should receive stderr-from-hook');

  // Verify warning buffer ONLY contains additionalContext, NOT stderr
  assert.ok(fs.existsSync(warningBufPath), 'Warning buffer should exist for additionalContext');
  const warnings = fs.readFileSync(warningBufPath, 'utf8');
  assert.strictEqual(warnings.includes('stderr-from-hook'), false, 'Buffer should NOT contain stderr-from-hook');
  assert.ok(warnings.includes('additional-context-from-hook'), 'Buffer should contain additionalContext');

  // Clean up
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);
  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

test('pre-tool-use returns exit status 2 stderr as denial reason and does NOT buffer it', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin-hardblock');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const fakeHooksJson = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `node -e 'process.stderr.write("Dangerous command blocked!\\n"); process.exit(2);'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-hardblock',
    transcriptPath: path.join(testDir, 'transcript.jsonl'),
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    stepIdx: 3,
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'rm -rf /' }
    }
  };

  const warningBufPath = path.join(testDir, 'agy-warning-buffer.jsonl');
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/pre-tool-use.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0, 'Shim should exit 0');
  const output = JSON.parse(result.stdout.toString());
  assert.strictEqual(output.decision, 'deny');
  assert.strictEqual(output.reason, 'Dangerous command blocked!');

  // Warning buffer must NOT contain the denial reason (avoid duplicate display)
  const bufferExists = fs.existsSync(warningBufPath) && fs.readFileSync(warningBufPath, 'utf8').trim().length > 0;
  assert.strictEqual(bufferExists, false, 'Warning buffer should be empty for hard block');

  // Clean up
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);
  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
