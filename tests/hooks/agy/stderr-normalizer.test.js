'use strict';

const assert = require('assert');
const { normalizeStderr } = require('../../../scripts/hooks/agy/stderr-normalizer');

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

console.log('--- stderr-normalizer.test.js ---');

test('normalizeStderr: replaces /compact', () => {
  const input = "You should run /compact now.";
  const output = normalizeStderr(input);
  assert.strictEqual(output, "You should please summarise and clear context now.");
});

test('normalizeStderr: replaces /clear', () => {
  const input = "To fix this, type /clear.";
  const output = normalizeStderr(input);
  assert.strictEqual(output, "To fix this, type clear context.");
});

test('normalizeStderr: replaces /model', () => {
  const input = "Try /model to switch.";
  const output = normalizeStderr(input);
  assert.strictEqual(output, "Try change model to switch.");
});

test('normalizeStderr: handles multiple replacements', () => {
  const input = "Use /cost or /review or run /compact.";
  const output = normalizeStderr(input);
  assert.strictEqual(output, "Use show cost summary or review the work or please summarise and clear context.");
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
