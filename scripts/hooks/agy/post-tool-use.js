'use strict';
const fs = require('fs');
const path = require('path');
const { setupEnvironment, translateInput, normalizeStderr, createHookMatcher, executeHookCommand, bufferWarning } = require('./agy-adapter');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    console.error('post-tool-use: failed to parse input JSON');
    console.log(JSON.stringify({}));
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
            const result = executeHookCommand(hook, env.claudePluginRoot, claudeInput);
            
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

main();
