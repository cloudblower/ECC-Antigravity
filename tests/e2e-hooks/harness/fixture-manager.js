'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const LLMJudge = require('./llm-judge');

const { assertSafeDir: agyAssertSafeDir, isSamePath } = require('../../../scripts/hooks/agy/agy-adapter');

function assertSafeDir(dirPath, label = 'Directory', options = {}) {
  agyAssertSafeDir(dirPath, label, options);
}

function assertSafeSandboxDir(sandboxDir, options = {}) {
  assertSafeDir(sandboxDir, 'Sandbox directory', options);
  const isWinPath = process.platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(sandboxDir);
  const pathMod = options.path || (isWinPath ? path.win32 : path);
  const resolved = pathMod.resolve(sandboxDir);
  const repoRoot = pathMod.resolve(__dirname, '../../..');

  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch (_) {
    // Best-effort realpath
  }

  if (isSamePath(resolved, repoRoot, pathMod) || isSamePath(realResolved, repoRoot, pathMod) || resolved === repoRoot) {
    throw new Error(`Unsafe sandbox directory: "${sandboxDir}" cannot be the repository root`);
  }

  if (isSamePath(resolved, os.homedir(), pathMod) || isSamePath(realResolved, os.homedir(), pathMod) || resolved === os.homedir()) {
    throw new Error(`Unsafe sandbox directory: "${sandboxDir}" is a protected system or home directory`);
  }
}

const E2E_REQUIRED_SKILLS = [
  'continuous-learning',
  'continuous-learning-v2',
  'tdd-workflow'
];

