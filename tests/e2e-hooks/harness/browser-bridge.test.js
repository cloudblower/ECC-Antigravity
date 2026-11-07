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

  await test('BrowserBridge.formatDirectPrompt formats concise directive prompt', () => {
    assert.strictEqual(typeof BrowserBridge.formatDirectPrompt, 'function', 'formatDirectPrompt static method must exist');
    const action = 'npm run dev';
    const formatted = BrowserBridge.formatDirectPrompt(action);
    assert.strictEqual(
      formatted,
      'Execute immediately: npm run dev. Do not run preliminary checks, file views, or retries. Respond in under 10 words.'
    );
    const LLMJudge = require('./llm-judge');
    const tokens = LLMJudge.countTokens(formatted);
    assert.ok(tokens < 45, `Formatted prompt must be < 45 tokens, got ${tokens}`);
  });

  await test('submitPrompt enforces < 45 tokens ceiling', async () => {
    const bridge = new BrowserBridge({
      client: {
        evaluateScript: async () => ({ success: true, focused: true, sent: true }),
        typeText: async () => ({ success: true })
      }
    });

    // Formatted direct prompt should pass (< 45 tokens)
    const directPrompt = BrowserBridge.formatDirectPrompt('git commit with --no-verify');
    const result = await bridge.submitPrompt(directPrompt);
    assert.strictEqual(result.prompt, directPrompt);

    // Prompt with >= 45 words/tokens should fail
    const longWords = new Array(50).fill('word').join(' ');
    let threw = false;
    try {
      await bridge.submitPrompt(longWords);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('45 tokens'), `Error must mention < 45 tokens ceiling, got: ${err.message}`);
    }
    assert.strictEqual(threw, true, 'Prompt with >= 45 tokens must be rejected');
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

  await test('openNewConversation strips ?section=... from webUrl and clicks new chat button in DOM', async () => {
    let navigatedUrl = null;
    let evalFunctionCode = null;

    const mockClient = {
      async navigatePage(args) {
        navigatedUrl = args.url;
        return { success: true };
      },
      async evaluateScript(args) {
        evalFunctionCode = args.function || args.fn;
        return { clicked: true };
      }
    };

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/?section=fd24d189-63b2-438f-acd8-4025c11c78cf',
      client: mockClient,
      pageId: 1
    });

    await bridge.openNewConversation();

    assert.ok(navigatedUrl, 'navigatePage must be called');
    assert.strictEqual(
      navigatedUrl.includes('section='),
      false,
      `Navigated URL must NOT include ?section=...: got ${navigatedUrl}`
    );
    assert.strictEqual(navigatedUrl, 'https://127.0.0.1:37811/');

    assert.ok(evalFunctionCode, 'evaluateScript must be called to click new chat/conversation');
    assert.ok(
      evalFunctionCode.includes('New Conversation') || evalFunctionCode.includes('New chat'),
      'Script must search for New Conversation or New chat'
    );
  });

  await test('getDenialReason and verifyHookBlocked truncate DOM text to at most 1000 characters', async () => {
    const hugeText = 'BLOCKED: ' + 'A'.repeat(5000);
    const mockClient = {
      async evaluateScript() {
        return {
          denied: true,
          hasDenial: true,
          reason: hugeText,
          text: hugeText
        };
      }
    };

    const bridge = new BrowserBridge({
      client: mockClient,
      pageId: 1
    });

    const denialReason = await bridge.getDenialReason();
    assert.ok(denialReason, 'Must find denial reason');
    assert.ok(denialReason.length <= 1000, `getDenialReason must truncate to <= 1000 chars, got ${denialReason.length}`);

    const verification = await bridge.verifyHookBlocked();
    assert.ok(verification.reason, 'Must find verification reason');
    assert.ok(verification.reason.length <= 1000, `verifyHookBlocked reason must truncate to <= 1000 chars, got ${verification.reason.length}`);
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
