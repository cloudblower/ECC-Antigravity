'use strict';

const assert = require('assert');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox, cleanSandbox, cleanSessionEndTimers, collectSuiteSideEffects, writeHookEnv } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 01-pre-tool-bash-blocks.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 01: PreToolUse Bash Blocks Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('git commit with --no-verify');
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 45, `Prompt "${PROMPT}" must have < 45 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
writeHookEnv(config.sandboxDir, { ECC_GATEGUARD: 'off' });
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

    videoPath = await recorder.startScreencast(pageId, '01-pre-tool-bash-blocks', mcpClient);
    await bridge.openNewConversation();

    console.log(`  Submitting prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    // Dual verification: DOM + disk log
    console.log('  Verifying hook block (DOM + disk log)...');
    const verification = await bridge.verifyHookBlocked({
      expectedPattern: /--no-verify.*not allowed/i
    });

    screenshotPath = await recorder.captureScreenshot(pageId, '01-pre-tool-bash-blocks', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

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

    assert.ok(verification.blocked, `Expected git commit --no-verify to be blocked by hook. Reason: ${verification.reason}`);

    // LLM Judge semantic check (fast-paths if diskVerified)
    const evaluation = await judge.evaluate({
      criteria: 'Does the output or hook decision indicate that git commit with --no-verify was blocked to prevent bypassing git hooks?',
      actualOutput: verification.reason,
      fallbackKeywords: ['--no-verify', 'not allowed'],
      diskVerified: verification.diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ git commit with --no-verify blocked: ${verification.reason.split('\n')[0]}`);
    console.log(`    LLM evaluation: ${evaluation.reasoning}`);
    console.log(`    Dual verification: DOM=${verification.domVerified}, Disk=${verification.diskVerified}`);

    const structured = await recorder.captureStructuredEvidence('01-pre-tool-bash-blocks', {
      hookLogs: sideEffects.hookLogs,
      sideEffects,
      a11ySnapshot,
      domExtract: {
        reason: verification.reason,
        domVerified: verification.domVerified,
        diskVerified: verification.diskVerified
      },
      browserDiagnostics: { consoleMessages, networkRequests },
      verificationReceipt: {
        testName: 'Block git commit --no-verify',
        suite: '01-pre-tool-bash-blocks',
        status: 'pass',
        prompt: PROMPT,
        tokenCount,
        durationMs: Date.now() - startTime,
        verification
      }
    });

    const allEvidence = [screenshotPath, videoPath, ...structured.allFiles].filter(Boolean);

    recorder.recordTestResult({
      suite: '01-pre-tool-bash-blocks',
      testName: 'Block git commit --no-verify',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: verification.reason.split('\n')[0],
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
        screenshotPath = await recorder.captureScreenshot(pageId, '01-pre-tool-bash-blocks-error', mcpClient);
      } catch (_) {}
    }
    let structuredErr = null;
    try {
      const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
        sinceTimestamp: new Date(startTime).toISOString()
      });
      structuredErr = await recorder.captureStructuredEvidence('01-pre-tool-bash-blocks', {
        hookLogs: sideEffects.hookLogs,
        sideEffects,
        verificationReceipt: {
          testName: 'Block git commit --no-verify',
          suite: '01-pre-tool-bash-blocks',
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
      suite: '01-pre-tool-bash-blocks',
      testName: 'Block git commit --no-verify',
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
    process.exit(exitCode);
  }
})();
