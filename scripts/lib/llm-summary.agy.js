#!/usr/bin/env node
/**
 * LLM-powered session summary generator for Antigravity
 *
 * Uses `agy -p` (Antigravity CLI) to generate rich, contextual session
 * summaries from JSONL transcripts. Requires no API key — reuses Antigravity's
 * own authentication.
 *
 * Recursion guard: sets ECC_SKIP_LLM_SUMMARY=1 in subprocess env so any Stop
 * hooks fired by the subprocess do NOT re-enter LLM summarization.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { stripAnsi } = require('./utils');

const MAX_TRANSCRIPT_CHARS = 7000;
const MAX_TURNS = 25;
const LLM_TIMEOUT_MS = 90000;

let cachedAgyModel = null;

function clearCachedAgyModel() {
  cachedAgyModel = null;
}

function queryAvailableAgyModels(env) {
  try {
    const privateBinDir = path.join(os.homedir(), '.ecc', 'bin');
    const pathDelimiter = process.platform === 'win32' ? ';' : ':';
    const envPath = (env && env.PATH) ? `${privateBinDir}${pathDelimiter}${env.PATH}` : (process.env.PATH ? `${privateBinDir}${pathDelimiter}${process.env.PATH}` : privateBinDir);

    const result = spawnSync('agy', ['models'], {
      encoding: 'utf8',
      env: { ...(env || process.env), PATH: envPath },
      timeout: 5000,
      shell: process.platform === 'win32'
    });

    if (result.error || result.status !== 0 || !result.stdout) {
      return [];
    }

    const cleanOutput = stripAnsi(result.stdout);
    const lines = cleanOutput.split(/\r?\n/);
    const models = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[a-zA-Z0-9]/.test(trimmed)) {
        const slug = trimmed.split(/\s+/)[0];
        if (slug && !models.includes(slug)) {
          models.push(slug);
        }
      }
    }
    return models;
  } catch {
    return [];
  }
}

function resolveAgyModel(requested, options = {}) {
  if (options.cache !== false && cachedAgyModel !== null && requested === undefined) {
    return cachedAgyModel;
  }

  const requestedModel = (
    requested !== undefined
      ? requested
      : (process.env.ECC_LLM_SUMMARY_MODEL || process.env.AGY_MODEL_NAME || process.env.ECC_OBSERVER_MODEL || '')
  ).trim();

  const availableModels = options.availableModels !== undefined
    ? options.availableModels
    : queryAvailableAgyModels(options.env);

  if (!availableModels || availableModels.length === 0) {
    if (requestedModel === 'haiku') {
      return '';
    }
    return requestedModel;
  }

  let resolved = '';
  const lowerRequested = requestedModel.toLowerCase();

  switch (lowerRequested) {
    case 'haiku':
    case 'flash':
    case 'fast':
    case '': {
      const flashMedium = availableModels.find(m => /flash-medium/i.test(m));
      if (flashMedium) {
        resolved = flashMedium;
      } else {
        const flash = availableModels.find(m => /flash/i.test(m));
        resolved = flash || '';
      }
      break;
    }
    case 'opus':
    case 'pro':
    case 'heavy': {
      const opus = availableModels.find(m => /opus/i.test(m));
      if (opus) {
        resolved = opus;
      } else {
        const proHigh = availableModels.find(m => /pro-high|pro/i.test(m));
        resolved = proHigh || '';
      }
      break;
    }
    case 'sonnet': {
      const sonnet = availableModels.find(m => /sonnet/i.test(m));
      resolved = sonnet || requestedModel;
      break;
    }
    default: {
      const exactMatch = availableModels.find(m => m.toLowerCase() === lowerRequested);
      resolved = exactMatch || requestedModel;
      break;
    }
  }

  if (options.cache !== false && requested === undefined) {
    cachedAgyModel = resolved;
  }

  return resolved;
}

function getLLMModel() {
  return resolveAgyModel();
}

function getContextThreshold() {
  const raw = parseInt(process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD || '20', 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 20;
}

/**
 * Extract the last MAX_TURNS user+assistant turns from a JSONL transcript.
 * Returns null when the transcript is missing or has no parseable turns.
 */
