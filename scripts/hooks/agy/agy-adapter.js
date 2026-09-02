'use strict';
const path = require('path');
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
  updateContextWindowEnvForModel
};
