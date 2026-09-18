'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sanitizeSessionId } = require('../../lib/utils');
const { executeHookCommand } = require('./agy-adapter');

function getTimerDir() {
  const dir = path.join(os.homedir(), '.gemini', 'antigravity', 'session-timers');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (_error) {
      // ignore
    }
  }
  return dir;
}

function getTimerFilePath(conversationId) {
  const safeId = sanitizeSessionId(conversationId || 'default') || 'default';
  return path.join(getTimerDir(), `${safeId}.json`);
}

function cancelSessionEnd(conversationId) {
  if (!conversationId) return false;
  const timerFile = getTimerFilePath(conversationId);
  if (!fs.existsSync(timerFile)) return false;

  try {
    const raw = fs.readFileSync(timerFile, 'utf8');
    const state = JSON.parse(raw);
    if (state.status === 'pending') {
      state.status = 'cancelled';
      try {
        fs.writeFileSync(timerFile, JSON.stringify(state, null, 2), 'utf8');
      } catch (_error) {
        // ignore
      }
    }
    if (state.pid && Number.isInteger(state.pid) && state.pid > 0) {
      try {
        // Verify the process exists before sending signal
        process.kill(state.pid, 0);  // Signal 0 = check existence only
        process.kill(state.pid, 'SIGTERM');
      } catch (_error) {
        // Process doesn't exist or permission denied — safe to ignore
      }
    }
    try {
      fs.unlinkSync(timerFile);
    } catch (_error) {
      // ignore
    }
    return true;
  } catch (_error) {
    try {
      if (fs.existsSync(timerFile)) fs.unlinkSync(timerFile);
    } catch (_error) {
      // ignore
    }
    return false;
  }
}

function runSessionEndHooks(claudeEndInput, env = {}) {
  const pluginRoot = env.claudePluginRoot || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '../../../');
  const hooksJsonPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) {
    return;
  }

  let hooksConfig;
  try {
    hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  } catch (_error) {
    return;
  }

  const sessionEndHooks = hooksConfig.hooks?.SessionEnd || [];
  for (const hookGroup of sessionEndHooks) {
    for (const hook of hookGroup.hooks) {
      if (hook.type === 'command') {
        try {
          executeHookCommand(hook, pluginRoot, claudeEndInput || {}, { env });
        } catch (_error) {
          // ignore hook execution errors in background
        }
      }
    }
  }
}

function scheduleSessionEnd({ payload, claudeEndInput, env, delayMs }) {
  if (!payload || !payload.conversationId) return null;
  const conversationId = payload.conversationId;

  // Cancel any existing pending timer
  cancelSessionEnd(conversationId);

  const defaultDelay = 30 * 60 * 1000; // 30 minutes
  let delay = defaultDelay;
  if (delayMs !== undefined) {
    delay = Number(delayMs);
  } else if (process.env.ECC_SESSION_END_DELAY_MS) {
    const parsed = parseInt(process.env.ECC_SESSION_END_DELAY_MS, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      delay = parsed;
    }
  }
  if (isNaN(delay) || delay < 0) {
    delay = defaultDelay;
  }

  const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const timerFile = getTimerFilePath(conversationId);
  const pluginRoot = env?.claudePluginRoot || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '../../../');

  const state = {
    conversationId,
    token,
    scheduledAt: Date.now(),
    fireAt: Date.now() + delay,
    delayMs: delay,
    status: 'pending',
    claudeEndInput: claudeEndInput || {},
    claudePluginRoot: pluginRoot,
    env: {
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID || conversationId,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || (payload.workspacePaths?.[0] || process.cwd()),
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_TRANSCRIPT_PATH: process.env.CLAUDE_TRANSCRIPT_PATH || '',
      CLAUDE_MODEL: process.env.CLAUDE_MODEL || '',
      ECC_OBSERVER_PERSIST: process.env.ECC_OBSERVER_PERSIST || 'true',
      ECC_AGENT_DATA_HOME: process.env.ECC_AGENT_DATA_HOME || ''
    }
  };

  try {
    fs.writeFileSync(timerFile, JSON.stringify(state, null, 2), 'utf8');
  } catch (_error) {
    return null;
  }

  const workerScript = path.join(__dirname, 'session-end-worker.js');
  try {
    const child = spawn(process.execPath, [workerScript, timerFile, token], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...state.env }
    });
    child.unref();

    state.pid = child.pid;
    try {
      fs.writeFileSync(timerFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (_error) {
      // ignore
    }
  } catch (_error) {
    // If spawning background process fails, fallback
  }

  return timerFile;
}

module.exports = {
  getTimerDir,
  getTimerFilePath,
  cancelSessionEnd,
  runSessionEndHooks,
  scheduleSessionEnd
};
