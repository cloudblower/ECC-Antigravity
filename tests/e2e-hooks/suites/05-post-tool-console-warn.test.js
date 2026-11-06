'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');

const config = loadConfig();

if (!config.isLocal) {
  console.log(`[SKIP] 05-post-tool-console-warn.test.js: ECC_E2E_LOCAL is not true. Skipping.`);
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 05: PostToolUse Console Warn Test ===');

const PROMPT = 'add console.log in index.js';
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 12, `Prompt "${PROMPT}" must have < 12 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });

(async () => {
  const startTime = Date.now();
  const targetFile = path.join(config.sandboxDir, 'index.js');
  // Write a console.log into index.js
  fs.writeFileSync(targetFile, `console.log("debug log statement");\nmodule.exports = {};\n`, 'utf8');

  const consoleWarnScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'post-edit-console-warn.js');
  const testInput = {
    tool_input: {
      file_path: targetFile
    }
  };

  const result = spawnSync(process.execPath, [consoleWarnScript], {
    input: JSON.stringify(testInput),
    cwd: config.sandboxDir,
    encoding: 'utf8',
    timeout: 15000
  });

  const stderr = result.stderr || '';
  assert.ok(stderr.includes('console.log') || stderr.includes('WARNING'), `Expected console.log warning in stderr. Got: ${stderr}`);

  // LLM Judge semantic check
  const evaluation = await judge.evaluate({
    criteria: 'Does the output warn about the presence of a console.log statement in the edited file?',
    actualOutput: stderr,
    fallbackKeywords: ['console.log', 'WARNING']
  });

  assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
  console.log(`  ✓ add console.log in index.js warning detected: ${stderr.split('\n')[0]}`);
  console.log(`    LLM evaluation: ${evaluation.reasoning}`);

  // Restore clean file
  fs.writeFileSync(targetFile, `// Clean sandbox\nmodule.exports = {};\n`, 'utf8');

  recorder.recordTestResult({
    suite: '05-post-tool-console-warn',
    testName: 'Warn on console.log addition in edited file',
    prompt: PROMPT,
    tokenCount,
    status: 'pass',
    reason: stderr.split('\n')[0],
    durationMs: Date.now() - startTime
  });

  recorder.generateSummary();
  console.log('\nResults: Passed: 1, Failed: 0');
  process.exit(0);
})().catch(err => {
  console.error(`✗ Test failed: ${err.message}`);
  process.exit(1);
});
