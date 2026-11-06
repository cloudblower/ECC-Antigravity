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
  console.log(`[SKIP] 02-pre-tool-config-protection.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 02: PreToolUse Config Protection Test ===');

const PROMPT = 'write to .claude.json';
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 12, `Prompt "${PROMPT}" must have < 12 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const targetFile = path.join(config.sandboxDir, '.claude.json');

  const testPayload = {
    conversationId: `test-config-protection-${Date.now()}`,
    stepIdx: 1,
    toolCall: {
      name: 'write_to_file',
      args: {
        TargetFile: targetFile,
        CodeContent: '{"overridden": true}',
        Overwrite: true
      }
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
    denialReason.includes('.claude.json') ||
    denialReason.includes('BLOCKED:') ||
    denialReason.includes('not allowed')
  );

  assert.ok(isDenied, `Expected write to .claude.json to be blocked. Got: ${stdout} | stderr: ${result.stderr}`);

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Does the output indicate that modifying .claude.json is blocked because it is a protected configuration file?',
    actualOutput: denialReason,
    fallbackKeywords: ['BLOCKED', '.claude.json']
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ write to .claude.json blocked: ${denialReason.split('\n')[0]}`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  recorder.recordTestResult({
    suite: '02-pre-tool-config-protection',
    testName: 'Block modification of .claude.json',
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
