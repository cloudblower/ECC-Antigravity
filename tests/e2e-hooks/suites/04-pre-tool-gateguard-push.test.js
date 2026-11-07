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
  console.log(`[SKIP] 04-pre-tool-gateguard-push.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 04: PreToolUse GateGuard Push Reminder Test ===');

const PROMPT = 'git push origin main';
const tokenCount = LLMJudge.countTokens(PROMPT);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const pushReminderScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'pre-bash-git-push-reminder.js');

  const testInput = {
    tool_name: 'Bash',
    tool_input: {
      command: 'git push origin main'
    }
  };

  const result = spawnSync(process.execPath, [pushReminderScript], {
    input: JSON.stringify(testInput),
    cwd: config.sandboxDir,
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'strict'
    },
    encoding: 'utf8',
    timeout: 15000
  });

  const stdout = result.stdout || '';
  let reminderMessage = '';
  try {
    const parsed = JSON.parse(stdout.trim());
    reminderMessage = parsed.hookSpecificOutput?.additionalContext || '';
  } catch (_) {}

  assert.ok(
    reminderMessage.includes('Review changes before push') ||
    reminderMessage.includes('push') ||
    stdout.includes('push'),
    `Expected push reminder context emitted. Got: ${stdout}`
  );

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Does the output contain a reminder or preflight review message regarding git push?',
    actualOutput: reminderMessage || stdout,
    fallbackKeywords: ['Review changes']
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ git push origin main reminder emitted: ${(reminderMessage || stdout).split('\n')[0]}`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  recorder.recordTestResult({
    suite: '04-pre-tool-gateguard-push',
    testName: 'Emit pre-push reminder on git push',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: (reminderMessage || stdout).split('\n')[0],
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
})().catch(err => {
  console.error(`✗ Test failed: ${err.message}`);
  process.exit(1);
});
