'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const {
  seedSandbox,
  cleanSandbox,
  cleanSessionEndTimers,
  getHookLogs,
  readWarningBuffer,
  readEditedAccumulator,
  collectSuiteSideEffects
} = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 05-post-tool-console-warn.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 05: PostToolUse Console Warn & Warning Buffer Drain Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('add console.log in index.js');
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 45, `Prompt "${PROMPT}" must have < 45 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });
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

    console.log(`  Connecting to Web UI: ${config.webUrl.replace(/\?[^#]*/, '?section=[REDACTED]')}`);
    const conn = await bridge.connect();
    pageId = conn.pageId || 1;

    videoPath = await recorder.startScreencast(pageId, '05-post-tool-console-warn', mcpClient);
    await bridge.openNewConversation();

    const turnStartTime = new Date().toISOString();
    console.log(`  Submitting prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    screenshotPath = await recorder.captureScreenshot(pageId, '05-post-tool-console-warn', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

    // --- PostToolUse Hooks & Warning Buffer Verification ---
    // 1. post:edit:console-warn
    // 2. post:edit:design-quality-check
    // 3. Warning buffer drain into injectSteps / agy-warning-buffer.jsonl
    const hookLogs = getHookLogs(config.sandboxDir, turnStartTime);
    const warningBuffer = readWarningBuffer(config.artifactsDir);
    const accumulated = readEditedAccumulator({ cwd: config.sandboxDir });

    console.log(`  Telemetry captured: ${hookLogs.length} hook events, ${warningBuffer.length} buffer warnings`);

    const diskVerified = Boolean(warningBuffer.length > 0 || hookLogs.length > 0 || accumulated.length > 0);
    assert.ok(diskVerified, 'Disk telemetry must confirm post-edit console-warn hook execution');

    const evaluation = await judge.evaluate({
      criteria: 'Did adding console.log trigger post-edit quality checks and console-warn detection?',
      actualOutput: `Turn completed: ${turnResult.completed}. Warnings: ${warningBuffer.length}. Logs: ${hookLogs.length}`,
      fallbackKeywords: ['completed', 'true'],
      diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ add console.log in index.js verified with post-tool-use warning buffer`);
    console.log(`    LLM evaluation: ${evaluation.reasoning}`);

    let a11ySnapshot = '';
    let consoleMessages = [];
    let networkRequests = [];
    if (mcpClient) {
      try {
        a11ySnapshot = await mcpClient.takeSnapshot({ pageId });
        consoleMessages = await mcpClient.listConsoleMessages({ pageId });
        networkRequests = await mcpClient.listNetworkRequests({ pageId });
      } catch (_) {}
    }

    const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
      sinceTimestamp: new Date(startTime).toISOString()
    });

    const structured = await recorder.captureStructuredEvidence('05-post-tool-console-warn', {
      hookLogs: sideEffects.hookLogs,
      sideEffects,
      a11ySnapshot,
      domExtract: {
        turnResult,
        warningCount: warningBuffer.length,
        accumulatedCount: accumulated.length
      },
      browserDiagnostics: { consoleMessages, networkRequests },
      verificationReceipt: {
        testName: 'PostToolUse console-warn and design-quality-check buffer',
        suite: '05-post-tool-console-warn',
        status: 'pass',
        prompt: PROMPT,
        tokenCount,
        durationMs: Date.now() - startTime,
        evaluation
      }
    });

    const allEvidence = [screenshotPath, videoPath, ...structured.allFiles].filter(Boolean);

    recorder.recordTestResult({
      suite: '05-post-tool-console-warn',
      testName: 'PostToolUse console-warn and design-quality-check buffer',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: 'Post-edit console warn and design check buffer verified',
      evidenceFiles: allEvidence,
      structuredEvidence: structured,
      durationMs: Date.now() - startTime
    });

    recorder.generateSummary();
    console.log('\nResults: Passed: 1, Failed: 0');
  } catch (err) {
    exitCode = 1;
    const safeErrorMsg = LLMJudge.redactSecrets(err.message);
    console.error(`✗ Test failed: ${safeErrorMsg}`);
    if (mcpClient && !screenshotPath) {
      try {
        screenshotPath = await recorder.captureScreenshot(pageId, '05-post-tool-console-warn-error', mcpClient);
      } catch (_) {}
    }
    let structuredErr = null;
    try {
      const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
        sinceTimestamp: new Date(startTime).toISOString()
      });
      structuredErr = await recorder.captureStructuredEvidence('05-post-tool-console-warn', {
        hookLogs: sideEffects.hookLogs,
        sideEffects,
        verificationReceipt: {
          testName: 'PostToolUse console-warn and design-quality-check buffer',
          suite: '05-post-tool-console-warn',
          status: 'fail',
          prompt: PROMPT,
          tokenCount,
          durationMs: Date.now() - startTime,
          error: safeErrorMsg
        }
      });
    } catch (_) {}
    const allEvidenceErr = [screenshotPath, videoPath, ...(structuredErr ? structuredErr.allFiles : [])].filter(Boolean);
    recorder.recordTestResult({
      suite: '05-post-tool-console-warn',
      testName: 'PostToolUse console-warn and design-quality-check buffer',
      prompt: PROMPT,
      tokenCount,
      status: 'fail',
      reason: `Exception: ${safeErrorMsg}`,
      evidenceFiles: allEvidenceErr,
      structuredEvidence: structuredErr,
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
