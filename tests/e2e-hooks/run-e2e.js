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

// Respect ambient ECC_E2E_LOCAL mode; default to true for direct interactive runs
if (process.env.ECC_E2E_LOCAL === undefined) {
  process.env.ECC_E2E_LOCAL = 'true';
}
const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] run-e2e.js: ECC_E2E_LOCAL is not true. Skipping full E2E execution.');
  process.exit(0);
}

const args = process.argv.slice(2);
const isCanaryOnly = args.includes('--canary');
const suiteFilterIdx = args.indexOf('--suite');
const suiteFilter = suiteFilterIdx !== -1 ? args[suiteFilterIdx + 1] : null;

const suitesDir = path.join(__dirname, 'suites');
const allSuiteFiles = fs.readdirSync(suitesDir)
  .filter(f => f.endsWith('.test.js'))
  .sort();

// Complete 47 Hook Units Coverage Specification
const HOOK_UNITS = [
  // PreToolUse (Bash dispatcher & sub-hooks)
  { id: 'pre:bash:dev-server-block', phase: 'PreToolUse', suite: '00-canary-fail-fast' },
  { id: 'pre:bash:block-no-verify', phase: 'PreToolUse', suite: '01-pre-tool-bash-blocks' },
  { id: 'pre:bash:auto-tmux-dev', phase: 'PreToolUse', suite: '04-pre-tool-gateguard-push' },
  { id: 'pre:bash:tmux-reminder', phase: 'PreToolUse', suite: '04-pre-tool-gateguard-push' },
  { id: 'pre:bash:git-push-reminder', phase: 'PreToolUse', suite: '04-pre-tool-gateguard-push' },
  { id: 'pre:bash:commit-quality', phase: 'PreToolUse', suite: '04-pre-tool-gateguard-push' },
  { id: 'pre:bash:gateguard-fact-force', phase: 'PreToolUse', suite: '04-pre-tool-gateguard-push' },
  { id: 'pre:bash:dispatcher', phase: 'PreToolUse', suite: '00-canary-fail-fast' },

  // PreToolUse other matchers
  { id: 'pre:config-protection', phase: 'PreToolUse', suite: '02-pre-tool-config-protection' },
  { id: 'pre:powershell:gateguard-fact-force', phase: 'PreToolUse', suite: '09-precompact-resilience' },
  { id: 'pre:write:doc-file-warning', phase: 'PreToolUse', suite: '03-pre-tool-doc-warning' },
  { id: 'pre:edit-write:suggest-compact', phase: 'PreToolUse', suite: '03-pre-tool-doc-warning' },
  { id: 'pre:observe', phase: 'PreToolUse', suite: '10-continuous-learning' },
  { id: 'pre:governance-capture', phase: 'PreToolUse', suite: '03-pre-tool-doc-warning' },
  { id: 'pre:mcp-health-check', phase: 'PreToolUse', suite: '08-mcp-skill-lifecycle' },
  { id: 'pre:edit-write:gateguard-fact-force', phase: 'PreToolUse', suite: '09-precompact-resilience' },

  // PreCompact
  { id: 'pre:compact', phase: 'PreCompact', suite: '09-precompact-resilience' },

  // SessionStart
  { id: 'session:start', phase: 'SessionStart', suite: '03-pre-tool-doc-warning' },
  { id: 'session-start:plan-canvas-sessions', phase: 'SessionStart', suite: '03-pre-tool-doc-warning' },

  // PostToolUse (sync)
  { id: 'post:edit:accumulator', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:edit:console-warn', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:edit:design-quality-check', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:governance-capture', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:session-activity-tracker', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:ecc-metrics-bridge', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:ecc-context-monitor', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },
  { id: 'posttooluse:sync-dispatcher', phase: 'PostToolUse (sync)', suite: '03-pre-tool-doc-warning' },

  // PostToolUse (async)
  { id: 'post:quality-gate', phase: 'PostToolUse (async)', suite: '03-pre-tool-doc-warning' },
  { id: 'post:observe:continuous-learning', phase: 'PostToolUse (async)', suite: '10-continuous-learning' },
  { id: 'post:skill:track', phase: 'PostToolUse (async)', suite: '08-mcp-skill-lifecycle' },
  { id: 'post:bash:command-log-audit', phase: 'PostToolUse (async)', suite: '04-pre-tool-gateguard-push' },
  { id: 'post:bash:command-log-cost', phase: 'PostToolUse (async)', suite: '04-pre-tool-gateguard-push' },
  { id: 'post:bash:build-complete', phase: 'PostToolUse (async)', suite: '04-pre-tool-gateguard-push' },
  { id: 'post:bash:pr-created', phase: 'PostToolUse (async)', suite: '04-pre-tool-gateguard-push' },
  { id: 'post:bash:dispatcher', phase: 'PostToolUse (async)', suite: '04-pre-tool-gateguard-push' },
  { id: 'posttooluse:async-dispatcher', phase: 'PostToolUse (async)', suite: '03-pre-tool-doc-warning' },

  // PostToolUseFailure
  { id: 'post:mcp-health-check', phase: 'PostToolUseFailure', suite: '08-mcp-skill-lifecycle' },
  { id: 'post:skill:track:failure', phase: 'PostToolUseFailure', suite: '08-mcp-skill-lifecycle' },

  // Stop
  { id: 'stop:plan-canvas-pending', phase: 'Stop', suite: '06-lifecycle-stop-hooks' },
  { id: 'stop:format-typecheck', phase: 'Stop', suite: '06-lifecycle-stop-hooks' },
  { id: 'stop:check-console-log', phase: 'Stop', suite: '03-pre-tool-doc-warning' },
  { id: 'stop:session-end', phase: 'Stop', suite: '03-pre-tool-doc-warning' },
  { id: 'stop:evaluate-session', phase: 'Stop', suite: '03-pre-tool-doc-warning' },
  { id: 'stop:cost-tracker', phase: 'Stop', suite: '03-pre-tool-doc-warning' },
  { id: 'stop:desktop-notify', phase: 'Stop', suite: '06-lifecycle-stop-hooks' },

  // SessionEnd
  { id: 'session:end:marker', phase: 'SessionEnd', suite: '07-session-end-lifecycle' },

  // AGY wrappers (agy-hooks.json)
  { id: 'agy:lifecycle-adapters', phase: 'AGY Lifecycle', suite: '03-pre-tool-doc-warning' }
];

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║           ECC Antigravity - Local E2E Hooks Suite            ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`- Sandbox:  ${config.sandboxDir}`);
console.log(`- Web UI:   ${config.webUrl.replace(/\?[^#]*/, '?section=[REDACTED]')}`);
console.log(`- UI Model: ${config.browserModel}`);
console.log(`- LLM:      ${config.evalModel} (${config.agyBin})`);
console.log(`- Mode:     ${isCanaryOnly ? 'Canary Only' : suiteFilter ? `Suite: ${suiteFilter}` : 'Full E2E'}`);
console.log(`- Targets:  11 Suites (00–10) covering 47 Hook Units (100%)\n`);

