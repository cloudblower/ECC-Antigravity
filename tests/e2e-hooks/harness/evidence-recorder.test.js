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

console.log('=== Testing e2e-hooks/harness/evidence-recorder.js ===');

let EvidenceRecorder;
try {
  EvidenceRecorder = require('./evidence-recorder');
} catch (e) {
  // RED phase before file creation
}

test('EvidenceRecorder class is exported', () => {
  assert.ok(EvidenceRecorder, 'EvidenceRecorder must be defined');
  assert.strictEqual(typeof EvidenceRecorder, 'function');
});

test('EvidenceRecorder creates timestamped run directory and tracks results', () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-test-'));
  try {
    const recorder = new EvidenceRecorder({ baseDir: tmpBase });
    assert.ok(fs.existsSync(recorder.runDir), 'runDir must be created');

    recorder.recordTestResult({
      suite: '00-canary-fail-fast',
      testName: 'canary dev server block',
      prompt: 'run dev server',
      tokenCount: 3,
      status: 'pass',
      reason: 'Blocked by hook exit code 2',
      durationMs: 1200
    });

    assert.strictEqual(recorder.results.length, 1);

    const reportPath = recorder.generateSummary({ totalDurationMs: 5000 });
    assert.ok(fs.existsSync(reportPath), 'summary.md must exist');
    const content = fs.readFileSync(reportPath, 'utf8');
    assert.ok(content.includes('00-canary-fail-fast'), 'summary must mention canary');
    assert.ok(content.includes('run dev server'), 'summary must mention prompt');
    assert.ok(content.includes('tokenCount') || content.includes('Tokens: 3') || content.includes('| 3 |'), 'summary must mention token count');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('EvidenceRecorder prevents path traversal in testName', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-traversal-'));
  try {
    const recorder = new EvidenceRecorder({ baseDir: tmpBase });
    const maliciousName = '../../../../etc/passwd';
    const filePath = await recorder.captureScreenshot('page1', maliciousName);
    assert.ok(filePath.startsWith(path.resolve(recorder.runDir)), 'Resolved path must remain inside runDir');
    assert.strictEqual(path.basename(filePath), 'passwd.png', 'Basename should be sanitized');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
