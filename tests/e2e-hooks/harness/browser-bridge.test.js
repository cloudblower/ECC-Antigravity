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
} catch (_e) {
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

    // Verify evaluateScript was called to select model, focus Lexical input and click send button
    assert.ok(evalScripts.length >= 2, 'Must call evaluateScript at least twice (focus + click)');
    const focusCall = evalScripts.find(call => {
      const code = call.fn || call.function || '';
      return code.includes('aria-label="Message input"') || code.includes('data-lexical-editor');
    });
    assert.ok(focusCall, 'Focus call must target Lexical editor');
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
        const code = args.function || args.fn;
        if (code && (code.includes('New Conversation') || code.includes('new (?:conversation|chat)'))) {
          evalFunctionCode = code;
        }
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

  await test('openNewConversation does not click sidebar section item or Whats new button', async () => {
    let evalCode = '';
    const mockClient = {
      async navigatePage() { return {}; },
      async evaluateScript(args) {
        const code = args.function || args.fn;
        if (code && (code.includes('New Conversation') || code.includes('new (?:conversation|chat)'))) {
          evalCode = code;
        }
        return { clicked: true };
      }
    };

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/?section=sec-999',
      client: mockClient,
      pageId: 1
    });

    await bridge.openNewConversation();

    // Verify selector rules inside evalCode:
    // 1. Must NOT allow bare a[href*="..."] fallback
    assert.strictEqual(
      evalCode.includes("document.querySelector('a[href*=\"' + targetSection"),
      false,
      'Must NOT fall back to bare a[href*="..."] which targets sidebar section item'
    );
    // 2. Must NOT include aria.includes('new')
    assert.strictEqual(
      evalCode.includes(".includes('new')"),
      false,
      'Must NOT use loose .includes(\'new\') which matches "What\'s new"'
    );
    // 3. Must target bounded regex /\bnew (?:conversation|chat)\b/i or aria-label="New Conversation in Project"
    assert.ok(
      evalCode.includes('New Conversation in Project'),
      'Must target New Conversation in Project'
    );
    assert.ok(
      evalCode.includes('new (?:conversation|chat)') || evalCode.includes('new-conversation-button'),
      'Must use bounded regex or testid'
    );
  });

  await test('getDenialReason and verifyHookBlocked evaluate denial on full DOM text before truncating', async () => {
    let denialEvalCode = '';
    let verifyEvalCode = '';

    const mockClient = {
      async evaluateScript(args) {
        const code = args.function || args.fn;
        if (code.includes('planner-response-text') && code.includes('return { denied: true')) {
          denialEvalCode = code;
        } else if (code.includes('Fact-Forcing Gate')) {
          verifyEvalCode = code;
        }
        return { hasDenial: true, denied: true, reason: 'BLOCKED', text: 'BLOCKED' };
      }
    };

    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    await bridge.getDenialReason();
    await bridge.verifyHookBlocked();

    // Verify slicing does not happen before .includes('BLOCKED:') in getDenialReason
    assert.strictEqual(
      denialEvalCode.includes(')).slice(0, 1000);\n          if (bodyText.includes'),
      false,
      'Must NOT slice bodyText before checking includes in getDenialReason'
    );

    // Verify slicing does not happen before denial checks in verifyHookBlocked
    assert.strictEqual(
      verifyEvalCode.includes('join(\' \').slice(0, 1000);\n            const hasDenial'),
      false,
      'Must NOT slice fullText before checking hasDenial in verifyHookBlocked'
    );
  });

  await test('waitForTurnCompletion does not resolve prematurely when sawExecutionStart is false', async () => {
    let callCount = 0;
    const mockClient = {
      async evaluateScript() {
        callCount++;
        // input ready, but execution never started
        return { isExecuting: false, hasStopButton: false, isInputReady: true };
      }
    };

    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    // Run with 100ms timeout
    const result = await bridge.waitForTurnCompletion(100, 20);
    assert.strictEqual(result.completed, false, 'Should timeout and NOT complete when sawExecutionStart is false');
    assert.strictEqual(result.timeout, true);
    assert.ok(callCount > 0, 'evaluateScript must have been called');
  });

  await test('disconnect calls client.stop and nulls client reference cleanly', async () => {
    let stopped = false;
    const mockClient = {
      async stop() {
        stopped = true;
      }
    };
    const bridge = new BrowserBridge({ client: mockClient });
    await bridge.disconnect();
    assert.strictEqual(stopped, true, 'client.stop must be called');
    assert.strictEqual(bridge.client, null, 'bridge.client must be null after disconnect');

    // Repeated call should be safe no-op
    await bridge.disconnect();
  });

  await test('BrowserBridge constructor initializes browserModel with default, env, or option', async () => {
    const savedEnv = process.env.ECC_E2E_BROWSER_MODEL;
    delete process.env.ECC_E2E_BROWSER_MODEL;
    try {
      // 1. Fallback to default (config/constant)
      const bridge1 = new BrowserBridge({});
      assert.strictEqual(bridge1.browserModel, 'Gemini 3.8 Flash (Low)');

      // 2. Option takes highest priority
      const bridge2 = new BrowserBridge({ browserModel: 'Custom 1.0 (High)' });
      assert.strictEqual(bridge2.browserModel, 'Custom 1.0 (High)');

      // 3. Ambient env var takes precedence when option omitted
      process.env.ECC_E2E_BROWSER_MODEL = 'Env Model (Medium)';
      const bridge3 = new BrowserBridge({});
      assert.strictEqual(bridge3.browserModel, 'Env Model (Medium)');
    } finally {
      if (savedEnv !== undefined) process.env.ECC_E2E_BROWSER_MODEL = savedEnv;
      else delete process.env.ECC_E2E_BROWSER_MODEL;
    }
  });

  await test('selectModel returns already_selected fast-path when baseModel and effort match', async () => {
    let executedScript = '';
    const mockClient = {
      async evaluateScript(args) {
        executedScript = args.function || args.fn;
        return { status: 'already_selected', currentText: 'Gemini 3.8 Flash (Low)' };
      }
    };
    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    const res = await bridge.selectModel('Gemini 3.8 Flash (Low)');
    assert.strictEqual(res.status, 'already_selected');
    assert.ok(executedScript.includes('model-selector-trigger'), 'Must query model-selector-trigger');
  });

  await test('selectModel opens panel, handles effort group, and dispatches ArrowRight', async () => {
    let evalCode = '';
    const mockClient = {
      async evaluateScript(args) {
        evalCode = args.function || args.fn;
        return {
          status: 'selected',
          baseModel: 'Gemini 3.8 Flash',
          effort: 'low',
          current: 'Gemini 3.8 Flash (Low)'
        };
      }
    };
    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    const res = await bridge.selectModel('Gemini 3.8 Flash (Low)');
    assert.strictEqual(res.status, 'selected');
    assert.ok(evalCode.includes('model-selector-trigger'), 'Script must query trigger');
    assert.ok(evalCode.includes('model-selector-panel'), 'Script must locate panel');
    assert.ok(evalCode.includes('ArrowRight'), 'Script must dispatch ArrowRight for nested effort menu');
    assert.ok(evalCode.includes('model-selector-effort-option'), 'Script must click effort option');
  });

  await test('selectModel closes open menu and returns not_found when model does not exist', async () => {
    let evalCode = '';
    const mockClient = {
      async evaluateScript(args) {
        evalCode = args.function || args.fn;
        return {
          status: 'not_found',
          targetBase: 'Nonexistent Model',
          targetEffort: 'low',
          current: 'Gemini 3.8 Flash (Low)'
        };
      }
    };
    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    const res = await bridge.selectModel('Nonexistent Model (Low)');
    assert.strictEqual(res.status, 'not_found');
    assert.strictEqual(res.targetBase, 'Nonexistent Model');
    assert.ok(evalCode.includes("key: 'Escape'"), 'Script must dispatch Escape keydown');
    assert.ok(evalCode.includes("trigger.getAttribute('aria-expanded') === 'true'"), 'Script must check aria-expanded');
    assert.ok(evalCode.includes('trigger.click()'), 'Script must click trigger to close if still expanded');
  });

  await test('submitPrompt automatically calls selectModel before typing prompt', async () => {
    let selectCalled = false;
    let typeCalled = false;
    const mockClient = {
      async evaluateScript(args) {
        const code = args.function || args.fn;
        if (code.includes('model-selector')) {
          selectCalled = true;
          return { status: 'already_selected' };
        }
        return { focused: true, sent: true };
      },
      async typeText() {
        typeCalled = true;
      }
    };
    const bridge = new BrowserBridge({ client: mockClient, pageId: 1 });
    await bridge.submitPrompt('test prompt');
    assert.strictEqual(selectCalled, true, 'submitPrompt must call selectModel');
    assert.strictEqual(typeCalled, true, 'submitPrompt must call typeText');
  });

  function splitSelectorParts(selector, delimiterRegex) {
    const parts = [];
    let current = '';
    let bracketDepth = 0;
    let quote = null;
    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      if (quote) {
        current += ch;
        if (ch === quote && selector[i - 1] !== '\\') quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === '[') {
        bracketDepth++;
        current += ch;
      } else if (ch === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        current += ch;
      } else if (bracketDepth === 0 && delimiterRegex.test(ch)) {
        if (current.trim()) parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  function matchesCompoundSelector(el, compound) {
    let rest = compound.trim();
    if (!rest) return false;
    const tagMatch = rest.match(/^[a-zA-Z0-9_-]+/);
    if (tagMatch) {
      if (el.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest[0] === '.') {
        const clsMatch = rest.match(/^\.([a-zA-Z0-9_-]+)/);
        if (!clsMatch) return false;
        const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        if (!classes.includes(clsMatch[1])) return false;
        rest = rest.slice(clsMatch[0].length);
      } else if (rest[0] === '[') {
        const attrMatch = rest.match(/^\[([^\]=*~^$|]+)(?:(\*?=)"([^"]*)"(?:\s+(i))?)?\]/);
        if (!attrMatch) return false;
        const [, attrName, op, expectedVal, flag] = attrMatch;
        const actualVal = el.getAttribute(attrName);
        if (actualVal === null) return false;
        if (op === '=') {
          const cmpActual = flag === 'i' ? actualVal.toLowerCase() : actualVal;
          const cmpExpected = flag === 'i' ? expectedVal.toLowerCase() : expectedVal;
          if (cmpActual !== cmpExpected) return false;
        } else if (op === '*=') {
          const cmpActual = flag === 'i' ? actualVal.toLowerCase() : actualVal;
          const cmpExpected = flag === 'i' ? expectedVal.toLowerCase() : expectedVal;
          if (!cmpActual.includes(cmpExpected)) return false;
        }
        rest = rest.slice(attrMatch[0].length);
      } else {
        return false;
      }
    }
    return true;
  }

  function matchesSelectorList(el, selector) {
    const groups = splitSelectorParts(selector, /,/);
    return groups.some(group => {
      const chain = splitSelectorParts(group, /\s/);
      if (chain.length === 0) return false;
      if (!matchesCompoundSelector(el, chain[chain.length - 1])) return false;
      let cur = el.parentElement;
      for (let i = chain.length - 2; i >= 0; i--) {
        while (cur && !matchesCompoundSelector(cur, chain[i])) {
          cur = cur.parentElement;
        }
        if (!cur) return false;
        cur = cur.parentElement;
      }
      return true;
    });
  }

  function createMockEl(tagName, attrs = {}, children = [], text = '') {
    const attributes = new Map();
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) {
        attributes.set(k, String(v));
      }
    }
    const el = {
      tagName: tagName.toUpperCase(),
      attributes,
      children: [],
      parentElement: null,
      innerText: text,
      textContent: text,
      clicks: 0,
      onClick: null,
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      setAttribute(name, val) {
        attributes.set(name, String(val));
      },
      hasAttribute(name) {
        return attributes.has(name);
      },
      appendChild(child) {
        child.parentElement = el;
        el.children.push(child);
        return child;
      },
      click() {
        el.clicks++;
        if (typeof el.onClick === 'function') el.onClick(el);
      },
      matches(selector) {
        return matchesSelectorList(el, selector);
      },
      closest(selector) {
        let cur = el;
        while (cur) {
          if (matchesSelectorList(cur, selector)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelector(selector) {
        return el.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const out = [];
        const walk = node => {
          for (const child of node.children) {
            if (matchesSelectorList(child, selector)) out.push(child);
            walk(child);
          }
        };
        walk(el);
        return out;
      }
    };
    for (const child of children) {
      el.appendChild(child);
    }
    return el;
  }

  function createMockDocument(rootChildren = []) {
    const body = createMockEl('body', {}, rootChildren);
    return {
      body,
      querySelector(selector) {
        return body.querySelector(selector);
      },
      querySelectorAll(selector) {
        return body.querySelectorAll(selector);
      }
    };
  }

  function buildSidebarProjectNode({ name, expanded = 'true', sectionId, deferLinkUntilExpanded = false }) {
    const newConvLink = createMockEl('a', {
      'aria-label': 'New Conversation in Project',
      href: `https://127.0.0.1:37811/?section=${sectionId}`
    });
    const projectBtn = createMockEl('button', { 'aria-expanded': expanded }, [], name);
    const actionsDiv = createMockEl('div', { class: 'actions' }, [
      createMockEl('button', { 'aria-label': 'Project options', 'aria-expanded': 'false' }),
      ...(deferLinkUntilExpanded && expanded === 'false' ? [] : [newConvLink])
    ]);
    if (expanded === 'false') {
      projectBtn.onClick = () => {
        projectBtn.setAttribute('aria-expanded', 'true');
        if (deferLinkUntilExpanded && !actionsDiv.children.includes(newConvLink)) {
          actionsDiv.appendChild(newConvLink);
        }
      };
    }
    const headerDiv = createMockEl('div', { class: 'group-header' }, [
      createMockEl('div', { class: 'w-full' }, [projectBtn]),
      actionsDiv
    ]);
    const wrapperDiv = createMockEl('div', { class: 'bg-sidebar' }, [headerDiv]);
    return { wrapperDiv, projectBtn, newConvLink };
  }

  function createDomClient(doc) {
    return {
      async navigatePage() {
        return { success: true };
      },
      async evaluateScript(args) {
        const code = args.function || args.fn;
        const fn = new Function('document', `return (${code})();`);
        return fn(doc);
      }
    };
  }

  await test('openNewConversation selects project matching sandboxDir basename when webUrl has no ?section= and throws if missing', async () => {
    const genericNewConv = createMockEl('a', { href: 'https://127.0.0.1:37811/' }, [], 'New Conversation');
    const wrapperProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-wrapper',
      expanded: 'true',
      sectionId: 'sec-wrapper'
    });
    const testProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-test',
      expanded: 'true',
      sectionId: 'sec-test'
    });
    const nav = createMockEl('nav', { 'aria-label': 'Sidebar' }, [
      genericNewConv,
      createMockEl('div', { class: 'projects-list' }, [
        createMockEl('button', { 'aria-expanded': 'true' }, [], 'Projects'),
        wrapperProj.wrapperDiv,
        testProj.wrapperDiv
      ])
    ]);
    const doc = createMockDocument([nav]);

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: '/tmp/ECC-Antigravity-test',
      client: createDomClient(doc),
      pageId: 1
    });

    await bridge.openNewConversation();

    assert.strictEqual(genericNewConv.clicks, 0, 'Must NOT click generic New Conversation link');
    assert.strictEqual(wrapperProj.newConvLink.clicks, 0, 'Must NOT click ECC-Antigravity-wrapper link');
    assert.strictEqual(testProj.newConvLink.clicks, 1, 'Must click ECC-Antigravity-test New Conversation in Project link');

    // Now test when ECC-Antigravity-test is missing from sidebar
    const wrapperOnly = buildSidebarProjectNode({
      name: 'ECC-Antigravity-wrapper',
      expanded: 'true',
      sectionId: 'sec-wrapper'
    });
    const missingDoc = createMockDocument([
      createMockEl('nav', { 'aria-label': 'Sidebar' }, [
        createMockEl('a', { href: 'https://127.0.0.1:37811/' }, [], 'New Conversation'),
        wrapperOnly.wrapperDiv
      ])
    ]);
    const missingBridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: '/tmp/ECC-Antigravity-test',
      client: createDomClient(missingDoc),
      pageId: 1
    });

    let threw = false;
    try {
      await missingBridge.openNewConversation({ pollTimeoutMs: 250, pollIntervalMs: 25 });
    } catch (err) {
      threw = true;
      assert.ok(
        err.message.includes('ECC-Antigravity-test'),
        `Error must mention missing project name ECC-Antigravity-test, got: ${err.message}`
      );
    }
    assert.strictEqual(threw, true, 'Must throw when ECC-Antigravity-test project is missing');
    assert.strictEqual(wrapperOnly.newConvLink.clicks, 0, 'Must NOT click wrong project when target project is missing');
  });

  await test('openNewConversation expands collapsed target project and polls for delayed sidebar render', async () => {
    const wrapperProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-wrapper',
      expanded: 'true',
      sectionId: 'sec-wrapper'
    });
    const testProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-test',
      expanded: 'false',
      sectionId: 'sec-test',
      deferLinkUntilExpanded: true
    });
    // Also place a composer project dropdown button with same text to ensure it is NOT clicked
    const composerProjectDropdown = createMockEl('button', {
      'aria-expanded': 'false',
      'aria-label': 'Select project, current: ECC-Antigravity-test'
    }, [], 'ECC-Antigravity-test');

    const doc = createMockDocument([composerProjectDropdown]);
    let evalCount = 0;
    const delayedClient = {
      async navigatePage() {
        return { success: true };
      },
      async evaluateScript(args) {
        evalCount++;
        // Render sidebar after 2 polls
        if (evalCount === 3) {
          const nav = createMockEl('nav', { 'aria-label': 'Sidebar' }, [
            wrapperProj.wrapperDiv,
            testProj.wrapperDiv
          ]);
          doc.body.appendChild(nav);
        }
        const code = args.function || args.fn;
        const fn = new Function('document', `return (${code})();`);
        return fn(doc);
      }
    };

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: '/tmp/ECC-Antigravity-test',
      client: delayedClient,
      pageId: 1
    });

    await bridge.openNewConversation();

    assert.strictEqual(composerProjectDropdown.clicks, 0, 'Must NOT click composer project selector button');
    assert.strictEqual(testProj.projectBtn.clicks, 1, 'Must click collapsed project button to expand');
    assert.strictEqual(testProj.projectBtn.getAttribute('aria-expanded'), 'true', 'Project button must be expanded');
    assert.strictEqual(testProj.newConvLink.clicks, 1, 'Must click ECC-Antigravity-test New Conversation in Project link after expansion');
  });

  await test('openNewConversation does not escape into shared projects-list when collapsed project link mounts asynchronously', async () => {
    const wrapperProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-wrapper',
      expanded: 'true',
      sectionId: 'sec-wrapper'
    });
    const testProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-test',
      expanded: 'false',
      sectionId: 'sec-test',
      deferLinkUntilExpanded: true
    });

    // Override onClick so clicking expands aria-expanded, while link mounts asynchronously 2 polls later
    const actionsDiv = testProj.projectBtn.parentElement.parentElement.children[1];
    testProj.projectBtn.onClick = () => {
      testProj.projectBtn.setAttribute('aria-expanded', 'true');
    };

    const projectsList = createMockEl('div', { class: 'projects-list' }, [
      createMockEl('button', { 'aria-expanded': 'true' }, [], 'Projects'),
      wrapperProj.wrapperDiv,
      testProj.wrapperDiv
    ]);
    const nav = createMockEl('nav', { 'aria-label': 'Sidebar' }, [projectsList]);
    const doc = createMockDocument([nav]);

    let pollsAfterExpand = 0;
    const asyncMountClient = {
      async navigatePage() {
        return { success: true };
      },
      async evaluateScript(args) {
        const code = args.function || args.fn;
        if (testProj.projectBtn.clicks > 0 && !actionsDiv.children.includes(testProj.newConvLink)) {
          pollsAfterExpand++;
          if (pollsAfterExpand >= 2) {
            actionsDiv.appendChild(testProj.newConvLink);
          }
        }
        const fn = new Function('document', `return (${code})();`);
        return fn(doc);
      }
    };

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: '/tmp/ECC-Antigravity-test',
      client: asyncMountClient,
      pageId: 1
    });

    await bridge.openNewConversation({ pollTimeoutMs: 1000, pollIntervalMs: 20 });

    assert.strictEqual(wrapperProj.newConvLink.clicks, 0, 'Must NEVER escape into shared projects-list and click ECC-Antigravity-wrapper link');
    assert.strictEqual(testProj.projectBtn.clicks, 1, 'Must click collapsed ECC-Antigravity-test project button once');
    assert.strictEqual(testProj.newConvLink.clicks, 1, 'Must wait and click ECC-Antigravity-test New Conversation in Project link once mounted');
  });

  await test('openNewConversation honors explicit sandboxDir: null and allows generic-new-chat fallback', async () => {
    const genericLink = createMockEl('a', { href: 'https://127.0.0.1:37811/' }, [], 'New Conversation');
    const doc = createMockDocument([
      createMockEl('nav', { 'aria-label': 'Sidebar' }, [genericLink])
    ]);

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: null,
      client: createDomClient(doc),
      pageId: 1
    });

    assert.strictEqual(bridge.sandboxDir, null, 'Explicit sandboxDir: null must be preserved');
    await bridge.openNewConversation(null);
    assert.strictEqual(genericLink.clicks, 1, 'Must fall back to generic New Conversation link when sandboxDir is null');
  });

  await test('openNewConversation waits after expanding collapsed Projects group instead of racing testid button and guards invalid poll options', async () => {
    const testIdBtn = createMockEl('button', { 'data-testid': 'new-conversation-button' }, [], 'New Conversation');
    const testProj = buildSidebarProjectNode({
      name: 'ECC-Antigravity-test',
      expanded: 'true',
      sectionId: 'sec-test'
    });
    const projectsGroupBtn = createMockEl('button', { 'aria-expanded': 'false' }, [], 'Projects');
    const projectsContainer = createMockEl('div', { class: 'projects-list' }, [projectsGroupBtn]);
    projectsGroupBtn.onClick = () => {
      projectsGroupBtn.setAttribute('aria-expanded', 'true');
      projectsContainer.appendChild(testProj.wrapperDiv);
    };

    const doc = createMockDocument([
      testIdBtn,
      createMockEl('nav', { 'aria-label': 'Sidebar' }, [projectsContainer])
    ]);

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: '/tmp/ECC-Antigravity-test',
      client: createDomClient(doc),
      pageId: 1
    });

    await bridge.openNewConversation({ pollTimeoutMs: -1, pollIntervalMs: 0 });

    assert.strictEqual(projectsGroupBtn.clicks, 1, 'Must click collapsed Projects group button');
    assert.strictEqual(testIdBtn.clicks, 0, 'Must NOT race to data-testid="new-conversation-button" while Projects group is expanding');
    assert.strictEqual(testProj.newConvLink.clicks, 1, 'Must click ECC-Antigravity-test New Conversation in Project link after Projects expands');
  });

  await test('openNewConversation still supports button[data-testid="new-conversation-button"]', async () => {
    const testIdBtn = createMockEl('button', { 'data-testid': 'new-conversation-button' }, [], 'New Conversation');
    const doc = createMockDocument([testIdBtn]);

    const bridge = new BrowserBridge({
      webUrl: 'https://127.0.0.1:37811/',
      sandboxDir: '/tmp/ECC-Antigravity-test',
      client: createDomClient(doc),
      pageId: 1
    });

    await bridge.openNewConversation();
    assert.strictEqual(testIdBtn.clicks, 1, 'Must click button[data-testid="new-conversation-button"] when present');
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
