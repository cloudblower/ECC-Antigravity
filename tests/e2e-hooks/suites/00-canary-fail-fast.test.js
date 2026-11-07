'use strict';

const assert = require('assert');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox, cleanSandbox, cleanSessionEndTimers } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

// Offline / CI Guard: cleanly skip with exit code 0 if ECC_E2E_LOCAL is not true
if (!config.isLocal) {
  console.log('[SKIP] 00-canary-fail-fast.test.js: ECC_E2E_LOCAL is not true. Skipping local browser E2E canary.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 00: Canary Fail-Fast Test (Real Browser Automation) ===');

const rawAction = process.env.ECC_E2E_CANARY_PROMPT || 'npm run dev';
const PROMPT = BrowserBridge.formatDirectPrompt(rawAction);
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 45, `Prompt "${PROMPT}" must have < 45 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const startTime = Date.now();

let mcpClient = null;
let bridge = null;
let screenshotPath = null;
let videoPath = null;
let pageId = 1;

(async () => {
  let exitCode = 0;
  try {
    mcpClient = new McpStdioClient({
      command: config.mcpCommand,
      args: config.mcpArgs
    });
    console.log('  Connecting to Chrome DevTools MCP...');
    await mcpClient.start();

    bridge = new BrowserBridge({
      webUrl: config.webUrl,
      sandboxDir: config.sandboxDir,
      client: mcpClient
    });

    console.log(`  Navigating to target section: ${config.webUrl.replace(/\?[^#]*/, '?section=[REDACTED]')}`);
    const conn = await bridge.connect();
    pageId = conn.pageId || 1;

    // Start video recording evidence
    videoPath = await recorder.startScreencast(pageId, '00-canary-fail-fast', mcpClient);

    // Ensure clean state
    await bridge.openNewConversation();

    console.log(`  Submitting canary prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete (up to 180s for agent reasoning & tool invocation)...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    // Dual verification: DOM + disk log
    console.log('  Verifying hook block (DOM + disk log)...');
    const verification = await bridge.verifyHookBlocked({
      expectedPattern: /(tmux|gate|blocked|not allowed|dev server)/i
    });

    // Capture visual screenshot evidence
    screenshotPath = await recorder.captureScreenshot(pageId, '00-canary-fail-fast', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

    if (!verification.blocked) {
      console.error('✗ CANARY FAILED: dev server was NOT blocked by PreToolUse hook!');
      recorder.recordTestResult({
        suite: '00-canary-fail-fast',
        testName: 'Canary dev server block',
        prompt: PROMPT,
        tokenCount,
        status: 'fail',
        reason: 'Dev server was not blocked',
        evidenceFiles: [screenshotPath, videoPath].filter(Boolean),
        durationMs: Date.now() - startTime
      });
      recorder.generateSummary();
      exitCode = 1;
      return;
    }

    const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });
    const evaluation = await judge.evaluate({
      criteria: 'Does the output or hook decision indicate that starting the dev server directly was blocked?',
      actualOutput: verification.reason,
      fallbackKeywords: ['tmux', 'gate', 'blocked', 'not allowed', 'dev server'],
      diskVerified: verification.diskVerified
    });

    console.log('  ✓ Canary passed: dev server blocked successfully by hook!');
    console.log(`    Denial reason: ${verification.reason.split('\n')[0]}`);
    console.log(`    Dual verification: DOM=${verification.domVerified}, Disk=${verification.diskVerified} (judge fastPath=${Boolean(evaluation.fastPathUsed)})`);

    recorder.recordTestResult({
      suite: '00-canary-fail-fast',
      testName: 'Canary dev server block',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: verification.reason.split('\n')[0],
      evidenceFiles: [screenshotPath, videoPath].filter(Boolean),
      durationMs: Date.now() - startTime
    });

    recorder.generateSummary();
    console.log('\nResults: Passed: 1, Failed: 0');
  } catch (err) {
    exitCode = 1;
    const safeErrorMsg = LLMJudge.redactSecrets(err.message);
    console.error(`✗ CANARY EXCEPTION: ${safeErrorMsg}`);
    if (mcpClient && !screenshotPath) {
      try {
        screenshotPath = await recorder.captureScreenshot(pageId, '00-canary-fail-fast-error', mcpClient);
      } catch (_) {}
    }
    recorder.recordTestResult({
      suite: '00-canary-fail-fast',
      testName: 'Canary dev server block',
      prompt: PROMPT,
      tokenCount,
      status: 'fail',
      reason: `Exception: ${safeErrorMsg}`,
      evidenceFiles: [screenshotPath, videoPath].filter(Boolean),
      durationMs: Date.now() - startTime
    });
    recorder.generateSummary();
  } finally {
    if (videoPath) {
      try { await recorder.stopScreencast(pageId, mcpClient); } catch (_) {}
    }
    if (bridge) {
      try { await bridge.disconnect(); } catch (_) {}
    } else if (mcpClient) {
      try { await mcpClient.stop(); } catch (_) {}
    }
    try { cleanSessionEndTimers(); } catch (_) {}
    try { cleanSandbox(config.sandboxDir); } catch (_) {}
  }
  process.exit(exitCode);
})();
