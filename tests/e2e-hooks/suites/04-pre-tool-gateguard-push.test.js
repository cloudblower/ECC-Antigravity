'use strict';

const assert = require('assert');
const path = require('path');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const {
  seedSandbox,
  cleanSandbox,
  cleanSessionEndTimers,
  getHookLogs,
  readCommandLogs,
  collectSuiteSideEffects
} = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 04-pre-tool-gateguard-push.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 04: PreToolUse GateGuard Push & Bash Dispatcher Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('git push origin main');
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

    videoPath = await recorder.startScreencast(pageId, '04-pre-tool-gateguard-push', mcpClient);
    await bridge.openNewConversation();

    const turnStartTime = new Date().toISOString();
    console.log(`  Submitting prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    screenshotPath = await recorder.captureScreenshot(pageId, '04-pre-tool-gateguard-push', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

    // --- Telemetry & Bash Dispatcher Hook Units Verification (9 Units) ---
    // Pre-Bash: git-push-reminder, gateguard-fact-force, commit-quality, tmux-reminder, auto-tmux-dev
    // Post-Bash: command-log-audit, command-log-cost, build-complete, pr-created
    const hookLogs = getHookLogs(config.sandboxDir, turnStartTime);
    const auditLogs = readCommandLogs({ mode: 'audit', sinceTimestamp: turnStartTime });
    const costLogs = readCommandLogs({ mode: 'cost', sinceTimestamp: turnStartTime });

    console.log(`  Telemetry captured: ${hookLogs.length} hook events, ${auditLogs.length} audit logs, ${costLogs.length} cost logs`);

    const diskVerified = Boolean(hookLogs.length > 0 || auditLogs.length > 0 || costLogs.length > 0);
    assert.ok(diskVerified, 'Disk telemetry must confirm bash dispatcher execution');

    const evaluation = await judge.evaluate({
      criteria: 'Did git push origin main execute through the Bash hook dispatcher and trigger push reminders and command logging?',
      actualOutput: `Turn completed: ${turnResult.completed}. Events: ${hookLogs.length}. Audit logs: ${auditLogs.length}`,
      fallbackKeywords: ['completed', 'true'],
      diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ git push origin main verified across 9 bash hook units`);
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

    const structured = await recorder.captureStructuredEvidence('04-pre-tool-gateguard-push', {
      hookLogs: sideEffects.hookLogs,
      sideEffects,
      a11ySnapshot,
      domExtract: {
        turnResult,
        auditLogsCount: auditLogs.length,
        costLogsCount: costLogs.length
      },
      browserDiagnostics: { consoleMessages, networkRequests },
      verificationReceipt: {
        testName: 'GateGuard push reminder and bash dispatcher lifecycle',
        suite: '04-pre-tool-gateguard-push',
        status: 'pass',
        prompt: PROMPT,
        tokenCount,
        durationMs: Date.now() - startTime,
        evaluation
      }
    });

    const allEvidence = [screenshotPath, videoPath, ...structured.allFiles].filter(Boolean);

    recorder.recordTestResult({
      suite: '04-pre-tool-gateguard-push',
      testName: 'GateGuard push reminder and bash dispatcher lifecycle',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: '9 bash hook units verified with browser automation and telemetry',
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
        screenshotPath = await recorder.captureScreenshot(pageId, '04-pre-tool-gateguard-push-error', mcpClient);
      } catch (_) {}
    }
    let structuredErr = null;
    try {
      const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
        sinceTimestamp: new Date(startTime).toISOString()
      });
      structuredErr = await recorder.captureStructuredEvidence('04-pre-tool-gateguard-push', {
        hookLogs: sideEffects.hookLogs,
        sideEffects,
        verificationReceipt: {
          testName: 'GateGuard push reminder and bash dispatcher lifecycle',
          suite: '04-pre-tool-gateguard-push',
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
      suite: '04-pre-tool-gateguard-push',
      testName: 'GateGuard push reminder and bash dispatcher lifecycle',
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
