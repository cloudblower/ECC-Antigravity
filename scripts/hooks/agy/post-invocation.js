'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { setupEnvironment, translateInput, translateOutput, normalizeStderr } = require('./agy-adapter');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    process.exit(1);
  }

  const env = setupEnvironment(payload);
  
  // PostInvocation loosely maps to Stop hooks (the ones that run when model finishes turn).
  // But wait, in the plan: 
  // "Maps PostInvocation → Claude Code Stop (model finished a turn)."
  // "ECC Stop hooks read transcript_path..."
  // Wait, in ECC there is only ONE 'Stop' event.
  // The plan maps PostInvocation -> Claude Stop, AND AGY Stop -> Claude Stop.
  // This might double-run the Stop hooks!
  // Let's check the plan carefully:
  // "Component 2: post-invocation.js: Maps PostInvocation → Claude Code Stop (model finished a turn)."
  // "stop.js: Maps Antigravity Stop → Claude Code Stop. Runs ECC Stop-event hooks directly."
  // Wait, if both run Claude Code Stop hooks, they will run twice. 
  // Let's just run them in AGY Stop, because AGY Stop is when the execution loop terminates, which is exactly when Claude Code Stop hooks are meant to run! 
  // But wait, if we mapped it, let's just implement it to return {} and maybe run PreCompact checks if necessary.
  // Actually, I'll just make it return {} for now, to avoid double execution, unless the plan intended something else. The plan says "Returns Antigravity terminationBehavior derived from ECC's decision: continue".
  
  // Let's implement it to run Claude's Stop hooks. If they say "continue", we return terminationBehavior: force_continue.
  const claudeInput = translateInput(payload, 'Stop');
  let finalDecision = null;

  const hooksJsonPath = path.join(env.claudePluginRoot, 'hooks', 'hooks.json');
  if (fs.existsSync(hooksJsonPath)) {
    const hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    const stopHooks = hooksConfig.hooks?.Stop || [];
    
    for (const hookGroup of stopHooks) {
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
          
          if (result.status === 2) {
            finalDecision = { terminationBehavior: 'force_continue' };
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
                finalDecision = { terminationBehavior: 'force_continue' };
              }
            } catch (_error) {
              // Ignore JSON parse errors
            }
          }
          
          if (additionalContextText.trim()) {
            bufferWarning(payload.artifactDirectoryPath, normalizeStderr(additionalContextText.trim()));
          }
        }
      }
    }
  }

  console.log(JSON.stringify(finalDecision || {}));
}

function bufferWarning(artifactDirectoryPath, warningText) {
  if (!artifactDirectoryPath || !warningText) return;
  const bufferPath = path.join(artifactDirectoryPath, 'agy-warning-buffer.jsonl');
  const entry = JSON.stringify({ message: warningText, timestamp: Date.now() }) + '\n';
  fs.appendFileSync(bufferPath, entry, 'utf8');
}

main();
