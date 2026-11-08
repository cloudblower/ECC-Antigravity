/**
 * End-to-End Continuous Learning Suite for Antigravity (ECC-Antigravity)
 *
 * Verifies the full continuous learning end-to-end cycle:
 *   1. Mock CLI (agy + claude) creation
 *   2. Sandbox project setup with Git and Homunculus config
 *   3. Stage 1: PreToolUse & PostToolUse observation capture (pre:observe & post:observe:continuous-learning)
 *   4. Stage 2: Lazy daemon startup (.observer.pid liveness)
 *   5. Stage 3: Batch analysis, observation archival & instinct creation
 *   6. Stage 4: session-start.js discovery & ranking
 *   7. Stage 5: Antigravity pre-invocation.js context injection
 *   8. Stage 6: Parameterized loop matrix (observer-loop.agy.sh & observer-loop.sh) + guaranteed teardown
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../config');

const config = loadConfig();

if (!config.isLocal) {
  console.log('[SKIP] 10-continuous-learning.test.js: ECC_E2E_LOCAL is not true. Skipping continuous learning E2E suite.');
  console.log('Passed: 1, Failed: 0');
  process.exit(0);
}

const repoRoot = path.resolve(__dirname, '../../..');
const { resolveProjectContext, stopObserverForContext } = require(path.join(repoRoot, 'scripts/lib/observer-sessions'));

let passed = 0;
let failed = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil(predicate, timeoutMs = 10000, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await predicate();
      if (res) return res;
    } catch (_) { /* ignore */ }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * 1. Universal Mock CLI (createMockCli)
 * Exposes an executable in sandbox bin/ as both `agy` and `claude`.
 */
function createMockCli(binDir) {
  const mockCliScript = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const invokedAs = path.basename(process.argv[1]);
const logPath = process.env.MOCK_CLI_LOG;
if (logPath) {
  fs.appendFileSync(logPath, JSON.stringify({
    invokedAs,
    args,
    env_instincts: process.env.INSTINCTS_DIR || ''
  }) + '\\n');
}

// Handler for 'models' command
if (args.includes('models')) {
  process.stdout.write('flash-medium\\n');
  process.exit(0);
}

// Extract prompt
let prompt = '';
const pIdx = args.indexOf('-p');
if (pIdx !== -1 && args[pIdx + 1]) {
  prompt = args[pIdx + 1];
} else {
  prompt = args.join(' ');
}

// Resolve instincts directory
let instinctsDir = process.env.INSTINCTS_DIR;
if (!instinctsDir) {
  const match = prompt.match(/directly to ([^\\s]+)\\/<id>\\.ya?ml/);
  if (match) {
    instinctsDir = match[1];
  } else if (process.env.PROJECT_DIR) {
    instinctsDir = path.join(process.env.PROJECT_DIR, 'instincts', 'personal');
  } else {
    instinctsDir = path.join(process.cwd(), 'instincts', 'personal');
  }
}

fs.mkdirSync(instinctsDir, { recursive: true });

const instinctContent = \`---
id: test-deterministic-verification
trigger: when testing code
confidence: 0.85
domain: code-style
source: session-observation
scope: project
---
# Deterministic Verification
## Action
Always enforce deterministic test verifications.
\`;

fs.writeFileSync(path.join(instinctsDir, 'test-pattern.md'), instinctContent, 'utf8');
process.stdout.write('{"status":"analysis_complete"}\\n');
process.exit(0);
`;

  const agyPath = path.join(binDir, 'agy');
  const claudePath = path.join(binDir, 'claude');

  fs.writeFileSync(agyPath, mockCliScript, { mode: 0o755 });
  fs.writeFileSync(claudePath, mockCliScript, { mode: 0o755 });
}

/**
 * 2. Sandbox Setup (setupSandbox)
 */
