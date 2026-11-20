'use strict';
const assert = require('assert');
const path = require('path');
const os = require('os');
const { createHookMatcher, setupEnvironment, assertSafeDir, redactLogSecrets, bufferWarning } = require('../../../scripts/hooks/agy/agy-adapter');

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

const envKeys = [
  'CLAUDE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_MODEL',
  'CLAUDE_TRANSCRIPT_PATH',
  'ECC_MCP_CONFIG_PATH',
  'ECC_CONTEXT_WINDOW_TOKENS',
  'AGY_MODEL_NAME'
];
const initialEnv = {};
for (const key of envKeys) {
  initialEnv[key] = process.env[key];
}

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

test('setupEnvironment loads .ecc-hook-env.json applying only whitelisted keys in sandbox mode', () => {
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hook-env-test-'));
  const hookEnvPath = path.join(tempDir, '.ecc-hook-env.json');
  const originalPath = process.env.PATH;
  delete process.env.LD_PRELOAD;
  delete process.env.NODE_OPTIONS;
  delete process.env.ECC_HOOK_PROFILE;
  delete process.env.COMPACT_THRESHOLD;
  delete process.env.GATEGUARD_MODE;
  delete process.env.CLAUDE_TEST_KEY;
  delete process.env.TMUX;
  delete process.env.MOCK_VAR;

  fs.writeFileSync(hookEnvPath, JSON.stringify({
    ECC_E2E_TEST_SANDBOX: 'true',
    ECC_HOOK_PROFILE: 'strict',
    COMPACT_THRESHOLD: '5',
    GATEGUARD_MODE: 'bypass',
    CLAUDE_TEST_KEY: 'testval',
    TMUX: 'tmux-session-1',
    MOCK_VAR: 'mockval',
    PATH: '/evil/bin',
    LD_PRELOAD: '/evil/lib.so',
    NODE_OPTIONS: '--require evil.js'
  }));

  try {
    setupEnvironment({
      conversationId: 'test-conv-env',
      workspacePaths: [tempDir]
    });

    assert.strictEqual(process.env.ECC_HOOK_PROFILE, 'strict');
    assert.strictEqual(process.env.COMPACT_THRESHOLD, '5');
    assert.strictEqual(process.env.GATEGUARD_MODE, 'bypass');
    assert.strictEqual(process.env.CLAUDE_TEST_KEY, 'testval');
    assert.strictEqual(process.env.TMUX, 'tmux-session-1');
    assert.strictEqual(process.env.MOCK_VAR, 'mockval');
    assert.strictEqual(process.env.PATH, originalPath, 'PATH should not be overridden');
    assert.strictEqual(process.env.LD_PRELOAD, undefined, 'LD_PRELOAD should be ignored');
    assert.strictEqual(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS should be ignored');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ECC_HOOK_PROFILE;
    delete process.env.COMPACT_THRESHOLD;
    delete process.env.GATEGUARD_MODE;
    delete process.env.CLAUDE_TEST_KEY;
    delete process.env.TMUX;
    delete process.env.MOCK_VAR;
  }
});

test('setupEnvironment loads .ecc-hook-env.json from toolCall.args.Cwd', () => {
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cwd-test-'));
  const envFile = path.join(tempDir, '.ecc-hook-env.json');
  fs.writeFileSync(envFile, JSON.stringify({
    ECC_E2E_TEST_SANDBOX: 'true',
    ECC_HOOK_PROFILE: 'strict',
    ECC_GATEGUARD: 'off'
  }));

  try {
    setupEnvironment({
      conversationId: 'test-cwd-env',
      toolCall: {
        name: 'run_command',
        args: { Cwd: tempDir, CommandLine: 'npm run dev' }
      }
    });

    assert.strictEqual(process.env.ECC_HOOK_PROFILE, 'strict');
    assert.strictEqual(process.env.ECC_GATEGUARD, 'off');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ECC_HOOK_PROFILE;
    delete process.env.ECC_GATEGUARD;
  }
});

test('setupEnvironment gates GateGuard overrides when ECC_E2E_TEST_SANDBOX is unset', () => {
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-gateguard-gate-'));
  const envFile = path.join(tempDir, '.ecc-hook-env.json');
  delete process.env.ECC_GATEGUARD;
  delete process.env.GATEGUARD_MODE;

  fs.writeFileSync(envFile, JSON.stringify({
    ECC_HOOK_PROFILE: 'strict',
    ECC_GATEGUARD: 'off',
    GATEGUARD_MODE: 'bypass'
  }));

  try {
    setupEnvironment({
      conversationId: 'test-gate-env',
      workspacePaths: [tempDir]
    });

    assert.strictEqual(process.env.ECC_HOOK_PROFILE, 'strict');
    assert.strictEqual(process.env.ECC_GATEGUARD, undefined, 'ECC_GATEGUARD should be ignored without sandbox flag');
    assert.strictEqual(process.env.GATEGUARD_MODE, undefined, 'GATEGUARD_MODE should be ignored without sandbox flag');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ECC_HOOK_PROFILE;
    delete process.env.ECC_GATEGUARD;
    delete process.env.GATEGUARD_MODE;
  }
});

test('setupEnvironment ignores prototype pollution keys in .ecc-hook-env.json', () => {
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-proto-test-'));
  const envFile = path.join(tempDir, '.ecc-hook-env.json');
  fs.writeFileSync(envFile, JSON.stringify({
    __proto__: { polluted: 'true' },
    constructor: { prototype: { polluted: 'true' } },
    prototype: { polluted: 'true' },
    ECC_HOOK_PROFILE: 'strict'
  }));

  try {
    setupEnvironment({
      conversationId: 'test-proto-env',
      workspacePaths: [tempDir]
    });

    assert.strictEqual(Object.prototype.polluted, undefined);
    assert.strictEqual(process.env.ECC_HOOK_PROFILE, 'strict');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ECC_HOOK_PROFILE;
  }
});

test('assertSafeDir rejects filesystem root, system directories and subdirectories', () => {
  assert.throws(() => assertSafeDir('/'), /filesystem root/);
  assert.throws(() => assertSafeDir('/etc'), /protected system directory/);
  assert.throws(() => assertSafeDir('/etc/passwd'), /protected system directory/);
  assert.throws(() => assertSafeDir('/usr'), /protected system directory/);
  assert.throws(() => assertSafeDir('/usr/local/bin'), /protected system directory/);
  assert.throws(() => assertSafeDir('/var/log'), /protected system directory/);
  assert.throws(() => assertSafeDir('/tmp'), /protected system directory/);
  assert.throws(() => assertSafeDir('/home'), /protected system directory/);

  // Subdirectories of /tmp and /home must be permitted
  assert.doesNotThrow(() => assertSafeDir('/tmp/ecc-sandbox-123'));
  assert.doesNotThrow(() => assertSafeDir('/home/fedora/project'));
});

test('assertSafeDir permits subdirectories of os.tmpdir even when tmpdir is under a protected system dir (macOS /var regression)', () => {
  const fs = require('fs');
  const originalTmpdir = os.tmpdir;
  let simTmp = null;

  try {
    const baseDir = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
    simTmp = fs.mkdtempSync(path.join(baseDir, 'ecc-reg-tmp-'));
    os.tmpdir = () => simTmp;

    const subDir = path.join(simTmp, 'ecc-hook-env-sandbox');
    fs.mkdirSync(subDir, { recursive: true });
    const hookEnvFile = path.join(subDir, '.ecc-hook-env.json');
    fs.writeFileSync(hookEnvFile, JSON.stringify({
      ECC_E2E_TEST_SANDBOX: 'true',
      ECC_HOOK_PROFILE: 'strict'
    }));

    // 1. assertSafeDir must permit the subdirectory of os.tmpdir()
    assert.doesNotThrow(() => assertSafeDir(subDir));

    // 2. Also non-existent child inside os.tmpdir() subdirectory must be permitted
    assert.doesNotThrow(() => assertSafeDir(path.join(subDir, 'nested', 'child')));

    // 3. Dot-named sandbox subdirectories under tmpdir must be permitted
    assert.doesNotThrow(() => assertSafeDir(path.join(simTmp, '..sandbox-style')));

    // 4. setupEnvironment must not silently skip .ecc-hook-env.json
    delete process.env.ECC_HOOK_PROFILE;
    setupEnvironment({
      conversationId: 'test-var-tmp-env',
      workspacePaths: [subDir]
    });
    assert.strictEqual(process.env.ECC_HOOK_PROFILE, 'strict', '.ecc-hook-env.json should be loaded from tmpdir under /var');
  } finally {
    os.tmpdir = originalTmpdir;
    delete process.env.ECC_HOOK_PROFILE;
    if (simTmp) {
      fs.rmSync(simTmp, { recursive: true, force: true });
    }
  }
});

test('assertSafeDir still rejects symlinks inside tmpdir pointing to protected directories', () => {
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-symlink-guard-'));
  const linkToEtc = path.join(tempDir, 'link-to-etc');
  const linkToVarTarget = path.join(tempDir, 'link-to-var-target');

  function tryCreateDirSymlink(target, linkPath) {
    try {
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(target, linkPath, symlinkType);
      return true;
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
        return false;
      }
      throw err;
    }
  }

  try {
    if (tryCreateDirSymlink('/etc', linkToEtc)) {
      assert.throws(() => assertSafeDir(linkToEtc), /protected system directory/);
      assert.throws(() => assertSafeDir(path.join(linkToEtc, 'passwd')), /protected system directory/);
    }

    const varTarget = fs.existsSync('/var/log') ? '/var/log' : (fs.existsSync('/var/lib') ? '/var/lib' : null);
    if (varTarget && tryCreateDirSymlink(varTarget, linkToVarTarget)) {
      assert.throws(() => assertSafeDir(linkToVarTarget), /protected system directory/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assertSafeDir still rejects other /var subpaths and exact system directories', () => {
  assert.throws(() => assertSafeDir('/var/lib'), /protected system directory/);
  assert.throws(() => assertSafeDir('/var/log'), /protected system directory/);
  assert.throws(() => assertSafeDir('/var'), /protected system directory/);
  assert.throws(() => assertSafeDir('/etc/..evil'), /protected system directory/);
});

test('assertSafeDir rejects canonicalized macOS /private protected directories while permitting /private/tmp subdirectories', () => {
  // Exact system directories must be rejected
  assert.throws(() => assertSafeDir('/private'), /protected system directory/);
  assert.throws(() => assertSafeDir('/private/tmp'), /protected system directory/);
  assert.throws(() => assertSafeDir('/tmp'), /protected system directory/);

  // Subdirectories of /tmp and /private/tmp (macOS canonical /tmp) must be permitted
  assert.doesNotThrow(() => assertSafeDir('/tmp/my-project'));
  assert.doesNotThrow(() => assertSafeDir('/private/tmp/my-project'));
  assert.doesNotThrow(() => assertSafeDir('/private/tmp/sub/nested-proj'));

  // System protected directories under /private must still be rejected
  assert.throws(() => assertSafeDir('/private/etc'), /protected system directory/);
  assert.throws(() => assertSafeDir('/private/etc/passwd'), /protected system directory/);
  assert.throws(() => assertSafeDir('/private/var'), /protected system directory/);
  assert.throws(() => assertSafeDir('/private/var/log'), /protected system directory/);
});

test('normalizePathPrefix normalizes Windows extended paths including UNC and drive paths', () => {
  const { normalizePathPrefix } = require('../../../scripts/hooks/agy/agy-adapter');
  const origPlatform = process.platform;

  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    // 1. UNC extended path \\?\UNC\server\share\file -> \\server\share\file
    assert.strictEqual(
      normalizePathPrefix('\\\\?\\UNC\\server\\share\\project'),
      '\\\\server\\share\\project'
    );
    assert.strictEqual(
      normalizePathPrefix('\\\\?\\unc\\server\\share\\nested\\file.txt'),
      '\\\\server\\share\\nested\\file.txt'
    );

    // 2. Drive extended path \\?\X: -> X:
    assert.strictEqual(
      normalizePathPrefix('\\\\?\\C:\\Users\\fedora\\project'),
      'C:\\Users\\fedora\\project'
    );
    assert.strictEqual(
      normalizePathPrefix('\\\\?\\D:\\workspace'),
      'D:\\workspace'
    );

    // 3. Normal path unchanged
    assert.strictEqual(normalizePathPrefix('C:\\normal\\path'), 'C:\\normal\\path');

    // 4. Non-win32 platforms leave extended prefixes unchanged
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    assert.strictEqual(
      normalizePathPrefix('\\\\?\\UNC\\server\\share'),
      '\\\\?\\UNC\\server\\share'
    );
    assert.strictEqual(
      normalizePathPrefix('\\\\?\\C:\\project'),
      '\\\\?\\C:\\project'
    );

    // 5. Non-string inputs returned as-is
    assert.strictEqual(normalizePathPrefix(null), null);
    assert.strictEqual(normalizePathPrefix(undefined), undefined);
  } finally {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  }
});

test('assertSafeDir prevents tmpdir exemption abuse when os.tmpdir is stubbed or symlinked to protected dirs', () => {
  const fs = require('fs');
  const originalTmpdir = os.tmpdir;
  const testTmp = fs.mkdtempSync(path.join(originalTmpdir(), 'ecc-abuse-test-'));
  const symlinkToEtc = path.join(testTmp, 'tmp-symlink-etc');

  try {
    os.tmpdir = () => '/var';
    assert.throws(() => assertSafeDir('/var/log'), /protected system directory/);
    assert.throws(() => assertSafeDir('/var/ecc-malicious-sub'), /protected system directory/);

    os.tmpdir = () => '/etc';
    assert.throws(() => assertSafeDir('/etc/cron.d'), /protected system directory/);
    assert.throws(() => assertSafeDir('/etc/ecc-malicious-sub'), /protected system directory/);

    let symlinkCreated = false;
    try {
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync('/etc', symlinkToEtc, symlinkType);
      symlinkCreated = true;
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
        symlinkCreated = false;
      } else {
        throw err;
      }
    }

    if (symlinkCreated) {
      os.tmpdir = () => symlinkToEtc;
      assert.throws(() => assertSafeDir(path.join(symlinkToEtc, 'cron.d')), /protected system directory/);
    }
  } finally {
    os.tmpdir = originalTmpdir;
    fs.rmSync(testTmp, { recursive: true, force: true });
  }
});

test('assertSafeDir fails closed on symlink loops', () => {
  const fs = require('fs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-loop-test-'));
  const loopA = path.join(tempDir, 'loop-a');
  const loopB = path.join(tempDir, 'loop-b');

  try {
    let created = false;
    try {
      fs.symlinkSync(loopB, loopA);
      fs.symlinkSync(loopA, loopB);
      created = true;
    } catch (err) {
      if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
        created = false;
      } else {
        throw err;
      }
    }
    if (created) {
      assert.throws(() => assertSafeDir(loopA), /cannot be verified safely|Unsafe/);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('setupEnvironment safely skips unsafe inferred candidate directories without crashing', () => {
  const payload = {
    conversationId: 'test-unsafe-candidates',
    toolCall: {
      name: 'run_command',
      args: { Cwd: '/etc' }
    }
  };
  assert.doesNotThrow(() => {
    const env = setupEnvironment(payload);
    assert.notStrictEqual(env.claudeProjectDir, '/etc');
  });
});

test('setupEnvironment throws when explicit projectDir is unsafe', () => {
  const payload = {
    conversationId: 'test-unsafe-explicit',
    projectDir: '/etc'
  };
  assert.throws(() => setupEnvironment(payload), /protected system directory/);
});

test('redactLogSecrets masks sensitive tokens, keys, and credentials', () => {
  const raw = [
    'Authorization: Bearer secret-token-12345',
    'OpenAI: sk-proj-1234567890abcdefghijklmnop',
    'GitHub: ghp_12345678901234567890',
    'AWS: AKIAIOSFODNN7EXAMPLE',
    '{"api_key": "supersecretkey", "password": "supersecretpassword"}',
    'api_key=myapikey123&other=1'
  ].join('\n');

  const redacted = redactLogSecrets(raw);
  assert.ok(!redacted.includes('secret-token-12345'), 'Bearer token should be redacted');
  assert.ok(!redacted.includes('sk-proj-1234567890abcdefghijklmnop'), 'sk- token should be redacted');
  assert.ok(!redacted.includes('ghp_12345678901234567890'), 'ghp token should be redacted');
  assert.ok(!redacted.includes('AKIAIOSFODNN7EXAMPLE'), 'AKIA key should be redacted');
  assert.ok(!redacted.includes('supersecretkey'), 'api_key value should be redacted');
  assert.ok(!redacted.includes('supersecretpassword'), 'password value should be redacted');
  assert.ok(!redacted.includes('myapikey123'), 'api_key parameter should be redacted');
  assert.ok(redacted.includes('[REDACTED]'), 'Redacted marker should appear');
});

test('bufferWarning only writes to CLAUDE_PROJECT_DIR when ECC_E2E_TEST_SANDBOX is enabled', () => {
  const fs = require('fs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-buffer-warning-'));
  const artifactDir = path.join(tempRoot, 'artifacts');
  const projectDir = path.join(tempRoot, 'project');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
  const prevSandbox = process.env.ECC_E2E_TEST_SANDBOX;
  const prevArtifactsDir = process.env.ECC_E2E_ARTIFACTS_DIR;

  try {
    const artifactBufferPath = path.join(artifactDir, 'agy-warning-buffer.jsonl');
    const projectBufferPath = path.join(projectDir, 'agy-warning-buffer.jsonl');

    process.env.CLAUDE_PROJECT_DIR = projectDir;
    delete process.env.ECC_E2E_TEST_SANDBOX;
    delete process.env.ECC_E2E_ARTIFACTS_DIR;

    bufferWarning(artifactDir, 'warn');
    assert.strictEqual(
      fs.existsSync(artifactBufferPath),
      true,
      'artifactDir agy-warning-buffer.jsonl should exist'
    );
    assert.strictEqual(
      fs.existsSync(projectBufferPath),
      false,
      'projectDir agy-warning-buffer.jsonl should NOT exist when ECC_E2E_TEST_SANDBOX is unset'
    );

    process.env.ECC_E2E_TEST_SANDBOX = 'false';
    bufferWarning(artifactDir, 'warn');
    assert.strictEqual(
      fs.existsSync(projectBufferPath),
      false,
      'projectDir agy-warning-buffer.jsonl should NOT exist when ECC_E2E_TEST_SANDBOX is false'
    );

    process.env.ECC_E2E_TEST_SANDBOX = 'true';
    bufferWarning(artifactDir, 'warn');
    assert.strictEqual(
      fs.existsSync(projectBufferPath),
      true,
      'projectDir agy-warning-buffer.jsonl should be created when ECC_E2E_TEST_SANDBOX is true'
    );

    fs.rmSync(projectBufferPath, { force: true });
    process.env.ECC_E2E_TEST_SANDBOX = '1';
    bufferWarning(artifactDir, 'warn');
    assert.strictEqual(
      fs.existsSync(projectBufferPath),
      true,
      'projectDir agy-warning-buffer.jsonl should be created when ECC_E2E_TEST_SANDBOX is 1'
    );
  } finally {
    if (prevProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    }
    if (prevSandbox === undefined) {
      delete process.env.ECC_E2E_TEST_SANDBOX;
    } else {
      process.env.ECC_E2E_TEST_SANDBOX = prevSandbox;
    }
    if (prevArtifactsDir === undefined) {
      delete process.env.ECC_E2E_ARTIFACTS_DIR;
    } else {
      process.env.ECC_E2E_ARTIFACTS_DIR = prevArtifactsDir;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const key of envKeys) {
  if (initialEnv[key] === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = initialEnv[key];
  }
}

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
