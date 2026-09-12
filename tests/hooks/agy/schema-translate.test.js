'use strict';
/**
 * Tests for scripts/hooks/a../../../scripts/hooks/agy/schema-translate.js
 */

const assert = require('assert');
const {
  translateInput,
  translateOutput,
  mapToolNameToClaude,
  mapToolNameToAgy,
  mapToolInputToClaude,
  mapToolInputToAgy,
  extractSkillName,
  resolveSkillPath
} = require('../../../scripts/hooks/agy/schema-translate');

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

console.log('--- schema-translate.test.js ---');

test('mapToolNameToClaude: maps AGY tools to Claude tools', () => {
  assert.strictEqual(mapToolNameToClaude('run_command'), 'Bash');
  assert.strictEqual(mapToolNameToClaude('write_to_file'), 'Write');
  assert.strictEqual(mapToolNameToClaude('replace_file_content'), 'Edit');
  assert.strictEqual(mapToolNameToClaude('multi_replace_file_content'), 'MultiEdit');
  assert.strictEqual(mapToolNameToClaude('view_file'), 'Read');
  assert.strictEqual(mapToolNameToClaude('find_by_name'), 'Glob');
  assert.strictEqual(mapToolNameToClaude('grep_search'), 'Grep');
  assert.strictEqual(mapToolNameToClaude('list_dir'), 'LS');
  assert.strictEqual(mapToolNameToClaude('mcp__server__tool'), 'mcp__server__tool');
});

test('mapToolInputToClaude: maps run_command args to Bash tool_input', () => {
  const agyArgs = { CommandLine: 'npm test', toolSummary: 'Run tests' };
  const claudeInput = mapToolInputToClaude('run_command', agyArgs);
  assert.deepStrictEqual(claudeInput, { command: 'npm test', description: 'Run tests' });
});

test('mapToolInputToClaude: maps write_to_file args to Write tool_input', () => {
  const agyArgs = { TargetFile: '/path/to/file.js', CodeContent: 'console.log("hello");' };
  const claudeInput = mapToolInputToClaude('write_to_file', agyArgs);
  assert.deepStrictEqual(claudeInput, { file_path: '/path/to/file.js', content: 'console.log("hello");' });
});

test('mapToolInputToClaude: maps replace_file_content args to Edit tool_input', () => {
  const agyArgs = { TargetFile: '/path/to/file.js', TargetContent: 'foo', ReplacementContent: 'bar' };
  const claudeInput = mapToolInputToClaude('replace_file_content', agyArgs);
  assert.deepStrictEqual(claudeInput, { file_path: '/path/to/file.js', old_string: 'foo', new_string: 'bar' });
});

test('mapToolInputToAgy: maps Bash tool_input to run_command args', () => {
  const claudeInput = { command: 'npm test', description: 'Run tests' };
  const agyArgs = mapToolInputToAgy('Bash', claudeInput);
  assert.deepStrictEqual(agyArgs, { CommandLine: 'npm test', toolSummary: 'Run tests' });
});

test('mapToolInputToAgy: maps Write tool_input to write_to_file args', () => {
  const claudeInput = { file_path: '/path/to/file.js', content: 'console.log("hello");' };
  const agyArgs = mapToolInputToAgy('Write', claudeInput);
  assert.deepStrictEqual(agyArgs, { TargetFile: '/path/to/file.js', CodeContent: 'console.log("hello");' });
});

test('translateInput: translates PreToolUse input correctly', () => {
  const agyPayload = {
    conversationId: 'uuid-123',
    transcriptPath: '/fake/transcript.jsonl',
    workspacePaths: ['/workspace/project'],
    stepIdx: 19,
    toolCall: {
      name: 'run_command',
      args: { CommandLine: 'echo hi' }
    }
  };
  const claudePayload = translateInput(agyPayload, 'PreToolUse');
  assert.strictEqual(claudePayload.session_id, 'uuid-123');
  assert.strictEqual(claudePayload.cwd, '/workspace/project');
  assert.strictEqual(claudePayload.hook_event_name, 'PreToolUse');
  assert.strictEqual(claudePayload.tool_name, 'Bash');
  assert.deepStrictEqual(claudePayload.tool_input, { command: 'echo hi' });
  assert.strictEqual(claudePayload.tool_use_id, 'toolu_agy_19');
});

