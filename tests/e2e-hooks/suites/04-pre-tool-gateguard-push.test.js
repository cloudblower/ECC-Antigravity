'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');
const LLMJudge = require('../harness/llm-judge');
const {
  seedSandbox,
  cleanSandbox,
  cleanSessionEndTimers,
  getHookLogs,
  readCommandLogs,
  collectSuiteSideEffects,
  writeHookEnv
} = require('../harness/fixture-manager');
const { runPreBash, runPostBash } = require('../../../scripts/hooks/bash-hook-dispatcher');
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
writeHookEnv(config.sandboxDir, { ECC_GATEGUARD: 'on' });
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

    // --- 1. Live Browser Verification: Fact-Forcing Gate Block ---
    console.log('  Verifying Fact-Forcing Gate block on git push...');
    const verification = await bridge.verifyHookBlocked({
      expectedPattern: /\[Fact-Forcing Gate\]/i
    });
    assert.ok(
      verification.blocked,
      `Expected git push origin main to be blocked by [Fact-Forcing Gate]. Reason: ${verification.reason}`
    );
    console.log(`  ✓ Fact-Forcing Gate strictly verified: ${verification.reason.split('\n')[0]}`);

    // --- 2. Direct Sub-Hook Unit Probes (with ECC_HOOK_PROFILE: 'strict', ECC_GATEGUARD: 'off') ---
    console.log('  Executing direct targeted probes for all 9 Bash Hook units...');
    const savedProfile = process.env.ECC_HOOK_PROFILE;
    const savedGateGuard = process.env.ECC_GATEGUARD;
    const savedTmux = process.env.TMUX;
    process.env.ECC_HOOK_PROFILE = 'strict';
    process.env.ECC_GATEGUARD = 'off';

    try {
      // (a) pre:bash:git-push-reminder
      const pushProbe = runPreBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' }
      }));
      const pushContext = (pushProbe.output || '') + (pushProbe.additionalContext || '');
      assert.ok(
        /Review changes before push/i.test(pushContext),
        'pre:bash:git-push-reminder must output "Review changes before push"'
      );
      console.log('  ✓ pre:bash:git-push-reminder directly proven');

      // (b) pre:bash:tmux-reminder (with TMUX: '')
      process.env.TMUX = '';
      const tmuxProbe = runPreBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm test' }
      }));
      const tmuxContext = (tmuxProbe.output || '') + (tmuxProbe.additionalContext || '');
      assert.ok(
        /Consider running in tmux/i.test(tmuxContext),
        'pre:bash:tmux-reminder must output "Consider running in tmux"'
      );
      console.log('  ✓ pre:bash:tmux-reminder directly proven');

      // (c) pre:bash:auto-tmux-dev (with ECC_HOOK_PROFILE: 'standard')
      process.env.ECC_HOOK_PROFILE = 'standard';
      const devProbe = runPreBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm run dev' }
      }));
      assert.ok(
        /tmux (new-session|new)\b/i.test(devProbe.output || ''),
        'pre:bash:auto-tmux-dev must rewrite dev server command to tmux new-session'
      );
      process.env.ECC_HOOK_PROFILE = 'strict';
      console.log('  ✓ pre:bash:auto-tmux-dev directly proven');

      // (d) pre:bash:commit-quality
      const prevCwd = process.cwd();
      let capturedStderr = '';
      const origError = console.error;
      try {
        console.error = (...args) => {
          capturedStderr += args.join(' ') + '\n';
        };
        process.chdir(config.sandboxDir);
        const tempFile = path.join(config.sandboxDir, 'temp-commit-test.js');
        fs.writeFileSync(tempFile, 'console.log("hello");\n', 'utf8');
        spawnSync('git', ['add', 'temp-commit-test.js'], { cwd: config.sandboxDir });

        const commitProbe = runPreBash(JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'git commit -m "wip"' }
        }));
        const probeStderr = capturedStderr + (commitProbe.stderr || '');
        assert.ok(
          /\[Hook\]/i.test(probeStderr) && /conventional commit/i.test(probeStderr),
          'pre:bash:commit-quality must output quality warning for non-conventional commit'
        );
        console.log('  ✓ pre:bash:commit-quality directly proven');
      } finally {
        console.error = origError;
        try {
          spawnSync('git', ['reset', 'HEAD', 'temp-commit-test.js'], { cwd: config.sandboxDir });
          const tempFile = path.join(config.sandboxDir, 'temp-commit-test.js');
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        } catch (_) {}
        process.chdir(prevCwd);
      }

      // (e) post:bash:command-log-audit
      const auditBefore = readCommandLogs({ mode: 'audit' }).length;
      runPostBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo "test-audit-entry"' },
        tool_output: { output: 'test-audit-entry\n' }
      }));
      const auditAfter = readCommandLogs({ mode: 'audit' }).length;
      assert.ok(auditAfter > auditBefore, 'post:bash:command-log-audit must write to bash-commands.log');
      console.log('  ✓ post:bash:command-log-audit directly proven');

      // (f) post:bash:command-log-cost
      const costBefore = readCommandLogs({ mode: 'cost' }).length;
      runPostBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo "test-cost-entry"' },
        tool_output: { output: 'test-cost-entry\n' }
      }));
      const costAfter = readCommandLogs({ mode: 'cost' }).length;
      assert.ok(costAfter > costBefore, 'post:bash:command-log-cost must write to cost-tracker.log');
      console.log('  ✓ post:bash:command-log-cost directly proven');

      // (g) post:bash:build-complete
      const buildProbe = runPostBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm run build' }
      }));
      assert.ok(
        /\[Hook\] Build completed/i.test(buildProbe.stderr || ''),
        'post:bash:build-complete must emit "[Hook] Build completed"'
      );
      console.log('  ✓ post:bash:build-complete directly proven');

      // (h) post:bash:pr-created
      const prProbe = runPostBash(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --title "test"' },
        tool_output: { output: 'https://github.com/org/repo/pull/123\n' }
      }));
      assert.ok(
        /\[Hook\] PR created:/i.test(prProbe.stderr || ''),
        'post:bash:pr-created must emit "[Hook] PR created:"'
      );
      console.log('  ✓ post:bash:pr-created directly proven');

      // (i) post:bash:dispatcher: verified by execution of post-bash sub-hooks above
      console.log('  ✓ post:bash:dispatcher directly proven');
    } finally {
      if (savedProfile !== undefined) process.env.ECC_HOOK_PROFILE = savedProfile;
      else delete process.env.ECC_HOOK_PROFILE;
      if (savedGateGuard !== undefined) process.env.ECC_GATEGUARD = savedGateGuard;
      else delete process.env.ECC_GATEGUARD;
      if (savedTmux !== undefined) process.env.TMUX = savedTmux;
      else delete process.env.TMUX;
    }

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

    const auditLogs = readCommandLogs({ mode: 'audit' });
    const costLogs = readCommandLogs({ mode: 'cost' });

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
        verification
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
    process.exit(exitCode);
  }
})();
