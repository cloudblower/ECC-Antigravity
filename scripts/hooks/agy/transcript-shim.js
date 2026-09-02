'use strict';
const fs = require('fs');
const {
  mapToolNameToClaude,
  mapToolNameToAgy,
  mapToolInputToClaude,
  mapToolInputToAgy
} = require('./schema-translate');

const TOOL_RESULT_TYPES = new Set([
  'GENERIC',
  'TOOL_RESULT',
  'RUN_COMMAND',
  'VIEW_FILE',
  'LIST_DIRECTORY',
  'READ_URL_CONTENT',
  'INVOKE_SUBAGENT',
  'GREP_SEARCH',
  'SEARCH_WEB',
  'ASK_QUESTION',
  'CODE_ACTION',
  'MCP_TOOL'
]);

function estimateTextTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

function updateContextWindowEnvForModel(model) {
  if (!model || typeof model !== 'string') return;
  const lower = model.toLowerCase();
  if (lower.includes('gemini')) {
    process.env.ECC_CONTEXT_WINDOW_TOKENS = '1000000';
  } else if (lower.includes('[1m]') || /claude-(opus-5|fable-5|mythos-5)/i.test(model)) {
    process.env.ECC_CONTEXT_WINDOW_TOKENS = '1000000';
  } else if (/claude-(sonnet|haiku|opus)-[34]/i.test(model)) {
    process.env.ECC_CONTEXT_WINDOW_TOKENS = '200000';
  }
}

function normalizeModelName(model) {
  if (!model) return 'gemini-3';
  return model;
}

