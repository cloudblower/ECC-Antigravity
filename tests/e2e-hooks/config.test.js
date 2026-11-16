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
} catch (_e) {
  // Expected to fail in RED phase if config.js doesn't exist
}

test('config module exports loadConfig and defaultConfig', () => {
  assert.ok(configModule, 'configModule should be defined');
  assert.strictEqual(typeof configModule.loadConfig, 'function', 'loadConfig should be a function');
  assert.ok(configModule.defaultConfig, 'defaultConfig should be defined');
});

test('loadConfig applies sensible defaults', () => {
  const savedLocal = process.env.ECC_E2E_LOCAL;
  const savedModel = process.env.ECC_E2E_BROWSER_MODEL;
  delete process.env.ECC_E2E_LOCAL;
  delete process.env.ECC_E2E_BROWSER_MODEL;
  try {
    const config = configModule.loadConfig({}, '/non-existent-.env');
    const expectedSandbox = fs.existsSync(path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test'))
      ? path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test')
      : path.resolve(__dirname, '../../test-sandbox');
    assert.strictEqual(config.sandboxDir, expectedSandbox);
    assert.strictEqual(config.evalModel, 'gemini-3.8-flash-low');
    assert.ok(config.artifactsDir.includes('test-artifacts'));
    assert.strictEqual(typeof config.timeoutMs, 'number');
    assert.strictEqual(config.isLocal, false);
    assert.strictEqual(config.browserModel, 'Gemini 3.8 Flash (Low)');
    assert.strictEqual(config.mcpCommand, 'npx');
    assert.deepStrictEqual(config.mcpArgs, ['-y', 'chrome-devtools-mcp@latest', '--categoryExtensions', '--isolated', '--headless', '--chrome-arg=--ignore-certificate-errors', '--allowUnrestrictedPaths']);
  } finally {
    if (savedLocal !== undefined) process.env.ECC_E2E_LOCAL = savedLocal;
    else delete process.env.ECC_E2E_LOCAL;
    if (savedModel !== undefined) process.env.ECC_E2E_BROWSER_MODEL = savedModel;
    else delete process.env.ECC_E2E_BROWSER_MODEL;
  }
});

test('loadConfig prioritizes environment overrides', () => {
  const config = configModule.loadConfig({
    ECC_E2E_LOCAL: 'true',
    ECC_E2E_WEB_URL: 'https://localhost:9999/',
    ECC_E2E_EVAL_MODEL: 'custom-model',
    ECC_E2E_BROWSER_MODEL: 'Custom Model (High)',
    ECC_E2E_TIMEOUT_MS: '15000',
    ECC_E2E_MCP_COMMAND: 'custom-mcp',
    ECC_E2E_MCP_ARGS: '["--custom-arg"]'
  }, '/non-existent-.env');

  assert.strictEqual(config.isLocal, true);
  assert.strictEqual(config.webUrl, 'https://localhost:9999/');
  assert.strictEqual(config.evalModel, 'custom-model');
  assert.strictEqual(config.browserModel, 'Custom Model (High)');
  assert.strictEqual(config.timeoutMs, 15000);
  assert.strictEqual(config.mcpCommand, 'custom-mcp');
  assert.deepStrictEqual(config.mcpArgs, ['--custom-arg']);
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
      ECC_E2E_BROWSER_MODEL="Gemini 3.8 Flash (Low)"
      ECC_E2E_TIMEOUT_MS=45000
    `);

    const config = configModule.loadConfig({}, envPath);
    assert.strictEqual(config.isLocal, true);
    assert.strictEqual(config.webUrl, 'https://127.0.0.1:37811/');
    assert.strictEqual(config.evalModel, 'gemini-3.8-flash-low');
    assert.strictEqual(config.browserModel, 'Gemini 3.8 Flash (Low)');
    assert.strictEqual(config.timeoutMs, 45000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
