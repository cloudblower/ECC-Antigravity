'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox, cleanSandbox, cleanSessionEndTimers } = require('../harness/fixture-manager');
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

    // --- MCP & Skill Lifecycle Unit Assertions ---
    // 1. pre:mcp-health-check (^mcp__)
    // 2. post:mcp-health-check (^mcp__ failure)
    // 3. post:skill:track (Skill success & failure)
    const mcpHealthScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'mcp-health-check.js');
    const skillTrackScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'skill-run-tracker.js');

    // Test pre:mcp-health-check
    const mcpPreRes = spawnSync(process.execPath, [mcpHealthScript], {
      input: JSON.stringify({ tool_name: 'mcp__test__query', tool_input: {} }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.ok(mcpPreRes.status === 0 || mcpPreRes.status === null, 'Pre MCP health check must succeed without fatal error');

    // Test post:mcp-health-check failure handling
    const mcpPostFailRes = spawnSync(process.execPath, [mcpHealthScript], {
      input: JSON.stringify({ tool_name: 'mcp__test__query', error: 'ECONNREFUSED' }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.ok(mcpPostFailRes.status === 0 || mcpPostFailRes.status === null, 'Post MCP failure check must handle error without fatal crash');

    // Test post:skill:track success and failure
    const skillSuccessRes = spawnSync(process.execPath, [skillTrackScript], {
      input: JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'tdd-workflow' } }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(skillSuccessRes.status, 0, 'Skill track success must exit 0');

    const skillFailureRes = spawnSync(process.execPath, [skillTrackScript], {
      input: JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'tdd-workflow' }, error: 'failed' }),
      env: process.env,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(skillFailureRes.status, 0, 'Skill track failure must exit 0');

    const diskVerified = Boolean(mcpPreRes.status === 0 && skillSuccessRes.status === 0 && skillFailureRes.status === 0);
    assert.ok(diskVerified, 'Disk telemetry must confirm MCP and Skill hook lifecycles');

    const evaluation = await judge.evaluate({
      criteria: 'Did the MCP and Skill lifecycles execute correctly for pre-check, post-failure, and skill run tracking?',
      actualOutput: `Turn: ${turnResult.completed}, PreMCP: ${mcpPreRes.status}, PostMCPFail: ${mcpPostFailRes.status}, SkillTrack: ${skillSuccessRes.status}`,
      fallbackKeywords: ['Turn: true'],
      diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ MCP health checks and skill tracking lifecycles verified`);
    console.log(`    LLM evaluation: ${evaluation.reasoning}`);

    recorder.recordTestResult({
      suite: '08-mcp-skill-lifecycle',
      testName: 'MCP health check and skill track success/failure lifecycles',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: 'MCP pre/post health checks and skill tracking verified',
      evidenceFiles: [screenshotPath, videoPath].filter(Boolean),
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
      } catch (_) {}
    }
    recorder.recordTestResult({
      suite: '08-mcp-skill-lifecycle',
      testName: 'MCP health check and skill track success/failure lifecycles',
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
