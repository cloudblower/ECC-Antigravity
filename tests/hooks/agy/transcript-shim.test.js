'use strict';
/**
 * Tests for scripts/hooks/a../../../scripts/hooks/agy/transcript-shim.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  translateTranscriptLine,
  translateClaudeTranscriptLineToAgy,
  shimTranscriptPath,
  shimClaudeTranscriptToAgy,
  updateContextWindowEnvForModel
} = require('../../../scripts/hooks/agy/transcript-shim');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
    return false;
  }
}

console.log('--- transcript-shim.test.js ---');

test('translateTranscriptLine: translates USER_INPUT to user message', () => {
  const agyLine = {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content: 'Hello'
  };
  const claudeLine = translateTranscriptLine(agyLine);
  assert.deepStrictEqual(claudeLine, {
    type: 'user',
    message: { role: 'user', content: 'Hello' }
  });
});

test('translateTranscriptLine: translates SYSTEM to system message', () => {
  const agyLine = {
    step_index: 0,
    source: 'SYSTEM',
    type: 'SYSTEM',
    content: 'System prompt'
  };
  const claudeLine = translateTranscriptLine(agyLine);
  assert.deepStrictEqual(claudeLine, {
    type: 'system',
    message: { role: 'system', content: 'System prompt' }
  });
});

test('translateTranscriptLine: translates CHECKPOINT and SYSTEM_MESSAGE to system message', () => {
  const checkpointLine = {
    step_index: 1,
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    content: 'Context compaction summary'
  };
  assert.deepStrictEqual(translateTranscriptLine(checkpointLine), {
    type: 'system',
    message: { role: 'system', content: 'Context compaction summary' }
  });

  const sysMsgLine = {
    step_index: 2,
    source: 'SYSTEM',
    type: 'SYSTEM_MESSAGE',
    content: 'Task completed'
  };
  assert.deepStrictEqual(translateTranscriptLine(sysMsgLine), {
    type: 'system',
    message: { role: 'system', content: 'Task completed' }
  });
});

test('translateTranscriptLine: translates native Antigravity PLANNER_RESPONSE with name and args', () => {
  const agyLine = {
    step_index: 5,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    content: 'Running tests now',
    thinking: 'Need to run npm test to verify',
    tool_calls: [
      {
        name: 'run_command',
        args: { CommandLine: 'npm test', toolSummary: 'Run tests' }
      },
      {
        name: 'call_mcp_tool',
        args: { ServerName: 'db', ToolName: 'query', Arguments: { sql: 'SELECT 1' } }
      }
    ]
  };
  const claudeLine = translateTranscriptLine(agyLine);
  assert.strictEqual(claudeLine.type, 'assistant');
  assert.strictEqual(claudeLine.message.role, 'assistant');
  assert.strictEqual(claudeLine.message.content[0].type, 'text');
  assert.strictEqual(claudeLine.message.content[0].text, 'Running tests now');
  
  assert.strictEqual(claudeLine.message.content[1].type, 'tool_use');
  assert.strictEqual(claudeLine.message.content[1].name, 'Bash');
  assert.deepStrictEqual(claudeLine.message.content[1].input, { command: 'npm test', description: 'Run tests' });
  assert.ok(claudeLine.message.content[1].id.startsWith('toolu_agy_'));

  assert.strictEqual(claudeLine.message.content[2].type, 'tool_use');
  assert.strictEqual(claudeLine.message.content[2].name, 'mcp__db__query');
  assert.deepStrictEqual(claudeLine.message.content[2].input, { sql: 'SELECT 1' });
});

test('translateTranscriptLine: translates legacy/OpenAI PLANNER_RESPONSE with function arguments', () => {
  const agyLine = {
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    content: 'I will run a command',
    tool_calls: [
      { id: 'call_1', function: { name: 'run_command', arguments: '{"CommandLine":"echo hi"}' } }
    ]
  };
  const claudeLine = translateTranscriptLine(agyLine);
  assert.deepStrictEqual(claudeLine, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will run a command' },
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo hi' } }
      ]
    }
  });
});

test('translateTranscriptLine: translates Antigravity GENERIC tool result to Claude tool_result', () => {
  const genericStep = {
    step_index: 6,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    content: 'All tests passed (2/2)'
  };
  const claudeLine = translateTranscriptLine(genericStep);
  assert.strictEqual(claudeLine.type, 'tool_result');
  assert.strictEqual(claudeLine.content, 'All tests passed (2/2)');
  assert.strictEqual(claudeLine.tool_use_id, 'toolu_agy_6');
  assert.strictEqual(claudeLine.is_error, false);

  const errorStep = {
    step_index: 7,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'ERROR',
    content: 'Command failed with exit code 1'
  };
  const claudeErrorLine = translateTranscriptLine(errorStep);
  assert.strictEqual(claudeErrorLine.type, 'tool_result');
  assert.strictEqual(claudeErrorLine.is_error, true);
});

test('translateTranscriptLine: translates legacy TOOL_RESULT to tool_result message', () => {
  const agyLine = {
    step_index: 1,
    source: 'TOOL_RESULT',
    type: 'TOOL_RESULT',
    tool_calls: [{ id: 'call_1' }],
    content: 'hi\n'
  };
  const claudeLine = translateTranscriptLine(agyLine);
  assert.deepStrictEqual(claudeLine, {
    type: 'tool_result',
    tool_use_id: 'call_1',
    content: 'hi\n',
    is_error: false
  });
});

test('translateClaudeTranscriptLineToAgy: translates Claude user message to Antigravity USER_INPUT', () => {
  const claudeUser = {
    type: 'user',
    message: { role: 'user', content: 'Please review this PR' }
  };
  const agyLine = translateClaudeTranscriptLineToAgy(claudeUser);
  assert.strictEqual(agyLine.source, 'USER_EXPLICIT');
  assert.strictEqual(agyLine.type, 'USER_INPUT');
  assert.strictEqual(agyLine.status, 'DONE');
  assert.strictEqual(agyLine.content, 'Please review this PR');
});

test('translateClaudeTranscriptLineToAgy: translates Claude assistant message to Antigravity PLANNER_RESPONSE', () => {
  const claudeAssistant = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Analyzing code structure' },
        { type: 'text', text: 'I am modifying the file' },
        {
          type: 'tool_use',
          id: 'toolu_101',
          name: 'Edit',
          input: { file_path: '/src/app.js', old_string: 'var x = 1;', new_string: 'const x = 1;' }
        },
        {
          type: 'tool_use',
          id: 'toolu_102',
          name: 'mcp__git__commit',
          input: { message: 'feat: modern const' }
        }
      ]
    }
  };
  const agyLine = translateClaudeTranscriptLineToAgy(claudeAssistant);
  assert.strictEqual(agyLine.source, 'MODEL');
  assert.strictEqual(agyLine.type, 'PLANNER_RESPONSE');
  assert.strictEqual(agyLine.status, 'DONE');
  assert.strictEqual(agyLine.content, 'I am modifying the file');
  assert.strictEqual(agyLine.thinking, 'Analyzing code structure');
  assert.strictEqual(agyLine.tool_calls.length, 2);

  assert.strictEqual(agyLine.tool_calls[0].name, 'replace_file_content');
  assert.strictEqual(agyLine.tool_calls[0].id, 'toolu_101');
  assert.deepStrictEqual(agyLine.tool_calls[0].args.TargetFile, '/src/app.js');
  assert.deepStrictEqual(agyLine.tool_calls[0].args.TargetContent, 'var x = 1;');
  assert.deepStrictEqual(agyLine.tool_calls[0].args.ReplacementContent, 'const x = 1;');

  assert.strictEqual(agyLine.tool_calls[1].name, 'call_mcp_tool');
  assert.strictEqual(agyLine.tool_calls[1].args.ServerName, 'git');
  assert.strictEqual(agyLine.tool_calls[1].args.ToolName, 'commit');
  assert.deepStrictEqual(agyLine.tool_calls[1].args.Arguments, { message: 'feat: modern const' });
});

test('translateClaudeTranscriptLineToAgy: translates Claude tool_result to Antigravity GENERIC', () => {
  const claudeResult = {
    type: 'tool_result',
    tool_use_id: 'toolu_101',
    content: 'File updated successfully',
    is_error: false
  };
  const agyLine = translateClaudeTranscriptLineToAgy(claudeResult);
  assert.strictEqual(agyLine.source, 'MODEL');
  assert.strictEqual(agyLine.type, 'GENERIC');
  assert.strictEqual(agyLine.status, 'DONE');
  assert.strictEqual(agyLine.content, 'File updated successfully');
  assert.strictEqual(agyLine.tool_use_id, 'toolu_101');
});

test('translateClaudeTranscriptLineToAgy: translates Claude system message to Antigravity SYSTEM_MESSAGE', () => {
  const claudeSystem = {
    type: 'system',
    message: { role: 'system', content: 'Context warning' }
  };
  const agyLine = translateClaudeTranscriptLineToAgy(claudeSystem);
  assert.strictEqual(agyLine.source, 'SYSTEM');
  assert.strictEqual(agyLine.type, 'SYSTEM_MESSAGE');
  assert.strictEqual(agyLine.status, 'DONE');
  assert.strictEqual(agyLine.content, 'Context warning');
});

test('shimTranscriptPath: creates a shadow file', () => {
  const tmpDir = fs.mkdtempSync('/tmp/agy-shim-test-');
  const agyPath = path.join(tmpDir, 'transcript.jsonl');
  const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');
  
  fs.writeFileSync(agyPath, JSON.stringify({ type: 'USER_INPUT', content: 'hi' }) + '\n');
  
  const resultPath = shimTranscriptPath(agyPath, shadowPath);
  assert.strictEqual(resultPath, shadowPath);
  
  const shadowContent = fs.readFileSync(shadowPath, 'utf8').trim();
  const shadowObj = JSON.parse(shadowContent);
  assert.strictEqual(shadowObj.type, 'user');
  assert.strictEqual(shadowObj.message.content, 'hi');
  
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('shimClaudeTranscriptToAgy: creates an Antigravity shadow file from Claude transcript', () => {
  const tmpDir = fs.mkdtempSync('/tmp/claude-to-agy-test-');
  const claudePath = path.join(tmpDir, 'claude-transcript.jsonl');
  const agyShadowPath = path.join(tmpDir, 'transcript.jsonl');

  const claudeData = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Listing files' },
          { type: 'tool_use', id: 't1', name: 'LS', input: { path: '/tmp' } }
        ]
      }
    }),
    JSON.stringify({ type: 'tool_result', tool_use_id: 't1', content: 'file1.txt\nfile2.txt' })
  ].join('\n') + '\n';

  fs.writeFileSync(claudePath, claudeData);

  const resultPath = shimClaudeTranscriptToAgy(claudePath, agyShadowPath);
  assert.strictEqual(resultPath, agyShadowPath);

  const agyContent = fs.readFileSync(agyShadowPath, 'utf8').trim().split('\n');
  assert.strictEqual(agyContent.length, 3);
  const step0 = JSON.parse(agyContent[0]);
  const step1 = JSON.parse(agyContent[1]);
  const step2 = JSON.parse(agyContent[2]);

  assert.strictEqual(step0.type, 'USER_INPUT');
  assert.strictEqual(step0.content, 'Hello');

  assert.strictEqual(step1.type, 'PLANNER_RESPONSE');
  assert.strictEqual(step1.tool_calls[0].name, 'list_dir');
  assert.strictEqual(step1.tool_calls[0].args.DirectoryPath, '/tmp');

  assert.strictEqual(step2.type, 'GENERIC');
  assert.strictEqual(step2.content, 'file1.txt\nfile2.txt');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('llm-summary extractConversationText works seamlessly on shimmed Antigravity transcript', () => {
  const { extractConversationText } = require('../../../scripts/lib/llm-summary');
  const tmpDir = fs.mkdtempSync('/tmp/llm-summary-shim-test-');
  const agyPath = path.join(tmpDir, 'transcript.jsonl');
  const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');

  const agyLines = [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Refactor the authentication module' }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'I will check the files and edit auth.js',
      tool_calls: [
        { name: 'replace_file_content', args: { TargetFile: '/src/auth.js', TargetContent: 'old', ReplacementContent: 'new' } }
      ]
    }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Replacement successful' })
  ].join('\n') + '\n';

  fs.writeFileSync(agyPath, agyLines);
  shimTranscriptPath(agyPath, shadowPath);

  const turns = extractConversationText(shadowPath);
  assert.ok(turns !== null, 'Conversation turns should be extracted');
  assert.ok(turns.includes('Refactor the authentication module'), 'Should include user request');
  assert.ok(turns.includes('I will check the files and edit auth.js'), 'Should include assistant response');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('shimTranscriptPath: calculates token usage and model for PLANNER_RESPONSE in shadow file', () => {
  const { extractUsageTokens, readLatestContextTokens, resolveContextWindowTokens } = require('../../../scripts/lib/transcript-context');
  const { getContextRemainingPct } = require('../../../scripts/lib/llm-summary');

  const tmpDir = fs.mkdtempSync('/tmp/agy-token-test-');
  const agyPath = path.join(tmpDir, 'transcript.jsonl');
  const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');

  const userReq = 'Build a high-performance HTTP caching proxy in Rust.';
  const assistantReply = 'I will create the Cargo project and start implementing the proxy.';

  const agyLines = [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: userReq }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: assistantReply,
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'cargo new proxy --bin', toolSummary: 'Create project' } }
      ]
    }),
    JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Created binary (application) `proxy` package' }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Now creating the main configuration file.',
      tool_calls: [
        { name: 'write_to_file', args: { TargetFile: 'proxy/config.toml', CodeContent: 'port = 8080' } }
      ]
    })
  ].join('\n') + '\n';

  fs.writeFileSync(agyPath, agyLines);
  shimTranscriptPath(agyPath, shadowPath, { model: 'gemini-3.7-flash-medium' });

  const shadowLines = fs.readFileSync(shadowPath, 'utf8').trim().split('\n');
  assert.strictEqual(shadowLines.length, 4);

  const assistantTurn1 = JSON.parse(shadowLines[1]);
  assert.strictEqual(assistantTurn1.type, 'assistant');
  assert.ok(assistantTurn1.message.usage, 'Turn 1 should have usage object');
  assert.ok(assistantTurn1.message.usage.input_tokens > 0, 'Turn 1 should have input_tokens > 0');
  assert.ok(assistantTurn1.message.usage.output_tokens > 0, 'Turn 1 should have output_tokens > 0');
  assert.ok(assistantTurn1.message.model.includes('gemini-3.7-flash-medium'), 'Turn 1 should have model');

  const assistantTurn2 = JSON.parse(shadowLines[3]);
  assert.strictEqual(assistantTurn2.type, 'assistant');
  assert.ok(assistantTurn2.message.usage, 'Turn 2 should have usage object');
  assert.ok(
    assistantTurn2.message.usage.input_tokens > assistantTurn1.message.usage.input_tokens,
    `Turn 2 input_tokens (${assistantTurn2.message.usage.input_tokens}) should be greater than Turn 1 (${assistantTurn1.message.usage.input_tokens})`
  );

  // Test extractUsageTokens from transcript-context.js
  const extractedTokens = extractUsageTokens(assistantTurn2);
  assert.ok(extractedTokens > 0, 'extractUsageTokens should return > 0');
  assert.strictEqual(extractedTokens, assistantTurn2.message.usage.input_tokens);

  // Test readLatestContextTokens from transcript-context.js
  const latestUsage = readLatestContextTokens(shadowPath);
  assert.ok(latestUsage !== null, 'readLatestContextTokens should return usage object');
  assert.strictEqual(latestUsage.tokens, assistantTurn2.message.usage.input_tokens);
  assert.strictEqual(latestUsage.model, assistantTurn2.message.model);

  // Test resolveContextWindowTokens from transcript-context.js
  const windowTokens = resolveContextWindowTokens(latestUsage.tokens, latestUsage.model);
  assert.ok(windowTokens >= 200000, `Window tokens should be at least 200k, got ${windowTokens}`);

  // Test getContextRemainingPct from llm-summary.js
  const pct = getContextRemainingPct(shadowPath);
  assert.strictEqual(typeof pct, 'number', 'getContextRemainingPct should return a number');
  assert.ok(pct >= 0 && pct <= 100, `getContextRemainingPct should be between 0 and 100, got ${pct}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('shimTranscriptPath: CHECKPOINT resets cumulative input tokens', () => {
  const tmpDir = fs.mkdtempSync('/tmp/agy-checkpoint-test-');
  const agyPath = path.join(tmpDir, 'transcript.jsonl');
  const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');

  const agyLines = [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'A very long request...'.repeat(500) }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Working on it' }),
    JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', content: 'Compacted brief summary' }),
    JSON.stringify({ step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Resuming work' })
  ].join('\n') + '\n';

  fs.writeFileSync(agyPath, agyLines);
  shimTranscriptPath(agyPath, shadowPath);

  const shadowLines = fs.readFileSync(shadowPath, 'utf8').trim().split('\n');
  const turnBeforeCheckpoint = JSON.parse(shadowLines[1]);
  const turnAfterCheckpoint = JSON.parse(shadowLines[3]);

  assert.ok(
    turnAfterCheckpoint.message.usage.input_tokens < turnBeforeCheckpoint.message.usage.input_tokens,
    `Tokens after checkpoint (${turnAfterCheckpoint.message.usage.input_tokens}) should be smaller than before (${turnBeforeCheckpoint.message.usage.input_tokens})`
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('translateClaudeTranscriptLineToAgy preserves usage and model', () => {
  const claudeAssistant = {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 15000, output_tokens: 250 },
      content: [{ type: 'text', text: 'Hello' }]
    }
  };
  const agyStep = translateClaudeTranscriptLineToAgy(claudeAssistant);
  assert.strictEqual(agyStep.model, 'claude-sonnet-4-6');
  assert.deepStrictEqual(agyStep.usage, { input_tokens: 15000, output_tokens: 250 });
});

test('updateContextWindowEnvForModel: sets 1M window for Gemini models', () => {
  const oldVal = process.env.ECC_CONTEXT_WINDOW_TOKENS;
  try {
    delete process.env.ECC_CONTEXT_WINDOW_TOKENS;
    updateContextWindowEnvForModel('gemini-3');
    assert.strictEqual(process.env.ECC_CONTEXT_WINDOW_TOKENS, '1000000');
  } finally {
    if (oldVal !== undefined) {
      process.env.ECC_CONTEXT_WINDOW_TOKENS = oldVal;
    } else {
      delete process.env.ECC_CONTEXT_WINDOW_TOKENS;
    }
  }
});

test('shimTranscriptPath: does not mutate process.env.ECC_CONTEXT_WINDOW_TOKENS while translating transcripts', () => {
  const oldVal = process.env.ECC_CONTEXT_WINDOW_TOKENS;
  try {
    delete process.env.ECC_CONTEXT_WINDOW_TOKENS;

    const tmpDir = fs.mkdtempSync('/tmp/agy-no-env-mutation-test-');
    const agyPath = path.join(tmpDir, 'transcript.jsonl');
    const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');

    const agyLines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'Design an architectural review system' }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        model: 'gemini-3',
        content: 'I will outline the architecture components.'
      })
    ].join('\n') + '\n';

    fs.writeFileSync(agyPath, agyLines);
    shimTranscriptPath(agyPath, shadowPath, { model: 'gemini-3' });

    assert.strictEqual(process.env.ECC_CONTEXT_WINDOW_TOKENS, undefined, 'shimTranscriptPath should not mutate process.env');

    const shadowLines = fs.readFileSync(shadowPath, 'utf8').trim().split('\n');
    const assistantTurn = JSON.parse(shadowLines[1]);
    assert.strictEqual(assistantTurn.message.model, 'gemini-3');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  } finally {
    if (oldVal !== undefined) {
      process.env.ECC_CONTEXT_WINDOW_TOKENS = oldVal;
    } else {
      delete process.env.ECC_CONTEXT_WINDOW_TOKENS;
    }
  }
});

test('shimTranscriptPath: recognizes model from Model Selection settings changes with spaces and periods', () => {
  const tmpDir = fs.mkdtempSync('/tmp/agy-model-selection-test-');
  const agyPath = path.join(tmpDir, 'transcript.jsonl');
  const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');

  const agyLines = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nHello\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.6 Flash (Low). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Hello! How can I help you today?'
    }),
    JSON.stringify({
      step_index: 2,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nHello again\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.6 Flash (Low) to Gemini 3.8 Flash (Medium). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 3,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Hello again! How can I assist you with your project today?'
    }),
    JSON.stringify({
      step_index: 4,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nSwitching back\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 3.8 Flash (Medium) to Gemini 3.6 Flash (Low). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Understood!'
    }),
    JSON.stringify({
      step_index: 6,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nFormat example\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.7 Flash (High).\n</USER_SETTINGS_CHANGE>'
    }),
    JSON.stringify({
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Ready!'
    })
  ].join('\n') + '\n';

  fs.writeFileSync(agyPath, agyLines);
  shimTranscriptPath(agyPath, shadowPath);

  const shadowLines = fs.readFileSync(shadowPath, 'utf8').trim().split('\n');
  assert.strictEqual(shadowLines.length, 8);

  const turn1 = JSON.parse(shadowLines[1]);
  assert.strictEqual(turn1.message.model, 'gemini-3.6-flash-low');

  const turn2 = JSON.parse(shadowLines[3]);
  assert.strictEqual(turn2.message.model, 'gemini-3.8-flash-medium');

  const turn3 = JSON.parse(shadowLines[5]);
  assert.strictEqual(turn3.message.model, 'gemini-3.6-flash-low');

  const turn4 = JSON.parse(shadowLines[7]);
  assert.strictEqual(turn4.message.model, 'gemini-3.7-flash-high');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('shimTranscriptPath: correctly recognizes models across full session from real transcript.jsonl', () => {
  const realTranscriptPath = '/home/nob/.gemini/antigravity/brain/cf7013d9-6ae6-4f24-b178-56dc20c6e616/.system_generated/logs/transcript.jsonl';
  if (!fs.existsSync(realTranscriptPath)) {
    return;
  }

  const tmpDir = fs.mkdtempSync('/tmp/agy-real-transcript-test-');
  const shadowPath = path.join(tmpDir, 'claude-compat-transcript.jsonl');

  shimTranscriptPath(realTranscriptPath, shadowPath);
  const shadowLines = fs.readFileSync(shadowPath, 'utf8').trim().split('\n');

  // Turn index 4 (step_index 4) was preceded by step 0: "from None to Gemini 3.6 Flash (Low)"
  const step4 = JSON.parse(shadowLines[4]);
  assert.strictEqual(step4.message.model, 'gemini-3.6-flash-low');

  // Turn index 8 (step_index 8) was preceded by step 5: "from Gemini 3.6 Flash (Low) to Gemini 3.8 Flash (Medium)"
  const step8 = JSON.parse(shadowLines[8]);
  assert.strictEqual(step8.message.model, 'gemini-3.8-flash-medium');

  // Turn index 12 (step_index 12) was preceded by step 9: "from Gemini 3.8 Flash (Medium) to Gemini 3.6 Flash (Low)"
  const step12 = JSON.parse(shadowLines[12]);
  assert.strictEqual(step12.message.model, 'gemini-3.6-flash-low');

  // Turn index 36 (step_index 36) was preceded by step 33: "from Gemini 3.6 Flash (Low) to Gemini 3.8 Flash (Medium)"
  const step36 = JSON.parse(shadowLines[36]);
  assert.strictEqual(step36.message.model, 'gemini-3.8-flash-medium');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('translateTranscriptLine & translateClaudeTranscriptLineToAgy: bidirectionally translates Skill tool calls', () => {
  const agyLine = {
    step_index: 3,
    type: 'PLANNER_RESPONSE',
    content: 'Running TDD workflow',
    tool_calls: [
      {
        id: 'toolu_123',
        name: 'view_file',
        args: { AbsolutePath: '/workspace/.agent/skills/tdd-workflow/SKILL.md', IsSkillFile: true }
      }
    ]
  };
  const claudeLine = translateTranscriptLine(agyLine);
  assert.strictEqual(claudeLine.type, 'assistant');
  const toolUse = claudeLine.message.content.find(c => c.type === 'tool_use');
  assert.ok(toolUse);
  assert.strictEqual(toolUse.name, 'Skill');
  assert.strictEqual(toolUse.input.skill, 'tdd-workflow');

  const reverseClaudeLine = {
    step_index: 3,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_123', name: 'Skill', input: { skill: 'tdd-workflow' } }
      ]
    }
  };
  const reverseAgyLine = translateClaudeTranscriptLineToAgy(reverseClaudeLine);
  assert.strictEqual(reverseAgyLine.type, 'PLANNER_RESPONSE');
  assert.strictEqual(reverseAgyLine.tool_calls[0].name, 'view_file');
  assert.ok(reverseAgyLine.tool_calls[0].args.AbsolutePath.endsWith('SKILL.md'));
  assert.strictEqual(reverseAgyLine.tool_calls[0].args.IsSkillFile, true);
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);

