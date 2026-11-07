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

test('fixtureManager exports seedSandbox, cleanSandbox, getHookLogs, and telemetry helpers', () => {
  assert.ok(fixtureManager, 'fixtureManager must be defined');
  assert.strictEqual(typeof fixtureManager.seedSandbox, 'function');
  assert.strictEqual(typeof fixtureManager.cleanSandbox, 'function');
  assert.strictEqual(typeof fixtureManager.getHookLogs, 'function');
  assert.strictEqual(typeof fixtureManager.readWarningBuffer, 'function');
  assert.strictEqual(typeof fixtureManager.readEditedAccumulator, 'function');
  assert.strictEqual(typeof fixtureManager.readMetricsBridge, 'function');
  assert.strictEqual(typeof fixtureManager.readSessionActivityLogs, 'function');
  assert.strictEqual(typeof fixtureManager.readCommandLogs, 'function');
  assert.strictEqual(typeof fixtureManager.findSessionEndTimers, 'function');
  assert.strictEqual(typeof fixtureManager.assertSafeDir, 'function');
  assert.strictEqual(typeof fixtureManager.cleanSessionEndTimers, 'function');
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

test('readWarningBuffer parses agy-warning-buffer.jsonl', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-warn-test-'));
  try {
    assert.deepStrictEqual(fixtureManager.readWarningBuffer(tmpDir), []);
    const bufferFile = path.join(tmpDir, 'agy-warning-buffer.jsonl');
    fs.writeFileSync(bufferFile, JSON.stringify({ message: 'Warning 1', timestamp: 100 }) + '\n' +
                                JSON.stringify({ warning: 'Warning 2', timestamp: 200 }) + '\n');
    const warnings = fixtureManager.readWarningBuffer(tmpDir);
    assert.strictEqual(warnings.length, 2);
    assert.strictEqual(warnings[0].message, 'Warning 1');
    assert.strictEqual(warnings[1].warning, 'Warning 2');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readEditedAccumulator reads accumulated edited file paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-accum-test-'));
  const sessionId = 'test-session-123';
  try {
    assert.deepStrictEqual(fixtureManager.readEditedAccumulator({ sessionId, tmpDir }), []);
    const accumFile = path.join(tmpDir, `ecc-edited-${sessionId}.txt`);
    fs.writeFileSync(accumFile, 'docs/guide.md\nindex.js\n', 'utf8');
    const paths = fixtureManager.readEditedAccumulator({ sessionId, tmpDir });
    assert.deepStrictEqual(paths, ['docs/guide.md', 'index.js']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readMetricsBridge reads session metrics json file', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-metrics-test-'));
  const sessionId = 'session-abc';
  try {
    assert.strictEqual(fixtureManager.readMetricsBridge(sessionId, { tmpDir }), null);
    const bridgeFile = path.join(tmpDir, `ecc-metrics-${sessionId}.json`);
    const data = { toolCount: 5, filesModified: ['a.js'] };
    fs.writeFileSync(bridgeFile, JSON.stringify(data), 'utf8');
    const read = fixtureManager.readMetricsBridge(sessionId, { tmpDir });
    assert.deepStrictEqual(read, data);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readSessionActivityLogs reads tool-usage.jsonl with timestamp filtering', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-activity-test-'));
  const metricsDir = path.join(tmpDir, 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  const logFile = path.join(metricsDir, 'tool-usage.jsonl');
  const t1 = '2026-11-06T10:00:00.000Z';
  const t2 = '2026-11-06T11:00:00.000Z';
  fs.writeFileSync(logFile, JSON.stringify({ timestamp: t1, tool: 'Bash' }) + '\n' +
                           JSON.stringify({ timestamp: t2, tool: 'Write' }) + '\n');
  try {
    const allLogs = fixtureManager.readSessionActivityLogs({ claudeDir: tmpDir });
    assert.strictEqual(allLogs.length, 2);
    const filtered = fixtureManager.readSessionActivityLogs({ claudeDir: tmpDir, sinceTimestamp: '2026-11-06T10:30:00.000Z' });
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].tool, 'Write');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readCommandLogs reads bash-commands.log and cost-tracker.log', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cmd-test-'));
  const auditFile = path.join(tmpDir, 'bash-commands.log');
  const costFile = path.join(tmpDir, 'cost-tracker.log');
  fs.writeFileSync(auditFile, '[2026-11-06T10:00:00.000Z] git push\n', 'utf8');
  fs.writeFileSync(costFile, '[2026-11-06T10:00:00.000Z] tool=Bash command=git push\n', 'utf8');
  try {
    const auditLogs = fixtureManager.readCommandLogs({ claudeDir: tmpDir, mode: 'audit' });
    assert.strictEqual(auditLogs.length, 1);
    assert.ok(auditLogs[0].includes('git push'));

    const costLogs = fixtureManager.readCommandLogs({ claudeDir: tmpDir, mode: 'cost' });
    assert.strictEqual(costLogs.length, 1);
    assert.ok(costLogs[0].includes('tool=Bash'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findSessionEndTimers lists and parses scheduled timer files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-timer-test-'));
  const timer1 = path.join(tmpDir, 'conv1.json');
  fs.writeFileSync(timer1, JSON.stringify({ conversationId: 'conv1', status: 'pending', delayMs: 5000 }), 'utf8');
  try {
    const timers = fixtureManager.findSessionEndTimers({ timerDir: tmpDir });
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].conversationId, 'conv1');
    assert.strictEqual(timers[0].status, 'pending');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('assertSafeDir guards against root and protected system directories', () => {
  assert.throws(() => fixtureManager.assertSafeDir('/', 'Target'), /cannot be the filesystem root/);
  assert.throws(() => fixtureManager.assertSafeDir('/etc', 'Target'), /protected system directory/);
  assert.throws(() => fixtureManager.assertSafeDir('/bin', 'Target'), /protected system directory/);
  assert.throws(() => fixtureManager.assertSafeDir('', 'Target'), /valid non-empty string/);

  // Enforced in helpers
  assert.throws(() => fixtureManager.readWarningBuffer('/'), /protected system directory|filesystem root/);
  assert.throws(() => fixtureManager.readEditedAccumulator({ tmpDir: '/etc' }), /protected system directory/);
  assert.throws(() => fixtureManager.readMetricsBridge('test', { tmpDir: '/bin' }), /protected system directory/);
  assert.throws(() => fixtureManager.readSessionActivityLogs({ claudeDir: '/proc' }), /protected system directory/);
  assert.throws(() => fixtureManager.readCommandLogs({ claudeDir: '/sys' }), /protected system directory/);
  assert.throws(() => fixtureManager.findSessionEndTimers({ timerDir: '/var' }), /protected system directory/);
  assert.throws(() => fixtureManager.getHookLogs('/etc'), /protected system directory/);
});

test('cleanSessionEndTimers terminates workers and unlinks timer files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-timer-clean-'));
  const timerFile = path.join(tmpDir, 'timer1.json');
  fs.writeFileSync(timerFile, JSON.stringify({
    conversationId: 'conv-clean-1',
    pid: 99999999, // Non-existent PID to test safe kill signal
    status: 'pending'
  }), 'utf8');

  try {
    const count = fixtureManager.cleanSessionEndTimers({ timerDir: tmpDir });
    assert.strictEqual(count, 1, 'Should clean 1 timer file');
    assert.strictEqual(fs.existsSync(timerFile), false, 'Timer file should be unlinked');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('cleanSandbox resets .claude.json and cleans transient logs', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-sandbox-clean-'));
  try {
    fixtureManager.seedSandbox(tmpDir);

    // Corrupt .claude.json and add transient logs
    const claudeJson = path.join(tmpDir, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ corrupted: true }));
    const logFile = path.join(tmpDir, '.agents', 'hooks-execution.log');
    fs.writeFileSync(logFile, 'transient log content\n');

    fixtureManager.cleanSandbox(tmpDir);

    // .claude.json should be restored to allowedTools default
    const restored = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    assert.deepStrictEqual(restored.allowedTools, ['Bash', 'Write', 'Edit']);
    // hooks-execution.log should be cleaned
    assert.strictEqual(fs.existsSync(logFile), false, 'Transient log should be unlinked by cleanSandbox');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
