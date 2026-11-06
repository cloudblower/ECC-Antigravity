'use strict';

const assert = require('assert');

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
  });

  await test('submitPrompt enforces < 12 tokens constraint', async () => {
    const bridge = new BrowserBridge({
      client: {
        evaluateScript: async () => ({ success: true }),
        click: async () => ({ success: true })
      }
    });

    // Prompt >= 12 tokens should throw
    const longPrompt = 'please start up the development server and run all pending background build steps right now';
    let threw = false;
    try {
      await bridge.submitPrompt(longPrompt);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('tokens'), 'Error must mention token constraint');
    }
    assert.strictEqual(threw, true, 'Long prompt must be rejected');

    // Short prompt (< 12 tokens) should pass
    let submittedText = null;
    bridge.client = {
      evaluateScript: async ({ fn, args }) => {
        if (args && args[0]) submittedText = args[0];
        return { success: true };
      },
      click: async () => ({ success: true })
    };

    await bridge.submitPrompt('run dev server');
    assert.strictEqual(submittedText, 'run dev server');
  });

  await test('getDenialReason returns reason from log or DOM', async () => {
    const bridge = new BrowserBridge({
      sandboxDir: '/non-existent',
      client: {
        evaluateScript: async () => {
          return {
            denied: true,
            reason: 'BLOCKED: Dev server must run inside tmux'
          };
        }
      }
    });

    const denial = await bridge.getDenialReason();
    assert.ok(denial);
    assert.ok(denial.includes('Dev server must run inside tmux') || denial.includes('BLOCKED'));
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