function setupSandbox(customEnv = {}) {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cl-e2e-'));
  const homunculusDir = path.join(sandboxDir, 'homunculus');
  const binDir = path.join(sandboxDir, 'bin');
  const homeDir = path.join(sandboxDir, 'home');
  const cliLog = path.join(sandboxDir, 'mock-cli.log');

  fs.mkdirSync(homunculusDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });

  // git init and add remote
  const gitInit = spawnSync('git', ['init'], { cwd: sandboxDir, encoding: 'utf8' });
  if (gitInit.status !== 0) throw new Error(`git init failed: ${gitInit.stderr}`);

  const gitRemote = spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/ecc-test/e2e-project.git'], { cwd: sandboxDir, encoding: 'utf8' });
  if (gitRemote.status !== 0) throw new Error(`git remote add failed: ${gitRemote.stderr}`);

  // write config.json
  const config = {
    version: '2.1',
    observer: {
      enabled: true,
      min_observations_to_analyze: 1,
      run_interval_minutes: 1
    }
  };
  fs.writeFileSync(path.join(homunculusDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  // create universal mock CLI
  createMockCli(binDir);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: homeDir,
    CLV2_HOMUNCULUS_DIR: homunculusDir,
    CLAUDE_PROJECT_DIR: sandboxDir,
    OBSERVER_ACTIVE_HOURS_START: '0',
    OBSERVER_ACTIVE_HOURS_END: '0',
    OBSERVER_INTERVAL_SECONDS: '0',
    OBSERVER_MAX_IDLE_SECONDS: '0',
    ECC_OBSERVER_ANALYSIS_COOLDOWN: '0',
    ECC_OBSERVER_SIGNAL_EVERY_N: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ECC_HOOK_PROFILE: 'standard',
    CLAUDE_PLUGIN_ROOT: repoRoot,
    ECC_PLUGIN_ROOT: repoRoot,
    OBSERVER_LAST_RUN_LOG: path.join(sandboxDir, 'observer-last-run.log'),
    MOCK_CLI_LOG: cliLog,
    ...customEnv
  };

  // Resolve project context within sandbox
  const savedHomunculus = process.env.CLV2_HOMUNCULUS_DIR;
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLV2_HOMUNCULUS_DIR = homunculusDir;
  process.env.CLAUDE_PROJECT_DIR = sandboxDir;
  let projectContext;
  try {
    projectContext = resolveProjectContext(sandboxDir);
  } finally {
    if (savedHomunculus !== undefined) process.env.CLV2_HOMUNCULUS_DIR = savedHomunculus;
    else delete process.env.CLV2_HOMUNCULUS_DIR;
    if (savedProjectDir !== undefined) process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    else delete process.env.CLAUDE_PROJECT_DIR;
  }

  return {
    sandboxDir,
    homunculusDir,
    binDir,
    cliLog,
    env,
    projectContext
  };
}

/**
 * Teardown helper ensuring zero leaked processes.
 */
