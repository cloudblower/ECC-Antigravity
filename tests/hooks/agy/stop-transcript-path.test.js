'use strict';
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
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

console.log('--- stop-transcript-path.test.js ---');

const testDir = path.join(__dirname, 'test-env-stop-tp');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

test('stop.js passes shimmed claude-compat-transcript.jsonl to hooks via stdin JSON transcript_path', () => {
  const agyTranscriptPath = path.join(testDir, 'transcript.jsonl');
  // Write a valid Antigravity transcript line
  const agyLine = {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    content: 'Please create an awesome feature'
  };
  fs.writeFileSync(agyTranscriptPath, JSON.stringify(agyLine) + '\n', 'utf8');

  const payload = {
    conversationId: 'conv-tp-123',
    transcriptPath: agyTranscriptPath,
    workspacePaths: [testDir],
    artifactDirectoryPath: testDir,
    fullyIdle: true,
    terminationReason: 'model_stop'
  };

  const capturedInputFile = path.join(testDir, 'captured-input.json');
  const mockDispatcher = path.join(testDir, 'mock-capture.js');
  fs.writeFileSync(mockDispatcher, `
    const fs = require('fs');
    const input = fs.readFileSync(0, 'utf8');
    fs.writeFileSync(${JSON.stringify(capturedInputFile)}, input, 'utf8');
    console.log(JSON.stringify({}));
  `);

  const result = spawnSync('node', [path.join(__dirname, '../../../scripts/hooks/agy/stop.js')], {
    input: JSON.stringify(payload),
    env: { ...process.env, MOCK_ECC_DISPATCHER: mockDispatcher }
  });

  assert.strictEqual(result.status, 0);
  assert(fs.existsSync(capturedInputFile), 'Captured input file must exist');

  const capturedInput = JSON.parse(fs.readFileSync(capturedInputFile, 'utf8'));
  const expectedCompatPath = path.join(testDir, 'claude-compat-transcript.jsonl');

  assert.strictEqual(capturedInput.transcript_path, expectedCompatPath);
  assert(fs.existsSync(expectedCompatPath), 'Compat transcript must have been generated');

  // Verify that session-end.js can run with this captured input and extract the user message
  const sessionEndScript = path.join(__dirname, '../../../scripts/hooks/session-end.js');
  const agentDataHome = path.join(testDir, 'agent-data');
  const sessionEndResult = spawnSync('node', [sessionEndScript], {
    input: JSON.stringify(capturedInput),
    env: {
      ...process.env,
      ECC_AGENT_DATA_HOME: agentDataHome,
      CLAUDE_PROJECT_DIR: testDir,
      CLAUDE_SESSION_ID: 'conv-tp-123'
    }
  });
  assert.strictEqual(sessionEndResult.status, 0);

  // Check generated session file
  const sessionsDir = path.join(agentDataHome, 'session-data');
  const files = fs.readdirSync(sessionsDir);
  assert(files.length > 0, 'Session file should be created');
  const sessionContent = fs.readFileSync(path.join(sessionsDir, files[0]), 'utf8');
  assert(sessionContent.includes('Please create an awesome feature'), 'Summary should contain user message from compat transcript');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
