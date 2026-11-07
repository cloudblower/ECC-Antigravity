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

  await test('evaluate fast-paths when diskVerified is true without invoking runner', async () => {
    let runnerCalled = false;
    const judge = new LLMJudge({
      runner: async () => {
        runnerCalled = true;
        throw new Error('Runner should not be called on fast-path');
      }
    });

    const res = await judge.evaluate({
      criteria: 'Did hook block dev server?',
      actualOutput: 'Some output without keywords',
      diskVerified: true
    });

    assert.strictEqual(runnerCalled, false, 'Runner must NOT be invoked when diskVerified is true');
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.fastPathUsed, true);
    assert.ok(res.reasoning.includes('disk log') || res.reasoning.includes('fast-path'));
  });

  await test('evaluate fast-paths on keyword match without invoking runner', async () => {
    let runnerCalled = false;
    const judge = new LLMJudge({
      runner: async () => {
        runnerCalled = true;
        throw new Error('Runner should not be called on fast-path');
      }
    });

    // Default denial keyword match
    const resDefault = await judge.evaluate({
      criteria: 'Did hook block dev server?',
      actualOutput: '[Hook] BLOCKED: Dev server must run in tmux'
    });
    assert.strictEqual(runnerCalled, false, 'Runner must NOT be invoked when default keyword matches');
    assert.strictEqual(resDefault.passed, true);
    assert.strictEqual(resDefault.fastPathUsed, true);

    // Custom fallback keyword match
    const resCustom = await judge.evaluate({
      criteria: 'Warning on docs',
      actualOutput: 'WARNING: Documentation update detected',
      fallbackKeywords: ['WARNING', 'doc']
    });
    assert.strictEqual(runnerCalled, false, 'Runner must NOT be invoked when custom fallback keyword matches');
    assert.strictEqual(resCustom.passed, true);
    assert.strictEqual(resCustom.fastPathUsed, true);
  });

  await test('evaluate invokes runner with compact prompt and truncates actualOutput to 300 chars', async () => {
    let receivedPrompt = '';
    const judge = new LLMJudge({
      runner: async ({ prompt }) => {
        receivedPrompt = prompt;
        return {
          passed: true,
          reasoning: 'Compact prompt evaluated'
        };
      }
    });

    const hugeOutput = 'Unrecognized execution output: ' + 'Z'.repeat(1000);
    const criteria = 'Check if completed';
    const res = await judge.evaluate({
      criteria,
      actualOutput: hugeOutput,
      fallbackKeywords: ['none_of_these']
    });

    assert.strictEqual(res.passed, true);
    assert.ok(receivedPrompt.startsWith('Judge if output satisfies criteria.'), 'Prompt must use compact format');
    assert.ok(receivedPrompt.includes(`<out>${hugeOutput.slice(0, 300)}</out>`), 'Output in prompt must be truncated to 300 chars');
    assert.ok(!receivedPrompt.includes('Z'.repeat(301)), 'Prompt must not contain more than 300 chars of actual output');
    assert.ok(receivedPrompt.includes('Return JSON: {"passed": boolean, "reasoning": string}'));
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
