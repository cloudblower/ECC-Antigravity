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
  assert.strictEqual(typeof fixtureManager.collectSuiteSideEffects, 'function');
  assert.strictEqual(typeof fixtureManager.writeHookEnv, 'function');
  assert.strictEqual(typeof fixtureManager.cleanHookEnv, 'function');
  assert.strictEqual(typeof fixtureManager.readObservationLogs, 'function');
  assert.strictEqual(typeof fixtureManager.readGovernanceLogs, 'function');
  assert.strictEqual(typeof fixtureManager.readMcpHealthCache, 'function');
  assert.strictEqual(typeof fixtureManager.readSkillRunsLog, 'function');
  assert.strictEqual(typeof fixtureManager.readCostMetricsLog, 'function');
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

test('collectSuiteSideEffects aggregates telemetry, bounds logs to 20, redacts secrets, and asserts safe paths', () => {
  assert.strictEqual(typeof fixtureManager.collectSuiteSideEffects, 'function');

  // Test unsafe sandbox dir assertion
  assert.throws(() => fixtureManager.collectSuiteSideEffects('/etc'), /protected system directory/);

  const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-side-effects-test-'));
  const tmpClaude = path.join(tmpSandbox, '.claude');
  const tmpTimers = path.join(tmpSandbox, 'timers');
  fs.mkdirSync(path.join(tmpSandbox, '.agents'), { recursive: true });
  fs.mkdirSync(tmpClaude, { recursive: true });
  fs.mkdirSync(tmpTimers, { recursive: true });

  try {
    // 1. Hook log with secret
    const hookLogPath = path.join(tmpSandbox, '.agents', 'hooks-execution.log');
    fs.writeFileSync(hookLogPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      hook: 'PreToolUse:Bash',
      command: 'curl -H "Authorization: Bearer sk-ant-secret1234567890abcdef" https://api.test?token=supersecret'
    }) + '\n', 'utf8');

    // 2. Warning buffer
    const warnPath = path.join(tmpSandbox, 'agy-warning-buffer.jsonl');
    fs.writeFileSync(warnPath, JSON.stringify({
      warning: 'Fact check warning for api_key: AIzaSyB1234567890abcdefghij1234567890'
    }) + '\n', 'utf8');

    // 3. Edited accumulator
    const sessionId = 'test-session-1';
    const editFile = path.join(os.tmpdir(), `ecc-edited-${sessionId}.txt`);
    fs.writeFileSync(editFile, '/path/to/edited1.js\n/path/to/edited2.js\n', 'utf8');

    // 4. Metrics bridge
    const metricsFile = path.join(os.tmpdir(), `ecc-metrics-${sessionId}.json`);
    fs.writeFileSync(metricsFile, JSON.stringify({
      totalCost: 0.05,
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'
    }), 'utf8');

    // 5. Activity logs (25 items to test 20 bound)
    const actLines = [];
    for (let i = 0; i < 25; i++) {
      actLines.push(JSON.stringify({ index: i, tool: `tool-${i}`, secret: `ghp_123456789012345678901234567890123456` }));
    }
    fs.writeFileSync(path.join(tmpClaude, 'tool-usage.jsonl'), actLines.join('\n') + '\n', 'utf8');

    // 6. Command logs (25 items to test 20 bound)
    const cmdLines = [];
    for (let i = 0; i < 25; i++) {
      cmdLines.push(`[2026-11-08T00:00:00.000Z] cmd ${i} --key=secret_${i}`);
    }
    fs.writeFileSync(path.join(tmpClaude, 'bash-commands.log'), cmdLines.join('\n') + '\n', 'utf8');

    // 7. Session timers
    fs.writeFileSync(path.join(tmpTimers, 'timer1.json'), JSON.stringify({
      conversationId: 'conv-123',
      status: 'pending'
    }), 'utf8');

    // Collect side effects
    const sideEffects = fixtureManager.collectSuiteSideEffects(tmpSandbox, {
      sessionId,
      claudeDir: tmpClaude,
      timerDir: tmpTimers,
      extra: { customNote: 'my secret token sk-12345678901234567890' }
    });

    assert.ok(sideEffects, 'Side effects should be returned');
    assert.strictEqual(sideEffects.hookLogs.length, 1);
    assert.strictEqual(sideEffects.warningBuffer.length, 1);
    assert.strictEqual(sideEffects.editedAccumulator.length, 2);
    assert.strictEqual(sideEffects.metricsBridge.totalCost, 0.05);
    assert.strictEqual(sideEffects.activityLogs.length, 20, 'Activity logs should be capped at 20');
    assert.strictEqual(sideEffects.activityLogs[0].index, 5, 'Activity logs should contain the last 20 entries');
    assert.strictEqual(sideEffects.commandLogs.length, 20, 'Command logs should be capped at 20');
    assert.strictEqual(sideEffects.sessionTimers.length, 1);
    assert.ok(sideEffects.extra);

    // Verify secrets are redacted across all fields
    const serialized = JSON.stringify(sideEffects);
    assert.strictEqual(serialized.includes('sk-ant-secret'), false, 'Bearer secret should be redacted');
    assert.strictEqual(serialized.includes('supersecret'), false, 'URL token should be redacted');
    assert.strictEqual(serialized.includes('AIzaSyB'), false, 'AIza key should be redacted');
    assert.strictEqual(serialized.includes('ghp_1234567890'), false, 'GitHub token should be redacted');
    assert.strictEqual(serialized.includes('sk-1234567890'), false, 'sk token should be redacted');
    assert.ok(serialized.includes('[REDACTED'), 'Redaction placeholder should be present');

    // Clean up tmp files
    try { fs.unlinkSync(editFile); } catch (_) {}
    try { fs.unlinkSync(metricsFile); } catch (_) {}
  } finally {
    fs.rmSync(tmpSandbox, { recursive: true, force: true });
  }
});