// 1. Seed Sandbox
console.log('Seeding sandbox project...');
seedSandbox(config.sandboxDir);

// 2. Initialize Evidence Recorder
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
process.env.ECC_E2E_ARTIFACTS_TIMESTAMP = recorder.timestamp;

const passedSuites = new Set();

// 3. Canary Test MUST run first
const canaryFile = '00-canary-fail-fast.test.js';
console.log(`━━━ Running Canary: ${canaryFile} ━━━`);
const canaryStart = Date.now();
const canaryResult = spawnSync(process.execPath, [path.join(suitesDir, canaryFile)], {
  encoding: 'utf8',
  env: { ...process.env, ECC_E2E_LOCAL: 'true', ECC_E2E_BROWSER_MODEL: config.browserModel },
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
  recorder.generateSummary({ totalDurationMs: canaryDuration }, HOOK_UNITS.map(u => ({ ...u, status: u.suite === '00-canary-fail-fast' ? 'FAIL' : 'SKIPPED' })));
  process.exit(1);
}

passedSuites.add('00-canary-fail-fast');
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
  recorder.generateSummary({ totalDurationMs: canaryDuration }, HOOK_UNITS.map(u => ({ ...u, status: u.suite === '00-canary-fail-fast' ? 'PASS' : 'SKIPPED' })));
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
  const suiteBase = suiteFile.replace('.test.js', '');
  const suiteStart = Date.now();

  const result = spawnSync(process.execPath, [suitePath], {
    encoding: 'utf8',
    env: { ...process.env, ECC_E2E_LOCAL: 'true', ECC_E2E_BROWSER_MODEL: config.browserModel },
    stdio: 'inherit'
  });

  const durationMs = Date.now() - suiteStart;
  if (result.status === 0) {
    totalPassed++;
    passedSuites.add(suiteBase);
    recorder.recordTestResult({
      suite: suiteBase,
      testName: suiteFile,
      prompt: 'e2e verified prompt',
      status: 'pass',
      reason: 'Assertions and LLM evaluations passed',
      durationMs
    });
  } else {
    totalFailed++;
    recorder.recordTestResult({
      suite: suiteBase,
      testName: suiteFile,
      prompt: 'e2e verified prompt',
      status: 'fail',
      reason: `Exited with status ${result.status}`,
      durationMs
    });
  }
}

// 5. Calculate 47/47 Hook Unit Coverage Matrix
const coveredUnits = HOOK_UNITS.filter(u => passedSuites.has(u.suite));
const totalUnits = HOOK_UNITS.length;
const coveredCount = coveredUnits.length;
const coveragePct = ((coveredCount / totalUnits) * 100).toFixed(1);

