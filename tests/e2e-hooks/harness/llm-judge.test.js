'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('=== Testing e2e-hooks/harness/llm-judge.js ===');

let LLMJudge;
try {
  LLMJudge = require('./llm-judge');
} catch (e) {
  // RED phase before file creation
}

(async () => {
  await test('LLMJudge class is exported with countTokens and evaluate', () => {
    assert.ok(LLMJudge, 'LLMJudge must be defined');
    assert.strictEqual(typeof LLMJudge.countTokens, 'function');
    const judge = new LLMJudge();
    assert.strictEqual(typeof judge.evaluate, 'function');
  });

  await test('countTokens calculates minimal token counts accurately', () => {
    assert.strictEqual(LLMJudge.countTokens('run dev server'), 3);
    assert.strictEqual(LLMJudge.countTokens('git commit with --no-verify'), 5);
    assert.strictEqual(LLMJudge.countTokens('write to .claude.json'), 4);
    assert.ok(LLMJudge.countTokens('this is a test prompt with several words for token calculation') < 12);
  });

  await test('evaluate evaluates semantic match with fallback or CLI', async () => {
    const judge = new LLMJudge({
      // mock runner for deterministic unit testing
      runner: async ({ prompt }) => {
        return {
          passed: prompt.includes('BLOCKED'),
          reasoning: 'Evaluated by mock LLM'
        };
      }
    });

    const res1 = await judge.evaluate({
      criteria: 'Did the hook block execution because of dev server?',
      actualOutput: '[Hook] BLOCKED: Dev server must run in tmux for log access'
    });
    assert.strictEqual(res1.passed, true);
    assert.strictEqual(res1.reasoning, 'Evaluated by mock LLM');

    const res2 = await judge.evaluate({
      criteria: 'Did the hook block execution?',
      actualOutput: 'Command executed successfully'
    });
    assert.strictEqual(res2.passed, false);
  });

  await test('evaluate fallback handles CLI failures gracefully', async () => {
    const judge = new LLMJudge({
      runner: async () => {
        throw new Error('Quota exceeded 429');
      }
    });

    // Fallback checks keywords
    const res = await judge.evaluate({
      criteria: 'Block dev server',
      actualOutput: '[Hook] BLOCKED: Dev server must run in tmux for log access',
      fallbackKeywords: ['BLOCKED', 'tmux']
    });
    assert.strictEqual(res.passed, true);
    assert.ok(res.reasoning.includes('Fallback pattern match'));
  });

  await test('redactSecrets sanitizes API keys and bearer tokens', () => {
    const raw = 'Failed with api_key: sk-proj-1234567890abcdef12345678 and token ghp_111122223333444455556666777788889999';
    const redacted = LLMJudge.redactSecrets(raw);
    assert.ok(!redacted.includes('sk-proj-1234567890abcdef12345678'));
    assert.ok(!redacted.includes('ghp_111122223333444455556666777788889999'));
    assert.ok(redacted.includes('[REDACTED'));
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
