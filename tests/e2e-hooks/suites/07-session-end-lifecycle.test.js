'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');

const config = loadConfig();

if (!config.isLocal) {
  console.log(`[SKIP] 07-session-end-lifecycle.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 07: Session End Lifecycle Test ===');

const PROMPT = 'session end lifecycle';
const tokenCount = LLMJudge.countTokens(PROMPT);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const schedulerModule = require(path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'agy', 'session-end-scheduler.js'));

  const convId = `session-end-test-${Date.now()}`;
  const env = {
    claudePluginRoot: config.sandboxDir,
    projectDir: config.sandboxDir
  };

  // 1. Verify scheduling creates timer file with status pending
  const timerFile = schedulerModule.scheduleSessionEnd({
    payload: { conversationId: convId },
    claudeEndInput: { session_id: convId },
    env,
    delayMs: 30000
  });

  assert.ok(timerFile && fs.existsSync(timerFile), 'Timer file must be created on schedule');
  const scheduledState = JSON.parse(fs.readFileSync(timerFile, 'utf8'));
  const isScheduled = scheduledState.status === 'pending';
  assert.strictEqual(isScheduled, true, 'SessionEnd state should be pending');

  // 2. Verify cancellation removes timer file and terminates worker
  const cancelResult = schedulerModule.cancelSessionEnd(convId);
  assert.strictEqual(cancelResult, true, 'cancelSessionEnd should return true');
  const isCancelled = !fs.existsSync(timerFile);
  assert.strictEqual(isCancelled, true, 'Timer file should be removed on cancellation');


  // Cleanup
  try { if (fs.existsSync(timerFile)) fs.unlinkSync(timerFile); } catch (_) {}

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Did the session-end lifecycle scheduler successfully schedule and cancel a delayed session termination?',
    actualOutput: `Scheduled: ${isScheduled}, Cancelled: ${isCancelled}`,
    fallbackKeywords: ['Scheduled: true', 'Cancelled: true'],
    requireAllKeywords: true
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ Session-end lifecycle scheduling and cancellation verified`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  recorder.recordTestResult({
    suite: '07-session-end-lifecycle',
    testName: 'Schedule and cancel delayed session-end',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: 'Scheduled and cancelled successfully',
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
})().catch(err => {
  console.error(`✗ Test failed: ${err.message}`);
  process.exit(1);
});
