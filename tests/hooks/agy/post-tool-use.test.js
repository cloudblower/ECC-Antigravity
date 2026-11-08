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

console.log('--- post-tool-use.test.js ---');

const testDir = path.join(__dirname, 'test-env-post');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

test('post-tool-use buffers non-blocking stderr warnings from sub-hooks', () => {
  const fakePluginRoot = path.join(testDir, 'fake-plugin-post');
  const fakeHooksDir = path.join(fakePluginRoot, 'hooks');
  fs.mkdirSync(fakeHooksDir, { recursive: true });

  const fakeHooksJson = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit|Write|.*',
          hooks: [
            {
              type: 'command',
              command: `node -e 'process.stderr.write("[Hook] WARNING: console.log found in index.js\\n");'`
            }
          ]
        }
      ]
    }
  };
  fs.writeFileSync(path.join(fakeHooksDir, 'hooks.json'), JSON.stringify(fakeHooksJson, null, 2));

  const payload = {
    conversationId: 'test-conv-post-warn',
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    toolCall: {
      name: 'replace_file_content',
      args: { TargetFile: path.join(testDir, 'index.js') }
    }
  };

  const warningBufPath = path.join(testDir, 'agy-warning-buffer.jsonl');
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);

  const result = spawnSync(process.execPath, [path.join(__dirname, '../../../scripts/hooks/agy/post-tool-use.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: fakePluginRoot }
  });

  assert.strictEqual(result.status, 0, 'post-tool-use should exit 0');
  assert.ok(fs.existsSync(warningBufPath), 'Warning buffer should be created');
  const warnings = fs.readFileSync(warningBufPath, 'utf8');
  assert.ok(
    warnings.includes('WARNING: console.log found in index.js'),
    `Warning buffer should contain console.log warning. Got: ${warnings}`
  );

  // Clean up
  if (fs.existsSync(warningBufPath)) fs.unlinkSync(warningBufPath);
  fs.rmSync(fakePluginRoot, { recursive: true, force: true });
});

if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
