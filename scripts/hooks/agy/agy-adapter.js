'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { translateInput, translateOutput } = require('./schema-translate');
const {
  translateTranscriptLine,
  translateClaudeTranscriptLineToAgy,
  shimTranscriptPath,
  shimClaudeTranscriptToAgy,
  updateContextWindowEnvForModel
} = require('./transcript-shim');
const { normalizeStderr } = require('./stderr-normalizer');

const PROTECTED_SYSTEM_DIRS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/var'
];

const EXACT_ONLY_DIRS = new Set([
  '/',
  '/home',
  '/tmp'
]);

function assertSafeDir(dirPath, label = 'Directory') {
  if (!dirPath || typeof dirPath !== 'string') {
    throw new Error(`${label} must be a valid non-empty string`);
  }
  const resolved = path.resolve(dirPath);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new Error(`Unsafe ${label.toLowerCase()}: "${dirPath}" cannot be the filesystem root`);
  }
  if (EXACT_ONLY_DIRS.has(resolved)) {
    throw new Error(`Unsafe ${label.toLowerCase()}: "${dirPath}" is a protected system directory`);
  }
  for (const sysDir of PROTECTED_SYSTEM_DIRS) {
    if (resolved === sysDir || resolved.startsWith(sysDir + path.sep)) {
      throw new Error(`Unsafe ${label.toLowerCase()}: "${dirPath}" is a protected system directory`);
    }
  }
}

function redactLogSecrets(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/\bgh[pousr]_[a-zA-Z0-9]{16,}\b/g, 'ghp_[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)["']?\s*[:=]\s*["'])(?:[^"'\\]|\\.)*(["'])/gi, '$1[REDACTED]$2')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*=\s*)([^\s&]+)/gi, '$1[REDACTED]');
}

function setupEnvironment(agyPayload) {
  // Infer plugin root (assumes scripts/hooks/agy/agy-adapter.js)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '../../../');

  const conversationId = agyPayload.conversationId;

  // Explicit projectDir validation (fails fast if passed and unsafe)
  if (agyPayload && agyPayload.projectDir) {
    assertSafeDir(agyPayload.projectDir, 'Project directory');
  }

  const candidateDirs = [
    agyPayload.projectDir,
    (agyPayload.workspacePaths && agyPayload.workspacePaths.length > 0) ? agyPayload.workspacePaths[0] : null,
    agyPayload.toolCall?.args?.Cwd,
    agyPayload.toolCall?.args?.DirectoryPath,
    agyPayload.cwd,
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd()
  ].filter(Boolean);

  let projectDir = process.cwd();
  for (const dir of candidateDirs) {
    try {
      assertSafeDir(dir, 'Project directory');
      projectDir = dir;
      break;
    } catch (_) {
      // Continue searching for safe directory
    }
  }

  // Load .ecc-hook-env.json if present from candidate project directories
  for (const dir of candidateDirs) {
    try {
      assertSafeDir(dir, 'Project directory');
      const hookEnvFile = path.join(dir, '.ecc-hook-env.json');
      if (fs.existsSync(hookEnvFile)) {
        projectDir = dir;
        const raw = fs.readFileSync(hookEnvFile, 'utf8');
        const parsed = JSON.parse(raw);
        const isSandbox = parsed.ECC_E2E_TEST_SANDBOX === 'true' || parsed.ECC_E2E_TEST_SANDBOX === true;
        const whitelistRegex = /^(ECC_|COMPACT_|GATEGUARD_|CLAUDE_|TMUX$|MOCK_)/;
        for (const [key, val] of Object.entries(parsed)) {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
          if ((key === 'ECC_GATEGUARD' || key.startsWith('GATEGUARD_')) && !isSandbox) {
            continue;
          }
          if (whitelistRegex.test(key) && val !== undefined && val !== null) {
            process.env[key] = String(val);
          }
        }
        break;
      }
    } catch (_err) {
      // Inferred candidate is unsafe or inaccessible: safely continue to next candidate
      continue;
    }
  }
    
  const modelName = agyPayload.modelName || process.env.AGY_MODEL_NAME || process.env.ECC_OBSERVER_MODEL || 'gemini-3';
  process.env.AGY_MODEL_NAME = modelName;
  if (!process.env.CLAUDE_MODEL) {
    process.env.CLAUDE_MODEL = modelName;
  }
  updateContextWindowEnvForModel(modelName);

  let claudeTranscriptPath = '';
  if (agyPayload.transcriptPath) {
    const shadowPath = path.join(path.dirname(agyPayload.transcriptPath), 'claude-compat-transcript.jsonl');
    claudeTranscriptPath = shimTranscriptPath(agyPayload.transcriptPath, shadowPath, { model: modelName });
  }

  process.env.CLAUDE_SESSION_ID = conversationId;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_PLUGIN_ROOT = pluginRoot;
  process.env.CLAUDE_TRANSCRIPT_PATH = claudeTranscriptPath;
  process.env.ECC_MCP_CONFIG_PATH = path.join(require('os').homedir(), '.gemini/config/mcp_config.json');

  return {
    claudeSessionId: conversationId,
    claudeProjectDir: projectDir,
    claudePluginRoot: pluginRoot,
    claudeTranscriptPath,
    claudeModel: modelName
  };
}

function createHookMatcher(matcherStr) {
  try {
    return new RegExp(matcherStr === '*' ? '.*' : matcherStr, 'i');
  } catch (_error) {
    return { test: (val) => val === matcherStr };
  }
}

