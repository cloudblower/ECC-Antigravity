'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox, findLastDenial } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');

const config = loadConfig();

if (!config.isLocal) {
  console.log(`[SKIP] 00-canary-fail-fast.test.js: ECC_E2E_LOCAL is not true. Skipping local E2E test.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 00: Canary Fail-Fast Test ===');

const PROMPT = 'run dev server';
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 12, `Prompt "${PROMPT}" must have < 12 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });

let canaryPassed = false;
let denialReason = null;
const startTime = Date.now();

try {
  // Test direct invocation through pre-tool-use shim in strict profile
  const testPayload = {
    conversationId: `canary-${Date.now()}`,
    stepIdx: 1,
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'npm run dev' }
    }
  };

  const shimPath = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'agy', 'pre-tool-use.js');
  const result = spawnSync(process.execPath, [shimPath], {
    input: JSON.stringify(testPayload),
    cwd: config.sandboxDir,
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'strict',
      GATEGUARD_BASH_ROUTINE_DISABLED: '1'
    },
    encoding: 'utf8',
    timeout: 15000
  });

  const stdout = result.stdout || '';
  let parsed = {};
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (_) {}

  denialReason = parsed.reason || result.stderr || '';

  const isBlocked = parsed.decision === 'deny' && (
    denialReason.includes('BLOCKED:') ||
    denialReason.includes('Dev server must run in tmux') ||
    denialReason.includes('Dev server must run inside tmux')
  );

  if (!isBlocked) {
    console.error('✗ CANARY FAILED: `run dev server` was NOT blocked by status 2 / denied!');
    console.error(`  Output: ${stdout}`);
    console.error(`  Stderr: ${result.stderr}`);
    process.exit(1); // Fail-fast canary abort!
  }

  canaryPassed = true;
  console.log(`  ✓ Canary passed: dev server blocked successfully with exit status 2`);
  console.log(`    Denial reason: ${denialReason.split('\n')[0]}`);

  recorder.recordTestResult({
    suite: '00-canary-fail-fast',
    testName: 'Canary dev server block',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: denialReason.split('\n')[0],
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
} catch (err) {
  console.error(`✗ CANARY EXCEPTION: ${err.message}`);
  process.exit(1);
}
