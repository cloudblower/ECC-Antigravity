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

function setupEnvironment(agyPayload) {
  // Infer plugin root (assumes scripts/hooks/agy/agy-adapter.js)
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '../../../');

  const conversationId = agyPayload.conversationId;
  const projectDir = (agyPayload.workspacePaths && agyPayload.workspacePaths.length > 0) 
    ? agyPayload.workspacePaths[0] 
    : process.cwd();
    
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
  if (!artifactDirectoryPath || !warningText) return;
  const bufferPath = path.join(artifactDirectoryPath, 'agy-warning-buffer.jsonl');
  try {
    fs.appendFileSync(bufferPath, JSON.stringify({
      message: warningText,
      warning: warningText,
      timestamp: Date.now()
    }) + '\n', 'utf8');
  } catch (_err) {
    // Ignore buffer write errors
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
  bufferWarning
};
