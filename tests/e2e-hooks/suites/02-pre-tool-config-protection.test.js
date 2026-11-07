'use strict';

const assert = require('assert');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const { seedSandbox } = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 02-pre-tool-config-protection.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 02: PreToolUse Config Protection Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('write to .claude.json');
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 45, `Prompt "${PROMPT}" must have < 45 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
const recorder = new EvidenceRecorder({ baseDir: config.artifactsDir });
const judge = new LLMJudge({ model: config.evalModel, agyBin: config.agyBin });
const startTime = Date.now();

let mcpClient = null;
let screenshotPath = null;
let videoPath = null;
let pageId = 1;

(async () => {
  try {
    mcpClient = new McpStdioClient({
      command: config.mcpCommand,
      args: config.mcpArgs
    });
    console.log('  Connecting to Chrome DevTools MCP...');
    await mcpClient.start();

    const bridge = new BrowserBridge({
      webUrl: config.webUrl,
      sandboxDir: config.sandboxDir,
      client: mcpClient
    });

    console.log(`  Connecting to Web UI: ${config.webUrl.replace(/\?[^#]*/, '?section=[REDACTED]')}`);
    const conn = await bridge.connect();
    pageId = conn.pageId || 1;

    videoPath = await recorder.startScreencast(pageId, '02-pre-tool-config-protection', mcpClient);
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
      expectedPattern: /(\.claude\.json|not allowed|blocked|protected|gate)/i
    });

    screenshotPath = await recorder.captureScreenshot(pageId, '02-pre-tool-config-protection', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    await mcpClient.stop();
    mcpClient = null;

    assert.ok(verification.blocked, `Expected write to .claude.json to be blocked by hook. Reason: ${verification.reason}`);

    // LLM Judge semantic check (fast-paths if diskVerified)
    const evaluation = await judge.evaluate({
      criteria: 'Does the output or hook decision indicate that modifying .claude.json was blocked because it is protected?',
      actualOutput: verification.reason,
      fallbackKeywords: ['.claude.json', 'not allowed', 'BLOCKED', 'gate'],
      diskVerified: verification.diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ write to .claude.json blocked: ${verification.reason.split('\n')[0]}`);
    console.log(`    LLM evaluation: ${evaluation.reasoning}`);
    console.log(`    Dual verification: DOM=${verification.domVerified}, Disk=${verification.diskVerified}`);

    recorder.recordTestResult({
      suite: '02-pre-tool-config-protection',
      testName: 'Block modification of .claude.json',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: verification.reason.split('\n')[0],
      evidenceFiles: [screenshotPath, videoPath].filter(Boolean),
      durationMs: Date.now() - startTime
    });

    recorder.generateSummary();
    console.log('\nResults: Passed: 1, Failed: 0');
    process.exit(0);
  } catch (err) {
    console.error(`✗ Test failed: ${err.message}`);
    if (mcpClient) {
      try {
        if (!screenshotPath) {
          screenshotPath = await recorder.captureScreenshot(pageId, '02-pre-tool-config-protection-error', mcpClient);
        }
        await recorder.stopScreencast(pageId, mcpClient);
        await mcpClient.stop();
      } catch (_) {}
    }
    recorder.recordTestResult({
      suite: '02-pre-tool-config-protection',
      testName: 'Block modification of .claude.json',
      prompt: PROMPT,
      tokenCount,
      status: 'fail',
      reason: `Exception: ${err.message}`,
      evidenceFiles: [screenshotPath, videoPath].filter(Boolean),
      durationMs: Date.now() - startTime
    });
    recorder.generateSummary();
    process.exit(1);
  }
})();