test('translateOutput: handles permissionDecision mapping', () => {
  const claudeOutput = {
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: 'Not allowed'
    }
  };
  const agyOutput = translateOutput(claudeOutput, 'PreToolUse', 'run_command');
  assert.strictEqual(agyOutput.decision, 'deny');
  assert.strictEqual(agyOutput.reason, 'Not allowed');
});

test('translateOutput: maps updatedInput to overwrite', () => {
  const claudeOutput = {
    hookSpecificOutput: {
      permissionDecision: 'allow',
      updatedInput: {
        command: 'tmux new-session -d "echo hi"'
      }
    }
  };
  const agyOutput = translateOutput(claudeOutput, 'PreToolUse', 'run_command');
  assert.strictEqual(agyOutput.decision, 'allow');
  assert.deepStrictEqual(agyOutput.overwrite, { CommandLine: 'tmux new-session -d "echo hi"' });
});

test('mapToolNameToClaude: maps call_mcp_tool to mcp__server__tool', () => {
  const agyArgs = { ServerName: 'context7', ToolName: 'fetch_docs' };
  assert.strictEqual(mapToolNameToClaude('call_mcp_tool', agyArgs), 'mcp__context7__fetch_docs');
  // Fallback when ServerName is omitted
  assert.strictEqual(mapToolNameToClaude('call_mcp_tool', { ToolName: 'query' }), 'mcp__mcp__query');
});

test('mapToolInputToClaude: maps call_mcp_tool args (string and object)', () => {
  const agyArgsString = { ServerName: 'context7', ToolName: 'resolve', Args: JSON.stringify({ library: 'react' }) };
  assert.deepStrictEqual(mapToolInputToClaude('call_mcp_tool', agyArgsString), { library: 'react' });

  const agyArgsObj = { ServerName: 'context7', ToolName: 'resolve', Args: { library: 'vue' } };
  assert.deepStrictEqual(mapToolInputToClaude('call_mcp_tool', agyArgsObj), { library: 'vue' });
});

test('mapToolInputToAgy: maps mcp__server__tool to call_mcp_tool format', () => {
  const claudeInput = { library: 'react', version: '18' };
  const agyArgs = mapToolInputToAgy('mcp__context7__resolve', claudeInput);
  assert.strictEqual(agyArgs.ServerName, 'context7');
  assert.strictEqual(agyArgs.ToolName, 'resolve');
  assert.strictEqual(agyArgs.Args, JSON.stringify(claudeInput));
});

test('translateOutput: maps MCP updatedInput to overwrite with call_mcp_tool structure', () => {
  const claudeOutput = {
    hookSpecificOutput: {
      permissionDecision: 'allow',
      updatedInput: { path: '/safe/path.txt' }
    }
  };
  const originalAgyArgs = { ServerName: 'filesystem', ToolName: 'read_file', Args: '{"path":"/raw/path.txt"}' };
  const agyOutput = translateOutput(claudeOutput, 'PreToolUse', 'call_mcp_tool', originalAgyArgs);
  assert.strictEqual(agyOutput.decision, 'allow');
  assert.deepStrictEqual(agyOutput.overwrite, {
    ServerName: 'filesystem',
    ToolName: 'read_file',
    Arguments: { path: '/safe/path.txt' },
    Args: JSON.stringify({ path: '/safe/path.txt' })
  });
});

test('translateOutput: maps Stop decision: block and reason to continue decision', () => {
  const claudeOutput = { decision: 'block', reason: 'Review required' };
  const agyOutput = translateOutput(claudeOutput, 'Stop');
  assert.strictEqual(agyOutput.decision, 'continue');
  assert.strictEqual(agyOutput.reason, 'Review required');
});