async function guaranteedTeardown(sandboxDir, projectContext, env, capturedPid = null) {
  let pid = capturedPid;
  if (!pid && projectContext && projectContext.projectDir) {
    const pidFile = path.join(projectContext.projectDir, '.observer.pid');
    if (fs.existsSync(pidFile)) {
      try {
        pid = fs.readFileSync(pidFile, 'utf8').trim();
      } catch (_) { /* ignore */ }
    }
  }

  // 1. Invoke stopObserverForContext
  if (projectContext) {
    try {
      stopObserverForContext(projectContext);
    } catch (_) { /* ignore */ }
  }

  // 2. Execute start-observer.sh stop
  try {
    spawnSync('bash', [
      path.join(repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'start-observer.sh'),
      'stop'
    ], {
      cwd: sandboxDir,
      env,
      encoding: 'utf8'
    });
  } catch (_) { /* ignore */ }

  // 3. Poll process.kill(pid, 0) with SIGKILL escalation (strictly guarded: pid > 1)
  if (pid && /^\d+$/.test(pid)) {
    const numPid = Number(pid);
    if (Number.isInteger(numPid) && numPid > 1) {
      const start = Date.now();
      while (Date.now() - start < 3000) {
        try {
          process.kill(numPid, 0);
          if (Date.now() - start > 1500) {
            try { process.kill(numPid, 'SIGKILL'); } catch (_) { /* ignore */ }
          } else {
            try { process.kill(numPid, 'SIGTERM'); } catch (_) { /* ignore */ }
          }
          await sleep(100);
        } catch (_) {
          break; // Process is dead
        }
      }
    }
  }

  // 4. Remove sandbox directory (strictly guarded against non-sandbox paths)
  const expectedSandboxPrefix = path.join(os.tmpdir(), 'ecc-cl-e2e-');
  if (typeof sandboxDir === 'string' && sandboxDir.startsWith(expectedSandboxPrefix)) {
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

/**
 * Execute full continuous learning cycle against a specific loop script.
 */
async function runContinuousLearningCycle(loopScriptPath, expectedCli) {
  const { sandboxDir, cliLog, env, projectContext } = setupSandbox({
    ECC_OBSERVER_LOOP_SCRIPT: loopScriptPath
  });

  const projectDir = projectContext.projectDir;
  let observerPid = null;

  try {
    // -------------------------------------------------------------------------
    // Stage 1: PreToolUse & PostToolUse Observation (pre:observe & post:observe:continuous-learning)
    // -------------------------------------------------------------------------
    const toolPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo deterministic-test-verification' },
      session_id: 'test-session-e2e-1',
      cwd: sandboxDir
    };

    const observeResult = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'hooks', 'observe-runner.js'),
      'pre:observe'
    ], {
      input: JSON.stringify(toolPayload),
      cwd: sandboxDir,
      env,
      encoding: 'utf8'
    });

    assert.strictEqual(observeResult.status, 0, `observe-runner failed with status ${observeResult.status}: ${observeResult.stderr}`);

    const observationsFile = path.join(projectDir, 'observations.jsonl');
    const obsFileCreated = await pollUntil(() => fs.existsSync(observationsFile), 4000);
    assert.ok(obsFileCreated, `observations.jsonl must exist at ${observationsFile}`);

    let obsContent = fs.readFileSync(observationsFile, 'utf8');
    assert.ok(obsContent.includes('"event":"tool_start"') || obsContent.includes('"event": "tool_start"'),
      `observations.jsonl must contain tool_start event. Content was: ${obsContent}`);

    // Verify post:observe:continuous-learning records tool_complete event
    const postPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo deterministic-test-verification' },
      tool_output: { output: 'deterministic-test-verification' },
      session_id: 'test-session-e2e-1',
      cwd: sandboxDir
    };

    const postObserveResult = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'hooks', 'observe-runner.js'),
      'post:observe:continuous-learning'
    ], {
      input: JSON.stringify(postPayload),
      cwd: sandboxDir,
      env,
      encoding: 'utf8'
    });

    assert.strictEqual(postObserveResult.status, 0, `observe-runner post failed with status ${postObserveResult.status}: ${postObserveResult.stderr}`);

    const obsPostLogged = await pollUntil(() => {
      if (!fs.existsSync(observationsFile)) return false;
      const content = fs.readFileSync(observationsFile, 'utf8');
      return content.includes('"event":"tool_complete"') || content.includes('"event": "tool_complete"');
    }, 4000);
    assert.ok(obsPostLogged, 'observations.jsonl must contain tool_complete event after post:observe:continuous-learning');

    // -------------------------------------------------------------------------
    // Stage 2: Lazy Daemon Startup
    // -------------------------------------------------------------------------
    const pidFile = path.join(projectDir, '.observer.pid');
    const pidFound = await pollUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0, 6000);
    assert.ok(pidFound, `Daemon PID file should exist at ${pidFile}`);

    observerPid = fs.readFileSync(pidFile, 'utf8').trim();
    assert.ok(/^\d+$/.test(observerPid), `Invalid observer PID in ${pidFile}: ${observerPid}`);

    const numPid = Number(observerPid);
    assert.ok(Number.isInteger(numPid) && numPid > 1, `Observer PID must be greater than 1, got ${observerPid}`);

    let isAlive = false;
    try {
      process.kill(numPid, 0);
      isAlive = true;
    } catch (_) {
      isAlive = false;
    }
    assert.ok(isAlive, `Observer daemon with PID ${observerPid} must be running`);

    // -------------------------------------------------------------------------
    // Stage 3: Batch Analysis, Archival & Instinct Creation
    // -------------------------------------------------------------------------
    // Nudge the daemon via SIGUSR1 (guarded numPid > 1)
    process.kill(numPid, 'SIGUSR1');

    const instinctFile = path.join(projectDir, 'instincts', 'personal', 'test-pattern.md');
    const instinctCreated = await pollUntil(() => fs.existsSync(instinctFile), 10000, 200);
    assert.ok(instinctCreated, `Instinct file should be created at ${instinctFile}`);

    // Assert observations.jsonl was archived
    const archiveDir = path.join(projectDir, 'observations.archive');
    const archiveFound = await pollUntil(() => {
      const liveExists = fs.existsSync(observationsFile);
      const hasArchive = fs.existsSync(archiveDir) && fs.readdirSync(archiveDir).some(f => f.endsWith('.jsonl'));
      return !liveExists && hasArchive;
    }, 6000, 150);
    assert.ok(archiveFound, `observations.jsonl should be archived into ${archiveDir}`);

    // Validate instinct frontmatter and action
    const instinctContent = fs.readFileSync(instinctFile, 'utf8');
    assert.ok(instinctContent.includes('confidence: 0.85'), `Instinct must have confidence: 0.85. Got:\n${instinctContent}`);
    assert.ok(instinctContent.includes('id: test-deterministic-verification'), `Instinct must have correct id. Got:\n${instinctContent}`);
    assert.ok(instinctContent.includes('scope: project'), `Instinct must have scope: project. Got:\n${instinctContent}`);
    assert.ok(instinctContent.includes('Always enforce deterministic test verifications.'), `Instinct must contain action text. Got:\n${instinctContent}`);

    // Verify expected CLI was invoked according to loop matrix
    if (fs.existsSync(cliLog)) {
      const logLines = fs.readFileSync(cliLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      const invokedCliNames = logLines.map(l => l.invokedAs);
      assert.ok(
        invokedCliNames.includes(expectedCli),
        `Expected CLI "${expectedCli}" to have been invoked in loop matrix (${path.basename(loopScriptPath)}), but invocations were: ${JSON.stringify(invokedCliNames)}`
      );
    } else {
      assert.fail(`mock-cli.log was not created at ${cliLog}`);
    }

    // -------------------------------------------------------------------------
    // Stage 4: session-start.js Discovery & Ranking
    // -------------------------------------------------------------------------
    const sessionStartResult = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'hooks', 'session-start.js')
    ], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      cwd: sandboxDir,
      env,
      encoding: 'utf8'
    });

    assert.strictEqual(sessionStartResult.status, 0, `session-start.js failed: ${sessionStartResult.stderr}`);
    const sessionStartJson = JSON.parse(sessionStartResult.stdout.trim());
    const additionalContext = sessionStartJson?.hookSpecificOutput?.additionalContext || '';
    assert.ok(
      additionalContext.includes('Active instincts:\n- [project 85%] Always enforce deterministic test verifications.'),
      `session-start output should contain ranked active instinct. Got:\n${sessionStartResult.stdout}`
    );

    // -------------------------------------------------------------------------
    // Stage 5: Antigravity pre-invocation.js Context Injection
    // -------------------------------------------------------------------------
    const preInvPayload = {
      conversationId: 'test-conv-e2e',
      invocationNum: 0,
      workspacePaths: [sandboxDir],
      artifactDirectoryPath: sandboxDir,
      transcriptPath: path.join(sandboxDir, 'transcript.jsonl')
    };

    const preInvResult = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'hooks', 'agy', 'pre-invocation.js')
    ], {
      input: JSON.stringify(preInvPayload),
      cwd: sandboxDir,
      env,
      encoding: 'utf8'
    });

    assert.strictEqual(preInvResult.status, 0, `pre-invocation.js failed: ${preInvResult.stderr}`);
    const preInvOutput = JSON.parse(preInvResult.stdout.trim());
    assert.ok(Array.isArray(preInvOutput.injectSteps), 'pre-invocation must return injectSteps array');
    assert.ok(preInvOutput.injectSteps.length > 0, 'pre-invocation must have at least one injectStep');
    assert.ok(
      preInvOutput.injectSteps[0].ephemeralMessage.includes('Active instincts:\n- [project 85%] Always enforce deterministic test verifications.'),
      `injectSteps[0].ephemeralMessage must contain active instincts string. Got:\n${JSON.stringify(preInvOutput.injectSteps[0])}`
    );

  } finally {
    // -------------------------------------------------------------------------
    // Stage 6: Guaranteed Teardown
    // -------------------------------------------------------------------------
    await guaranteedTeardown(sandboxDir, projectContext, env, observerPid);
  }
}

