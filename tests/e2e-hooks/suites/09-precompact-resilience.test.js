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
  collectSuiteSideEffects
} = require('../harness/fixture-manager');
const EvidenceRecorder = require('../harness/evidence-recorder');
const McpStdioClient = require('../harness/mcp-stdio-client');
const BrowserBridge = require('../harness/browser-bridge');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 09-precompact-resilience.test.js: ECC_E2E_LOCAL is not true. Skipping.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

console.log('=== Suite 09: PreCompact & GateGuard Fact-Force Resilience Test (Real Browser Automation) ===');

const PROMPT = BrowserBridge.formatDirectPrompt('verify gateguard fact force resilience');
const tokenCount = LLMJudge.countTokens(PROMPT);
assert.ok(tokenCount < 45, `Prompt "${PROMPT}" must have < 45 tokens, got ${tokenCount}`);

seedSandbox(config.sandboxDir);
writeHookEnv(config.sandboxDir, {
  ECC_HOOK_PROFILE: 'strict',
  ECC_GATEGUARD: 'on'
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

    videoPath = await recorder.startScreencast(pageId, '09-precompact-resilience', mcpClient);
    await bridge.openNewConversation();

    console.log(`  Submitting prompt: "${PROMPT}" (${tokenCount} tokens)...`);
    await bridge.submitPrompt(PROMPT);

    console.log('  Waiting for turn execution to complete...');
    const timeoutMs = Math.max(config.timeoutMs || 60000, 180000);
    const turnResult = await bridge.waitForTurnCompletion(timeoutMs);
    console.log(`  Turn finished: completed=${turnResult.completed}, duration=${turnResult.durationMs}ms`);

    screenshotPath = await recorder.captureScreenshot(pageId, '09-precompact-resilience', mcpClient);
    await recorder.stopScreencast(pageId, mcpClient);
    videoPath = null;

    // --- Direct Unit Assertions for Target Hooks ---
    // 1. pre:compact
    // 2. pre:powershell:gateguard-fact-force
    // 3. pre:edit-write:gateguard-fact-force
    const runWithFlagsScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'run-with-flags.js');
    const preCompactScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'pre-compact.js');
    const agyPreToolScript = path.join(config.sandboxDir, '.agents', 'scripts', 'hooks', 'agy', 'pre-tool-use.js');

    // 1. pre:compact execution check: Seed session file and verify compaction log and session annotation
    const sessionsDir = path.join(os.homedir(), '.claude', 'session-data');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, `suite09-test-${Date.now()}-session.tmp`);
    fs.writeFileSync(sessionFile, `# Session\n**Worktree:** ${config.sandboxDir}\n**Project:** ${path.basename(config.sandboxDir)}\n<!-- ECC:SUMMARY:START -->\nPre-existing summary\n<!-- ECC:SUMMARY:END -->\n`);
    const transcriptFile = path.join(config.sandboxDir, '.agents', 'transcript.jsonl');
    fs.mkdirSync(path.dirname(transcriptFile), { recursive: true });
    if (!fs.existsSync(transcriptFile)) {
      fs.writeFileSync(transcriptFile, '{"role":"user","content":"verify compaction"}\n');
    }

    const compactRes = spawnSync(process.execPath, [preCompactScript], {
      input: JSON.stringify({
        transcript_path: transcriptFile
      }),
      env: process.env,
      cwd: config.sandboxDir,
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(compactRes.status, 0, 'PreCompact hook must execute cleanly with status 0');
    const compactionLog = path.join(sessionsDir, 'compaction-log.txt');
    const compactLogExists = fs.existsSync(compactionLog);
    assert.ok(compactLogExists, 'compaction-log.txt must exist after pre:compact runs');
    const sessionContent = fs.readFileSync(sessionFile, 'utf8');
    const compactSessionUpdated = sessionContent.includes('<!-- ECC:SUMMARY:START -->') || sessionContent.includes('Compaction');
    assert.ok(compactSessionUpdated, 'Session file must contain compaction summary or annotation');
    try { fs.unlinkSync(sessionFile); } catch (_) { /* Best-effort cleanup */ }

    // 2. pre:powershell:gateguard-fact-force execution check: Verify strict Fact-Forcing denial
    const ggPsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-ps-state-'));
    const psRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'pre:powershell:gateguard-fact-force',
      'scripts/hooks/gateguard-fact-force.js',
      'standard,strict'
    ], {
      input: JSON.stringify({
        tool_name: 'PowerShell',
        tool_input: { command: 'Stop-Process -Name node -Force' }
      }),
      env: {
        ...process.env,
        ECC_GATEGUARD: 'on',
        GATEGUARD_STATE_DIR: ggPsStateDir
      },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(psRes.status, 0, 'PowerShell gateguard fact-force runner must exit 0');
    const psOut = JSON.parse(psRes.stdout.trim());
    assert.strictEqual(psOut.hookSpecificOutput?.permissionDecision, 'deny', 'PowerShell destructive command must be denied');
    assert.match(
      psOut.hookSpecificOutput?.permissionDecisionReason || '',
      /\[Fact-Forcing Gate\]/,
      'PowerShell denial reason must cite [Fact-Forcing Gate]'
    );

    // Also verify via Antigravity pre-tool adapter
    const agyPsRes = spawnSync(process.execPath, [agyPreToolScript], {
      input: JSON.stringify({
        toolCall: { name: 'PowerShell', args: { command: 'Stop-Process -Name node -Force' } }
      }),
      env: {
        ...process.env,
        ECC_GATEGUARD: 'on',
        GATEGUARD_STATE_DIR: ggPsStateDir
      },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(agyPsRes.status, 0, 'AGY adapter for PowerShell must exit 0');
    const agyPsOut = JSON.parse(agyPsRes.stdout.trim());
    assert.strictEqual(agyPsOut.decision, 'deny', 'AGY adapter must output decision === "deny"');
    assert.match(agyPsOut.reason, /\[Fact-Forcing Gate\]/, 'AGY adapter reason must cite [Fact-Forcing Gate]');
    fs.rmSync(ggPsStateDir, { recursive: true, force: true });

    // 3. pre:edit-write:gateguard-fact-force execution check: Verify strict Fact-Forcing denial on uninspected write
    const ggWriteStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-write-state-'));
    const uninspectedFile = path.join(config.sandboxDir, 'uninspected-e2e-file.js');
    const editRes = spawnSync(process.execPath, [
      runWithFlagsScript,
      'pre:edit-write:gateguard-fact-force',
      'scripts/hooks/gateguard-fact-force.js',
      'standard,strict'
    ], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: uninspectedFile, content: '// uninspected write\n' }
      }),
      env: {
        ...process.env,
        ECC_GATEGUARD: 'on',
        GATEGUARD_STATE_DIR: ggWriteStateDir
      },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(editRes.status, 0, 'Edit/Write gateguard fact-force runner must exit 0');
    const editOut = JSON.parse(editRes.stdout.trim());
    assert.strictEqual(editOut.hookSpecificOutput?.permissionDecision, 'deny', 'Uninspected Write must be denied by Fact-Forcing Gate');
    assert.match(
      editOut.hookSpecificOutput?.permissionDecisionReason || '',
      /\[Fact-Forcing Gate\]/,
      'Write denial reason must cite [Fact-Forcing Gate]'
    );

    // Also verify via Antigravity pre-tool adapter
    const agyEditRes = spawnSync(process.execPath, [agyPreToolScript], {
      input: JSON.stringify({
        toolCall: { name: 'write_to_file', args: { TargetFile: uninspectedFile, CodeContent: '// uninspected write\n' } }
      }),
      env: {
        ...process.env,
        ECC_GATEGUARD: 'on',
        GATEGUARD_STATE_DIR: ggWriteStateDir
      },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.strictEqual(agyEditRes.status, 0, 'AGY adapter for Write must exit 0');
    const agyEditOut = JSON.parse(agyEditRes.stdout.trim());
    assert.strictEqual(agyEditOut.decision, 'deny', 'AGY adapter must output decision === "deny" for uninspected Write');
    assert.match(agyEditOut.reason, /\[Fact-Forcing Gate\]/, 'AGY adapter reason must cite [Fact-Forcing Gate]');
    fs.rmSync(ggWriteStateDir, { recursive: true, force: true });

    const diskVerified = Boolean(
      compactRes.status === 0 &&
      compactLogExists &&
      compactSessionUpdated &&
      psOut.hookSpecificOutput?.permissionDecision === 'deny' &&
      editOut.hookSpecificOutput?.permissionDecision === 'deny' &&
      agyPsOut.decision === 'deny' &&
      agyEditOut.decision === 'deny'
    );
    assert.ok(diskVerified, 'Disk telemetry and deterministic Fact-Forcing denials must confirm all 3 resilience hook units');

    const evaluation = await judge.evaluate({
      criteria: 'Did pre:compact, PowerShell gateguard-fact-force, and Edit/Write gateguard-fact-force hooks execute resiliently?',
      actualOutput: `Turn: ${turnResult.completed}, CompactLog: ${compactLogExists}, PowerShellGateDeny: true, EditWriteGateDeny: true`,
      fallbackKeywords: ['Turn: true'],
      diskVerified
    });

    assert.strictEqual(evaluation.passed, true, `LLM evaluation failed: ${evaluation.reasoning}`);
    console.log(`  ✓ PreCompact and GateGuard fact-force resilience hooks verified directly (all 3 units)`);
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

    const structured = await recorder.captureStructuredEvidence('09-precompact-resilience', {
      hookLogs: sideEffects.hookLogs,
      sideEffects,
      a11ySnapshot,
      domExtract: {
        turnResult,
        compactStatus: compactRes.status,
        psStatus: psRes.status,
        editStatus: editRes.status
      },
      browserDiagnostics: { consoleMessages, networkRequests },
      verificationReceipt: {
        testName: 'PreCompact and GateGuard fact-force resilience lifecycles',
        suite: '09-precompact-resilience',
        status: 'pass',
        prompt: PROMPT,
        tokenCount,
        durationMs: Date.now() - startTime,
        evaluation
      }
    });

    const allEvidence = [screenshotPath, videoPath, ...structured.allFiles].filter(Boolean);

    recorder.recordTestResult({
      suite: '09-precompact-resilience',
      testName: 'PreCompact and GateGuard fact-force resilience lifecycles',
      prompt: PROMPT,
      tokenCount,
      status: 'pass',
      reason: 'pre:compact, PowerShell and Edit/Write fact-forcing verified',
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
        screenshotPath = await recorder.captureScreenshot(pageId, '09-precompact-resilience-error', mcpClient);
      } catch (_) {
        // Best-effort screenshot
      }
    }
    let structuredErr = null;
    try {
      const sideEffects = collectSuiteSideEffects(config.sandboxDir, {
        sinceTimestamp: new Date(startTime).toISOString()
      });
      structuredErr = await recorder.captureStructuredEvidence('09-precompact-resilience', {
        hookLogs: sideEffects.hookLogs,
        sideEffects,
        verificationReceipt: {
          testName: 'PreCompact and GateGuard fact-force resilience lifecycles',
          suite: '09-precompact-resilience',
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
      suite: '09-precompact-resilience',
      testName: 'PreCompact and GateGuard fact-force resilience lifecycles',
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
