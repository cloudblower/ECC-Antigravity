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

console.log('=== Testing e2e-hooks/harness/browser-bridge.js ===');

let BrowserBridge;
try {
  BrowserBridge = require('./browser-bridge');
} catch (e) {
  // RED phase before file creation
}

(async () => {
  await test('BrowserBridge class is exported', () => {
    assert.ok(BrowserBridge, 'BrowserBridge must be defined');
    const bridge = new BrowserBridge();
    assert.strictEqual(typeof bridge.connect, 'function');
    assert.strictEqual(typeof bridge.submitPrompt, 'function');
    assert.strictEqual(typeof bridge.waitForTurnCompletion, 'function');
    assert.strictEqual(typeof bridge.getDenialReason, 'function');
    assert.strictEqual(typeof bridge.verifyHookBlocked, 'function');
  });

  await test('submitPrompt enforces < 12 tokens constraint', async () => {
    const bridge = new BrowserBridge({
      client: {
        evaluateScript: async () => ({ success: true }),
        typeText: async () => ({ success: true })
      }
    });

    const longPrompt = 'please start up the development server and run all pending background build steps right now';
    let threw = false;
    try {
      await bridge.submitPrompt(longPrompt);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('tokens'), 'Error must mention token constraint');
    }
    assert.strictEqual(threw, true, 'Long prompt must be rejected');
  });

  await test('submitPrompt focuses Lexical editor, types text with typeText, and clicks send button', async () => {
    const evalScripts = [];
    const typedTexts = [];

    const mockClient = {
      async evaluateScript(args) {
        evalScripts.push(args);
        return { success: true, focused: true, clicked: true };
      },
      async typeText(args) {
        typedTexts.push(args);
        return { success: true };
      }
    };

    const bridge = new BrowserBridge({
      client: mockClient,
      pageId: 42
    });

    const res = await bridge.submitPrompt('run dev server');
    assert.strictEqual(res.prompt, 'run dev server');
    assert.strictEqual(res.tokenCount, 3);

    // Verify typeText was called with correct pageId and prompt
    assert.strictEqual(typedTexts.length, 1);
    assert.strictEqual(typedTexts[0].pageId, 42);
    assert.strictEqual(typedTexts[0].text, 'run dev server');

    // Verify evaluateScript was called to focus Lexical input and click send button
    assert.ok(evalScripts.length >= 2, 'Must call evaluateScript at least twice (focus + click)');
    const focusCall = evalScripts[0];
    assert.ok(focusCall.fn || focusCall.function);
    const focusCode = focusCall.fn || focusCall.function;
    assert.ok(focusCode.includes('aria-label="Message input"') || focusCode.includes('data-lexical-editor'), 'Focus call must target Lexical editor');

    const clickCall = evalScripts[evalScripts.length - 1];
    const clickCode = clickCall.fn || clickCall.function;
    assert.ok(clickCode.includes('data-testid="send-button"') || clickCode.includes('aria-label="Send message"'), 'Click call must target send button');
  });

  await test('submitPrompt throws when Lexical editor focus fails', async () => {
    const mockClient = {
      async evaluateScript() {
        return { focused: false, error: 'input element not found' };
      }
    };
    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    let threw = false;
    try {
      await bridge.submitPrompt('npm run dev');
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Failed to focus Lexical message input'));
    }
    assert.strictEqual(threw, true, 'Must throw when focus fails');
  });

  await test('waitForTurnCompletion tracks Stop execution button lifecycle (appearance -> disappearance)', async () => {
    let callCount = 0;
    const mockClient = {
      async evaluateScript() {
        callCount++;
        // Turn:
        // call 1: stop button not yet visible
        // call 2: stop button appears (isExecuting = true)
        // call 3: stop button disappears (isExecuting = false)
        if (callCount === 1) return { isExecuting: false, hasStopButton: false };
        if (callCount === 2) return { isExecuting: true, hasStopButton: true };
        return { isExecuting: false, hasStopButton: false, isInputReady: true };
      }
    };

    const bridge = new BrowserBridge({
      client: mockClient,
      pageId: 42
    });

    const result = await bridge.waitForTurnCompletion(5000, 20);
    assert.strictEqual(result.completed, true);
    assert.ok(callCount >= 3, `Expected at least 3 poll calls, got ${callCount}`);
  });

  await test('verifyHookBlocked performs dual verification against DOM and disk log', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-bridge-sandbox-'));
    const agentsDir = path.join(tmpDir, '.agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const logEntry = {
      timestamp: new Date().toISOString(),
      hook: 'PreToolUse',
      conversationId: 'conv-123',
      result: {
        decision: 'deny',
        reason: '[Hook] BLOCKED: Dev server must run in tmux for log access'
      }
    };
    fs.writeFileSync(path.join(agentsDir, 'hooks-execution.log'), JSON.stringify(logEntry) + '\n');

    try {
      const mockClient = {
        async evaluateScript() {
          return {
            deniedInDom: true,
            domText: 'BLOCKED: Dev server must run in tmux for log access',
            plannerText: 'Execution was stopped by hook'
          };
        }
      };

      const bridge = new BrowserBridge({
        sandboxDir: tmpDir,
        client: mockClient,
        pageId: 42
      });

      const verification = await bridge.verifyHookBlocked({ expectedPattern: 'tmux' });
      assert.strictEqual(verification.blocked, true);
      assert.strictEqual(verification.domVerified, true);
      assert.strictEqual(verification.diskVerified, true);
      assert.ok(verification.reason.includes('tmux'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