test('writeHookEnv and cleanHookEnv manage .ecc-hook-env.json', () => {
  const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hook-env-sbx-'));
  try {
    fixtureManager.writeHookEnv(tmpSandbox, {
      ECC_GATEGUARD: 'off',
      ECC_HOOK_PROFILE: 'strict'
    });
    const envFile = path.join(tmpSandbox, '.ecc-hook-env.json');
    assert.ok(fs.existsSync(envFile), '.ecc-hook-env.json must exist');
    const loaded = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.strictEqual(loaded.ECC_GATEGUARD, 'off');
    assert.strictEqual(loaded.ECC_HOOK_PROFILE, 'strict');
    assert.strictEqual(loaded.ECC_E2E_TEST_SANDBOX, 'true');

    fixtureManager.cleanHookEnv(tmpSandbox);
    assert.strictEqual(fs.existsSync(envFile), false, '.ecc-hook-env.json must be unlinked');

    // Also verify cleanSandbox calls cleanHookEnv
    fixtureManager.writeHookEnv(tmpSandbox, { ECC_GATEGUARD: 'off' });
    assert.ok(fs.existsSync(envFile));
    fixtureManager.cleanSandbox(tmpSandbox);
    assert.strictEqual(fs.existsSync(envFile), false, 'cleanSandbox must remove .ecc-hook-env.json');
  } finally {
    fs.rmSync(tmpSandbox, { recursive: true, force: true });
  }
});

test('readObservationLogs locates observations.jsonl and parses tool_start / tool_complete events', () => {
  const tmpClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-obs-claude-'));
  const projDir = path.join(tmpClaude, 'homunculus', 'projects', 'proj-123');
  fs.mkdirSync(projDir, { recursive: true });
  const obsFile = path.join(projDir, 'observations.jsonl');

  const now = Date.now();
  const entries = [
    { timestamp: now - 5000, event: 'tool_start', tool: 'Bash', input: { command: 'ls' } },
    { timestamp: now - 3000, event: 'tool_complete', tool: 'Bash', result: 'file.txt' }
  ];
  fs.writeFileSync(obsFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

  try {
    const logs = fixtureManager.readObservationLogs('/fake/sandbox', {
      claudeDir: tmpClaude,
      sinceMs: now - 4000
    });

    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].event, 'tool_complete');
    assert.strictEqual(logs[0].tool, 'Bash');

    const allLogs = fixtureManager.readObservationLogs('/fake/sandbox', {
      claudeDir: tmpClaude
    });
    assert.strictEqual(allLogs.length, 2);
  } finally {
    fs.rmSync(tmpClaude, { recursive: true, force: true });
  }
});

test('readGovernanceLogs extracts [governance] JSON events from warning buffer and log files', () => {
  const warningBuffer = [
    { message: '[governance] {"eventId":"gov-1","hookPhase":"pre","eventType":"policy_violation"}' },
    { message: 'normal warning' },
    { warning: '[governance] {"eventId":"gov-2","hookPhase":"post","eventType":"secret_detected"}' }
  ];

  const govEvents = fixtureManager.readGovernanceLogs('/fake/sandbox', {
    warningBuffer
  });

  assert.strictEqual(govEvents.length, 2);
  assert.strictEqual(govEvents[0].eventId, 'gov-1');
  assert.strictEqual(govEvents[0].hookPhase, 'pre');
  assert.strictEqual(govEvents[1].eventId, 'gov-2');
  assert.strictEqual(govEvents[1].hookPhase, 'post');
});

