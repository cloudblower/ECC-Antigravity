'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput, translateOutput, normalizeStderr, executeHookCommand, bufferWarning, logHookExecution } = require('./agy-adapter');
const { scheduleSessionEnd } = require('./session-end-scheduler');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    console.error('stop: failed to parse input JSON');
    console.log(JSON.stringify({}));
    process.exit(0);
  }

  // Treat Antigravity Stop Hook with fullyIdle = true as Claude Code Stop Hook.
  // If not fullyIdle, skip running Stop hooks and allow stopping.
  if (!payload.fullyIdle) {
    console.log(JSON.stringify({}));
    return;
  }

  const env = setupEnvironment(payload);
  const claudeInput = translateInput(payload, 'Stop');

  let dispatcherPath = process.env.MOCK_ECC_DISPATCHER;
  
  if (dispatcherPath) {
    const result = spawnSync(process.execPath, [dispatcherPath], {
      input: JSON.stringify(claudeInput),
      env: process.env,
      encoding: 'utf8'
    });
    
    handleResult(result, payload, env);
    return;
  }
  
  // Real execution
  const hooksJsonPath = path.join(env.claudePluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) {
    const claudeEndInput = translateInput(payload, 'SessionEnd');
    scheduleSessionEnd({ payload, claudeEndInput, env });
    logHookExecution(env.claudeProjectDir, 'Stop', payload, {});
    console.log(JSON.stringify({}));
    return;
  }
  
  const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const stopHooks = hooksConfig.hooks?.Stop || [];
  
  let finalDecision = null;
  
  for (const hookGroup of stopHooks) {
    if (hookGroup.id === 'stop:desktop-notify') {
      continue;
    }
    for (const hook of hookGroup.hooks) {
      if (hook.id === 'stop:desktop-notify' || (typeof hook.command === 'string' && hook.command.includes('desktop-notify'))) {
        continue;
      }
      if (hook.type === 'command') {
        const result = executeHookCommand(hook, env.claudePluginRoot, claudeInput);
        
        if (result.status === 2) {
          // Hard block: exit code 2 blocks Stop with stderr, returned as the reason to continue.
          finalDecision = {
            decision: 'continue',
            reason: normalizeStderr((result.stderr || 'Blocked by stop hook').trim())
          };
          break;
        }

        if (result.stderr) {
          process.stderr.write(result.stderr);
          if (result.stderr.trim()) {
            bufferWarning(payload.artifactDirectoryPath, normalizeStderr(result.stderr.trim()));
          }
        }

        let additionalContextText = '';
        if (result.stdout) {
          try {
            const claudeOutput = JSON.parse(result.stdout.trim());
            if (claudeOutput.hookSpecificOutput?.additionalContext) {
              additionalContextText += claudeOutput.hookSpecificOutput.additionalContext + '\n';
            }
            const agyOutput = translateOutput(claudeOutput, 'Stop');
            if (agyOutput.decision === 'continue') {
              finalDecision = agyOutput; // any hook that says "continue" (meaning "block Stop" in Claude) wins
              break;
            }
          } catch (_error) {
            // ignore parse error
          }
        }
        
        if (!finalDecision && additionalContextText.trim()) {
          bufferWarning(payload.artifactDirectoryPath, normalizeStderr(additionalContextText.trim()));
        }
      }
    }
    if (finalDecision) break;
  }
  
  // Schedule Claude SessionEnd hook with 30 minutes delay if stop is NOT blocked
  if (!finalDecision || finalDecision.decision !== 'continue') {
    const claudeEndInput = translateInput(payload, 'SessionEnd');
    scheduleSessionEnd({ payload, claudeEndInput, env });
  }
  
  const response = finalDecision || {};
  logHookExecution(env.claudeProjectDir, 'Stop', payload, response);
  console.log(JSON.stringify(response));
}

function handleResult(result, payload, env) {
  let response = {};
  if (result.status === 2) {
    response = {
      decision: 'continue',
      reason: normalizeStderr((result.stderr || 'Blocked by stop hook').trim())
    };
  } else {
    if (result.stderr) {
      process.stderr.write(result.stderr);
      if (result.stderr.trim()) {
        bufferWarning(payload ? payload.artifactDirectoryPath : null, normalizeStderr(result.stderr.trim()));
      }
    }
    if (result.stdout) {
      try {
        const claudeOutput = JSON.parse(result.stdout.trim());
        const agyOutput = translateOutput(claudeOutput, 'Stop');
        if (agyOutput && agyOutput.decision === 'continue') {
          response = agyOutput;
        }
      } catch (_error) {
        // ignore parse error
      }
    }

    if (payload && env && response.decision !== 'continue') {
      const claudeEndInput = translateInput(payload, 'SessionEnd');
      scheduleSessionEnd({ payload, claudeEndInput, env });
    }
  }

  const targetDir = env?.claudeProjectDir || payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  logHookExecution(targetDir, 'Stop', payload, response);
  console.log(JSON.stringify(response));
}

main();
