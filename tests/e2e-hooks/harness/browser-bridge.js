const fs = require('fs');
const os = require('os');
const path = require('path');
const LLMJudge = require('./llm-judge');
const { findLastDenial } = require('./fixture-manager');

class BrowserBridge {
  constructor(options = {}) {
    const defaultSandbox = path.resolve(__dirname, '../../../test-sandbox');
    const homeSandbox = path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test');

    this.webUrl = options.webUrl || 'https://127.0.0.1:37811/';
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
      const pages = await this.client.listPages();
      const antigravityPage = pages.find(p => p.url && p.url.includes('127.0.0.1:37811'));
      if (antigravityPage) {
        this.pageId = antigravityPage.id || 1;
      }
    }
    return { connected: true, pageId: this.pageId };
  }

  async openNewConversation() {
    this.lastTurnTimestamp = new Date().toISOString();
    if (this.client && typeof this.client.evaluateScript === 'function') {
      await this.client.evaluateScript({
        pageId: this.pageId,
        format: 'function',
        fn: `() => {
          const newLink = document.querySelector('a[href="/"]');
          if (newLink) {
            newLink.click();
            return { clicked: true };
          }
          return { clicked: false };
        }`
      });
      // Small pause for view transition
      await new Promise(r => setTimeout(r, 800));
    }
  }

  async submitPrompt(promptText) {
    const tokenCount = LLMJudge.countTokens(promptText);
    if (tokenCount >= 12) {
      throw new Error(`Minimal Token Constraint Violated: prompt "${promptText}" has ${tokenCount} tokens (must be < 12 tokens).`);
    }

    this.lastTurnTimestamp = new Date().toISOString();

    if (this.client) {
      if (typeof this.client.evaluateScript === 'function') {
        await this.client.evaluateScript({
          pageId: this.pageId,
          format: 'function',
          args: [promptText],
          fn: `(text) => {
            const input = document.querySelector('[aria-label="Message input"]');
            if (input) {
              input.focus();
              input.innerText = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return { success: true };
            }
            return { success: false, error: 'input element not found' };
          }`
        });

        // Click send button
        await this.client.evaluateScript({
          pageId: this.pageId,
          format: 'function',
          fn: `() => {
            const sendBtn = document.querySelector('button[aria-label="Send message"]');
            if (sendBtn && !sendBtn.disabled) {
              sendBtn.click();
              return { sent: true };
            }
            return { sent: false };
          }`
        });
      }
    }

    return { prompt: promptText, tokenCount, submittedAt: this.lastTurnTimestamp };
  }

  async waitForTurnCompletion(timeoutMs = 45000, pollIntervalMs = 1500) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.client && typeof this.client.evaluateScript === 'function') {
        const status = await this.client.evaluateScript({
          pageId: this.pageId,
          format: 'function',
          fn: `() => {
            const stopBtn = document.querySelector('button[aria-label="Stop execution"]');
            const sendBtn = document.querySelector('button[aria-label="Send message"]');
            const isExecuting = Boolean(stopBtn);
            const isInputReady = Boolean(sendBtn && !sendBtn.disabled);
            return { isExecuting, isInputReady };
          }`
        });

        // If execution has finished and input is ready, or if denial occurred
        if (status && !status.isExecuting) {
          // Check if at least 1-2 seconds elapsed since submit
          if (Date.now() - startTime > 2000) {
            return { completed: true, durationMs: Date.now() - startTime };
          }
        }
      } else {
        // Mock / non-interactive bridge wait
        await new Promise(r => setTimeout(r, 100));
        return { completed: true, durationMs: 100 };
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    return { completed: false, timeout: true, durationMs: Date.now() - startTime };
  }

  async getDenialReason() {
    // 1. First check the disk log (most accurate exit code & status)
    const logDenial = findLastDenial(this.sandboxDir, this.lastTurnTimestamp);
    if (logDenial && logDenial.result && logDenial.result.reason) {
      return logDenial.result.reason;
    }

    // 2. Query DOM for denial text
    if (this.client && typeof this.client.evaluateScript === 'function') {
      const domResult = await this.client.evaluateScript({
        pageId: this.pageId,
        format: 'function',
        fn: `() => {
          const bodyText = document.body.innerText || '';
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
}

module.exports = BrowserBridge;
