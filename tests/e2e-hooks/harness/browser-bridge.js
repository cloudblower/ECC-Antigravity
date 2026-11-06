'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const LLMJudge = require('./llm-judge');
const { findLastDenial } = require('./fixture-manager');

class BrowserBridge {
  constructor(options = {}) {
    const defaultSandbox = path.resolve(__dirname, '../../../test-sandbox');
    const homeSandbox = path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test');

    this.webUrl = options.webUrl || 'https://127.0.0.1:37811/?section=fd24d189-63b2-438f-acd8-4025c11c78cf';
    this.sandboxDir = options.sandboxDir || (fs.existsSync(homeSandbox) ? homeSandbox : defaultSandbox);
    this.client = options.client || null;
    this.pageId = options.pageId || 1;
    this.lastTurnTimestamp = null;
  }

  async connect(mcpClient = null) {
    if (mcpClient) {
      this.client = mcpClient;
    }

    if (this.client && typeof this.client.listPages === 'function') {
      try {
        const pages = await this.client.listPages();
        if (Array.isArray(pages)) {
          const antigravityPage = pages.find(p => p.url && (p.url.includes('127.0.0.1:37811') || p.url.includes('antigravity')));
          if (antigravityPage) {
            this.pageId = antigravityPage.id || 1;
          }
        } else if (typeof pages === 'string') {
          const lines = pages.split('\n');
          for (const line of lines) {
            const match = line.match(/^(\d+):\s*(.*)/);
            if (match) {
              const id = parseInt(match[1], 10);
              const info = match[2];
              if (info.includes('127.0.0.1:37811') || info.toLowerCase().includes('antigravity')) {
                this.pageId = id;
                break;
              }
            }
          }
        }
      } catch (_) {}
    }

    // Navigate to webUrl if client supports navigatePage
    if (this.client && typeof this.client.navigatePage === 'function') {
      try {
        await this.client.navigatePage({
          pageId: this.pageId,
          url: this.webUrl
        });
        await new Promise(r => setTimeout(r, 1200));
      } catch (_) {}
    }

    return { connected: true, pageId: this.pageId };
  }

  async openNewConversation() {
    this.lastTurnTimestamp = new Date().toISOString();
    if (this.client && typeof this.client.navigatePage === 'function') {
      try {
        await this.client.navigatePage({
          pageId: this.pageId,
          url: this.webUrl
        });
        await new Promise(r => setTimeout(r, 1200));
      } catch (_) {}
    } else if (this.client && typeof this.client.evaluateScript === 'function') {
      await this.client.evaluateScript({
        pageId: this.pageId,
        format: 'function',
        function: `() => {
          const links = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
          const newChat = links.find(el => (el.innerText || '').includes('New Conversation') || (el.getAttribute('aria-label') || '').includes('New'));
          if (newChat) {
            newChat.click();
            return { clicked: true };
          }
          return { clicked: false };
        }`
      });
      await new Promise(r => setTimeout(r, 600));
    }
  }

  async submitPrompt(promptText) {
    const tokenCount = LLMJudge.countTokens(promptText);
    if (tokenCount >= 12) {
      throw new Error(`Minimal Token Constraint Violated: prompt "${promptText}" has ${tokenCount} tokens (must be < 12 tokens).`);
    }

    this.lastTurnTimestamp = new Date().toISOString();

    if (this.client) {
      // 1. Focus Lexical rich-text input
      if (typeof this.client.evaluateScript === 'function') {
        const focusRes = await this.client.evaluateScript({
          pageId: this.pageId,
          format: 'function',
          function: `() => {
            const input = document.querySelector('div[aria-label="Message input"][data-lexical-editor="true"]')
              || document.querySelector('div[aria-label="Message input"]')
              || document.querySelector('[data-lexical-editor="true"]')
              || document.querySelector('div[contenteditable="true"]');
            if (input) {
              input.focus();
              return { focused: true };
            }
            return { focused: false, error: 'input element not found' };
          }`
        });

        if (focusRes && focusRes.focused === false) {
          throw new Error(`Failed to focus Lexical message input: ${focusRes.error || 'input element not found'}`);
        }
      }

      // 2. Dispatch real keyboard text typing via type_text
      if (typeof this.client.typeText === 'function') {
        await this.client.typeText({
          pageId: this.pageId,
          text: promptText
        });
      } else if (typeof this.client.callTool === 'function') {
        await this.client.callTool('type_text', {
          pageId: this.pageId,
          text: promptText
        });
      }

      // Small pause for Lexical internal transaction
      await new Promise(r => setTimeout(r, 200));

      // 3. Click send button
      if (typeof this.client.evaluateScript === 'function') {
        await this.client.evaluateScript({
          pageId: this.pageId,
          format: 'function',
          function: `() => {
            const sendBtn = document.querySelector('button[data-testid="send-button"]')
              || document.querySelector('button[aria-label="Send message"]');
            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click();
              return { sent: true };
            }
            return { sent: false, disabled: Boolean(sendBtn?.disabled) };
          }`
        });
      }
    }

    return { prompt: promptText, tokenCount, submittedAt: this.lastTurnTimestamp };
  }

