'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

function isSkillInvocation(agyToolName, agyArgs) {
  if (agyToolName !== 'view_file' || !agyArgs) return false;

  const rawArgs = typeof agyArgs === 'string'
    ? (function() { try { return JSON.parse(agyArgs); } catch(_) { return {}; } })()
    : agyArgs;

  if (rawArgs.IsSkillFile === true) return true;
  if (rawArgs.IsSkillFile === false) return false;

  const filePath = rawArgs.AbsolutePath || '';
  return /[/\\]skills[/\\][^/\\]+[/\\]SKILL\.md$/i.test(filePath);
}

function extractSkillName(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  const match = filePath.match(/[/\\]skills[/\\]([^/\\]+)(?:[/\\]SKILL\.md)?$/i);
  if (match) return match[1];
  const base = path.basename(filePath, path.extname(filePath));
  if (base.toLowerCase() === 'skill') {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== '.' && parent !== '/' && parent !== '\\') {
      return parent;
    }
  }
  return base || 'unknown';
}

function resolveSkillPath(skillName, preferredPath) {
  if (preferredPath && typeof preferredPath === 'string' && fs.existsSync(preferredPath)) {
    return preferredPath;
  }

  if (!skillName || typeof skillName !== 'string') {
    return preferredPath || '';
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const homeDir = os.homedir();

  const candidateDirs = [
    path.join(projectDir, '.agent', 'skills'),
    path.join(projectDir, '.agents', 'skills'),
    path.join(projectDir, '.claude', 'skills'),
    path.join(projectDir, 'skills'),
    pluginRoot ? path.join(pluginRoot, 'skills') : null,
    path.join(homeDir, '.gemini', 'antigravity', 'builtin', 'skills'),
    path.join(homeDir, '.claude', 'skills'),
    path.join(homeDir, '.agents', 'skills')
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, skillName, 'SKILL.md');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return preferredPath || path.join(projectDir, 'skills', skillName, 'SKILL.md');
}

function mapToolNameToClaude(agyToolName, agyArgs) {
  if (isSkillInvocation(agyToolName, agyArgs)) {
    return 'Skill';
  }

  const map = {
    run_command: 'Bash',
    write_to_file: 'Write',
    replace_file_content: 'Edit',
    multi_replace_file_content: 'MultiEdit',
    view_file: 'Read',
    find_by_name: 'Glob',
    grep_search: 'Grep',
    list_dir: 'LS'
  };
  if (agyToolName === 'call_mcp_tool') {
    return `mcp__${agyArgs?.ServerName || 'mcp'}__${agyArgs?.ToolName}`;
  }
  return map[agyToolName] || agyToolName;
}

function mapToolNameToAgy(claudeToolName) {
  const map = {
    Bash: 'run_command',
    Write: 'write_to_file',
    Edit: 'replace_file_content',
    MultiEdit: 'multi_replace_file_content',
    Read: 'view_file',
    Skill: 'view_file',
    Glob: 'find_by_name',
    Grep: 'grep_search',
    LS: 'list_dir'
  };
  if (claudeToolName?.startsWith('mcp__')) {
    return 'call_mcp_tool';
  }
  return map[claudeToolName] || claudeToolName;
}

function filterUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([_, v]) => v !== undefined));
}