function extractConversationText(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n').filter(Boolean);
  const turns = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const isUser = entry.type === 'user' || entry.message?.role === 'user';
      const isAssistant = entry.type === 'assistant';

      if (isUser) {
        const rawContent = entry.message?.content ?? entry.content;
        const text =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
                  .filter(c => c?.type === 'text')
                  .map(c => c.text)
                  .join(' ')
              : '';
        const cleaned = text.replace(/\n+/g, ' ').trim();
        if (cleaned) {
          turns.push({ role: 'User', text: cleaned.slice(0, 400) });
        }
      }

      if (isAssistant && Array.isArray(entry.message?.content)) {
        const textParts = entry.message.content
          .filter(b => b?.type === 'text')
          .map(b => b.text)
          .join(' ')
          .replace(/\n+/g, ' ')
          .trim();
        if (textParts) {
          turns.push({ role: 'Assistant', text: textParts.slice(0, 600) });
        }
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (turns.length === 0) return null;

  const recent = turns.slice(-MAX_TURNS);
  const formatted = recent.map(t => `**${t.role}:** ${t.text}`).join('\n\n');
  return formatted.length > MAX_TRANSCRIPT_CHARS ? '...(前略)\n\n' + formatted.slice(-MAX_TRANSCRIPT_CHARS) : formatted;
}

/**
 * Read the context remaining percentage from a transcript's latest usage record.
 * Returns null when unavailable.
 */
function getContextRemainingPct(transcriptPath) {
  try {
    const { readLatestContextTokens, resolveContextWindowTokens } = require('./transcript-context');
    const usage = readLatestContextTokens(transcriptPath);
    if (!usage) return null;
    const windowTokens = resolveContextWindowTokens(usage.tokens, usage.model);
    return Math.round((1 - usage.tokens / windowTokens) * 100);
  } catch {
    return null;
  }
}

/**
 * Generate a session summary using `agy -p`.
 * Returns the summary string, or null on failure or when recursion guard is active.
 */
function generateSessionSummary(transcriptPath) {
  if (process.env.ECC_SKIP_LLM_SUMMARY) return null;

  const conversation = extractConversationText(transcriptPath);
  if (!conversation) return null;

  const prompt = [
    'Below is a conversation log from an Antigravity coding session.',
    'Create a summary to help the next session quickly understand the context.',
    '',
    '## Prioritize including',
    '- Design decisions and technology choices made this session',
    '- Bugs and problems solved',
    '- Files changed or created, with a brief description of changes',
    '- Unfinished tasks and work to continue in the next session',
    '- Important context the next session needs to know',
    '',
    '## Conversation log',
    conversation,
    '',
    '## Output format (Markdown only, no preamble)',
    '',
    '## Session Summary',
    '',
    '### Tasks',
    '(main tasks worked on this session)',
    '',
    '### Decisions Made',
    '(design decisions and technology choices)',
    '',
    '### Files Modified',
    '(files changed or created)',
    '',
    '### Unresolved Issues',
    '(unfinished tasks and work to continue)',
    '',
    '### Next Session Context',
    '(important context for the next session)'
  ].join('\n');

  try {
    const model = getLLMModel();
    const args = [];
    if (model) {
      args.push('--model', model);
    }
    args.push('-p', prompt);

    const privateBinDir = path.join(os.homedir(), '.ecc', 'bin');
    const pathDelimiter = process.platform === 'win32' ? ';' : ':';
    const envPath = process.env.PATH ? `${privateBinDir}${pathDelimiter}${process.env.PATH}` : privateBinDir;

    const result = spawnSync('agy', args, {
      input: prompt,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: envPath,
        ECC_SKIP_LLM_SUMMARY: '1'
      },
      timeout: LLM_TIMEOUT_MS,
      shell: process.platform === 'win32'
    });

    if (result.error || result.status !== 0) {
      return null;
    }

    const output = (result.stdout || '').trim();
    return output || null;
  } catch {
    return null;
  }
}

module.exports = {
  generateSessionSummary,
  extractConversationText,
  getContextRemainingPct,
  getContextThreshold,
  getLLMModel,
  resolveAgyModel,
  clearCachedAgyModel
};