function executeHookCommand(hook, pluginRoot, inputObj, opts = {}) {
  const normalizedRoot = pluginRoot.replace(/\\/g, '/');
  const rawCmd = (hook.command || '').replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, normalizedRoot);
  const extraArgs = hook.args || [];
  const timeoutMs = hook.timeout ? hook.timeout * 1000 : 30000;
  const inputStr = typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj || {});
  const spawnEnv = { ...process.env, ...(opts.env || {}) };

  // 1. Check if command is `node -e '...'` or `node -e "..."`
  const nodeEvalSingle = rawCmd.match(/^node(?:\.exe)?\s+(?:--?\w+\s+)*-e\s+'([\s\S]*?)'(?:\s+([\s\S]*))?$/);
  const nodeEvalDouble = rawCmd.match(/^node(?:\.exe)?\s+(?:--?\w+\s+)*-e\s+"([\s\S]*?)"(?:\s+([\s\S]*))?$/);

  if (nodeEvalSingle || nodeEvalDouble) {
    const match = nodeEvalSingle || nodeEvalDouble;
    const code = match[1];
    const trailing = match[2] ? match[2].trim() : '';
    const trailingArgs = trailing ? trailing.split(/\s+/) : [];
    const fullArgs = ['-e', code, ...trailingArgs, ...extraArgs];

    return spawnSync(process.execPath, fullArgs, {
      shell: false,
      input: inputStr,
      env: spawnEnv,
      encoding: 'utf8',
      timeout: timeoutMs
    });
  }

  // 2. Check if command starts with `node ` or `node.exe ` without -e
  if (rawCmd.startsWith('node ') || rawCmd.startsWith('node.exe ')) {
    const scriptPart = rawCmd.replace(/^node(?:\.exe)?\s+/, '').trim();
    // Parse arguments respecting quotes for paths with spaces
    const parts = [];
    let current = '';
    let inQuote = null;
    for (const ch of scriptPart) {
      if ((ch === '"' || ch === "'") && !inQuote) { inQuote = ch; continue; }
      if (ch === inQuote) { inQuote = null; continue; }
      if (/\s/.test(ch) && !inQuote && current) { parts.push(current); current = ''; continue; }
      if (/\s/.test(ch) && !inQuote) continue;
      current += ch;
    }
    if (current) parts.push(current);
    const script = parts[0];
    if (!script) {
      return {
        status: 1,
        stdout: '',
        stderr: 'Invalid hook command: empty script path'
      };
    }
    const scriptArgs = parts.slice(1);
    const fullArgs = [script, ...scriptArgs, ...extraArgs];

    return spawnSync(process.execPath, fullArgs, {
      shell: false,
      input: inputStr,
      env: spawnEnv,
      encoding: 'utf8',
      timeout: timeoutMs
    });
  }

  // 3. Fallback: arbitrary command via shell
  // SECURITY NOTE: shell: true is required for non-Node commands (bash scripts, etc.).
  // pluginRoot is already normalized above to mitigate injection via path separators.
  // The rawCmd originates from hooks.json which is a trusted, user-controlled config file.
  return spawnSync(rawCmd, extraArgs, {
    shell: true,
    input: inputStr,
    env: spawnEnv,
    encoding: 'utf8',
    timeout: timeoutMs
  });
}

function bufferWarning(artifactDirectoryPath, warningText) {
  if (!warningText) return;
  const pluginRoot = path.resolve(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '../../../'));
  const targetDirs = [];

  const addSafeDir = (d) => {
    if (!d) return;
    const resolved = path.resolve(d);
    // Never write warning buffer to the plugin/repository root
    if (resolved === pluginRoot) return;
    if (!targetDirs.includes(resolved)) {
      targetDirs.push(resolved);
    }
  };

  addSafeDir(artifactDirectoryPath);
  addSafeDir(process.env.ECC_E2E_ARTIFACTS_DIR);
  addSafeDir(process.env.CLAUDE_PROJECT_DIR);

  if (targetDirs.length === 0) {
    // Skip writing when no specific artifact or sandbox project directory is configured
    return;
  }

  const sanitizedWarning = redactLogSecrets(warningText);

  for (const dir of targetDirs) {
    try {
      assertSafeDir(dir, 'Buffer directory');
      const bufferPath = path.join(dir, 'agy-warning-buffer.jsonl');
      fs.appendFileSync(bufferPath, JSON.stringify({
        message: sanitizedWarning,
        warning: sanitizedWarning,
        timestamp: Date.now()
      }) + '\n', 'utf8');
    } catch (_err) {
      // Ignore buffer write errors
    }
  }
}

function logHookExecution(projectDir, hookName, payload, result) {
  if (!projectDir || !payload) return;
  try {
    assertSafeDir(projectDir, 'Project directory');
    const agentsDir = path.join(projectDir, '.agents');
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    const logPath = path.join(agentsDir, 'hooks-execution.log');
    const entry = {
      timestamp: new Date().toISOString(),
      hook: hookName,
      conversationId: payload.conversationId || payload.session_id,
      ...(payload.invocationNum !== undefined ? { invocationNum: payload.invocationNum } : {}),
      stepIdx: payload.stepIdx,
      toolCall: payload.toolCall,
      result: result
    };
    const sanitizedEntry = redactLogSecrets(JSON.stringify(entry));
    fs.appendFileSync(logPath, sanitizedEntry + '\n', 'utf8');
  } catch (_) {
    // Best-effort logging
  }
}

module.exports = {
  translateInput,
  translateOutput,
  translateTranscriptLine,
  translateAgyTranscriptLineToClaude: translateTranscriptLine,
  translateClaudeTranscriptLineToAgy,
  shimTranscriptPath,
  shimClaudeTranscriptToAgy,
  normalizeStderr,
  setupEnvironment,
  createHookMatcher,
  executeHookCommand,
  updateContextWindowEnvForModel,
  bufferWarning,
  assertSafeDir,
  redactLogSecrets,
  logHookExecution
};

