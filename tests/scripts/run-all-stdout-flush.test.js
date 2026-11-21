'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const runAllPath = path.join(repoRoot, 'tests', 'run-all.js');

const BURST_BYTES_PER_FILE = 300 * 1024;

function writeFixtureTest(testsDir, filename, lines) {
  fs.writeFileSync(path.join(testsDir, filename), `${lines.join('\n')}\n`, 'utf8');
}

function runPatchedRunAllWithBackpressure(tempRoot) {
  const runnerPath = path.join(tempRoot, 'run-all-wrapper.js');
  const tempTestsDir = path.join(tempRoot, 'tests');
  const original = fs.readFileSync(runAllPath, 'utf8');
  const patched = original.replace(
    'const testsDir = __dirname;',
    `const testsDir = ${JSON.stringify(tempTestsDir)};`
  );
  assert.notStrictEqual(patched, original, 'Failed to patch testsDir in tests/run-all.js copy');
  fs.writeFileSync(runnerPath, patched, 'utf8');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let resumed = false;

    const resumeStdout = () => {
      if (!resumed) {
        resumed = true;
        child.stdout.resume();
      }
    };

    // Hold pipe reading briefly so libuv queues stdout writes above the kernel pipe buffer
    child.stdout.on('data', chunk => stdoutChunks.push(chunk));
    child.stdout.pause();
    child.stderr.on('data', chunk => stderrChunks.push(chunk));

    const resumeTimer = setTimeout(resumeStdout, 150);
    const killTimer = setTimeout(() => {
      resumeStdout();
      child.kill('SIGKILL');
      reject(new Error('Timed out waiting for run-all wrapper to exit'));
    }, 15000);

    child.once('exit', () => {
      clearTimeout(resumeTimer);
      resumeStdout();
    });

    child.once('error', err => {
      clearTimeout(resumeTimer);
      clearTimeout(killTimer);
      reject(err);
    });

    child.once('close', (code, signal) => {
      clearTimeout(resumeTimer);
      clearTimeout(killTimer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function main() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${error.message}`);
      failed += 1;
    }
  }

  console.log('\n=== run-all.js stdout flush regression tests ===\n');

  await test('tests/run-all.js sets process.exitCode instead of calling process.exit(...)', () => {
    const source = fs.readFileSync(runAllPath, 'utf8');
    const codeOnly = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    assert.ok(
      !/\bprocess\.exit\s*\(/.test(codeOnly),
      'tests/run-all.js must not call process.exit(...) because it drops queued libuv stdout on pipes'
    );
    assert.match(
      codeOnly,
      /process\.exitCode\s*=\s*totalFailed\s*>\s*0\s*\?\s*1\s*:\s*0/,
      'tests/run-all.js must exit via process.exitCode = totalFailed > 0 ? 1 : 0'
    );
  });

  await test('flushes full stdout and Final Results over a backpressured pipe on non-zero exit after >70 KB bursts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-run-all-flush-fail-'));
    const tempTestsDir = path.join(tempRoot, 'tests');
    fs.mkdirSync(tempTestsDir, { recursive: true });

    try {
      writeFixtureTest(tempTestsDir, '01-burst-a.test.js', [
        `console.log('A'.repeat(${BURST_BYTES_PER_FILE}));`,
        "console.log('Passed: 1, Failed: 0');",
      ]);
      writeFixtureTest(tempTestsDir, '02-burst-b.test.js', [
        `console.log('B'.repeat(${BURST_BYTES_PER_FILE}));`,
        "console.log('Passed: 1, Failed: 0');",
      ]);
      writeFixtureTest(tempTestsDir, '03-fail.test.js', [
        "console.log('FAIL_FIXTURE_MARKER');",
        "console.log('Passed: 0, Failed: 1');",
        'process.exitCode = 1;',
      ]);

      const result = await runPatchedRunAllWithBackpressure(tempRoot);
      assert.strictEqual(result.signal, null, `Unexpected signal: ${result.signal}`);
      assert.strictEqual(result.code, 1, `Expected exit code 1, got ${result.code}; stderr: ${result.stderr}`);
      assert.ok(
        result.stdout.length >= BURST_BYTES_PER_FILE * 2,
        `Expected full burst output (>= ${BURST_BYTES_PER_FILE * 2} bytes), got ${result.stdout.length} bytes`
      );
      assert.ok(result.stdout.includes('FAIL_FIXTURE_MARKER'), 'Expected trailing test marker to flush');
      assert.ok(result.stdout.includes('Final Results'), 'Expected Final Results banner to flush');
      assert.match(result.stdout, /Total Tests:\s+3\b/);
      assert.match(result.stdout, /Passed:\s+2\b/);
      assert.match(result.stdout, /Failed:\s+1\b/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await test('flushes full stdout and Final Results over a backpressured pipe on zero exit after >70 KB bursts', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-run-all-flush-pass-'));
    const tempTestsDir = path.join(tempRoot, 'tests');
    fs.mkdirSync(tempTestsDir, { recursive: true });

    try {
      writeFixtureTest(tempTestsDir, '01-burst-a.test.js', [
        `console.log('A'.repeat(${BURST_BYTES_PER_FILE}));`,
        "console.log('Passed: 1, Failed: 0');",
      ]);
      writeFixtureTest(tempTestsDir, '02-burst-b.test.js', [
        `console.log('B'.repeat(${BURST_BYTES_PER_FILE}));`,
        "console.log('PASS_FIXTURE_MARKER');",
        "console.log('Passed: 1, Failed: 0');",
      ]);

      const result = await runPatchedRunAllWithBackpressure(tempRoot);
      assert.strictEqual(result.signal, null, `Unexpected signal: ${result.signal}`);
      assert.strictEqual(result.code, 0, `Expected exit code 0, got ${result.code}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('PASS_FIXTURE_MARKER'), 'Expected trailing test marker to flush');
      assert.ok(result.stdout.includes('Final Results'), 'Expected Final Results banner to flush');
      assert.match(result.stdout, /Total Tests:\s+2\b/);
      assert.match(result.stdout, /Passed:\s+2\b/);
      assert.match(result.stdout, /Failed:\s+0\b/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await test('flushes empty-suite error message over a backpressured pipe without process.exit', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-run-all-flush-empty-'));
    const tempTestsDir = path.join(tempRoot, 'tests');
    fs.mkdirSync(tempTestsDir, { recursive: true });

    try {
      const result = await runPatchedRunAllWithBackpressure(tempRoot);
      assert.strictEqual(result.signal, null, `Unexpected signal: ${result.signal}`);
      assert.strictEqual(result.code, 1, `Expected exit code 1, got ${result.code}; stderr: ${result.stderr}`);
      assert.ok(result.stdout.includes('ECC - Test Suite'), 'Expected suite banner to flush');
      assert.ok(result.stdout.includes('No test files matched'), 'Expected empty-suite message to flush');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