function createTranscriptContextTracker(options = {}) {
  const BASE_SYSTEM_TOKENS = 2500;
  let cumulativeInputTokens = BASE_SYSTEM_TOKENS;
  let currentModel = options.model || process.env.AGY_MODEL_NAME || process.env.ECC_OBSERVER_MODEL || 'gemini-3';

  return {
    processLine(agyObj) {
      if (agyObj.model) {
        currentModel = agyObj.model;
      } else if (agyObj.content && typeof agyObj.content === 'string') {
        const modelMatch = agyObj.content.match(/Model Selection` from .+? to ([^<\n]+?)(?:\.\s|\.$|\.?(?=<)|$)/i);
        if (modelMatch) {
          const raw = modelMatch[1].trim();
          if (/gemini/i.test(raw) || /claude/i.test(raw)) {
            currentModel = raw.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/-+$/, '');
          }
        }
      }

      if (agyObj.type === 'CHECKPOINT') {
        cumulativeInputTokens = BASE_SYSTEM_TOKENS + estimateTextTokens(agyObj.content);
        return translateTranscriptLine(agyObj);
      }

      if (agyObj.type === 'PLANNER_RESPONSE') {
        const textTokens = estimateTextTokens(agyObj.content);
        const thinkingTokens = estimateTextTokens(agyObj.thinking);
        const toolTokens = agyObj.tool_calls ? estimateTextTokens(JSON.stringify(agyObj.tool_calls)) : 0;
        const outputTokens = Math.max(1, textTokens + thinkingTokens + toolTokens);

        const turnInputTokens = agyObj.usage?.input_tokens ?? cumulativeInputTokens;
        const turnOutputTokens = agyObj.usage?.output_tokens ?? outputTokens;
        const formattedModel = normalizeModelName(agyObj.model || currentModel);

        cumulativeInputTokens += outputTokens;

        return translateTranscriptLine(agyObj, {
          model: formattedModel,
          usage: {
            input_tokens: turnInputTokens,
            output_tokens: turnOutputTokens,
            cache_read_input_tokens: agyObj.usage?.cache_read_input_tokens || 0,
            cache_creation_input_tokens: agyObj.usage?.cache_creation_input_tokens || 0
          }
        });
      }

      const contentTokens = estimateTextTokens(agyObj.content);
      cumulativeInputTokens += contentTokens;

      return translateTranscriptLine(agyObj);
    }
  };
}

function translateTranscriptLine(agyLine, context) {
  if (agyLine.type === 'USER_INPUT') {
    return {
      type: 'user',
      message: { role: 'user', content: agyLine.content || '' }
    };
  }
  
  if (
    agyLine.type === 'SYSTEM' ||
    agyLine.type === 'CHECKPOINT' ||
    agyLine.type === 'SYSTEM_MESSAGE' ||
    agyLine.type === 'EPHEMERAL_MESSAGE' ||
    agyLine.type === 'ERROR_MESSAGE' ||
    agyLine.type === 'CONVERSATION_HISTORY'
  ) {
    return {
      type: 'system',
      message: { role: 'system', content: agyLine.content || agyLine.error || '' }
    };
  }
  
  if (agyLine.type === 'PLANNER_RESPONSE') {
    const content = [];
    if (agyLine.content) {
      content.push({ type: 'text', text: agyLine.content });
    }
    if (agyLine.tool_calls && Array.isArray(agyLine.tool_calls)) {
      agyLine.tool_calls.forEach((call, idx) => {
        const toolName = call.name || call.function?.name || '';
        const rawArgs = call.args !== undefined ? call.args : (call.function?.arguments !== undefined ? call.function.arguments : {});
        let args = {};
        try {
          args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
        } catch (_error) {
          args = rawArgs || {};
        }

        const toolUseId = call.id || call.call_id || ('toolu_agy_' + (agyLine.step_index !== undefined ? agyLine.step_index : 0) + (agyLine.tool_calls.length > 1 ? `_${idx}` : ''));
        content.push({
          type: 'tool_use',
          id: toolUseId,
          name: mapToolNameToClaude(toolName, args),
          input: mapToolInputToClaude(toolName, args)
        });
      });
    }

    const message = { role: 'assistant', content };
    if (context && context.model) {
      message.model = context.model;
    } else if (agyLine.model) {
      message.model = agyLine.model;
    }

    if (context && context.usage) {
      message.usage = context.usage;
    } else if (agyLine.usage) {
      message.usage = agyLine.usage;
    }

    return {
      type: 'assistant',
      message
    };
  }
  
  if (TOOL_RESULT_TYPES.has(agyLine.type) || agyLine.source === 'TOOL_RESULT') {
    const toolUseId = (agyLine.tool_calls && agyLine.tool_calls[0] && (agyLine.tool_calls[0].id || agyLine.tool_calls[0].call_id))
      || agyLine.tool_use_id
      || agyLine.call_id
      || ('toolu_agy_' + (agyLine.step_index !== undefined ? agyLine.step_index : 'unknown'));

    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: agyLine.content || '',
      is_error: agyLine.status === 'ERROR' || Boolean(agyLine.error)
    };
  }

  // Fallback
  return { type: 'unknown', original: agyLine };
}

function translateClaudeTranscriptLineToAgy(claudeLine) {
  const timestamp = claudeLine.created_at || claudeLine.timestamp || new Date().toISOString();
  const stepIndex = Number.isInteger(claudeLine.step_index) ? claudeLine.step_index : 0;

  // 1. User messages
  if (claudeLine.type === 'user' || claudeLine.role === 'user' || claudeLine.message?.role === 'user') {
    const rawContent = claudeLine.message?.content ?? claudeLine.content;
    
    // Check if user content contains a tool_result block (Anthropic API format)
    if (Array.isArray(rawContent)) {
      const toolResultBlock = rawContent.find(b => b && b.type === 'tool_result');
      if (toolResultBlock) {
        return {
          step_index: stepIndex,
          source: 'MODEL',
          type: 'GENERIC',
          status: toolResultBlock.is_error ? 'ERROR' : 'DONE',
          created_at: timestamp,
          content: typeof toolResultBlock.content === 'string' ? toolResultBlock.content : JSON.stringify(toolResultBlock.content || ''),
          tool_use_id: toolResultBlock.tool_use_id || ('toolu_agy_' + stepIndex)
        };
      }
    }

    const text = typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.filter(c => c && (c.type === 'text' || typeof c === 'string')).map(c => typeof c === 'string' ? c : c.text).join('\n')
        : '';

    return {
      step_index: stepIndex,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: timestamp,
      content: text
    };
  }

  // 2. Assistant messages
  if (claudeLine.type === 'assistant' || claudeLine.role === 'assistant' || claudeLine.message?.role === 'assistant') {
    const contentBlocks = Array.isArray(claudeLine.message?.content)
      ? claudeLine.message.content
      : Array.isArray(claudeLine.content)
        ? claudeLine.content
        : [];

    let textContent = '';
    let thinkingContent = '';
    const toolCalls = [];

    if (typeof (claudeLine.message?.content ?? claudeLine.content) === 'string') {
      textContent = claudeLine.message?.content ?? claudeLine.content;
    }

    for (const block of contentBlocks) {
      if (!block) continue;
      if (block.type === 'text') {
        textContent += (textContent ? '\n' : '') + (block.text || '');
      } else if (block.type === 'thinking') {
        thinkingContent += (thinkingContent ? '\n' : '') + (block.thinking || '');
      } else if (block.type === 'tool_use') {
        const agyToolName = mapToolNameToAgy(block.name);
        const agyToolArgs = mapToolInputToAgy(block.name, block.input || {});
        const callObj = {
          name: agyToolName,
          args: agyToolArgs
        };
        if (block.id) {
          callObj.id = block.id;
        }
        toolCalls.push(callObj);
      }
    }

    const res = {
      step_index: stepIndex,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: timestamp,
      content: textContent
    };
    if (thinkingContent) {
      res.thinking = thinkingContent;
    }
    if (toolCalls.length > 0) {
      res.tool_calls = toolCalls;
    }
    const model = claudeLine.message?.model || claudeLine.model;
    if (model) {
      res.model = model;
    }
    const usage = claudeLine.message?.usage || claudeLine.usage;
    if (usage) {
      res.usage = usage;
    }
    return res;
  }

  // 3. Tool results (direct entry)
  if (claudeLine.type === 'tool_result') {
    return {
      step_index: stepIndex,
      source: 'MODEL',
      type: 'GENERIC',
      status: claudeLine.is_error ? 'ERROR' : 'DONE',
      created_at: timestamp,
      content: typeof claudeLine.content === 'string' ? claudeLine.content : JSON.stringify(claudeLine.content || ''),
      tool_use_id: claudeLine.tool_use_id || ('toolu_agy_' + stepIndex)
    };
  }

  // 4. Direct tool_use entries
  if (claudeLine.type === 'tool_use' || claudeLine.tool_name) {
    const toolName = claudeLine.tool_name || claudeLine.name;
    const toolInput = claudeLine.tool_input || claudeLine.input || {};
    const agyToolName = mapToolNameToAgy(toolName);
    const agyToolArgs = mapToolInputToAgy(toolName, toolInput);
    return {
      step_index: stepIndex,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: timestamp,
      tool_calls: [
        {
          id: claudeLine.tool_use_id || claudeLine.id,
          name: agyToolName,
          args: agyToolArgs
        }
      ]
    };
  }

  // 5. System messages
  if (claudeLine.type === 'system' || claudeLine.role === 'system' || claudeLine.message?.role === 'system') {
    const rawContent = claudeLine.message?.content ?? claudeLine.content;
    const text = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent || '');
    return {
      step_index: stepIndex,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: timestamp,
      content: text
    };
  }

  // Fallback
  return {
    step_index: stepIndex,
    source: 'SYSTEM',
    type: 'GENERIC',
    status: 'DONE',
    created_at: timestamp,
    content: JSON.stringify(claudeLine)
  };
}

function shimTranscriptPath(agyPath, shadowPath, options = {}) {
  if (!fs.existsSync(agyPath)) {
    return shadowPath;
  }
  
  const agyStat = fs.statSync(agyPath);
  let shadowStat = null;
  if (fs.existsSync(shadowPath)) {
    shadowStat = fs.statSync(shadowPath);
  }
  
  // Lazy evaluation: only rebuild if AGY transcript is newer or shadow doesn't exist
  if (!shadowStat || agyStat.mtimeMs > shadowStat.mtimeMs) {
    const lines = fs.readFileSync(agyPath, 'utf8').split('\n');
    const tracker = createTranscriptContextTracker(options);
    const shadowLines = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const agyObj = JSON.parse(line);
        const claudeObj = tracker.processLine(agyObj);
        shadowLines.push(JSON.stringify(claudeObj));
      } catch (_error) {
        // Ignore parse errors on incomplete lines
      }
    }
    fs.writeFileSync(shadowPath, shadowLines.join('\n') + '\n', 'utf8');
  }
  
  return shadowPath;
}

function shimClaudeTranscriptToAgy(claudePath, agyShadowPath) {
  if (!fs.existsSync(claudePath)) {
    return agyShadowPath;
  }
  
  const claudeStat = fs.statSync(claudePath);
  let shadowStat = null;
  if (fs.existsSync(agyShadowPath)) {
    shadowStat = fs.statSync(agyShadowPath);
  }
  
  if (!shadowStat || claudeStat.mtimeMs > shadowStat.mtimeMs) {
    const lines = fs.readFileSync(claudePath, 'utf8').split('\n');
    const shadowLines = [];
    let stepIndex = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const claudeObj = JSON.parse(line);
        if (!Number.isInteger(claudeObj.step_index)) {
          claudeObj.step_index = stepIndex;
        }
        const agyObj = translateClaudeTranscriptLineToAgy(claudeObj);
        shadowLines.push(JSON.stringify(agyObj));
        stepIndex++;
      } catch (_error) {
        // Ignore parse errors on incomplete lines
      }
    }
    fs.writeFileSync(agyShadowPath, shadowLines.join('\n') + '\n', 'utf8');
  }
  
  return agyShadowPath;
}

module.exports = {
  translateTranscriptLine,
  translateAgyTranscriptLineToClaude: translateTranscriptLine,
  translateClaudeTranscriptLineToAgy,
  shimTranscriptPath,
  shimClaudeTranscriptToAgy,
  updateContextWindowEnvForModel,
  normalizeModelName
};