function mapToolInputToClaude(agyToolName, agyArgs) {
  const map = {
    run_command: args => {
      const res = {
        command: args.CommandLine || args.command,
        description: args.toolSummary || args.description
      };
      if (args.Cwd || args.cwd) res.cwd = args.Cwd || args.cwd;
      return res;
    },
    write_to_file: args => ({
      file_path: args.TargetFile || args.file_path,
      content: args.CodeContent !== undefined ? args.CodeContent : args.content
    }),
    replace_file_content: args => ({
      file_path: args.TargetFile || args.file_path,
      old_string: args.TargetContent !== undefined ? args.TargetContent : args.old_string,
      new_string: args.ReplacementContent !== undefined ? args.ReplacementContent : args.new_string
    }),
    multi_replace_file_content: args => {
      const targetFile = args.TargetFile || args.file_path;
      const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
      const edits = chunks.map(chunk => filterUndefined({
        file_path: targetFile,
        old_string: chunk.TargetContent,
        new_string: chunk.ReplacementContent,
        replace_all: chunk.AllowMultiple
      }));

      return filterUndefined({
        file_path: targetFile,
        edits
      });
    },
    view_file: args => {
      if (isSkillInvocation('view_file', args)) {
        const filePath = args.AbsolutePath || '';
        const skillName = extractSkillName(filePath);
        return filterUndefined({
          skill: skillName,
          skill_id: skillName,
          file_path: filePath
        });
      }

      const res = { file_path: args.AbsolutePath || args.file_path };
      if (args.StartLine !== undefined) res.offset = args.StartLine;
      if (args.StartLine !== undefined && args.EndLine !== undefined) {
        res.limit = args.EndLine - args.StartLine + 1;
      }
      return res;
    },
    find_by_name: args => ({
      pattern: args.Pattern || args.pattern,
      path: args.SearchDirectory || args.path || args.search_directory,
      search_directory: args.SearchDirectory || args.path || args.search_directory
    }),
    grep_search: args => ({
      query: args.Query || args.query,
      pattern: args.Query || args.pattern || args.query,
      path: args.SearchPath || args.path || args.search_path,
      search_path: args.SearchPath || args.path || args.search_path
    }),
    list_dir: args => ({
      path: args.DirectoryPath || args.path || args.directory_path,
      directory_path: args.DirectoryPath || args.path || args.directory_path
    })
  };

  if (agyToolName === 'call_mcp_tool') {
    const rawArgs = agyArgs?.Arguments !== undefined ? agyArgs.Arguments : agyArgs?.Args;
    let parsed = {};
    try {
      parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
    } catch (_error) {
      parsed = rawArgs || {};
    }
    return parsed;
  }

  if (!map[agyToolName]) {
    return agyArgs;
  }

  return filterUndefined(map[agyToolName](agyArgs));
}

function mapToolInputToAgy(claudeToolName, claudeInput) {
  const map = {
    Bash: input => filterUndefined({
      CommandLine: input.command || input.CommandLine,
      toolSummary: input.description || input.toolSummary,
      Cwd: input.cwd || input.Cwd
    }),
    Write: input => filterUndefined({
      TargetFile: input.file_path || input.TargetFile,
      CodeContent: input.content !== undefined ? input.content : input.CodeContent
    }),
    Edit: input => filterUndefined({
      TargetFile: input.file_path || input.TargetFile,
      TargetContent: input.old_string !== undefined ? input.old_string : input.TargetContent,
      ReplacementContent: input.new_string !== undefined ? input.new_string : input.ReplacementContent
    }),
    MultiEdit: input => {
      const targetFile = input.file_path || input.TargetFile || input.edits?.[0]?.file_path;
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const relevantEdits = targetFile
        ? edits.filter(e => !e.file_path || e.file_path === targetFile)
        : edits;

      const chunks = relevantEdits.map(edit => filterUndefined({
        TargetContent: edit.old_string,
        ReplacementContent: edit.new_string,
        AllowMultiple: edit.replace_all
      }));

      return filterUndefined({
        TargetFile: targetFile,
        ReplacementChunks: chunks,
        Instruction: input.Instruction || input.instruction,
        Description: input.Description || input.description
      });
    },
    Read: input => {
      const res = { AbsolutePath: input.file_path || input.AbsolutePath };
      if (input.offset !== undefined) {
        res.StartLine = input.offset;
        if (input.limit !== undefined) {
          res.EndLine = input.offset + input.limit - 1;
        }
      }
      return filterUndefined(res);
    },
    Skill: input => {
      const skillName = input.skill || input.skill_id;
      const explicitPath = input.file_path;
      const resolvedPath = resolveSkillPath(skillName, explicitPath);

      return filterUndefined({
        AbsolutePath: resolvedPath,
        IsSkillFile: true
      });
    },
    Glob: input => filterUndefined({
      Pattern: input.pattern || input.Pattern,
      SearchDirectory: input.path || input.search_directory || input.SearchDirectory
    }),
    Grep: input => filterUndefined({
      Query: input.query || input.pattern || input.Query,
      SearchPath: input.path || input.search_path || input.SearchPath
    }),
    LS: input => filterUndefined({
      DirectoryPath: input.path || input.directory_path || input.DirectoryPath
    })
  };

  if (claudeToolName?.startsWith('mcp__')) {
    const parts = claudeToolName.split('__');
    const serverName = parts[1] || 'mcp';
    const toolName = parts.slice(2).join('__');
    const argsObject = typeof claudeInput === 'string'
      ? (function() { try { return JSON.parse(claudeInput); } catch(_) { return claudeInput; } })()
      : (claudeInput || {});
    const argsString = typeof claudeInput === 'string'
      ? claudeInput
      : JSON.stringify(claudeInput || {});

    return {
      ServerName: serverName,
      ToolName: toolName,
      Arguments: argsObject,
      Args: argsString
    };
  }

  if (!map[claudeToolName]) {
    return claudeInput;
  }

  return map[claudeToolName](claudeInput);
}