function seedSandbox(sandboxDir) {
  assertSafeSandboxDir(sandboxDir);
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  const agentsDir = path.join(sandboxDir, '.agents');
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  // 1. Ensure scripts symlink / directory exists and points to repo scripts
  const repoScripts = path.resolve(__dirname, '../../../scripts');
  const scriptsLink = path.join(sandboxDir, 'scripts');
  const agentsScripts = path.join(sandboxDir, '.agents', 'scripts');

  if (fs.existsSync(repoScripts)) {
    try {
      if (fs.existsSync(agentsScripts)) {
        const stats = fs.lstatSync(agentsScripts);
        if (!stats.isSymbolicLink()) {
          fs.rmSync(agentsScripts, { recursive: true, force: true });
        }
      }
      if (!fs.existsSync(agentsScripts)) {
        try {
          fs.symlinkSync(repoScripts, agentsScripts);
        } catch (_) {
          fs.cpSync(repoScripts, agentsScripts, { recursive: true });
        }
      }
    } catch (_) {
      try {
        fs.cpSync(repoScripts, agentsScripts, { recursive: true });
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (!fs.existsSync(scriptsLink)) {
    const target = fs.existsSync(repoScripts) ? repoScripts : agentsScripts;
    if (fs.existsSync(target)) {
      try {
        fs.symlinkSync(target, scriptsLink);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Ensure .agents/skills is a real directory containing only E2E-required skills
  // to stay well under Antigravity language_server's 20k-token customization budget.
  const repoSkills = path.resolve(__dirname, '../../../skills');
  const skillsLink = path.join(sandboxDir, 'skills');
  const agentsSkills = path.join(sandboxDir, '.agents', 'skills');

  if (fs.existsSync(repoSkills)) {
    try {
      const stats = fs.lstatSync(agentsSkills);
      if (stats.isSymbolicLink()) {
        fs.unlinkSync(agentsSkills);
      } else {
        fs.rmSync(agentsSkills, { recursive: true, force: true });
      }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        try {
          fs.rmSync(agentsSkills, { recursive: true, force: true });
        } catch (_) {
          /* ignore */
        }
      }
    }

    fs.mkdirSync(agentsSkills, { recursive: true });

    for (const skillName of E2E_REQUIRED_SKILLS) {
      const srcSkill = path.join(repoSkills, skillName);
      const destSkill = path.join(agentsSkills, skillName);
      if (!fs.existsSync(srcSkill)) continue;

      try {
        fs.symlinkSync(srcSkill, destSkill, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (_) {
        try {
          fs.cpSync(srcSkill, destSkill, { recursive: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  if (!fs.existsSync(skillsLink)) {
    const target = fs.existsSync(agentsSkills) ? agentsSkills : repoSkills;
    if (fs.existsSync(target)) {
      try {
        fs.symlinkSync(target, skillsLink);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // 2. Ensure package.json exists with dev server script
  const pkgPath = path.join(sandboxDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const pkgContent = {
      name: 'ecc-antigravity-test-sandbox',
      version: '1.0.0',
      description: 'E2E test sandbox for Antigravity hooks',
      main: 'index.js',
      scripts: {
        dev: 'node -e \'console.log("dev server running")\'',
        build: 'node -e \'console.log("build complete")\'',
        test: 'node -e \'console.log("test complete")\''
      }
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkgContent, null, 2) + '\n', 'utf8');
  }

  // 3. Ensure index.js exists
  const indexPath = path.join(sandboxDir, 'index.js');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, '// Test sandbox entry point\nmodule.exports = { name: "sandbox" };\n', 'utf8');
  }

  // 4. Ensure docs/guide.md exists
  const docsDir = path.join(sandboxDir, 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  const guidePath = path.join(docsDir, 'guide.md');
  if (!fs.existsSync(guidePath)) {
    fs.writeFileSync(guidePath, '# Guide\nDocumentation for test project.\n', 'utf8');
  }

  // 5. Ensure .claude.json exists for config-protection testing
  const claudeJsonPath = path.join(sandboxDir, '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ allowedTools: ['Bash', 'Write', 'Edit'] }, null, 2) + '\n', 'utf8');
  }

  return {
    scriptsLink,
    pkgPath,
    indexPath,
    guidePath,
    claudeJsonPath
  };
}

function writeHookEnv(sandboxDir, envMap = {}) {
  assertSafeSandboxDir(sandboxDir);
  const hookEnvPath = path.join(sandboxDir, '.ecc-hook-env.json');
  const merged = { ECC_E2E_TEST_SANDBOX: 'true', ...envMap };
  fs.writeFileSync(hookEnvPath, JSON.stringify(merged, null, 2), 'utf8');
}

function cleanHookEnv(sandboxDir) {
  assertSafeSandboxDir(sandboxDir);
  const hookEnvPath = path.join(sandboxDir, '.ecc-hook-env.json');
  if (fs.existsSync(hookEnvPath)) {
    try { fs.unlinkSync(hookEnvPath); } catch (_) { /* ignore */ }
  }
}

function cleanSandbox(sandboxDir) {
  assertSafeSandboxDir(sandboxDir);
  cleanHookEnv(sandboxDir);
  // Re-seed clean versions of edited files
  const indexPath = path.join(sandboxDir, 'index.js');
  if (fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, '// Test sandbox entry point\nmodule.exports = { name: "sandbox" };\n', 'utf8');
  }

  const guidePath = path.join(sandboxDir, 'docs', 'guide.md');
  if (fs.existsSync(guidePath)) {
    fs.writeFileSync(guidePath, '# Guide\nDocumentation for test project.\n', 'utf8');
  }

  // Reset .claude.json to default allowed tools
  const claudeJsonPath = path.join(sandboxDir, '.claude.json');
  fs.writeFileSync(claudeJsonPath, JSON.stringify({ allowedTools: ['Bash', 'Write', 'Edit'] }, null, 2) + '\n', 'utf8');

  // Clean transient logs
  const transientLogs = [
    path.join(sandboxDir, '.agents', 'hooks-execution.log'),
    path.join(sandboxDir, '.agents', 'agy-warning-buffer.jsonl'),
    path.join(sandboxDir, 'agy-warning-buffer.jsonl')
  ];
  for (const logFile of transientLogs) {
    if (fs.existsSync(logFile)) {
      try { fs.unlinkSync(logFile); } catch (_) { /* ignore */ }
    }
  }
}

function getHookLogs(sandboxDir, sinceTimestamp = null) {
  assertSafeDir(sandboxDir, 'Sandbox directory');
  const logFile = path.join(sandboxDir, '.agents', 'hooks-execution.log');
  if (!fs.existsSync(logFile)) return [];

  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (sinceTimestamp) {
        const itemTime = new Date(parsed.timestamp).getTime();
        const sinceTime = new Date(sinceTimestamp).getTime();
        if (itemTime < sinceTime) continue;
      }
      events.push(parsed);
    } catch (_) {
      // Ignore unparseable lines
    }
  }

  return events;
}

function findLastDenial(sandboxDir, sinceTimestamp = null) {
  const logs = getHookLogs(sandboxDir, sinceTimestamp);
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (entry.result && entry.result.decision === 'deny') {
      return entry;
    }
  }
  return null;
}

function findHookEvents(sandboxDir, hookName, sinceTimestamp = null) {
  const logs = getHookLogs(sandboxDir, sinceTimestamp);
  return logs.filter(entry => entry.hook === hookName);
}

function readWarningBuffer(artifactDir) {
  if (!artifactDir) return [];
  assertSafeDir(artifactDir, 'Artifact directory');
  const bufferPath = path.join(artifactDir, 'agy-warning-buffer.jsonl');
  if (!fs.existsSync(bufferPath)) return [];
  try {
    const raw = fs.readFileSync(bufferPath, 'utf8');
    return raw
      .split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readEditedAccumulator(options = {}) {
  const opts = typeof options === 'string' ? { sessionId: options } : (options || {});
  const tmpDir = opts.tmpDir || os.tmpdir();
  assertSafeDir(tmpDir, 'Temp directory', { allowTmp: true });

  if (opts.sessionId) {
    const baseSessionId = path.basename(String(opts.sessionId));
    const safeSessionId = baseSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const targetFile = path.join(tmpDir, `ecc-edited-${safeSessionId}.txt`);
    if (fs.existsSync(targetFile)) {
      try {
        return fs.readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(line => line.trim());
      } catch {
        return [];
      }
    }
  }

  if (opts.cwd) {
    const hash = crypto.createHash('sha1').update(opts.cwd).digest('hex').slice(0, 12);
    const targetFile = path.join(tmpDir, `ecc-edited-${hash}.txt`);
    if (fs.existsSync(targetFile)) {
      try {
        return fs.readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(line => line.trim());
      } catch {
        return [];
      }
    }
  }

  // Fallback: search for any ecc-edited-*.txt files in tmpDir
  try {
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('ecc-edited-') && f.endsWith('.txt'));
    if (files.length > 0) {
      files.sort((a, b) => {
        const statA = fs.statSync(path.join(tmpDir, a));
        const statB = fs.statSync(path.join(tmpDir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });
      const latestFile = path.join(tmpDir, files[0]);
      return fs.readFileSync(latestFile, 'utf8').split(/\r?\n/).filter(line => line.trim());
    }
  } catch { /* ignore */ }

  return [];
}

function readMetricsBridge(sessionId, options = {}) {
  const opts = options || {};
  const tmpDir = opts.tmpDir || os.tmpdir();
  assertSafeDir(tmpDir, 'Temp directory', { allowTmp: true });

  if (sessionId) {
    const baseSessionId = path.basename(String(sessionId));
    const safeSessionId = baseSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const bridgePath = path.join(tmpDir, `ecc-metrics-${safeSessionId}.json`);
    if (fs.existsSync(bridgePath)) {
      try {
        return JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
      } catch {
        return null;
      }
    }
  }

  // Fallback: find latest ecc-metrics-*.json that does not end in .tmp
  try {
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('ecc-metrics-') && f.endsWith('.json'));
    if (files.length > 0) {
      files.sort((a, b) => {
        const statA = fs.statSync(path.join(tmpDir, a));
        const statB = fs.statSync(path.join(tmpDir, b));
        return statB.mtimeMs - statA.mtimeMs;
      });
      const latestFile = path.join(tmpDir, files[0]);
      return JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    }
  } catch { /* ignore */ }

  return null;
}

function readSessionActivityLogs(options = {}) {
  const opts = typeof options === 'string' ? { claudeDir: options } : (options || {});
  const baseDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  assertSafeDir(baseDir, 'Claude directory');
  const candidatePaths = [
    path.join(baseDir, 'metrics', 'tool-usage.jsonl'),
    path.join(baseDir, 'tool-usage.jsonl')
  ];

  let targetFile = null;
  for (const cp of candidatePaths) {
    if (fs.existsSync(cp)) {
      targetFile = cp;
      break;
    }
  }

  if (!targetFile) return [];

  try {
    const lines = fs.readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(line => line.trim());
    const events = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (opts.sinceTimestamp && parsed.timestamp) {
          const itemTime = new Date(parsed.timestamp).getTime();
          const sinceTime = new Date(opts.sinceTimestamp).getTime();
          if (itemTime < sinceTime) continue;
        }
        events.push(parsed);
      } catch { /* ignore */ }
    }
    return events;
  } catch {
    return [];
  }
}

function readCommandLogs(options = {}) {
  const opts = typeof options === 'string' ? { mode: options } : (options || {});
  const mode = opts.mode || 'audit';
  const baseDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  assertSafeDir(baseDir, 'Claude directory');
  const fileName = mode === 'cost' ? 'cost-tracker.log' : 'bash-commands.log';
  const targetFile = path.join(baseDir, fileName);

  if (!fs.existsSync(targetFile)) return [];

  try {
    const lines = fs.readFileSync(targetFile, 'utf8').split(/\r?\n/).filter(line => line.trim());
    if (opts.sinceTimestamp) {
      return lines.filter(line => {
        const match = line.match(/^\[(.*?)\]/);
        if (match) {
          const itemTime = new Date(match[1]).getTime();
          const sinceTime = new Date(opts.sinceTimestamp).getTime();
          return itemTime >= sinceTime;
        }
        return true;
      });
    }
    return lines;
  } catch {
    return [];
  }
}

function findSessionEndTimers(options = {}) {
  const opts = typeof options === 'string' ? { timerDir: options } : (options || {});
  const timerDir = opts.timerDir || path.join(os.homedir(), '.gemini', 'antigravity', 'session-timers');
  assertSafeDir(timerDir, 'Timer directory');

  if (!fs.existsSync(timerDir)) return [];

  try {
    const files = fs.readdirSync(timerDir).filter(f => f.endsWith('.json'));
    const timers = [];
    for (const f of files) {
      try {
        const safeFile = path.basename(f);
        const parsed = JSON.parse(fs.readFileSync(path.join(timerDir, safeFile), 'utf8'));
        timers.push(parsed);
      } catch { /* ignore */ }
    }
    return timers;
  } catch {
    return [];
  }
}

function cleanSessionEndTimers(options = {}) {
  const opts = typeof options === 'string' ? { timerDir: options } : (options || {});
  const timerDir = opts.timerDir || path.join(os.homedir(), '.gemini', 'antigravity', 'session-timers');
  assertSafeDir(timerDir, 'Timer directory');

  if (!fs.existsSync(timerDir)) return 0;

  let cleaned = 0;
  try {
    const files = fs.readdirSync(timerDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const safeFile = path.basename(f);
      const filePath = path.join(timerDir, safeFile);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const state = JSON.parse(raw);
        if (state.pid && Number.isInteger(state.pid) && state.pid > 0) {
          try {
            process.kill(state.pid, 0);
            process.kill(state.pid, 'SIGTERM');
          } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
      try {
        fs.unlinkSync(filePath);
        cleaned++;
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return cleaned;
}

function redactDeep(val) {
  if (typeof val === 'string') {
    return LLMJudge.redactSecrets(val);
  }
  if (Array.isArray(val)) {
    return val.map(redactDeep);
  }
  if (val && typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = redactDeep(v);
    }
    return res;
  }
  return val;
}

function collectSuiteSideEffects(sandboxDir, options = {}) {
  assertSafeSandboxDir(sandboxDir);

  const opts = options || {};
  if (opts.claudeDir) {
    assertSafeDir(opts.claudeDir, 'Claude directory');
  }
  if (opts.timerDir) {
    assertSafeDir(opts.timerDir, 'Timer directory');
  }
  const warningDirs = [];
  if (opts.artifactDir) {
    assertSafeDir(opts.artifactDir, 'Artifact directory');
    warningDirs.push(opts.artifactDir);
  }
  if (process.env.ECC_E2E_ARTIFACTS_DIR && !warningDirs.includes(process.env.ECC_E2E_ARTIFACTS_DIR)) {
    try {
      assertSafeDir(process.env.ECC_E2E_ARTIFACTS_DIR, 'Artifact directory');
      warningDirs.push(process.env.ECC_E2E_ARTIFACTS_DIR);
    } catch (_) { /* ignore */ }
  }
  if (sandboxDir && !warningDirs.includes(sandboxDir)) {
    warningDirs.push(sandboxDir);
  }

  const warningBuffer = Array.isArray(opts.warningBuffer) ? [...opts.warningBuffer] : [];
  for (const d of warningDirs) {
    try {
      const entries = readWarningBuffer(d);
      if (Array.isArray(entries) && entries.length > 0) {
        warningBuffer.push(...entries);
      }
    } catch (_) { /* ignore */ }
  }

  const hookLogs = getHookLogs(sandboxDir, opts.sinceTimestamp);
  const editedAccumulator = readEditedAccumulator({
    sessionId: opts.sessionId,
    cwd: sandboxDir,
    tmpDir: opts.tmpDir
  });
  const metricsBridge = readMetricsBridge(opts.sessionId, { tmpDir: opts.tmpDir });

  const allActivityLogs = readSessionActivityLogs({
    claudeDir: opts.claudeDir,
    sinceTimestamp: opts.sinceTimestamp
  });
  const activityLogs = allActivityLogs.slice(-20);

  const allCommandLogs = readCommandLogs({
    mode: opts.commandLogMode || 'audit',
    claudeDir: opts.claudeDir,
    sinceTimestamp: opts.sinceTimestamp
  });
  const commandLogs = allCommandLogs.slice(-20);

  const sessionTimers = findSessionEndTimers({ timerDir: opts.timerDir });

  const observations = readObservationLogs(sandboxDir, {
    claudeDir: opts.claudeDir,
    sinceMs: opts.sinceMs,
    sinceTimestamp: opts.sinceTimestamp
  });

  const governanceLogs = readGovernanceLogs(sandboxDir, {
    warningBuffer,
    artifactDir: opts.artifactDir,
    sinceMs: opts.sinceMs,
    sinceTimestamp: opts.sinceTimestamp
  });

  const mcpHealthCache = readMcpHealthCache({ claudeDir: opts.claudeDir });

  const skillRuns = readSkillRunsLog({
    claudeDir: opts.claudeDir,
    sinceMs: opts.sinceMs,
    sinceTimestamp: opts.sinceTimestamp
  });

  const costMetrics = readCostMetricsLog({
    claudeDir: opts.claudeDir,
    sinceMs: opts.sinceMs,
    sinceTimestamp: opts.sinceTimestamp
  });

  const rawBundle = {
    collectedAt: new Date().toISOString(),
    sandboxDir,
    hookLogs,
    warningBuffer,
    editedAccumulator,
    metricsBridge,
    activityLogs,
    commandLogs,
    sessionTimers,
    observations,
    governanceLogs,
    mcpHealthCache,
    skillRuns,
    costMetrics,
    extra: opts.extra || {}
  };

  return redactDeep(rawBundle);
}

function readObservationLogs(sandboxDir, options = {}) {
  const opts = options || {};
  const claudeDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  assertSafeDir(claudeDir, 'Claude directory');

  const homunculusDirs = [];
  if (opts.homunculusDir) {
    assertSafeDir(opts.homunculusDir, 'Homunculus directory');
    homunculusDirs.push(opts.homunculusDir);
  } else if (opts.claudeDir) {
    homunculusDirs.push(path.join(opts.claudeDir, 'homunculus'));
  } else {
    const candidates = [
      process.env.CLV2_HOMUNCULUS_DIR,
      process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'ecc-homunculus') : null,
      path.join(os.homedir(), '.local', 'share', 'ecc-homunculus'),
      path.join(claudeDir, 'homunculus')
    ].filter(Boolean);

    for (const cand of candidates) {
      if (fs.existsSync(cand) && !homunculusDirs.includes(cand)) {
        homunculusDirs.push(cand);
      }
    }
  }

  const filesToRead = [];
  for (const homunculusDir of homunculusDirs) {
    const projectsDir = path.join(homunculusDir, 'projects');
    if (fs.existsSync(projectsDir)) {
      try {
        const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        for (const d of dirs) {
          if (d.isDirectory()) {
            const obsFile = path.join(projectsDir, d.name, 'observations.jsonl');
            if (fs.existsSync(obsFile)) {
              filesToRead.push(obsFile);
            }
          }
        }
      } catch (_) { /* ignore */ }
    }

    const globalObsFile = path.join(homunculusDir, 'observations.jsonl');
    if (fs.existsSync(globalObsFile)) {
      filesToRead.push(globalObsFile);
    }
  }

  const results = [];
  const sinceMs = opts.sinceMs !== undefined ? Number(opts.sinceMs) : (opts.sinceTimestamp ? new Date(opts.sinceTimestamp).getTime() : null);

  for (const file of filesToRead) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/).filter(line => line.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (sinceMs !== null) {
            let entryTs = null;
            if (entry.timestamp) {
              entryTs = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
            }
            if (entryTs !== null && !isNaN(entryTs) && entryTs < sinceMs) {
              continue;
            }
          }
          results.push(entry);
        } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
  }

  return results;
}

function readGovernanceLogs(sandboxDir, options = {}) {
  const opts = options || {};
  let warningEntries = opts.warningBuffer;
  if (!warningEntries) {
    warningEntries = readWarningBuffer(sandboxDir);
    if (opts.artifactDir) {
      warningEntries = warningEntries.concat(readWarningBuffer(opts.artifactDir));
    }
  }

  const events = [];
  const sinceMs = opts.sinceMs !== undefined ? Number(opts.sinceMs) : (opts.sinceTimestamp ? new Date(opts.sinceTimestamp).getTime() : null);

  for (const w of (warningEntries || [])) {
    const text = String(w.message || w.warning || '');
    const match = text.match(/\[governance\]\s*(\{.*\})/);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (sinceMs !== null && parsed.timestamp) {
          const entryTs = typeof parsed.timestamp === 'number' ? parsed.timestamp : new Date(parsed.timestamp).getTime();
          if (!isNaN(entryTs) && entryTs < sinceMs) continue;
        }
        events.push(parsed);
      } catch (_) { /* ignore */ }
    }
  }

  if (opts.governanceLogPath) {
    assertSafeDir(path.dirname(path.resolve(opts.governanceLogPath)), 'Governance log directory');
    if (fs.existsSync(opts.governanceLogPath)) {
      try {
        const content = fs.readFileSync(opts.governanceLogPath, 'utf8');
        for (const line of content.split(/\r?\n/).filter(l => l.trim())) {
          try {
            const parsed = JSON.parse(line);
            events.push(parsed);
          } catch (_) { /* ignore */ }
        }
      } catch (_) { /* ignore */ }
    }
  }

  return events;
}

function readMcpHealthCache(options = {}) {
  const opts = options || {};
  const claudeDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  assertSafeDir(claudeDir, 'Claude directory');
  const cachePath = path.join(claudeDir, 'mcp-health-cache.json');
  if (!fs.existsSync(cachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function readSkillRunsLog(options = {}) {
  const opts = options || {};
  const claudeDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  assertSafeDir(claudeDir, 'Claude directory');
  const runsPath = path.join(claudeDir, 'state', 'skill-runs.jsonl');
  if (!fs.existsSync(runsPath)) return [];

  const results = [];
  const sinceMs = opts.sinceMs !== undefined ? Number(opts.sinceMs) : (opts.sinceTimestamp ? new Date(opts.sinceTimestamp).getTime() : null);

  try {
    const content = fs.readFileSync(runsPath, 'utf8');
    for (const line of content.split(/\r?\n/).filter(l => l.trim())) {
      try {
        const entry = JSON.parse(line);
        if (sinceMs !== null && entry.timestamp) {
          const entryTs = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
          if (!isNaN(entryTs) && entryTs < sinceMs) continue;
        }
        results.push(entry);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  return results;
}

function readCostMetricsLog(options = {}) {
  const opts = options || {};
  const claudeDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  assertSafeDir(claudeDir, 'Claude directory');
  const costsPath = path.join(claudeDir, 'metrics', 'costs.jsonl');
  if (!fs.existsSync(costsPath)) return [];

  const results = [];
  const sinceMs = opts.sinceMs !== undefined ? Number(opts.sinceMs) : (opts.sinceTimestamp ? new Date(opts.sinceTimestamp).getTime() : null);

  try {
    const content = fs.readFileSync(costsPath, 'utf8');
    for (const line of content.split(/\r?\n/).filter(l => l.trim())) {
      try {
        const entry = JSON.parse(line);
        if (sinceMs !== null && entry.timestamp) {
          const entryTs = typeof entry.timestamp === 'number' ? entry.timestamp : new Date(entry.timestamp).getTime();
          if (!isNaN(entryTs) && entryTs < sinceMs) continue;
        }
        results.push(entry);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  return results;
}

module.exports = {
  assertSafeDir,
  assertSafeSandboxDir,
  seedSandbox,
  cleanSandbox,
  writeHookEnv,
  cleanHookEnv,
  getHookLogs,
  findLastDenial,
  findHookEvents,
  readWarningBuffer,
  readEditedAccumulator,
  readMetricsBridge,
  readSessionActivityLogs,
  readCommandLogs,
  readObservationLogs,
  readGovernanceLogs,
  readMcpHealthCache,
  readSkillRunsLog,
  readCostMetricsLog,
  findSessionEndTimers,
  cleanSessionEndTimers,
  collectSuiteSideEffects
};
