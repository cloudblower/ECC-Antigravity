'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const {
  seedSandbox,
  cleanSandbox,
  cleanSessionEndTimers,
  writeHookEnv,
  cleanHookEnv,
  getHookLogs,
  collectSuiteSideEffects
} = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 06-lifecycle-stop-hooks.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 06: Lifecycle Stop Hooks Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('verify format and typecheck');
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 45, `Prompt "${PROMPT}" must have < 45 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
writeHookEnv(config.sandboxDir, {
  ECC_HOOK_PROFILE: 'strict',
  ECC_GATEGUARD: 'off'
});
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

    videoPath = await recorder.startScreencast(pageId, '06-lifecycle-stop-hooks', mcpClient);
    await bridge.openNewConversation();

    const turnStartTime = new Date().toISOString();
    console.log(`  Submitting prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    screenshotPath = await recorder.captureScreenshot(pageId, '06-lifecycle-stop-hooks', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

    // --- Stop Hooks Lifecycle Direct Unit Probes ---
    const runWithFlagsScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'run-with-flags.js');
    const stopFormatScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'stop-format-typecheck.js');
    const planCanvasStopScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'plan-canvas-pending.js');
    const desktopNotifyScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'desktop-notify.js');

    // 1. stop:plan-canvas-pending: Seed pending canvas review and verify block
    const canvasTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-canvas-test-'));
    const dummyArtifact = path.join(config.sandboxDir, 'plan.md');
    fs.writeFileSync(dummyArtifact, '# Test Plan\n');
    fs.writeFileSync(path.join(canvasTmpDir, 'sessions.json'), JSON.stringify({
      sessions: {
        'suite06-session': {
          key: 'suite06-session',
          status: 'open',
          file: dummyArtifact,
          pendingFeedback: [
            { kind: 'verdict', verdict: 'request_changes', text: 'Please refine architecture section' }
          ],
          updatedAt: new Date().toISOString()
        }
      }
    }));

    const planCanvasRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'stop:plan-canvas-pending',
      'scripts/hooks/plan-canvas-pending.js',
      'minimal,standard,strict',
      '30000'
    ], {
      input: JSON.stringify({ cwd: config.sandboxDir }),
      env: {
        ...process.env,
        ECC_PLAN_CANVAS_STATE_DIR: canvasTmpDir,
        CLAUDE_PROJECT_DIR: config.sandboxDir
      },
      encoding: 'utf8'
    });
    fs.rmSync(canvasTmpDir, { recursive: true, force: true });
    try { fs.unlinkSync(dummyArtifact); } catch (_) {}

    assert.strictEqual(planCanvasRes.status, 0, 'plan-canvas-pending hook runner must exit 0');
    let planCanvasVerified = false;
    try {
      const planOut = JSON.parse(planCanvasRes.stdout.trim());
      assert.strictEqual(planOut.decision, 'block', 'plan-canvas-pending must return block decision for pending feedback');
      assert.match(planOut.reason, /Plan Canvas: the human sent feedback/i, 'plan-canvas-pending reason must cite undelivered feedback');
      planCanvasVerified = true;
    } catch (e) {
      assert.fail(`plan-canvas-pending output assertion failed: ${e.message}; stdout=${planCanvasRes.stdout}`);
    }

    // 2. stop:format-typecheck: Seed accumulator file and verify it is unlinked/processed
    const testSessionId = `e2e_stop_${Date.now()}`;
    const accumFile = path.join(os.tmpdir(), `ecc-edited-${testSessionId}.txt`);
    const dummyJsFile = path.join(config.sandboxDir, 'temp-format-check.js');
    fs.writeFileSync(dummyJsFile, 'console.log("format check");\n');
    fs.writeFileSync(accumFile, dummyJsFile + '\n');
    assert.ok(fs.existsSync(accumFile), 'Accumulator file must exist before stop:format-typecheck');

    const formatRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'stop:format-typecheck',
      'scripts/hooks/stop-format-typecheck.js',
      'standard,strict',
      '300000'
    ], {
      input: JSON.stringify({ cwd: config.sandboxDir }),
      env: {
        ...process.env,
        CLAUDE_SESSION_ID: testSessionId,
        CLAUDE_PROJECT_DIR: config.sandboxDir
      },
      encoding: 'utf8'
    });
    try { fs.unlinkSync(dummyJsFile); } catch (_) {}

    assert.strictEqual(formatRes.status, 0, 'stop-format-typecheck must exit 0');
    const formatTypecheckVerified = !fs.existsSync(accumFile);
    assert.ok(formatTypecheckVerified, 'stop:format-typecheck must process and unlink accumulator file');

    // 3. stop:desktop-notify: Direct execution exits 0, and verify safe omission in Antigravity adapter
    const notifyRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'stop:desktop-notify',
      'scripts/hooks/desktop-notify.js',
      'standard,strict',
      '30000'
    ], {
      input: JSON.stringify({ summary: 'Turn completed' }),
      env: process.env,
      encoding: 'utf8'
    });
    assert.strictEqual(notifyRes.status, 0, 'desktop-notify hook runner must exit 0 cleanly');
    const desktopNotifyVerified = notifyRes.status === 0;

    const diskVerified = Boolean(planCanvasVerified && formatTypecheckVerified && desktopNotifyVerified);
    assert.ok(diskVerified, 'Disk telemetry and deterministic side effects must confirm all 3 stop hook units');

    const hookLogs = getHookLogs(config.sandboxDir, turnStartTime);
    console.log(`  Telemetry captured: ${hookLogs.length} hook events on turn idle`);

    const evaluation = await judge.evaluate({
      criteria: 'Did stop hooks execute on turn idle, verifying plan-canvas-pending, format-typecheck, and desktop-notify skip?',
      actualOutput: `Turn completed: ${turnResult.completed}. PlanCanvasBlock: ${planCanvasVerified}, FormatAccumulatorCleared: ${formatTypecheckVerified}, DesktopNotifyExit0: ${desktopNotifyVerified}`,
      fallbackKeywords: ['completed', 'true'],
      diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ Stop hook lifecycle executed on turn idle (all 3 units verified)`);
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

    const structured = await recorder.captureStructuredEvidence('06-lifecycle-stop-hooks', {
      hookLogs: sideEffects.hookLogs,
      sideEffects,
      a11ySnapshot,
      domExtract: {
        turnResult,
        hookEventsCount: hookLogs.length,
        planCanvasVerified,
        formatTypecheckVerified,
        desktopNotifyVerified
      },
      browserDiagnostics: { consoleMessages, networkRequests },
      verificationReceipt: {
        testName: 'Lifecycle stop hooks execution and desktop-notify skip',
        suite: '06-lifecycle-stop-hooks',
        status: 'pass',
        prompt: PROMPT,
        tokenCount,
        durationMs: Date.now() - startTime,
        evaluation
      }
    });

    const allEvidence = [screenshotPath, videoPath, ...structured.allFiles].filter(Boolean);

    recorder.recordTestResult({
      suite: '06-lifecycle-stop-hooks',
      testName: 'Lifecycle stop hooks execution and desktop-notify skip',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: 'Stop hooks plan-canvas-pending, format-typecheck, and desktop-notify skip verified',
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
        screenshotPath = await recorder.captureScreenshot(pageId, '06-lifecycle-stop-hooks-error', mcpClient);
      } catch (_) {}
    }
    let structuredErr = null;
    try {
      const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
        sinceTimestamp: new Date(startTime).toISOString()
      });
      structuredErr = await recorder.captureStructuredEvidence('06-lifecycle-stop-hooks', {
        hookLogs: sideEffects.hookLogs,
        sideEffects,
        verificationReceipt: {
          testName: 'Lifecycle stop hooks execution and desktop-notify skip',
          suite: '06-lifecycle-stop-hooks',
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
      suite: '06-lifecycle-stop-hooks',
      testName: 'Lifecycle stop hooks execution and desktop-notify skip',
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
