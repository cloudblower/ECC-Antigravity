'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const { createHookMatcher, setupEnvironment } = require('../../../scripts/hooks/agy/agy-adapter');

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

console.log('--- agy-adapter.test.js ---');

test('createHookMatcher handles wildcard * without throwing', () => {
  const matcher = createHookMatcher('*');
  assert.ok(matcher.test('Bash'));
  assert.ok(matcher.test('Write'));
  assert.ok(matcher.test('anything'));
});

test('createHookMatcher handles standard regex patterns', () => {
  const matcher = createHookMatcher('^Bash|Write$');
  assert.ok(matcher.test('Bash'));
  assert.ok(matcher.test('PreWrite'));
  assert.ok(!matcher.test('Read'));
});

test('createHookMatcher handles invalid regex strings gracefully with exact string fallback', () => {
  const matcher = createHookMatcher('[unclosed');
  assert.ok(matcher.test('[unclosed'));
  assert.ok(!matcher.test('other'));
});

test('setupEnvironment sets correct environment variables', () => {
  const payload = {
    conversationId: 'test-conv-456',
    workspacePaths: ['/test/project/dir']
  };
  const env = setupEnvironment(payload);

  assert.strictEqual(env.claudeSessionId, 'test-conv-456');
  assert.strictEqual(env.claudeProjectDir, '/test/project/dir');
  assert.strictEqual(process.env.CLAUDE_SESSION_ID, 'test-conv-456');
  assert.strictEqual(process.env.CLAUDE_PROJECT_DIR, '/test/project/dir');
  const repoRoot = path.resolve(__dirname, '../../../');
  assert.ok(
    process.env.CLAUDE_PLUGIN_ROOT === repoRoot ||
    process.env.CLAUDE_PLUGIN_ROOT.endsWith('.agents') ||
    process.env.CLAUDE_PLUGIN_ROOT.endsWith('.agent')
  );
  assert.strictEqual(process.env.ECC_MCP_CONFIG_PATH, path.join(os.homedir(), '.gemini/config/mcp_config.json'));
});

test('setupEnvironment propagates modelName and window tokens for Gemini models', () => {
  const payload = {
    conversationId: 'test-conv-789',
    workspacePaths: ['/test/project/dir'],
    modelName: 'gemini-3.7-flash-medium'
  };
  delete process.env.ECC_CONTEXT_WINDOW_TOKENS;
  const env = setupEnvironment(payload);

  assert.strictEqual(env.claudeModel, 'gemini-3.7-flash-medium');
  assert.strictEqual(process.env.AGY_MODEL_NAME, 'gemini-3.7-flash-medium');
  assert.strictEqual(process.env.ECC_CONTEXT_WINDOW_TOKENS, '1000000');
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
