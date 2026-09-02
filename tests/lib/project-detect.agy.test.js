/**
 * Tests for scripts/lib/project-detect.agy.js (Antigravity-specialized project detection)
 *
 * Run with: node tests/lib/project-detect.agy.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  detectProjectType,
  resolveProjectDir,
  LANGUAGE_RULES,
  FRAMEWORK_RULES,
  getPackageJsonDeps,
  getPythonDeps
} = require('../../scripts/lib/project-detect.agy');

// Test helper
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function createTempDir(prefix = 'ecc-agy-detect-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function writeTestFile(dir, filePath, content = '') {
  const fullPath = path.join(dir, filePath);
  const dirName = path.dirname(fullPath);
  fs.mkdirSync(dirName, { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function runTests() {
  console.log('\n=== Testing project-detect.agy.js ===\n');

  let passed = 0;
  let failed = 0;

  const originalEnv = { ...process.env };

  function resetEnv() {
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.AGY_PROJECT_DIR;
    delete process.env.WORKSPACE_DIR;
  }

  // 1. resolveProjectDir tests
  console.log('resolveProjectDir priority:');

  if (test('explicit argument takes highest priority', () => {
    resetEnv();
    const explicitDir = '/custom/explicit/path';
    process.env.CLAUDE_PROJECT_DIR = '/env/claude/path';
    process.env.AGY_PROJECT_DIR = '/env/agy/path';

    const resolved = resolveProjectDir(explicitDir);
    assert.strictEqual(resolved, path.resolve(explicitDir));
  })) passed++; else failed++;

  if (test('uses CLAUDE_PROJECT_DIR when projectDir argument is not provided', () => {
    resetEnv();
    const claudeDir = '/env/claude/project';
    process.env.CLAUDE_PROJECT_DIR = claudeDir;

    const resolved = resolveProjectDir();
    assert.strictEqual(resolved, path.resolve(claudeDir));
  })) passed++; else failed++;

  if (test('uses AGY_PROJECT_DIR when CLAUDE_PROJECT_DIR is unset', () => {
    resetEnv();
    const agyDir = '/env/agy/project';
    process.env.AGY_PROJECT_DIR = agyDir;

    const resolved = resolveProjectDir();
    assert.strictEqual(resolved, path.resolve(agyDir));
  })) passed++; else failed++;

  if (test('uses WORKSPACE_DIR when CLAUDE_PROJECT_DIR and AGY_PROJECT_DIR are unset', () => {
    resetEnv();
    const wsDir = '/env/workspace/project';
    process.env.WORKSPACE_DIR = wsDir;

    const resolved = resolveProjectDir();
    assert.strictEqual(resolved, path.resolve(wsDir));
  })) passed++; else failed++;

  if (test('falls back to process.cwd() when no argument and no env vars set', () => {
    resetEnv();
    const resolved = resolveProjectDir();
    assert.strictEqual(resolved, process.cwd());
  })) passed++; else failed++;

  // 2. detectProjectType with CLAUDE_PROJECT_DIR vs process.cwd()
  console.log('\nAntigravity Project Detection vs process.cwd():');

  if (test('detects project from CLAUDE_PROJECT_DIR when called with no arguments', () => {
    const pluginRootDir = createTempDir('ecc-plugin-root-');
    const userProjectDir = createTempDir('ecc-user-project-');

    try {
      // Simulate plugin root having package.json (e.g. ECC itself)
      writeTestFile(pluginRootDir, 'package.json', '{"dependencies":{"express":"4.18.0"}}');

      // Simulate user project being a Python Django project
      writeTestFile(userProjectDir, 'manage.py', '#!/usr/bin/env python');
      writeTestFile(userProjectDir, 'requirements.txt', 'django>=4.2\npsycopg2>=2.9');

      resetEnv();
      process.env.CLAUDE_PROJECT_DIR = userProjectDir;

      // detectProjectType called with NO arguments
      const result = detectProjectType();

      assert.strictEqual(result.projectDir, path.resolve(userProjectDir));
      assert.ok(result.languages.includes('python'), `Expected python language, got: ${JSON.stringify(result.languages)}`);
      assert.ok(result.frameworks.includes('django'), `Expected django framework, got: ${JSON.stringify(result.frameworks)}`);
      // Should NOT detect express from the plugin directory
      assert.ok(!result.frameworks.includes('express'), `Should not detect express from plugin root`);
    } finally {
      cleanupDir(pluginRootDir);
      cleanupDir(userProjectDir);
      resetEnv();
    }
  })) passed++; else failed++;

  if (test('detects project from explicit projectDir argument even if CLAUDE_PROJECT_DIR is set', () => {
    const dirA = createTempDir('ecc-dir-a-');
    const dirB = createTempDir('ecc-dir-b-');

    try {
      writeTestFile(dirA, 'Cargo.toml', '[package]\nname = "test"\n[dependencies]\naxum = "0.7"');
      writeTestFile(dirB, 'go.mod', 'module test\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)');

      resetEnv();
      process.env.CLAUDE_PROJECT_DIR = dirA;

      const result = detectProjectType(dirB);

      assert.strictEqual(result.projectDir, path.resolve(dirB));
      assert.ok(result.languages.includes('golang'));
      assert.ok(result.frameworks.includes('gin'));
      assert.ok(!result.languages.includes('rust'));
    } finally {
      cleanupDir(dirA);
      cleanupDir(dirB);
      resetEnv();
    }
  })) passed++; else failed++;

  // 3. Rule definitions and dependency readers
  console.log('\nRule Definitions and Dependency Readers:');

  if (test('exports LANGUAGE_RULES and FRAMEWORK_RULES', () => {
    assert.ok(Array.isArray(LANGUAGE_RULES) && LANGUAGE_RULES.length > 0);
    assert.ok(Array.isArray(FRAMEWORK_RULES) && FRAMEWORK_RULES.length > 0);
  })) passed++; else failed++;

  if (test('getPackageJsonDeps reads dependencies for resolved projectDir', () => {
    const dir = createTempDir('ecc-deps-');
    try {
      writeTestFile(dir, 'package.json', '{"dependencies":{"react":"18.0.0"},"devDependencies":{"typescript":"5.0.0"}}');
      const deps = getPackageJsonDeps(dir);
      assert.ok(deps.includes('react'));
      assert.ok(deps.includes('typescript'));
    } finally {
      cleanupDir(dir);
    }
  })) passed++; else failed++;

  if (test('getPythonDeps reads requirements for resolved projectDir', () => {
    const dir = createTempDir('ecc-pydeps-');
    try {
      writeTestFile(dir, 'requirements.txt', 'fastapi~=0.110\nuvicorn');
      const deps = getPythonDeps(dir);
      assert.ok(deps.includes('fastapi'));
      assert.ok(deps.includes('uvicorn'));
    } finally {
      cleanupDir(dir);
    }
  })) passed++; else failed++;

  // Restore env
  process.env = originalEnv;

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
