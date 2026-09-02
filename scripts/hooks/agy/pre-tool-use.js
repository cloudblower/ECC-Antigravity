'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput, translateOutput, normalizeStderr, createHookMatcher } = require('./agy-adapter');
const { cancelSessionEnd } = require('./session-end-scheduler');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (e) {
    console.error('Failed to parse input JSON:', e);
    process.exit(1);
  }

  // Cancel any pending SessionEnd timer for this conversation
  if (payload.conversationId) {
    cancelSessionEnd(payload.conversationId);
  }

  const env = setupEnvironment(payload);
  const claudeInput = translateInput(payload, 'PreToolUse');

  // Choose the dispatcher
  // MOCK_ECC_DISPATCHER is for testing
  let dispatcherPath = process.env.MOCK_ECC_DISPATCHER;
  if (!dispatcherPath) {
    // If we're modifying files, we should probably run gateguard-fact-force directly?
    // Actually, hooks.json defines what runs.
    // Wait, the plan says "Spawns the appropriate ECC dispatcher (or individual ECC hooks)."
    // Let's spawn run-with-flags.js ? No, ECC hooks use run-with-flags.js for Stop hooks.
    // For PreToolUse, ECC uses node directly.
    // The implementation plan says: "Implement pre-tool-use.js: tool name mapping, ECC dispatcher invocation..."
    // In Claude Code, PreToolUse hooks are triggered based on hooks.json matcher.
    // If we map to a single PreToolUse shim, we need to run all relevant PreToolUse hooks defined in src/hooks/hooks.json.
    // Or we can just use the provided MOCK or run a simple dispatcher.
    // Let's create a simple dispatcher here that mimics Claude Code's hook engine for PreToolUse,
    // OR we can just execute the known hooks. 
    // Known PreToolUse hooks from hooks.json:
    // pre:bash:dispatcher, pre:write:doc-file-warning, pre:edit-write:suggest-compact, pre:observe:continuous-learning, pre:governance-capture, pre:config-protection, pre:edit-write:gateguard-fact-force, pre:mcp-health-check
    
    // For simplicity, we can load hooks.json, filter PreToolUse hooks matching the claudeToolName, and run them sequentially.
    dispatcherPath = path.join(env.claudePluginRoot, 'scripts', 'hooks', 'hook-runner.js');
    if (!fs.existsSync(dispatcherPath)) {
      // If we don't want to write a full hook engine, we can just run the pre-tool-use scripts manually based on tool name.
      dispatcherPath = null;
    }
  }

  if (dispatcherPath) {
    runDispatcher(dispatcherPath, claudeInput, payload);
  } else {
    runHooksFromJson(claudeInput, payload, env);
  }
}

function runDispatcher(dispatcherPath, claudeInput, payload) {
  const result = spawnSync('node', [dispatcherPath], {
    input: JSON.stringify(claudeInput),
    env: process.env,
    encoding: 'utf8'
  });

  handleResult(result, claudeInput, payload);
}

function runHooksFromJson(claudeInput, payload, env) {
  const hooksJsonPath = path.join(env.claudePluginRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) {
    console.log(JSON.stringify({ decision: 'allow' }));
    return;
  }
  
  const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const preToolUseHooks = hooksConfig.hooks?.PreToolUse || [];
  
  let finalDecision = null;
  let finalOverwrite = null;
  let additionalContextText = '';
  
  // Minimal matcher
  for (const hookGroup of preToolUseHooks) {
    const matcher = createHookMatcher(hookGroup.matcher);
    if (matcher.test(claudeInput.tool_name)) {
      for (const hook of hookGroup.hooks) {
        if (hook.type === 'command') {
          // command is usually something like "${CLAUDE_PLUGIN_ROOT}/scripts/..."
          const cmdStr = hook.command.replace('${CLAUDE_PLUGIN_ROOT}', env.claudePluginRoot);
          const args = hook.args || [];
          
          // Actually, some commands are run via `node ...`
          let bin = cmdStr;
          let runArgs = args;
          if (cmdStr.startsWith('node ')) {
            bin = 'node';
            runArgs = [cmdStr.slice(5), ...args];
          }
          
          const result = spawnSync(bin, runArgs, {
            shell: true,
            input: JSON.stringify(claudeInput),
            env: process.env,
            encoding: 'utf8',
            timeout: hook.timeout ? hook.timeout * 1000 : 0
          });
          
          if (result.status === 2) {
             // Hard block: stderr is passed directly as the denial reason; do not buffer it
             finalDecision = { decision: 'deny', reason: normalizeStderr((result.stderr || 'Blocked by hook').trim()) };
             break;
          }

          if (result.stderr) {
            process.stderr.write(result.stderr);
          }

          if (result.stdout) {
            try {
              const claudeOutput = JSON.parse(result.stdout.trim());
              
              if (claudeOutput.hookSpecificOutput?.additionalContext) {
                additionalContextText += claudeOutput.hookSpecificOutput.additionalContext + '\n';
              }

              const agyOutput = translateOutput(claudeOutput, 'PreToolUse', payload.toolCall.name, payload.toolCall.args);

              if (agyOutput.decision && agyOutput.decision !== 'allow' && agyOutput.decision !== 'continue') {
                finalDecision = agyOutput;
              }
              if (agyOutput.overwrite) {
                finalOverwrite = agyOutput.overwrite;
                // update input for next hook
                claudeInput.tool_input = claudeOutput.hookSpecificOutput.updatedInput;
              }
            } catch (_error) {
              // ignore non-JSON output
            }
          }
        }
      }
    }
    if (finalDecision) break;
  }

  if (additionalContextText.trim()) {
    bufferWarning(payload.artifactDirectoryPath, normalizeStderr(additionalContextText.trim()));
  }
  
  const response = finalDecision || { decision: 'allow' };
  if (finalOverwrite) {
    response.overwrite = finalOverwrite;
  }
  
  console.log(JSON.stringify(response));
}

function handleResult(result, claudeInput, payload) {
  let response = { decision: 'allow' };
  
  if (result.status === 2) {
    response = { decision: 'deny', reason: normalizeStderr((result.stderr || 'Blocked by hook').trim()) };
  } else {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (result.stdout) {
      try {
        const claudeOutput = JSON.parse(result.stdout.trim());
        if (claudeOutput.hookSpecificOutput?.additionalContext) {
          bufferWarning(payload.artifactDirectoryPath, normalizeStderr(claudeOutput.hookSpecificOutput.additionalContext.trim()));
        }
        const agyOutput = translateOutput(claudeOutput, 'PreToolUse', payload.toolCall.name, payload.toolCall.args);
        if (agyOutput.decision && agyOutput.decision !== 'allow') {
          response.decision = agyOutput.decision;
          response.reason = agyOutput.reason;
        }
        if (agyOutput.overwrite) {
          response.overwrite = agyOutput.overwrite;
        }
      } catch (_error) {
        // not JSON
      }
    }
  }
  
  console.log(JSON.stringify(response));
}

function bufferWarning(artifactDirectoryPath, warningText) {
  if (!artifactDirectoryPath || !warningText) return;
  const bufferPath = path.join(artifactDirectoryPath, 'agy-warning-buffer.jsonl');
  const entry = JSON.stringify({ message: warningText, timestamp: Date.now() }) + '\n';
  fs.appendFileSync(bufferPath, entry, 'utf8');
}

main();