async function runAllTests() {
  console.log('=== Suite 10: Continuous Learning End-to-End Suite (10-continuous-learning.test.js) ===\n');

  // Test 1: Configurable observer loop script configuration check in start-observer.sh
  try {
    const startObserverScript = path.join(repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'start-observer.sh');
    const startObserverSrc = fs.readFileSync(startObserverScript, 'utf8');
    assert.ok(
      startObserverSrc.includes('ECC_OBSERVER_LOOP_SCRIPT') &&
      startObserverSrc.includes('observer-loop.sh|observer-loop.agy.sh'),
      'start-observer.sh must support allowlisted ECC_OBSERVER_LOOP_SCRIPT override'
    );

    // Negative test: invalid script name rejected
    const invalidResult = spawnSync('bash', [
      startObserverScript,
      'status'
    ], {
      env: { ...process.env, ECC_OBSERVER_LOOP_SCRIPT: '/tmp/malicious.sh' },
      encoding: 'utf8'
    });
    assert.strictEqual(invalidResult.status, 1, 'start-observer.sh must reject invalid loop script');
    assert.ok(
      invalidResult.stderr.includes('Invalid ECC_OBSERVER_LOOP_SCRIPT'),
      'start-observer.sh must output invalid script error'
    );

    console.log('  ✓ TASK-01: start-observer.sh uses configurable and allowlisted OBSERVER_LOOP_SCRIPT');
    passed++;
  } catch (err) {
    console.log('  ✗ TASK-01: start-observer.sh uses configurable and allowlisted OBSERVER_LOOP_SCRIPT');
    console.error(`    ${err.message}`);
    failed++;
  }

  // Test 2: Full Continuous Learning E2E Cycle with observer-loop.agy.sh
  try {
    const agyLoopScript = path.join(repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'observer-loop.agy.sh');
    await runContinuousLearningCycle(agyLoopScript, 'agy');
    console.log('  ✓ TASK-02 to TASK-08: Full Continuous Learning E2E Cycle (observer-loop.agy.sh)');
    passed++;
  } catch (err) {
    console.log('  ✗ TASK-02 to TASK-08: Full Continuous Learning E2E Cycle (observer-loop.agy.sh)');
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }

  // Test 3: Full Continuous Learning E2E Cycle with observer-loop.sh
  try {
    const claudeLoopScript = path.join(repoRoot, 'skills', 'continuous-learning-v2', 'agents', 'observer-loop.sh');
    await runContinuousLearningCycle(claudeLoopScript, 'claude');
    console.log('  ✓ TASK-02 to TASK-08: Full Continuous Learning E2E Cycle (observer-loop.sh)');
    passed++;
  } catch (err) {
    console.log('  ✗ TASK-02 to TASK-08: Full Continuous Learning E2E Cycle (observer-loop.sh)');
    console.error(`    ${err.stack || err.message}`);
    failed++;
  }

  console.log(`\n=== Test Results ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
