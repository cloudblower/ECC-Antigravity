'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');

const config = loadConfig();

if (!config.isLocal) {
  console.log(`[SKIP] 01-pre-tool-bash-blocks.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 01: PreToolUse Bash Blocks Test ===');

const PROMPT = 'git commit with --no-verify';
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 12, `Prompt "${PROMPT}" must have < 12 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const testPayload = {
    conversationId: `test-block-no-verify-${Date.now()}`,
    stepIdx: 1,
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'git commit --no-verify -m "bypass hook"' }
    }
  };

  const shimPath = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'agy', 'pre-tool-use.js');
  const result = spawnSync(process.execPath, [shimPath], {
    input: JSON.stringify(testPayload),
    cwd: config.sandboxDir,
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
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

  const denialReason = parsed.reason || result.stderr || '';
  const isDenied = parsed.decision === 'deny' && (
    denialReason.includes('--no-verify') ||
    denialReason.includes('BLOCKED:') ||
    denialReason.includes('Git hooks must not be bypassed')
  );

  assert.ok(isDenied, `Expected git commit --no-verify to be blocked. Got: ${stdout} | stderr: ${result.stderr}`);

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Does the output indicate that git commit with --no-verify was blocked to prevent bypassing git hooks?',
    actualOutput: denialReason,
    fallbackKeywords: ['--no-verify', 'not allowed']
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ git commit with --no-verify blocked: ${denialReason.split('\n')[0]}`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  recorder.recordTestResult({
    suite: '01-pre-tool-bash-blocks',
    testName: 'Block git commit --no-verify',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: denialReason.split('\n')[0],
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
})().catch(err => {
  console.error(`✗ Test failed: ${err.message}`);
  process.exit(1);
});
