'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput, normalizeStderr, createHookMatcher } = require('./agy-adapter');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    process.exit(1);
  }

  const env = setupEnvironment(payload);
  
  // If there's an error, it's PostToolUseFailure
  const claudeEvent = payload.error ? 'PostToolUseFailure' : 'PostToolUse';
  const claudeInput = translateInput(payload, claudeEvent);

  const hooksJsonPath = path.join(env.claudePluginRoot, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const hooks = hooksConfig.hooks?.[claudeEvent] || [];
    
    for (const hookGroup of hooks) {
      const matcher = createHookMatcher(hookGroup.matcher);
      if (matcher.test(claudeInput.tool_name)) {
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
              } catch (_error) {
                // ignore
              }
            }
            if (additionalContextText.trim()) {
              bufferWarning(payload.artifactDirectoryPath, normalizeStderr(additionalContextText.trim()));
            }
          }
        }
      }
    }
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
