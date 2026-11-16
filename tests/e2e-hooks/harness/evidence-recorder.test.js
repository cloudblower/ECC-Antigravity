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
  } catch (_e) {
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
        async takeScreenshot(_args) {
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

  await test('EvidenceRecorder redacts secrets in token cap violation list in summary', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-secret-violations-'));
    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });
      recorder.recordTestResult({
        suite: 'test-suite-tokens',
        testName: 'violating-prompt-with-secret',
        prompt: 'over budget with token: ghp_111122223333444455556666777788889999 and ' + 'word '.repeat(50),
        tokenCount: 52,
        status: 'fail',
        reason: 'Too long'
      });

      const summaryPath = recorder.generateSummary();
      const content = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(content.includes('Prompt token cap violated:'));
      assert.ok(!content.includes('ghp_111122223333444455556666777788889999'), 'Violating prompt in summary must have secret redacted');
      assert.ok(content.includes('[REDACTED_GH_TOKEN]'), 'Must replace with redacted token placeholder');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  await test('captureStructuredEvidence generates 6 multi-modal files, truncates a11y to 10k, redacts secrets, and generateSummary writes evidence-manifest.json', async () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-artifacts-structured-'));
    try {
      const recorder = new EvidenceRecorder({ baseDir: tmpBase });

      // Check method existence
      assert.strictEqual(typeof recorder.captureStructuredEvidence, 'function');

      const longA11ySnapshot = 'Snapshot line with Bearer sk-ant-secret1234567890abcdef. '.repeat(500); // ~28,000 chars

      const evidence = await recorder.captureStructuredEvidence('canary-test', {
        hookLogs: [
          { hook: 'PreToolUse:Bash', tool: 'Bash', command: 'git status --token=secrettoken123' }
        ],
        sideEffects: {
          metrics: { cost: 0.01 },
          warning: 'token: AIzaSyB1234567890abcdefghij1234567890'
        },
        a11ySnapshot: longA11ySnapshot,
        domExtract: {
          currentUrl: 'https://127.0.0.1:37811/?section=fd24d189-63b2-438f-acd8-4025c11c78cf',
          buttonText: 'Stop execution'
        },
        browserDiagnostics: {
          consoleMessages: [{ level: 'info', text: 'loaded' }],
          networkRequests: [{ url: 'https://127.0.0.1:37811/state', status: 200 }]
        },
        verificationReceipt: {
          testName: 'canary-test',
          status: 'pass',
          tokenCount: 12,
          authHeader: 'Bearer sk-ant-secret1234567890abcdef'
        }
      });

      assert.ok(evidence, 'Should return evidence object');
      assert.ok(fs.existsSync(evidence.hookTrace), 'hook-trace.jsonl must exist');
      assert.ok(fs.existsSync(evidence.sideEffects), 'side-effects.json must exist');
      assert.ok(fs.existsSync(evidence.a11ySnapshot), 'a11y-snapshot.txt must exist');
      assert.ok(fs.existsSync(evidence.domExtract), 'dom-extract.json must exist');
      assert.ok(fs.existsSync(evidence.browserDiagnostics), 'browser-diagnostics.json must exist');
      assert.ok(fs.existsSync(evidence.verificationReceipt), 'verification-receipt.json must exist');

      // Verify a11y snapshot is truncated to <= 10000 chars
      const a11yContent = fs.readFileSync(evidence.a11ySnapshot, 'utf8');
      assert.ok(a11yContent.length <= 10000, `a11yContent should be <= 10000 chars, got ${a11yContent.length}`);

      // Verify secret redaction across generated files
      for (const filePath of evidence.allFiles) {
        const raw = fs.readFileSync(filePath, 'utf8');
        assert.strictEqual(raw.includes('secrettoken123'), false, `Secret leaked in ${path.basename(filePath)}`);
        assert.strictEqual(raw.includes('sk-ant-secret1234567890abcdef'), false, `sk-ant leaked in ${path.basename(filePath)}`);
        assert.strictEqual(raw.includes('AIzaSyB1234567890abcdefghij1234567890'), false, `AIza leaked in ${path.basename(filePath)}`);
        assert.strictEqual(raw.includes('section=fd24d189-63b2-438f-acd8-4025c11c78cf'), false, `Section leaked in ${path.basename(filePath)}`);
      }

      // Record test result with evidence files
      recorder.recordTestResult({
        suite: '00-canary-fail-fast',
        testName: 'canary-test',
        prompt: 'test prompt',
        tokenCount: 4,
        status: 'pass',
        reason: 'Block verified',
        evidenceFiles: evidence.allFiles,
        structuredEvidence: evidence
      });

      const hookMatrix = [
        { id: 'PreToolUse:Bash:git-push-check', suite: '00-canary-fail-fast', testName: 'canary-test' }
      ];

      const summaryPath = recorder.generateSummary({ totalDurationMs: 1000 }, hookMatrix);
      assert.ok(fs.existsSync(summaryPath), 'summary.md must exist');

      // Verify evidence-manifest.json
      const manifestPath = path.join(recorder.runDir, 'evidence-manifest.json');
      assert.ok(fs.existsSync(manifestPath), 'evidence-manifest.json must exist');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(manifest.suites && manifest.suites.length === 1);
      assert.strictEqual(manifest.suites[0].suite, '00-canary-fail-fast');
      assert.ok(manifest.suites[0].evidenceFiles.length >= 6);
      assert.ok(manifest.hookMatrix && manifest.hookMatrix.length === 1);

      // Verify summary.md links to structured evidence
      const summaryMd = fs.readFileSync(summaryPath, 'utf8');
      assert.ok(summaryMd.includes('hook-trace.jsonl'), 'summary.md should reference hook-trace');
      assert.ok(summaryMd.includes('evidence-manifest.json'), 'summary.md should reference manifest');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
