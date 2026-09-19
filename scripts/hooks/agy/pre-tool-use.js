'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput, translateOutput, normalizeStderr, createHookMatcher, executeHookCommand, bufferWarning } = require('./agy-adapter');
const { cancelSessionEnd } = require('./session-end-scheduler');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (e) {
    console.error('pre-tool-use: failed to parse input JSON:', e);
    console.log(JSON.stringify({ decision: 'allow' }));
    process.exit(1);
  }

  // Cancel any pending SessionEnd timer for this conversation
  if (payload.conversationId) {
    cancelSessionEnd(payload.conversationId);
  }

  const env = setupEnvironment(payload);
  const claudeInput = translateInput(payload, 'PreToolUse');

  // Choose the dispatcher
  let dispatcherPath = process.env.MOCK_ECC_DISPATCHER;
  if (!dispatcherPath) {
    dispatcherPath = path.join(env.claudePluginRoot, 'scripts', 'hooks', 'hook-runner.js');
    if (!fs.existsSync(dispatcherPath)) {
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
  const result = spawnSync(process.execPath, [dispatcherPath], {
    input: JSON.stringify(claudeInput),
    env: process.env,
    encoding: 'utf8',
    timeout: 30000
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
          const result = executeHookCommand(hook, env.claudePluginRoot, claudeInput);
          
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

main();