  async waitForTurnCompletion(timeoutMs = 60000, pollIntervalMs = 500) {
    const startTime = Date.now();
    let sawExecutionStart = false;

    while (Date.now() - startTime < timeoutMs) {
      if (this.client && typeof this.client.evaluateScript === 'function') {
        let status = null;
        try {
          status = await this.client.evaluateScript({
            pageId: this.pageId,
            format: 'function',
            function: `() => {
              const stopBtn = document.querySelector('button[aria-label="Stop execution"]');
              const sendBtn = document.querySelector('button[data-testid="send-button"]')
                || document.querySelector('button[aria-label="Send message"]');
              const hasStopButton = Boolean(stopBtn);
              const isExecuting = hasStopButton;
              const isInputReady = Boolean(sendBtn && !sendBtn.disabled);
              return { isExecuting, hasStopButton, isInputReady };
            }`
          });
        } catch (_) {}

        if (status && (status.isExecuting || status.hasStopButton)) {
          sawExecutionStart = true;
        }

        // If execution started and has now stopped
        if (sawExecutionStart && status && !status.isExecuting && !status.hasStopButton) {
          return { completed: true, durationMs: Date.now() - startTime };
        }

        // Check if hook denial was already logged to disk for this turn
        if (this.lastTurnTimestamp) {
          const denial = findLastDenial(this.sandboxDir, this.lastTurnTimestamp);
          if (denial) {
            await new Promise(r => setTimeout(r, 2000));
            return { completed: true, durationMs: Date.now() - startTime, hookDenied: true };
          }
        }
      } else {
        await new Promise(r => setTimeout(r, 50));
        return { completed: true, durationMs: 50 };
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return { completed: false, timeout: true, durationMs: Date.now() - startTime };
  }

  async getDenialReason() {
    // 1. Check disk log (authoritative)
    const logDenial = findLastDenial(this.sandboxDir, this.lastTurnTimestamp);
    if (logDenial && logDenial.result && logDenial.result.reason) {
      return logDenial.result.reason;
    }

    // 2. Query DOM for denial text
    if (this.client && typeof this.client.evaluateScript === 'function') {
      const domResult = await this.client.evaluateScript({
        pageId: this.pageId,
        format: 'function',
        function: `() => {
          const planner = document.querySelector('[data-testid="planner-response-text"]');
          const step = document.querySelector('[data-testid="run-command-step"]');
          const bodyText = (planner?.innerText || '') + ' ' + (step?.innerText || '') + ' ' + (document.body.innerText || '');
          if (bodyText.includes('BLOCKED:') || bodyText.includes('denied') || bodyText.includes('prohibited')) {
            return { denied: true, reason: bodyText };
          }
          return null;
        }`
      });

      if (domResult && domResult.reason) {
        return domResult.reason;
      }
    }

    return null;
  }

  async verifyHookBlocked(options = {}) {
    const rawPattern = options.expectedPattern;
    const expectedRegex = rawPattern
      ? (rawPattern instanceof RegExp ? rawPattern : new RegExp(String(rawPattern), 'i'))
      : null;

    // 1. Disk verification
    let diskVerified = false;
    let diskReason = '';
    const logDenial = findLastDenial(this.sandboxDir, this.lastTurnTimestamp);
    if (logDenial && logDenial.result && logDenial.result.decision === 'deny') {
      diskReason = logDenial.result.reason || '';
      if (!expectedRegex || expectedRegex.test(diskReason)) {
        diskVerified = true;
      }
    }

    // 2. DOM verification
    let domVerified = false;
    let domReason = '';
    if (this.client && typeof this.client.evaluateScript === 'function') {
      try {
        const domResult = await this.client.evaluateScript({
          pageId: this.pageId,
          format: 'function',
          function: `() => {
            const planner = document.querySelector('[data-testid="planner-response-text"]');
            const step = document.querySelector('[data-testid="run-command-step"]');
            const body = document.body.innerText || '';
            const fullText = [(planner?.innerText || ''), (step?.innerText || ''), body].join(' ');
            const hasDenial = fullText.includes('BLOCKED:') ||
              fullText.includes('denied') ||
              fullText.includes('prohibited') ||
              fullText.includes('Fact-Forcing Gate') ||
              fullText.includes('GateGuard');
            return { hasDenial, text: fullText };
          }`
        });

        if (domResult && (domResult.hasDenial || domResult.deniedInDom)) {
          domReason = domResult.text || domResult.domText || '';
          if (!expectedRegex || expectedRegex.test(domReason)) {
            domVerified = true;
          }
        }
      } catch (_) {}
    }

    const blocked = diskVerified || domVerified;
    const reason = diskReason || domReason || 'Hook blocked execution';

    return {
      blocked,
      diskVerified,
      domVerified,
      reason
    };
  }
}

module.exports = BrowserBridge;