test('translateOutput: maps Stop continue: false and stopReason to continue decision', () => {
  const claudeOutput = { continue: false, stopReason: 'Quality gate failed' };
  const agyOutput = translateOutput(claudeOutput, 'Stop');
  assert.strictEqual(agyOutput.decision, 'continue');
  assert.strictEqual(agyOutput.reason, 'Quality gate failed');
});

test('mapToolInputToClaude: maps find_by_name to Glob with path and search_directory', () => {
  const agyArgs = { Pattern: '*.js', SearchDirectory: '/src' };
  const claudeInput = mapToolInputToClaude('find_by_name', agyArgs);
  assert.strictEqual(claudeInput.pattern, '*.js');
  assert.strictEqual(claudeInput.path, '/src');
  assert.strictEqual(claudeInput.search_directory, '/src');
});

test('mapToolInputToAgy: maps Glob with path to find_by_name with SearchDirectory', () => {
  const claudeInput = { pattern: '*.js', path: '/src' };
  const agyArgs = mapToolInputToAgy('Glob', claudeInput);
  assert.strictEqual(agyArgs.Pattern, '*.js');
  assert.strictEqual(agyArgs.SearchDirectory, '/src');
});

test('mapToolInputToClaude: maps grep_search to Grep with path, search_path, pattern, query', () => {
  const agyArgs = { Query: 'function test', SearchPath: '/src' };
  const claudeInput = mapToolInputToClaude('grep_search', agyArgs);
  assert.strictEqual(claudeInput.query, 'function test');
  assert.strictEqual(claudeInput.pattern, 'function test');
  assert.strictEqual(claudeInput.path, '/src');
  assert.strictEqual(claudeInput.search_path, '/src');
});

test('mapToolInputToAgy: maps Grep with pattern and path to grep_search with Query and SearchPath', () => {
  const claudeInput = { pattern: 'function test', path: '/src' };
  const agyArgs = mapToolInputToAgy('Grep', claudeInput);
  assert.strictEqual(agyArgs.Query, 'function test');
  assert.strictEqual(agyArgs.SearchPath, '/src');
});

test('mapToolInputToClaude: maps list_dir to LS with path and directory_path', () => {
  const agyArgs = { DirectoryPath: '/var/log' };
  const claudeInput = mapToolInputToClaude('list_dir', agyArgs);
  assert.strictEqual(claudeInput.path, '/var/log');
  assert.strictEqual(claudeInput.directory_path, '/var/log');
});

test('mapToolInputToAgy: maps LS with path to list_dir with DirectoryPath', () => {
  const claudeInput = { path: '/var/log' };
  const agyArgs = mapToolInputToAgy('LS', claudeInput);
  assert.strictEqual(agyArgs.DirectoryPath, '/var/log');
});

test('mapToolInputToClaude: maps view_file with StartLine and EndLine to Read with offset and limit', () => {
  const agyArgs = { AbsolutePath: '/src/index.js', StartLine: 10, EndLine: 25 };
  const claudeInput = mapToolInputToClaude('view_file', agyArgs);
  assert.strictEqual(claudeInput.file_path, '/src/index.js');
  assert.strictEqual(claudeInput.offset, 10);
  assert.strictEqual(claudeInput.limit, 16);
});

test('mapToolInputToAgy: maps Read with offset and limit to view_file with StartLine and EndLine', () => {
  const claudeInput = { file_path: '/src/index.js', offset: 10, limit: 16 };
  const agyArgs = mapToolInputToAgy('Read', claudeInput);
  assert.strictEqual(agyArgs.AbsolutePath, '/src/index.js');
  assert.strictEqual(agyArgs.StartLine, 10);
  assert.strictEqual(agyArgs.EndLine, 25);
});

test('mapToolInputToClaude: maps native Antigravity call_mcp_tool with Arguments', () => {
  const agyArgs = { ServerName: 'context7', ToolName: 'resolve', Arguments: { library: 'svelte' } };
  assert.deepStrictEqual(mapToolInputToClaude('call_mcp_tool', agyArgs), { library: 'svelte' });
});

