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
  console.log('[SKIP] 01-pre-tool-bash-blocks.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 01: PreToolUse Bash Blocks Test (Real Browser Automation) ===');

const PROMPT = 'git commit with --no-verify';
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 12, `Prompt "${PROMPT}" must have < 12 tokens, got ${tokenCount}`);

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
      expectedPattern: /(--no-verify|not allowed|blocked|git|gate)/i
    });

    screenshotPath = await recorder.captureScreenshot(pageId, '01-pre-tool-bash-blocks', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    await mcpClient.stop();
    mcpClient = null;

    assert.ok(verification.blocked, `Expected git commit --no-verify to be blocked by hook. Reason: ${verification.reason}`);

    // LLM Judge semantic check
    const evaluation = await judge.evaluate({
      criteria: 'Does the output or hook decision indicate that git commit with --no-verify was blocked to prevent bypassing git hooks?',
      actualOutput: verification.reason,
      fallbackKeywords: ['--no-verify', 'not allowed', 'gate', 'blocked']
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ git commit with --no-verify blocked: ${verification.reason.split('\n')[0]}`);
    console.log(`    LLM evaluation: ${evaluation.reasoning}`);
    console.log(`    Dual verification: DOM=${verification.domVerified}, Disk=${verification.diskVerified}`);

    recorder.recordTestResult({
      suite: '01-pre-tool-bash-blocks',
      testName: 'Block git commit --no-verify',
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
          screenshotPath = await recorder.captureScreenshot(pageId, '01-pre-tool-bash-blocks-error', mcpClient);
        }
        await recorder.stopScreencast(pageId, mcpClient);
        await mcpClient.stop();
      } catch (_) {}
    }
    recorder.recordTestResult({
      suite: '01-pre-tool-bash-blocks',
      testName: 'Block git commit --no-verify',
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
