'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
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

console.log('=== Testing e2e-hooks/harness/fixture-manager.js ===');

let fixtureManager;
try {
  fixtureManager = require('./fixture-manager');
} catch (e) {
  // RED phase before file creation
}

test('fixtureManager exports seedSandbox, cleanSandbox, and getHookLogs', () => {
  assert.ok(fixtureManager, 'fixtureManager must be defined');
  assert.strictEqual(typeof fixtureManager.seedSandbox, 'function');
  assert.strictEqual(typeof fixtureManager.cleanSandbox, 'function');
  assert.strictEqual(typeof fixtureManager.getHookLogs, 'function');
});

test('seedSandbox creates essential fixture files and scripts symlink', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-sandbox-test-'));
  const agentsScriptsDir = path.join(tmpDir, '.agents', 'scripts');
  fs.mkdirSync(agentsScriptsDir, { recursive: true });

  try {
    fixtureManager.seedSandbox(tmpDir);

    // Verify scripts link or dir
    assert.ok(fs.existsSync(path.join(tmpDir, 'scripts')), 'scripts must exist');
    // Verify package.json
    assert.ok(fs.existsSync(path.join(tmpDir, 'package.json')), 'package.json must exist');
    const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts && pkg.scripts.dev, 'package.json must contain dev script');

    // Verify index.js
    assert.ok(fs.existsSync(path.join(tmpDir, 'index.js')), 'index.js must exist');

    // Verify docs/guide.md
    assert.ok(fs.existsSync(path.join(tmpDir, 'docs', 'guide.md')), 'docs/guide.md must exist');

    // Verify .claude.json
    assert.ok(fs.existsSync(path.join(tmpDir, '.claude.json')), '.claude.json must exist');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getHookLogs parses NDJSON log file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-logs-test-'));
  const agentsDir = path.join(tmpDir, '.agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const logFile = path.join(agentsDir, 'hooks-execution.log');

  const sampleEvents = [
    { timestamp: '2026-11-06T00:00:00.000Z', hook: 'PreInvocation', result: { injectSteps: [] } },
    { timestamp: '2026-11-06T00:00:01.000Z', hook: 'PreToolUse', result: { decision: 'deny', reason: 'Blocked' } }
  ];
  fs.writeFileSync(logFile, sampleEvents.map(e => JSON.stringify(e)).join('\n') + '\n');

  try {
    const logs = fixtureManager.getHookLogs(tmpDir);
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].hook, 'PreInvocation');
    assert.strictEqual(logs[1].hook, 'PreToolUse');
    assert.strictEqual(logs[1].result.decision, 'deny');

    const lastDenial = fixtureManager.findLastDenial(tmpDir);
    assert.ok(lastDenial);
    assert.strictEqual(lastDenial.result.reason, 'Blocked');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('assertSafeSandboxDir prevents repo root and dangerous system directories', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  assert.throws(() => fixtureManager.assertSafeSandboxDir(repoRoot), /cannot be the repository root/);
  assert.throws(() => fixtureManager.assertSafeSandboxDir('/'), /protected system|root/);
  assert.throws(() => fixtureManager.assertSafeSandboxDir('/etc'), /protected system/);
  assert.throws(() => fixtureManager.assertSafeSandboxDir(os.homedir()), /protected system/);
  assert.throws(() => fixtureManager.assertSafeSandboxDir(''), /valid non-empty string/);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
