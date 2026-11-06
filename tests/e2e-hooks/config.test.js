'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('=== Testing e2e-hooks/config.js ===');

// Lazy require to verify failure before implementation exists
let configModule;
try {
  configModule = require('./config');
} catch (e) {
  // Expected to fail in RED phase if config.js doesn't exist
}

test('config module exports loadConfig and defaultConfig', () => {
  assert.ok(configModule, 'configModule should be defined');
  assert.strictEqual(typeof configModule.loadConfig, 'function', 'loadConfig should be a function');
  assert.ok(configModule.defaultConfig, 'defaultConfig should be defined');
});

test('loadConfig applies sensible defaults', () => {
  const config = configModule.loadConfig({}, '/non-existent-.env');
  assert.strictEqual(config.webUrl, 'https://127.0.0.1:37811/');
  assert.strictEqual(config.sandboxDir, '/home/fedora/Documents/ECC-Antigravity-test');
  assert.strictEqual(config.evalModel, 'gemini-3.8-flash-low');
  assert.ok(config.artifactsDir.includes('test-artifacts'));
  assert.strictEqual(typeof config.timeoutMs, 'number');
  assert.strictEqual(config.isLocal, false);
});

test('loadConfig prioritizes environment overrides', () => {
  const config = configModule.loadConfig({
    ECC_E2E_LOCAL: 'true',
    ECC_E2E_WEB_URL: 'https://localhost:9999/',
    ECC_E2E_EVAL_MODEL: 'custom-model',
    ECC_E2E_TIMEOUT_MS: '15000'
  }, '/non-existent-.env');

  assert.strictEqual(config.isLocal, true);
  assert.strictEqual(config.webUrl, 'https://localhost:9999/');
  assert.strictEqual(config.evalModel, 'custom-model');
  assert.strictEqual(config.timeoutMs, 15000);
});

test('loadConfig parses .env file correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-e2e-config-'));
  const envPath = path.join(tmpDir, '.env');
  try {
    fs.writeFileSync(envPath, `
      # Comments should be ignored
      ECC_E2E_LOCAL=true
      ECC_E2E_WEB_URL="https://127.0.0.1:37811/"
      ECC_E2E_EVAL_MODEL='gemini-3.8-flash-low'
      ECC_E2E_TIMEOUT_MS=45000
    `);

    const config = configModule.loadConfig({}, envPath);
    assert.strictEqual(config.isLocal, true);
    assert.strictEqual(config.webUrl, 'https://127.0.0.1:37811/');
    assert.strictEqual(config.evalModel, 'gemini-3.8-flash-low');
    assert.strictEqual(config.timeoutMs, 45000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