test('mapToolInputToAgy: maps mcp tool to call_mcp_tool with Arguments object and Args string', () => {
  const claudeInput = { library: 'svelte' };
  const agyArgs = mapToolInputToAgy('mcp__context7__resolve', claudeInput);
  assert.strictEqual(agyArgs.ServerName, 'context7');
  assert.strictEqual(agyArgs.ToolName, 'resolve');
  assert.deepStrictEqual(agyArgs.Arguments, { library: 'svelte' });
  assert.strictEqual(agyArgs.Args, JSON.stringify({ library: 'svelte' }));
});

test('translateInput: maps transcript_path to CLAUDE_TRANSCRIPT_PATH when env var is set', () => {
  const oldEnv = process.env.CLAUDE_TRANSCRIPT_PATH;
  try {
    process.env.CLAUDE_TRANSCRIPT_PATH = '/path/to/claude-compat-transcript.jsonl';
    const agyPayload = {
      conversationId: 'uuid-123',
      transcriptPath: '/path/to/raw-agy-transcript.jsonl',
      workspacePaths: ['/workspace/project']
    };
    const claudePayload = translateInput(agyPayload, 'Stop');
    assert.strictEqual(claudePayload.transcript_path, '/path/to/claude-compat-transcript.jsonl');
  } finally {
    if (oldEnv !== undefined) {
      process.env.CLAUDE_TRANSCRIPT_PATH = oldEnv;
    } else {
      delete process.env.CLAUDE_TRANSCRIPT_PATH;
    }
  }
});

test('translateInput: falls back to agyPayload.transcriptPath when CLAUDE_TRANSCRIPT_PATH is unset', () => {
  const oldEnv = process.env.CLAUDE_TRANSCRIPT_PATH;
  try {
    delete process.env.CLAUDE_TRANSCRIPT_PATH;
    const agyPayload = {
      conversationId: 'uuid-123',
      transcriptPath: '/path/to/raw-agy-transcript.jsonl',
      workspacePaths: ['/workspace/project']
    };
    const claudePayload = translateInput(agyPayload, 'Stop');
    assert.strictEqual(claudePayload.transcript_path, '/path/to/raw-agy-transcript.jsonl');
  } finally {
    if (oldEnv !== undefined) {
      process.env.CLAUDE_TRANSCRIPT_PATH = oldEnv;
    } else {
      delete process.env.CLAUDE_TRANSCRIPT_PATH;
    }
  }
});

test('mapToolInputToClaude: maps direct multi_replace_file_content with ReplacementChunks to MultiEdit', () => {
  const agyArgs = {
    TargetFile: '/path/to/app.js',
    ReplacementChunks: [
      {
        TargetContent: 'const a = 1;',
        ReplacementContent: 'const a = 2;',
        AllowMultiple: true
      }
    ]
  };
  const claudeInput = mapToolInputToClaude('multi_replace_file_content', agyArgs);
  assert.strictEqual(claudeInput.file_path, '/path/to/app.js');
  assert.deepStrictEqual(claudeInput.edits, [
    {
      file_path: '/path/to/app.js',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
      replace_all: true
    }
  ]);
});

test('mapToolInputToAgy: maps MultiEdit with edits array to multi_replace_file_content with ReplacementChunks', () => {
  const claudeInput = {
    file_path: '/path/to/app.js',
    edits: [
      {
        file_path: '/path/to/app.js',
        old_string: 'old block 1',
        new_string: 'new block 1',
        replace_all: false
      },
      {
        old_string: 'old block 2',
        new_string: 'new block 2'
      }
    ]
  };
  const agyArgs = mapToolInputToAgy('MultiEdit', claudeInput);
  assert.strictEqual(agyArgs.TargetFile, '/path/to/app.js');
  assert.ok(Array.isArray(agyArgs.ReplacementChunks));
  assert.strictEqual(agyArgs.ReplacementChunks.length, 2);
  assert.deepStrictEqual(agyArgs.ReplacementChunks[0], {
    TargetContent: 'old block 1',
    ReplacementContent: 'new block 1',
    AllowMultiple: false
  });
  assert.deepStrictEqual(agyArgs.ReplacementChunks[1], {
    TargetContent: 'old block 2',
    ReplacementContent: 'new block 2'
  });
});

