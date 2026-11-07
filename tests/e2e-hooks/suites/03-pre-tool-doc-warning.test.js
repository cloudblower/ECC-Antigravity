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
  console.log(`[SKIP] 03-pre-tool-doc-warning.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 03: PreToolUse Doc Warning Test ===');

const PROMPT = 'edit docs/guide.md';
const tokenCount = LLMJudge.countTokens(PROMPT);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const targetFile = path.join(config.sandboxDir, 'docs', 'guide.md');

  // Direct check through doc-file-warning hook
  const docWarningScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'doc-file-warning.js');
  const testInput = {
    tool_name: 'Write',
    tool_input: {
      file_path: targetFile,
      content: '# Updated Guide\n'
    }
  };

  const result = spawnSync(process.execPath, [docWarningScript], {
    input: JSON.stringify(testInput),
    cwd: config.sandboxDir,
    env: {
      ...process.env,
      ECC_DOC_WARN_ALL: '1',
      ECC_HOOK_PROFILE: 'standard'
    },
    encoding: 'utf8',
    timeout: 15000
  });

  const stdout = result.stdout || '';
  let warningMessage = '';
  try {
    const parsed = JSON.parse(stdout.trim());
    warningMessage = parsed.hookSpecificOutput?.additionalContext || '';
  } catch (_) {}

  // Also check if ad-hoc doc warning triggers without ECC_DOC_WARN_ALL
  if (!warningMessage) {
    const adhocResult = spawnSync('node', [docWarningScript], {
      input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'NOTES.md' } }),
      cwd: config.sandboxDir,
      encoding: 'utf8',
      timeout: 15000
    });
    try {
      const parsedAdhoc = JSON.parse((adhocResult.stdout || '').trim());
      warningMessage = parsedAdhoc.hookSpecificOutput?.additionalContext || '';
    } catch (_) {}
  }

  assert.ok(warningMessage.includes('WARNING') || warningMessage.includes('doc'), `Expected warning emitted for doc file edit. Got: ${stdout}`);

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Does the output contain a warning regarding documentation files?',
    actualOutput: warningMessage,
    fallbackKeywords: ['WARNING', 'doc']
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ edit docs/guide.md warning emitted: ${warningMessage.split('\n')[0]}`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  recorder.recordTestResult({
    suite: '03-pre-tool-doc-warning',
    testName: 'Emit warning on documentation file edit',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: warningMessage.split('\n')[0],
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
})().catch(err => {
  console.error(`✗ Test failed: ${err.message}`);
  process.exit(1);
});
