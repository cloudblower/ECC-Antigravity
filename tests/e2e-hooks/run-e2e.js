#!/usr/bin/env node
'use strict';

/**
 * Unified Local E2E Hooks Test Runner
 *
 * Usage:
 *   node tests/e2e-hooks/run-e2e.js
 *   node tests/e2e-hooks/run-e2e.js --canary
 *   node tests/e2e-hooks/run-e2e.js --suite 01-pre-tool-bash-blocks
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('./config');
const { seedSandbox } = require('./harness/fixture-manager');
const EvidenceRecorder = require('./harness/evidence-recorder');
const BrowserBridge = require('./harness/browser-bridge');
const LLMJudge = require('./harness/llm-judge');

// Force local E2E mode for this runner
process.env.ECC_E2E_LOCAL = 'true';
const config = loadConfig();

const args = process.argv.slice(2);
const isCanaryOnly = args.includes('--canary');
const suiteFilterIdx = args.indexOf('--suite');
const suiteFilter = suiteFilterIdx !== -1 ? args[suiteFilterIdx + 1] : null;

const suitesDir = path.join(__dirname, 'suites');
const allSuiteFiles = fs.readdirSync(suitesDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║           ECC Antigravity - Local E2E Hooks Suite            ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`- Sandbox: ${config.sandboxDir}`);
console.log(`- Web UI:  ${config.webUrl.replace(/\?[^#]*/, '?section=[REDACTED]')}`);
console.log(`- LLM:     ${config.evalModel} (${config.agyBin})`);
console.log(`- Mode:    ${isCanaryOnly ? 'Canary Only' : suiteFilter ? `Suite: ${suiteFilter}` : 'Full E2E'}\n`);

// 1. Seed Sandbox
console.log('Seeding sandbox project...');
seedSandbox(config.sandboxDir);

// 2. Initialize Evidence Recorder
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
process.env.ECC_E2E_ARTIFACTS_TIMESTAMP = recorder.timestamp;

// 3. Canary Test MUST run first
const canaryFile = '00-canary-fail-fast.test.js';
console.log(`━━━ Running Canary: ${canaryFile} ━━━`);
const canaryStart = Date.now();
const canaryResult = spawnSync(process.execPath, [path.join(suitesDir, canaryFile)], {
  encoding: 'utf8',
  env: { ...process.env, ECC_E2E_LOCAL: 'true' },
  stdio: 'inherit'
});

const canaryDuration = Date.now() - canaryStart;

const canaryPrompt = BrowserBridge.formatDirectPrompt('npm run dev');
const canaryTokens = LLMJudge.countTokens(canaryPrompt);

if (canaryResult.status !== 0) {
  console.error('\n✗ CANARY FAILED: Stopping all testing immediately.');
  recorder.recordTestResult({
    suite: '00-canary-fail-fast',
    testName: 'Canary fail-fast',
    prompt: canaryPrompt,
    tokenCount: canaryTokens,
    status: 'fail',
    reason: 'Canary failed to block dev server',
    durationMs: canaryDuration
  });
  recorder.generateSummary({ totalDurationMs: canaryDuration });
  process.exit(1);
}

recorder.recordTestResult({
  suite: '00-canary-fail-fast',
  testName: 'Canary fail-fast',
  prompt: canaryPrompt,
  tokenCount: canaryTokens,
  status: 'pass',
  reason: 'Dev server blocked with exit status 2',
  durationMs: canaryDuration
});

if (isCanaryOnly) {
  recorder.generateSummary({ totalDurationMs: canaryDuration });
  console.log('\n✓ Canary test passed. Stopping as requested (--canary).');
  process.exit(0);
}

// 4. Run remaining suites
const suitesToRun = allSuiteFiles.filter(f => f !== canaryFile && (!suiteFilter || f.includes(suiteFilter)));

let totalPassed = 1; // Canary passed
let totalFailed = 0;
const runStartTime = Date.now();

for (const suiteFile of suitesToRun) {
  console.log(`\n━━━ Running Suite: ${suiteFile} ━━━`);
  const suitePath = path.join(suitesDir, suiteFile);
  const suiteStart = Date.now();

  const result = spawnSync(process.execPath, [suitePath], {
    encoding: 'utf8',
    env: { ...process.env, ECC_E2E_LOCAL: 'true' },
    stdio: 'inherit'
  });

  const durationMs = Date.now() - suiteStart;
  if (result.status === 0) {
    totalPassed++;
    recorder.recordTestResult({
      suite: suiteFile.replace('.test.js', ''),
      testName: suiteFile,
      prompt: 'e2e verified prompt',
      status: 'pass',
      reason: 'Assertions and LLM evaluations passed',
      durationMs
    });
  } else {
    totalFailed++;
    recorder.recordTestResult({
      suite: suiteFile.replace('.test.js', ''),
      testName: suiteFile,
      prompt: 'e2e verified prompt',
      status: 'fail',
      reason: `Exited with status ${result.status}`,
      durationMs
    });
  }
}

const totalDurationMs = Date.now() - runStartTime + canaryDuration;
const summaryPath = recorder.generateSummary({ totalDurationMs });

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                     Final Results                            ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║  Total Suites: ${String(totalPassed + totalFailed).padStart(4)}                                          ║`);
console.log(`║  Passed:       ${String(totalPassed).padStart(4)}  ✓                                     ║`);
console.log(`║  Failed:       ${String(totalFailed).padStart(4)}  ${totalFailed > 0 ? '✗' : ' '}                                     ║`);
console.log(`║  Summary Report: ${path.relative(process.cwd(), summaryPath).padEnd(42)} ║`);
console.log('╚══════════════════════════════════════════════════════════════╝\n');

process.exit(totalFailed > 0 ? 1 : 0);