test('mapToolInputToAgy: MultiEdit multi-file edits are filtered to the target file only (Constraint 5)', () => {
  const claudeInput = {
    file_path: '/path/to/first.js',
    edits: [
      {
        file_path: '/path/to/first.js',
        old_string: 'first file edit',
        new_string: 'first file modified'
      },
      {
        file_path: '/path/to/second.js',
        old_string: 'second file edit',
        new_string: 'second file modified'
      }
    ]
  };
  const agyArgs = mapToolInputToAgy('MultiEdit', claudeInput);
  assert.strictEqual(agyArgs.TargetFile, '/path/to/first.js');
  assert.strictEqual(agyArgs.ReplacementChunks.length, 1);
  assert.strictEqual(agyArgs.ReplacementChunks[0].TargetContent, 'first file edit');
  assert.strictEqual(agyArgs.ReplacementChunks[0].ReplacementContent, 'first file modified');
});

test('translateOutput: maps MultiEdit updatedInput to direct overwrite when original was native multi_replace_file_content', () => {
  const claudeOutput = {
    hookSpecificOutput: {
      permissionDecision: 'allow',
      updatedInput: {
        file_path: '/path/to/app.js',
        edits: [
          {
            old_string: 'const foo = 1;',
            new_string: 'const foo = 2;'
          }
        ]
      }
    }
  };
  const originalAgyArgs = {
    TargetFile: '/path/to/app.js',
    ReplacementChunks: [{ TargetContent: 'const foo = 1;', ReplacementContent: 'const foo = 2;' }]
  };
  const agyOutput = translateOutput(claudeOutput, 'PreToolUse', 'multi_replace_file_content', originalAgyArgs);
  assert.strictEqual(agyOutput.decision, 'allow');
  assert.deepStrictEqual(agyOutput.overwrite, {
    TargetFile: '/path/to/app.js',
    ReplacementChunks: [{ TargetContent: 'const foo = 1;', ReplacementContent: 'const foo = 2;' }]
  });
});

test('mapToolNameToClaude: maps view_file with IsSkillFile: true to Skill', () => {
  assert.strictEqual(mapToolNameToClaude('view_file', { AbsolutePath: '/any/path/file.txt', IsSkillFile: true }), 'Skill');
});

test('mapToolNameToClaude: maps view_file on SKILL.md path to Skill when IsSkillFile is omitted', () => {
  assert.strictEqual(mapToolNameToClaude('view_file', { AbsolutePath: '/workspace/.agent/skills/tdd-workflow/SKILL.md' }), 'Skill');
  assert.strictEqual(mapToolNameToClaude('view_file', { AbsolutePath: 'C:\\workspace\\skills\\tdd-workflow\\SKILL.md' }), 'Skill');
});

test('mapToolNameToClaude: maps view_file with IsSkillFile: false to Read even if path ends with SKILL.md', () => {
  assert.strictEqual(mapToolNameToClaude('view_file', { AbsolutePath: '/workspace/skills/tdd-workflow/SKILL.md', IsSkillFile: false }), 'Read');
});

test('mapToolNameToClaude: maps view_file on non-skill files to Read', () => {
  assert.strictEqual(mapToolNameToClaude('view_file', { AbsolutePath: '/workspace/src/index.js' }), 'Read');
  assert.strictEqual(mapToolNameToClaude('view_file', { AbsolutePath: '/workspace/skills/my-skills.txt' }), 'Read');
});

test('mapToolNameToAgy: maps Skill to view_file', () => {
  assert.strictEqual(mapToolNameToAgy('Skill'), 'view_file');
});

test('mapToolInputToClaude: maps view_file skill invocation to Claude Skill input with skill and skill_id', () => {
  const agyArgs = { AbsolutePath: '/workspace/.agent/skills/tdd-workflow/SKILL.md', IsSkillFile: true };
  const claudeInput = mapToolInputToClaude('view_file', agyArgs);
  assert.strictEqual(claudeInput.skill, 'tdd-workflow');
  assert.strictEqual(claudeInput.skill_id, 'tdd-workflow');
  assert.strictEqual(claudeInput.file_path, '/workspace/.agent/skills/tdd-workflow/SKILL.md');
});

