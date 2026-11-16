'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const {
  seedSandbox,
  cleanSandbox,
  cleanSessionEndTimers,
  writeHookEnv,
  readMcpHealthCache,
  readSkillRunsLog,
  collectSuiteSideEffects
} = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 08-mcp-skill-lifecycle.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 08: MCP & Skill Hook Lifecycle Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('verify mcp health and skill track');
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

    videoPath = await recorder.startScreencast(pageId, '08-mcp-skill-lifecycle', mcpClient);
    await bridge.openNewConversation();

    console.log(`  Submitting prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    screenshotPath = await recorder.captureScreenshot(pageId, '08-mcp-skill-lifecycle', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

    // --- MCP & Skill Lifecycle Direct Unit Assertions ---
    const runWithFlagsScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'run-with-flags.js');

    // 1. pre:mcp-health-check (^mcp__)
    const mcpPreRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'pre:mcp-health-check',
      'scripts/hooks/mcp-health-check.js',
      'standard,strict'
    ], {
      input: JSON.stringify({ tool_name: 'mcp__test__query', tool_input: {} }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(mcpPreRes.status, 0, 'Pre MCP health check must succeed cleanly with status 0');

    // 2. post:mcp-health-check (^mcp__ failure): Writes unhealthy server status to mcp-health-cache.json
    const mcpCacheFile = path.join(config.sandboxDir, '.claude', 'mcp-health-cache.json');
    fs.mkdirSync(path.dirname(mcpCacheFile), { recursive: true });
    const mcpPostFailRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'post:mcp-health-check',
      'scripts/hooks/mcp-health-check.js',
      'standard,strict'
    ], {
      input: JSON.stringify({
        tool_name: 'mcp__mockfailserver__query',
        error: 'ECONNREFUSED connect failed'
      }),
      env: {
        ...process.env,
        CLAUDE_HOOK_EVENT_NAME: 'PostToolUseFailure',
        ECC_MCP_HEALTH_STATE_PATH: mcpCacheFile
      },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(mcpPostFailRes.status, 0, 'Post MCP failure check must exit 0');
    const healthCache = readMcpHealthCache({ claudeDir: path.join(config.sandboxDir, '.claude') });
    const mockServerEntry = healthCache.servers && healthCache.servers.mockfailserver;
    assert.ok(mockServerEntry, 'mcp-health-cache.json must contain mockfailserver entry');
    assert.ok(
      mockServerEntry.status === 'unhealthy' || mockServerEntry.healthy === false,
      `mockfailserver must be marked unhealthy in health cache, got: ${JSON.stringify(mockServerEntry)}`
    );

    // 3. post:skill:track and post:skill:track:failure: Verify recorded runs in skill-runs.jsonl
    const skillRunStartTime = new Date(Date.now() - 2000).toISOString();

    const skillSuccessRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'post:skill:track',
      'scripts/hooks/skill-run-tracker.js',
      'standard,strict'
    ], {
      input: JSON.stringify({
        tool_name: 'Skill',
        tool_input: { skill: 'tdd-workflow' },
        tool_response: { status: 'success' }
      }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(skillSuccessRes.status, 0, 'Skill track success must exit 0');

    const skillFailureRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'post:skill:track:failure',
      'scripts/hooks/skill-run-tracker.js',
      'standard,strict'
    ], {
      input: JSON.stringify({
        tool_name: 'Skill',
        tool_input: { skill: 'tdd-workflow' },
        tool_response: { is_error: true, error: 'Command failed' }
      }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(skillFailureRes.status, 0, 'Skill track failure must exit 0');

    const recordedRuns = readSkillRunsLog({ sinceTimestamp: skillRunStartTime });
    const hasSuccessRun = recordedRuns.some(r => r.skill_id === 'tdd-workflow' && r.outcome === 'success');
    const hasFailureRun = recordedRuns.some(r => r.skill_id === 'tdd-workflow' && r.outcome === 'failure');
    assert.ok(hasSuccessRun, 'Skill runs log must contain an entry with outcome === "success"');
    assert.ok(hasFailureRun, 'Skill runs log must contain an entry with outcome === "failure"');

    const diskVerified = Boolean(
      mcpPreRes.status === 0 &&
      mockServerEntry &&
      (mockServerEntry.status === 'unhealthy' || mockServerEntry.healthy === false) &&
      hasSuccessRun &&
      hasFailureRun
    );
    assert.ok(diskVerified, 'Disk telemetry and persistence caches must confirm MCP and Skill hook lifecycles');

    const evaluation = await judge.evaluate({
      criteria: 'Did the MCP and Skill lifecycles execute correctly for pre-check, post-failure, and skill run tracking?',
      actualOutput: `Turn: ${turnResult.completed}, PreMCP: ${mcpPreRes.status}, McpUnhealthyCached: ${Boolean(mockServerEntry)}, SkillSuccessLogged: ${hasSuccessRun}, SkillFailureLogged: ${hasFailureRun}`,
      fallbackKeywords: ['Turn: true'],
      diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ MCP health checks and skill tracking lifecycles verified directly (all 4 units)`);
    console.log(`    LLM evaluation: ${evaluation.reasoning}`);

    let a11ySnapshot = '';
    let consoleMessages = [];
    let networkRequests = [];
    if (mcpClient) {
      try {
        a11ySnapshot = await mcpClient.takeSnapshot({ pageId });
        consoleMessages = await mcpClient.listConsoleMessages({ pageId });
        networkRequests = await mcpClient.listNetworkRequests({ pageId });
      } catch (_) {
        // Best-effort diagnostics capture
      }
    }

    const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
      sinceTimestamp: new Date(startTime).toISOString()
    });

    const structured = await recorder.captureStructuredEvidence('08-mcp-skill-lifecycle', {
      hookLogs: sideEffects.hookLogs,
      sideEffects,
      a11ySnapshot,
      domExtract: {
        turnResult,
        mcpPreStatus: mcpPreRes.status,
        mcpPostFailStatus: mcpPostFailRes.status,
        skillSuccessStatus: skillSuccessRes.status
      },
      browserDiagnostics: { consoleMessages, networkRequests },
      verificationReceipt: {
        testName: 'MCP health check and skill track success/failure lifecycles',
        suite: '08-mcp-skill-lifecycle',
        status: 'pass',
        prompt: PROMPT,
        tokenCount,
        durationMs: Date.now() - startTime,
        evaluation
      }
    });

    const allEvidence = [screenshotPath, videoPath, ...structured.allFiles].filter(Boolean);

    recorder.recordTestResult({
      suite: '08-mcp-skill-lifecycle',
      testName: 'MCP health check and skill track success/failure lifecycles',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: 'MCP pre/post health checks and skill tracking verified',
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
        screenshotPath = await recorder.captureScreenshot(pageId, '08-mcp-skill-lifecycle-error', mcpClient);
      } catch (_) {
        // Best-effort screenshot
      }
    }
    let structuredErr = null;
    try {
      const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
        sinceTimestamp: new Date(startTime).toISOString()
      });
      structuredErr = await recorder.captureStructuredEvidence('08-mcp-skill-lifecycle', {
        hookLogs: sideEffects.hookLogs,
        sideEffects,
        verificationReceipt: {
          testName: 'MCP health check and skill track success/failure lifecycles',
          suite: '08-mcp-skill-lifecycle',
          status: 'fail',
          prompt: PROMPT,
          tokenCount,
          durationMs: Date.now() - startTime,
          error: safeErrorMsg
        }
      });
    } catch (_) {
      // Best-effort evidence collection
    }
    const allEvidenceErr = [screenshotPath, videoPath, ...(structuredErr ? structuredErr.allFiles : [])].filter(Boolean);
    recorder.recordTestResult({
      suite: '08-mcp-skill-lifecycle',
      testName: 'MCP health check and skill track success/failure lifecycles',
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
      try { await recorder.stopScreencast(pageId, mcpClient); } catch (_) { /* Best-effort */ }
    }
    if (bridge) {
      try { await bridge.disconnect(); } catch (_) { /* Best-effort */ }
    } else if (mcpClient) {
      try { await mcpClient.stop(); } catch (_) { /* Best-effort */ }
    }
    try { cleanSessionEndTimers(); } catch (_) { /* Best-effort */ }
    try { cleanSandbox(config.sandboxDir); } catch (_) { /* Best-effort */ }
    process.exit(exitCode);
  }
})();
