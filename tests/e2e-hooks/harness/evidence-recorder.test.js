'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

console.log('=== Testing e2e-hooks/harness/evidence-recorder.js ===');

(async () => {
  let EvidenceRecorder;
  try {
    EvidenceRecorder = require('./evidence-recorder');
  } catch (e) {
    // RED phase before file creation
  }

  await test('EvidenceRecorder class is exported', () => {
    assert.ok(EvidenceRecorder, 'EvidenceRecorder must be defined');
    assert.strictEqual(typeof EvidenceRecorder, 'function');
  });

  await test('EvidenceRecorder creates timestamped run directory and tracks results', () => {
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
      assert.ok(content.includes('< 45 tokens directive ceiling'), 'summary must mention < 45 tokens directive ceiling');
      assert.ok(content.includes('satisfied the minimal token requirement (< 45 tokens)'), 'summary must confirm < 45 tokens satisfied');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  await test('EvidenceRecorder flags prompt token ceiling violations at >= 45 tokens', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-tokens-'));
    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });
      recorder.recordTestResult({
        suite: 'test-suite',
        testName: 'over-budget prompt',
        prompt: 'a very long prompt over the limit',
        tokenCount: 46,
        status: 'fail',
        reason: 'Violation'
      });

      const reportPath = recorder.generateSummary();
      const content = fs.readFileSync(reportPath, 'utf8');
      assert.ok(content.includes('Prompt token cap violated'), 'Summary must flag violation');
      assert.ok(content.includes('46 tokens'), 'Summary must mention 46 tokens');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  await test('EvidenceRecorder prevents path traversal in testName', async () => {
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

  await test('EvidenceRecorder starts, stops, and relocates screencast recording from /tmp', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-screencast-'));
    const tmpVideoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-video-'));
    const dummyTmpVideo = path.join(tmpVideoDir, 'recording-123.mp4');
    fs.writeFileSync(dummyTmpVideo, 'fake-mp4-video-data');

    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });
      const mockMcpClient = {
        screencastStartCalls: [],
        screencastStopCalls: [],
        async screencastStart(args) {
          this.screencastStartCalls.push(args);
          return { content: [{ type: 'text', text: 'Started screencast' }] };
        },
        async screencastStop(args) {
          this.screencastStopCalls.push(args);
          return { content: [{ type: 'text', text: `Screencast saved to ${dummyTmpVideo}` }] };
        }
      };

      const targetPath = await recorder.startScreencast(42, 'canary-test', mockMcpClient);
      assert.ok(targetPath.endsWith('canary-test.mp4'));
      assert.strictEqual(mockMcpClient.screencastStartCalls.length, 1);
      assert.strictEqual(mockMcpClient.screencastStartCalls[0].pageId, 42);

      const finalPath = await recorder.stopScreencast(42, mockMcpClient);
      assert.strictEqual(finalPath, targetPath);
      assert.ok(fs.existsSync(finalPath), 'Relocated mp4 file must exist in runDir');
      assert.strictEqual(fs.readFileSync(finalPath, 'utf8'), 'fake-mp4-video-data');
      assert.strictEqual(mockMcpClient.screencastStopCalls.length, 1);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      fs.rmSync(tmpVideoDir, { recursive: true, force: true });
    }
  });

  await test('EvidenceRecorder captures screenshot and handles base64 image data', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-screenshot-'));
    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });
      const fakeBase64 = Buffer.from('fake-png-data').toString('base64');
      const mockMcpClient = {
        async takeScreenshot(args) {
          return {
            content: [
              { type: 'image', data: fakeBase64, mimeType: 'image/png' }
            ]
          };
        }
      };

      const shotPath = await recorder.captureScreenshot(42, 'canary-snap', mockMcpClient);
      assert.ok(shotPath.endsWith('canary-snap.png'));
      assert.ok(fs.existsSync(shotPath), 'Screenshot file must exist');
      assert.strictEqual(fs.readFileSync(shotPath, 'utf8'), 'fake-png-data');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  await test('EvidenceRecorder sanitizes timestamp and prevents runDir traversal', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-ts-'));
    try {
      const maliciousTs = '../../../../etc/passwd';
      const recorder = new EvidenceRecorder({ baseDir: tmpBase, timestamp: maliciousTs });
      assert.ok(recorder.runDir.startsWith(path.resolve(tmpBase) + path.sep), 'runDir must remain inside baseDir');
      assert.strictEqual(recorder.timestamp, 'passwd');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  await test('EvidenceRecorder rejects file copy from symlinks or paths outside os.tmpdir()', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-copy-'));
    const outsideFile = path.resolve(__dirname, 'evidence-recorder.js');
    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });
      const mockMcpClient = {
        async screencastStop() {
          return { content: [{ type: 'text', text: `Screencast saved to ${outsideFile}` }] };
        }
      };
      await recorder.startScreencast(1, 'test-outside');
      const finalPath = await recorder.stopScreencast(1, mockMcpClient);
      // Because outsideFile is outside os.tmpdir(), it must NOT copy outsideFile content
      assert.ok(!fs.existsSync(finalPath) || fs.readFileSync(finalPath, 'utf8') !== fs.readFileSync(outsideFile, 'utf8'));
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  await test('EvidenceRecorder redacts secrets in test results and summary', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-secrets-'));
    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });
      recorder.recordTestResult({
        suite: '01-secrets',
        testName: 'secret leakage test',
        prompt: 'test with api_key: sk-proj-1234567890abcdef12345678',
        tokenCount: 5,
        status: 'pass',
        reason: 'Blocked with token: ghp_111122223333444455556666777788889999'
      });

      const summaryPath = recorder.generateSummary();
      const summaryContent = fs.readFileSync(summaryPath, 'utf8');
      const jsonlContent = fs.readFileSync(path.join(recorder.runDir, 'results.jsonl'), 'utf8');

      assert.ok(!summaryContent.includes('sk-proj-1234567890abcdef12345678'), 'Summary must not contain API key');
      assert.ok(!summaryContent.includes('ghp_111122223333444455556666777788889999'), 'Summary must not contain GH token');
      assert.ok(!jsonlContent.includes('sk-proj-1234567890abcdef12345678'), 'JSONL must not contain API key');
      assert.ok(!jsonlContent.includes('ghp_111122223333444455556666777788889999'), 'JSONL must not contain GH token');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
