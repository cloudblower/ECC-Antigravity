'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput, translateOutput, normalizeStderr } = require('./agy-adapter');
const { scheduleSessionEnd } = require('./session-end-scheduler');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    process.exit(1);
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
    const result = spawnSync('node', [dispatcherPath], {
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
        const cmdStr = hook.command.replace('${CLAUDE_PLUGIN_ROOT}', env.claudePluginRoot);
        let bin = cmdStr;
        let runArgs = hook.args || [];
        if (cmdStr.startsWith('node ')) {
          bin = 'node';
          runArgs = [cmdStr.slice(5), ...runArgs];
        }
        
        const result = spawnSync(bin, runArgs, {
          shell: true,
          input: JSON.stringify(claudeInput),
          env: process.env,
          encoding: 'utf8',
          timeout: hook.timeout ? hook.timeout * 1000 : 0
        });
        
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
  
  console.log(JSON.stringify(finalDecision || {}));
}

function handleResult(result, payload, env) {
  if (result.status === 2) {
    console.log(JSON.stringify({
      decision: 'continue',
      reason: normalizeStderr((result.stderr || 'Blocked by stop hook').trim())
    }));
    return;
  }
  if (result.stdout) {
    try {
      const claudeOutput = JSON.parse(result.stdout.trim());
      const agyOutput = translateOutput(claudeOutput, 'Stop');
      if (agyOutput && agyOutput.decision === 'continue') {
        console.log(JSON.stringify(agyOutput));
        return;
      }
    } catch (_error) {
      // ignore parse error
    }
  }

  if (payload && env) {
    const claudeEndInput = translateInput(payload, 'SessionEnd');
    scheduleSessionEnd({ payload, claudeEndInput, env });
  }

  console.log(JSON.stringify({}));
}

function bufferWarning(artifactDirectoryPath, warningText) {
  if (!artifactDirectoryPath || !warningText) return;
  const bufferPath = path.join(artifactDirectoryPath, 'agy-warning-buffer.jsonl');
  const entry = JSON.stringify({ message: warningText, timestamp: Date.now() }) + '\n';
  fs.appendFileSync(bufferPath, entry, 'utf8');
}

main();
