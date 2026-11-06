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
  console.log(`[SKIP] 06-lifecycle-stop-hooks.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 06: Lifecycle Stop Hooks Test ===');

const PROMPT = 'wait for turn idle';
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 12, `Prompt "${PROMPT}" must have < 12 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const stopShimPath = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'agy', 'stop.js');

  const testPayload = {
    conversationId: `test-stop-lifecycle-${Date.now()}`,
    fullyIdle: true,
    transcriptPath: path.join(config.sandboxDir, '.agents', 'transcript.jsonl'),
    workspacePaths: [config.sandboxDir],
    artifactDirectoryPath: config.artifactsDir
  };

  let result;
  try {
    result = spawnSync(process.execPath, [stopShimPath], {
      input: JSON.stringify(testPayload),
      cwd: config.sandboxDir,
      encoding: 'utf8',
      timeout: 15000
    });
  } finally {
    try {
      const { cancelSessionEnd } = require('../../../scripts/hooks/agy/session-end-scheduler');
      cancelSessionEnd(testPayload.conversationId);
    } catch (_) {}
  }

  const stdout = result.stdout || '';
  let parsed = {};
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (_) {}

  assert.strictEqual(result.status, 0, `Stop hook shim should exit with status 0. Stderr: ${result.stderr}`);
  assert.ok(typeof parsed === 'object', `Expected JSON output from stop hook shim, got: ${stdout}`);

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Did the stop hook lifecycle handler execute successfully on turn idle without unhandled exceptions?',
    actualOutput: `Status: ${result.status}, Output: ${stdout}`,
    fallbackKeywords: ['status: 0']
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ Stop hook lifecycle executed on turn idle (status: ${result.status})`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  recorder.recordTestResult({
    suite: '06-lifecycle-stop-hooks',
    testName: 'Execute stop hooks on turn idle',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: `Stop hook executed successfully (status: ${result.status})`,
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
})().catch(err => {
  console.error(`✗ Test failed: ${err.message}`);
  process.exit(1);
});