function translateInput(agyPayload, hookEventName) {
  const claudePayload = {
    session_id: agyPayload.conversationId,
    // The shim logic resolves the transcriptPath to the compat transcript path.
    // We assume the caller (agy-adapter) injects it into process.env before this.
    // Map to the shimmed Claude-compatible transcript when available, falling back to agyPayload.transcriptPath.
    transcript_path: process.env.CLAUDE_TRANSCRIPT_PATH || agyPayload.transcriptPath,
    cwd: (agyPayload.workspacePaths && agyPayload.workspacePaths.length > 0) ? agyPayload.workspacePaths[0] : process.cwd(),
    hook_event_name: hookEventName
  };

  if (agyPayload.stepIdx !== undefined) {
    claudePayload.tool_use_id = `toolu_agy_${agyPayload.stepIdx}`;
  }

  if (agyPayload.toolCall) {
    claudePayload.tool_name = mapToolNameToClaude(agyPayload.toolCall.name, agyPayload.toolCall.args);
    claudePayload.tool_input = mapToolInputToClaude(agyPayload.toolCall.name, agyPayload.toolCall.args);
  }

  if (agyPayload.error) {
    claudePayload.error = agyPayload.error;
  }

  return claudePayload;
}

function translateOutput(claudeOutput, hookEventName, agyToolName, agyArgs) {
  const agyOutput = {};

  if (claudeOutput.hookSpecificOutput) {
    const specific = claudeOutput.hookSpecificOutput;
    if (specific.permissionDecision) {
      if (specific.permissionDecision === 'allow') {
        agyOutput.decision = 'allow';
      } else {
        agyOutput.decision = specific.permissionDecision;
        agyOutput.reason = specific.permissionDecisionReason;
      }
    }

    if (specific.updatedInput) {
      const claudeToolName = mapToolNameToClaude(agyToolName, agyArgs);
      agyOutput.overwrite = mapToolInputToAgy(claudeToolName, specific.updatedInput);
    }
  }

  // Handle 'Stop' hook translation
  if (claudeOutput.decision === 'block' || claudeOutput.continue === false) {
    agyOutput.decision = 'continue';
    agyOutput.reason = claudeOutput.reason || claudeOutput.stopReason || 'Blocked by hook';
  } else if (claudeOutput.decision === 'continue') {
    agyOutput.decision = 'continue';
    agyOutput.reason = claudeOutput.reason;
  }

  return agyOutput;
}

module.exports = {
  mapToolNameToClaude,
  mapToolNameToAgy,
  mapToolInputToClaude,
  mapToolInputToAgy,
  translateInput,
  translateOutput,
  isSkillInvocation,
  extractSkillName,
  resolveSkillPath
};