test('readMcpHealthCache parses mcp-health-cache.json', () => {
  const tmpClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-claude-'));
  const cacheFile = path.join(tmpClaude, 'mcp-health-cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    'mock-server': { healthy: false, lastCheck: Date.now(), error: 'Timeout' }
  }));

  try {
    const cache = fixtureManager.readMcpHealthCache({ claudeDir: tmpClaude });
    assert.ok(cache['mock-server']);
    assert.strictEqual(cache['mock-server'].healthy, false);
    assert.strictEqual(cache['mock-server'].error, 'Timeout');
  } finally {
    fs.rmSync(tmpClaude, { recursive: true, force: true });
  }
});

test('readSkillRunsLog parses skill-runs.jsonl with sinceMs support', () => {
  const tmpClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-skill-claude-'));
  const stateDir = path.join(tmpClaude, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const logFile = path.join(stateDir, 'skill-runs.jsonl');

  const now = Date.now();
  const runs = [
    { timestamp: new Date(now - 6000).toISOString(), skill_id: 'test-skill', outcome: 'success' },
    { timestamp: new Date(now - 2000).toISOString(), skill_id: 'test-skill', outcome: 'failure' }
  ];
  fs.writeFileSync(logFile, runs.map(r => JSON.stringify(r)).join('\n') + '\n');

  try {
    const allRuns = fixtureManager.readSkillRunsLog({ claudeDir: tmpClaude });
    assert.strictEqual(allRuns.length, 2);

    const filtered = fixtureManager.readSkillRunsLog({ claudeDir: tmpClaude, sinceMs: now - 4000 });
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].outcome, 'failure');
  } finally {
    fs.rmSync(tmpClaude, { recursive: true, force: true });
  }
});

test('readCostMetricsLog parses costs.jsonl with sinceMs support', () => {
  const tmpClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-costs-claude-'));
  const metricsDir = path.join(tmpClaude, 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  const logFile = path.join(metricsDir, 'costs.jsonl');

  const now = Date.now();
  const costs = [
    { timestamp: now - 5000, model: 'gemini-3.8', total_cost: 0.001 },
    { timestamp: now - 1000, model: 'gemini-3.8', total_cost: 0.002 }
  ];
  fs.writeFileSync(logFile, costs.map(c => JSON.stringify(c)).join('\n') + '\n');

  try {
    const allCosts = fixtureManager.readCostMetricsLog({ claudeDir: tmpClaude });
    assert.strictEqual(allCosts.length, 2);

    const filtered = fixtureManager.readCostMetricsLog({ claudeDir: tmpClaude, sinceMs: now - 3000 });
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].total_cost, 0.002);
  } finally {
    fs.rmSync(tmpClaude, { recursive: true, force: true });
  }
});

test('collectSuiteSideEffects includes observations, governanceLogs, mcpHealthCache, skillRuns, and costMetrics', () => {
  const tmpSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-collect-all-sbx-'));
  const tmpClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-collect-all-claude-'));

  try {
    // Seed dummy entries
    const projDir = path.join(tmpClaude, 'homunculus', 'projects', 'p1');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'observations.jsonl'), JSON.stringify({ event: 'tool_start' }) + '\n');

    fs.mkdirSync(path.join(tmpClaude, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpClaude, 'state', 'skill-runs.jsonl'), JSON.stringify({ skill_id: 's1' }) + '\n');

    fs.mkdirSync(path.join(tmpClaude, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(tmpClaude, 'metrics', 'costs.jsonl'), JSON.stringify({ cost: 0.01 }) + '\n');

    fs.writeFileSync(path.join(tmpClaude, 'mcp-health-cache.json'), JSON.stringify({ m1: { healthy: true } }));

    const effects = fixtureManager.collectSuiteSideEffects(tmpSandbox, {
      claudeDir: tmpClaude,
      warningBuffer: [{ message: '[governance] {"eventId":"g1","hookPhase":"pre"}' }]
    });

    assert.ok(Array.isArray(effects.observations), 'observations must be an array');
    assert.strictEqual(effects.observations.length, 1);
    assert.ok(Array.isArray(effects.governanceLogs), 'governanceLogs must be an array');
    assert.strictEqual(effects.governanceLogs.length, 1);
    assert.ok(effects.mcpHealthCache && effects.mcpHealthCache.m1, 'mcpHealthCache must be present');
    assert.ok(Array.isArray(effects.skillRuns), 'skillRuns must be an array');
    assert.strictEqual(effects.skillRuns.length, 1);
    assert.ok(Array.isArray(effects.costMetrics), 'costMetrics must be an array');
    assert.strictEqual(effects.costMetrics.length, 1);
  } finally {
    fs.rmSync(tmpSandbox, { recursive: true, force: true });
    fs.rmSync(tmpClaude, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
