'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput } = require('./agy-adapter');
const { cancelSessionEnd } = require('./session-end-scheduler');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    process.exit(1);
  }

  // Cancel any pending SessionEnd timer for this conversation
  if (payload.conversationId) {
    cancelSessionEnd(payload.conversationId);
  }

  const env = setupEnvironment(payload);
  const response = { injectSteps: [] };

  // 1. If invocationNum === 0, trigger Claude Code SessionStart hooks
  if (payload.invocationNum === 0) {
    const claudeInput = translateInput(payload, 'SessionStart');
    claudeInput.source = 'startup';
    
    // We only trigger via hooks.json if it exists, otherwise skip
    const hooksJsonPath = path.join(env.claudePluginRoot, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksJsonPath)) {
      const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      const sessionStartHooks = hooksConfig.hooks?.SessionStart || [];
      
      for (const hookGroup of sessionStartHooks) {
        for (const hook of hookGroup.hooks) {
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
             
             // In SessionStart, stdout is plain text and becomes additionalContext
             // Or it's JSON with additionalContext. For AGY, we put it into ephemeral
             if (result.stdout) {
               try {
                 const outJson = JSON.parse(result.stdout.trim());
                 if (outJson.hookSpecificOutput && outJson.hookSpecificOutput.additionalContext) {
                    response.injectSteps.push({ ephemeralMessage: outJson.hookSpecificOutput.additionalContext });
                 }
               } catch (_error) {
                 if (result.stdout.trim()) {
                   response.injectSteps.push({ ephemeralMessage: result.stdout.trim() });
                 }
               }
             }
           }
        }
      }
    }
  }

  // 2. Drain warnings buffer
  const bufferPath = path.join(payload.artifactDirectoryPath, 'agy-warning-buffer.jsonl');
  if (fs.existsSync(bufferPath)) {
    try {
      const lines = fs.readFileSync(bufferPath, 'utf8').split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const warnings = lines.map(l => JSON.parse(l).message).join('\n\n');
        response.injectSteps.push({ ephemeralMessage: `[ECC Hook Warnings]\n${warnings}` });
      }
      fs.unlinkSync(bufferPath);
    } catch (_error) {
      // ignore
    }
  }

  if (response.injectSteps.length === 0) {
    console.log("{}");
  } else {
    console.log(JSON.stringify(response));
  }
}

main();