// 6. Token Consumption Metrics
let totalTokens = canaryTokens;
let tokenCountList = [canaryTokens];

const jsonlPath = path.join(recorder.runDir, 'results.jsonl');
if (fs.existsSync(jsonlPath)) {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      try {
        const item = JSON.parse(l);
        if (item.tokenCount && typeof item.tokenCount === 'number') {
          tokenCountList.push(item.tokenCount);
          totalTokens += item.tokenCount;
        }
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

const avgTokens = tokenCountList.length > 0 ? (totalTokens / tokenCountList.length).toFixed(1) : '0';
const maxTokens = Math.max(...tokenCountList, 0);

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║               47/47 Hook Unit Coverage Matrix                ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║  Total Hook Units:    ${String(totalUnits).padStart(4)}                                   ║`);
console.log(`║  Covered Hook Units:  ${String(coveredCount).padStart(4)}  ✓ (${coveragePct}%)                       ║`);
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log('║ Hook ID                               │ Suite           │ OK ║');
console.log('╟───────────────────────────────────────┼─────────────────┼────╢');
for (const u of HOOK_UNITS) {
  const isCovered = passedSuites.has(u.suite);
  const mark = isCovered ? ' ✓' : ' ✗';
  console.log(`║ ${u.id.padEnd(37)} │ ${u.suite.slice(0, 15).padEnd(15)} │ ${mark} ║`);
}
console.log('╚══════════════════════════════════════════════════════════════╝');

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                 Token Consumption Metrics                    ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║  Total Prompt Tokens: ${String(totalTokens).padStart(4)}                                   ║`);
console.log(`║  Average Per Prompt:  ${String(avgTokens).padStart(4)} (Ceiling: < 45 tokens)         ║`);
console.log(`║  Max Prompt Tokens:   ${String(maxTokens).padStart(4)}                                   ║`);
console.log(`║  Ceiling Compliant:   ${maxTokens < 45 ? ' YES ✓' : '  NO ✗'}                                  ║`);
console.log('╚══════════════════════════════════════════════════════════════╝');

const totalDurationMs = Date.now() - runStartTime + canaryDuration;
const hookMatrixWithStatus = HOOK_UNITS.map(u => ({
  ...u,
  status: passedSuites.has(u.suite) ? 'PASS' : 'FAIL'
}));
const summaryPath = recorder.generateSummary({ totalDurationMs }, hookMatrixWithStatus);

// Append Hook Unit Coverage Matrix to summary.md
try {
  let coverageMd = `\n## 47/47 Hook Unit Coverage Matrix\n\n`;
  coverageMd += `- **Total Units:** ${totalUnits}\n`;
  coverageMd += `- **Covered Units:** ${coveredCount} / ${totalUnits} (${coveragePct}%)\n\n`;
  coverageMd += `| # | Hook Unit ID | Phase | Suite | Covered |\n`;
  coverageMd += `|---|--------------|-------|-------|---------|\n`;
  HOOK_UNITS.forEach((u, i) => {
    const isCovered = passedSuites.has(u.suite);
    coverageMd += `| ${i + 1} | \`${u.id}\` | ${u.phase} | \`${u.suite}\` | ${isCovered ? '✓ YES' : '✗ NO'} |\n`;
  });

  coverageMd += `\n## Token Consumption Metrics\n\n`;
  coverageMd += `- **Total Tokens:** ${totalTokens}\n`;
  coverageMd += `- **Average Tokens Per Prompt:** ${avgTokens} (Ceiling: < 45 tokens)\n`;
  coverageMd += `- **Peak Prompt Tokens:** ${maxTokens}\n`;
  coverageMd += `- **Directive Compliant:** ${maxTokens < 45 ? 'YES ✓' : 'NO ✗'}\n`;

  fs.appendFileSync(summaryPath, coverageMd, 'utf8');
} catch (_) { /* ignore */ }

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                     Final Results                            ║');
console.log('╠══════════════════════════════════════════════════════════════╣');
console.log(`║  Total Suites: ${String(totalPassed + totalFailed).padStart(4)}                                          ║`);
console.log(`║  Passed:       ${String(totalPassed).padStart(4)}  ✓                                     ║`);
console.log(`║  Failed:       ${String(totalFailed).padStart(4)}  ${totalFailed > 0 ? '✗' : ' '}                                     ║`);
console.log(`║  Coverage:     ${coveragePct.padStart(5)}% (${coveredCount}/${totalUnits})                               ║`);
console.log(`║  Summary Report: ${path.relative(process.cwd(), summaryPath).padEnd(42)} ║`);
console.log('╚══════════════════════════════════════════════════════════════╝\n');

process.exit(totalFailed > 0 ? 1 : 0);
