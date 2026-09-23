'use strict';
/**
 * Tests for scripts/lib/llm-summary.agy.js
 *
 * Run with: node tests/lib/llm-summary.agy.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractConversationText,
  getContextRemainingPct,
  getContextThreshold,
  getLLMModel,
  resolveAgyModel,
  clearCachedAgyModel,
  generateSessionSummary
} = require('../../scripts/lib/llm-summary.agy');

console.log('=== Testing llm-summary.agy.js ===\n');

let passed = 0;
let failed = 0;

function test(desc, fn) {
  try {
    fn();
    console.log(`  ✓ ${desc}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${desc}: ${e.message}`);
    failed++;
  }
}

let seq = 0;
const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-summary-agy-test-'));
function writeTranscript(lines) {
  seq++;
  const p = path.join(transcriptDir, `transcript-${seq}.jsonl`);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function userEntry(text) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
}

function assistantEntry(text) {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  });
}

// --- resolveAgyModel & getLLMModel ---
console.log('resolveAgyModel:');

const mockAvailableModels = [
  'gemini-3.7-flash',
  'gemini-3.5-flash-medium',
  'gemini-3-pro-high',
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6'
];

test('resolveAgyModel: dynamically picks flash-medium for haiku/flash/fast/empty', () => {
  assert.strictEqual(
    resolveAgyModel('haiku', { availableModels: mockAvailableModels, cache: false }),
    'gemini-3.5-flash-medium'
  );
  assert.strictEqual(
    resolveAgyModel('flash', { availableModels: mockAvailableModels, cache: false }),
    'gemini-3.5-flash-medium'
  );
  assert.strictEqual(
    resolveAgyModel('', { availableModels: mockAvailableModels, cache: false }),
    'gemini-3.5-flash-medium'
  );
});

test('resolveAgyModel: falls back to flash when flash-medium is absent', () => {
  const models = ['gemini-3.7-flash', 'gemini-3-pro-high'];
  assert.strictEqual(
    resolveAgyModel('haiku', { availableModels: models, cache: false }),
    'gemini-3.7-flash'
  );
  assert.strictEqual(
    resolveAgyModel('', { availableModels: models, cache: false }),
    'gemini-3.7-flash'
  );
});

test('resolveAgyModel: dynamically picks opus for opus/pro/heavy', () => {
  assert.strictEqual(
    resolveAgyModel('opus', { availableModels: mockAvailableModels, cache: false }),
    'claude-opus-4-6-thinking'
  );
  assert.strictEqual(
    resolveAgyModel('heavy', { availableModels: mockAvailableModels, cache: false }),
    'claude-opus-4-6-thinking'
  );
});

test('resolveAgyModel: falls back to pro-high/pro when opus is absent', () => {
  const models = ['gemini-3.7-flash', 'gemini-3-pro-high'];
  assert.strictEqual(
    resolveAgyModel('opus', { availableModels: models, cache: false }),
    'gemini-3-pro-high'
  );
  assert.strictEqual(
    resolveAgyModel('pro', { availableModels: models, cache: false }),
    'gemini-3-pro-high'
  );
});

test('resolveAgyModel: dynamically picks sonnet when present', () => {
  assert.strictEqual(
    resolveAgyModel('sonnet', { availableModels: mockAvailableModels, cache: false }),
    'claude-sonnet-4-6'
  );
});

test('resolveAgyModel: returns exact model slug if requested directly', () => {
  assert.strictEqual(
    resolveAgyModel('gemini-3.7-flash', { availableModels: mockAvailableModels, cache: false }),
    'gemini-3.7-flash'
  );
});

test('resolveAgyModel: handles empty available models gracefully', () => {
  assert.strictEqual(
    resolveAgyModel('haiku', { availableModels: [], cache: false }),
    ''
  );
  assert.strictEqual(
    resolveAgyModel('custom-model-id', { availableModels: [], cache: false }),
    'custom-model-id'
  );
  assert.strictEqual(
    resolveAgyModel('', { availableModels: [], cache: false }),
    ''
  );
});

test('getLLMModel: uses cached resolved model', () => {
  clearCachedAgyModel();
  const orig = process.env.ECC_LLM_SUMMARY_MODEL;
  delete process.env.ECC_LLM_SUMMARY_MODEL;

  // In test environment, queryAvailableAgyModels will run or fallback to ''
  const model = getLLMModel();
  assert.ok(typeof model === 'string');

  if (orig !== undefined) process.env.ECC_LLM_SUMMARY_MODEL = orig;
  clearCachedAgyModel();
});

// --- getContextThreshold ---
console.log('\ngetContextThreshold:');

test('returns 20 by default', () => {
  const orig = process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD;
  delete process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD;
  assert.strictEqual(getContextThreshold(), 20);
  if (orig !== undefined) process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD = orig;
});

test('reads ECC_LLM_SUMMARY_CONTEXT_THRESHOLD env var', () => {
  const orig = process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD;
  process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD = '70';
  assert.strictEqual(getContextThreshold(), 70);
  if (orig !== undefined) process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD = orig;
  else delete process.env.ECC_LLM_SUMMARY_CONTEXT_THRESHOLD;
});

// --- extractConversationText ---
console.log('\nextractConversationText:');

test('returns null for missing file', () => {
  assert.strictEqual(extractConversationText('/nonexistent/path.jsonl'), null);
});

test('extracts user and assistant turns', () => {
  const p = writeTranscript([userEntry('Hello, can you help?'), assistantEntry('Sure, what do you need?')]);
  const result = extractConversationText(p);
  assert.ok(result.includes('User:'));
  assert.ok(result.includes('Assistant:'));
  assert.ok(result.includes('Hello, can you help?'));
});

// --- getContextRemainingPct ---
console.log('\ngetContextRemainingPct:');

test('returns null for missing file', () => {
  assert.strictEqual(getContextRemainingPct('/nonexistent.jsonl'), null);
});

test('returns numeric percentage for transcript with usage data', () => {
  const p = writeTranscript([assistantEntry('ok')]);
  const pct = getContextRemainingPct(p);
  assert.ok(typeof pct === 'number');
  assert.ok(pct >= 0 && pct <= 100);
});

// --- generateSessionSummary ---
console.log('\ngenerateSessionSummary:');

test('returns null when ECC_SKIP_LLM_SUMMARY is set', () => {
  const orig = process.env.ECC_SKIP_LLM_SUMMARY;
  process.env.ECC_SKIP_LLM_SUMMARY = '1';
  const p = writeTranscript([userEntry('test')]);
  assert.strictEqual(generateSessionSummary(p), null);
  if (orig !== undefined) process.env.ECC_SKIP_LLM_SUMMARY = orig;
  else delete process.env.ECC_SKIP_LLM_SUMMARY;
});

test('returns null for missing transcript', () => {
  const orig = process.env.ECC_SKIP_LLM_SUMMARY;
  delete process.env.ECC_SKIP_LLM_SUMMARY;
  assert.strictEqual(generateSessionSummary('/nonexistent.jsonl'), null);
  if (orig !== undefined) process.env.ECC_SKIP_LLM_SUMMARY = orig;
});

// Clean up
try {
  fs.rmSync(transcriptDir, { recursive: true, force: true });
} catch {
  // ignore cleanup error
}

// --- Results ---
console.log('\n=== Test Results ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