test('mapToolInputToAgy: maps Skill with file_path to view_file args with IsSkillFile: true', () => {
  const claudeInput = { file_path: '/workspace/.agent/skills/tdd-workflow/SKILL.md' };
  const agyArgs = mapToolInputToAgy('Skill', claudeInput);
  assert.strictEqual(agyArgs.AbsolutePath, '/workspace/.agent/skills/tdd-workflow/SKILL.md');
  assert.strictEqual(agyArgs.IsSkillFile, true);
});

test('mapToolInputToAgy: maps Skill with only skill name by resolving AbsolutePath', () => {
  const claudeInput = { skill: 'tdd-workflow' };
  const agyArgs = mapToolInputToAgy('Skill', claudeInput);
  assert.ok(agyArgs.AbsolutePath, 'AbsolutePath must be resolved');
  assert.ok(agyArgs.AbsolutePath.endsWith('SKILL.md'), 'AbsolutePath must end with SKILL.md');
  assert.strictEqual(agyArgs.IsSkillFile, true);
});

test('translateInput: maps view_file skill call to tool_name Skill and passes skill-run-tracker extraction', () => {
  const { extractSkillId } = require('../../../scripts/hooks/skill-run-tracker');
  const agyPayload = {
    conversationId: 'uuid-456',
    workspacePaths: ['/workspace/project'],
    toolCall: {
      name: 'view_file',
      args: { AbsolutePath: '/workspace/.agent/skills/agent-sort/SKILL.md', IsSkillFile: true }
    }
  };
  const claudePayload = translateInput(agyPayload, 'PreToolUse');
  assert.strictEqual(claudePayload.tool_name, 'Skill');
  assert.strictEqual(claudePayload.tool_input.skill, 'agent-sort');
  assert.strictEqual(claudePayload.tool_input.skill_id, 'agent-sort');
  assert.strictEqual(extractSkillId(claudePayload.tool_input), 'agent-sort');
});

test('translateOutput: maps Skill updatedInput to view_file overwrite with AbsolutePath', () => {
  const claudeOutput = {
    hookSpecificOutput: {
      permissionDecision: 'allow',
      updatedInput: {
        skill: 'tdd-workflow'
      }
    }
  };
  const originalAgyArgs = { AbsolutePath: '/some/path/SKILL.md', IsSkillFile: true };
  const agyOutput = translateOutput(claudeOutput, 'PreToolUse', 'view_file', originalAgyArgs);
  assert.strictEqual(agyOutput.decision, 'allow');
  assert.ok(agyOutput.overwrite);
  assert.ok(agyOutput.overwrite.AbsolutePath);
  assert.strictEqual(agyOutput.overwrite.IsSkillFile, true);
});

test('extractSkillName: extracts skill directory name accurately', () => {
  assert.strictEqual(extractSkillName('/workspace/.agent/skills/tdd-workflow/SKILL.md'), 'tdd-workflow');
  assert.strictEqual(extractSkillName('C:\\workspace\\skills\\code-reviewer\\SKILL.md'), 'code-reviewer');
  assert.strictEqual(extractSkillName('/workspace/skills/agent-sort'), 'agent-sort');
  assert.strictEqual(extractSkillName('/custom/path/my-special-skill/SKILL.md'), 'my-special-skill');
});

test('resolveSkillPath: resolves existing skill or returns fallback path', () => {
  const existingPath = resolveSkillPath('tdd-workflow');
  assert.ok(existingPath.endsWith('SKILL.md'));
  assert.ok(require('fs').existsSync(existingPath), 'Resolved path should exist for known skill');

  const fallbackPath = resolveSkillPath('non-existent-dummy-skill');
  assert.ok(fallbackPath.endsWith('SKILL.md'));
  assert.ok(fallbackPath.includes('non-existent-dummy-skill'));
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);

