'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const LLMJudge = require('./llm-judge');
const { findLastDenial, getHookLogs } = require('./fixture-manager');
const { defaultConfig } = require('../config');

class BrowserBridge {
  constructor(options = {}) {
    const opts = options || {};
    const defaultSandbox = path.resolve(__dirname, '../../../test-sandbox');
    const homeSandbox = path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test');
    const fallbackSandbox = fs.existsSync(homeSandbox) ? homeSandbox : defaultSandbox;

    this.webUrl = opts.webUrl || 'https://127.0.0.1:37811/?section=fd24d189-63b2-438f-acd8-4025c11c78cf';
    this.sandboxDir = opts.sandboxDir !== undefined ? opts.sandboxDir : fallbackSandbox;
    this.client = opts.client || null;
    this.pageId = opts.pageId || 1;
    this.browserModel = opts.browserModel || process.env.ECC_E2E_BROWSER_MODEL || (defaultConfig && defaultConfig.browserModel) || 'Gemini 3.8 Flash (Low)';
    this.lastTurnTimestamp = null;
  }

  async connect(mcpClient = null) {
    if (mcpClient) {
      this.client = mcpClient;
    }

    if (this.client && typeof this.client.listPages === 'function') {
      try {
        const pages = await this.client.listPages();
        const urlMatch = (this.webUrl || '').match(/https?:\/\/([^/?#]+)/);
        const hostPort = urlMatch ? urlMatch[1] : '127.0.0.1:37811';
        if (Array.isArray(pages)) {
          const antigravityPage = pages.find(p => p.url && (p.url.includes(hostPort) || p.url.includes('127.0.0.1:37811') || p.url.includes('antigravity')));
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
              if (info.includes(hostPort) || info.includes('127.0.0.1:37811') || info.toLowerCase().includes('antigravity')) {
                this.pageId = id;
                break;
              }
            }
          }
        }
      } catch (_) {
        /* ignore */
      }
    }

    // Navigate to webUrl if client supports navigatePage
    if (this.client && typeof this.client.navigatePage === 'function') {
      try {
        await this.client.navigatePage({
          pageId: this.pageId,
          url: this.webUrl
        });
        await new Promise(r => setTimeout(r, 1200));
      } catch (_) {
        /* ignore */
      }
    }

    return { connected: true, pageId: this.pageId };
  }

  async disconnect() {
    if (this.client) {
      if (typeof this.client.stop === 'function') {
        try {
          await this.client.stop();
        } catch (_) {
          /* ignore */
        }
      }
      this.client = null;
    }
  }

  static formatDirectPrompt(action) {
    return `Execute immediately: ${action}. Do not run preliminary checks, file views, or retries. Respond in under 10 words.`;
  }

  async openNewConversation(options = {}) {
    const opts = options || {};
    this.lastTurnTimestamp = new Date().toISOString();
    const sectionMatch = this.webUrl ? this.webUrl.match(/[?&]section=([^&#]+)/) : null;
    const targetSectionId = sectionMatch ? sectionMatch[1] : null;
    const targetProjectName = this.sandboxDir ? path.basename(this.sandboxDir) : null;

    const cleanUrl = this.webUrl
      ? this.webUrl.replace(/([?&])section=[^&#]*(&|$)/, (m, p1, p2) => p2 ? p1 : '').replace(/[?&]$/, '')
      : this.webUrl;

    if (this.client && typeof this.client.navigatePage === 'function') {
      try {
        await this.client.navigatePage({
          pageId: this.pageId,
          url: cleanUrl
        });
      } catch (_) {
        /* ignore */
      }
    }

    if (this.client && typeof this.client.evaluateScript === 'function') {
      const pollTimeoutMs = Number.isFinite(opts.pollTimeoutMs) && opts.pollTimeoutMs >= 0 ? opts.pollTimeoutMs : 4000;
      const pollIntervalMs = Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0 ? opts.pollIntervalMs : 150;
      const deadline = Date.now() + pollTimeoutMs;
      const evalScriptFn = `() => {
        const targetSection = ${JSON.stringify(targetSectionId)};
        const targetProject = ${JSON.stringify(targetProjectName)};

        if (targetSection) {
          const projectLink = document.querySelector('a[aria-label="New Conversation in Project"][href*="' + targetSection + '"]');
          if (projectLink) {
            projectLink.click();
            return { clicked: true, target: 'project-section' };
          }
        }

        if (targetProject) {
          const sidebarRoot = document.querySelector('[aria-label="Sidebar"]')
            || document.querySelector('nav, [role="navigation"], aside')
            || document;
          const sidebarButtons = Array.from(sidebarRoot.querySelectorAll('button, [role="button"]'));

          const projectsGroupBtn = sidebarButtons.find(btn => {
            const text = (btn.innerText || btn.textContent || '').trim();
            return text === 'Projects' && btn.getAttribute('aria-expanded') === 'false';
          });
          if (projectsGroupBtn) {
            projectsGroupBtn.click();
            return { clicked: false, expanded: true, reason: 'waiting_for_projects_group', targetProject };
          }

          const projectBtn = sidebarButtons.find(btn => {
            const aria = (btn.getAttribute('aria-label') || '').trim();
            if (aria.toLowerCase().startsWith('select project')) return false;
            const text = (btn.innerText || btn.textContent || '').trim();
            return text === targetProject || aria === targetProject;
          });

          if (projectBtn) {
            let expandedNow = false;
            if (projectBtn.getAttribute('aria-expanded') === 'false') {
              projectBtn.click();
              expandedNow = true;
            }

            const maxWalkDepth = expandedNow ? 2 : 5;
            let cur = projectBtn.parentElement;
            let matchedLink = null;
            for (let depth = 0; depth < maxWalkDepth && cur && cur !== document.body; depth++) {
              if (cur === sidebarRoot && cur !== projectBtn.parentElement && sidebarRoot !== document) {
                break;
              }
              const hasOtherProjectToggle = Array.from(cur.querySelectorAll('button[aria-expanded]')).some(btn => {
                if (btn === projectBtn) return false;
                const btnAria = (btn.getAttribute('aria-label') || '').trim();
                return btnAria !== 'Project options';
              });
              if (hasOtherProjectToggle) {
                break;
              }
              const matches = Array.from(
                cur.querySelectorAll('a[aria-label="New Conversation in Project"], button[aria-label="New Conversation in Project"]')
              );
              if (matches.length === 1) {
                matchedLink = matches[0];
                break;
              }
              if (matches.length > 1) {
                break;
              }
              cur = cur.parentElement;
            }

            if (matchedLink) {
              matchedLink.click();
              return { clicked: true, target: 'project-name', projectName: targetProject };
            }

            if (expandedNow) {
              return { clicked: false, expanded: true, reason: 'waiting_for_project_link', targetProject };
            }
            return { clicked: false, reason: 'project_link_not_found', targetProject };
          }
        }

        const directBtn = document.querySelector('button[data-testid="new-conversation-button"]');
        if (directBtn) {
          directBtn.click();
          return { clicked: true, target: 'testid' };
        }

        if (targetProject) {
          return { clicked: false, reason: 'project_not_found', targetProject };
        }

        const links = Array.from(document.querySelectorAll('a, button, div[role="button"]'));
        const regex = /\\bnew (?:conversation|chat)\\b/i;
        const newChat = links.find(el => {
          const text = el.innerText || '';
          const aria = el.getAttribute('aria-label') || '';
          return regex.test(text) || regex.test(aria) || aria === 'New Conversation in Project';
        });
        if (newChat) {
          newChat.click();
          return { clicked: true, target: 'generic-new-chat' };
        }
        return { clicked: false, reason: 'new_conversation_control_not_found' };
      }`;

      let clicked = false;
      let lastResult = null;
      let lastError = null;

      while (true) {
        try {
          lastResult = await this.client.evaluateScript({
            pageId: this.pageId,
            format: 'function',
            function: evalScriptFn
          });
          lastError = null;
          if (lastResult && lastResult.clicked) {
            clicked = true;
            break;
          }
        } catch (err) {
          lastError = err;
        }

        if (Date.now() >= deadline) {
          break;
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }

      if (!clicked && targetProjectName) {
        const reason = lastResult && lastResult.reason ? ` (${lastResult.reason})` : '';
        const errDetail = lastError ? ` Last evaluateScript error: ${lastError.message}` : '';
        throw new Error(
          `Failed to open new conversation for project "${targetProjectName}" (sandboxDir: "${this.sandboxDir}"): no matching "New Conversation in Project" link found${reason}.${errDetail}`
        );
      }

      if (clicked) {
        await new Promise(r => setTimeout(r, 600));
      }
    }

    // Automatically enforce selected UI model on new conversation
    await this.selectModel(this.browserModel);
  }

  parseModelString(modelStr) {
    if (!modelStr || typeof modelStr !== 'string') {
      return { baseModel: 'Gemini 3.8 Flash', effort: null };
    }
    const match = modelStr.match(/^(.*?)(?:\s*\((low|medium|high)\))?$/i);
    if (match) {
      const baseModel = (match[1] || '').trim();
      const effort = match[2] ? match[2].toLowerCase() : null;
      return { baseModel, effort };
    }
    return { baseModel: modelStr.trim(), effort: null };
  }

  async selectModel(targetModelString = this.browserModel) {
    const { baseModel, effort: targetEffort } = this.parseModelString(targetModelString || this.browserModel);

    if (!this.client || typeof this.client.evaluateScript !== 'function') {
      return { status: 'noop', baseModel, effort: targetEffort };
    }

    try {
      const result = await this.client.evaluateScript({
        pageId: this.pageId,
        format: 'function',
        function: `() => {
          const trigger = document.querySelector('button[data-testid="model-selector-trigger"]')
            || document.querySelector('button[aria-label*="model" i]');
          if (!trigger) {
            return { status: 'trigger_not_found' };
          }

          const targetBase = ${JSON.stringify(baseModel)};
          const targetEffort = ${JSON.stringify(targetEffort)};

          // Fast-path: check if trigger already reflects the target model and effort
          const triggerLabel = (trigger.getAttribute('aria-label') || '').toLowerCase();
          const triggerText = (trigger.innerText || '').toLowerCase();
          const combined = triggerLabel + ' ' + triggerText;

          if (combined.includes(targetBase.toLowerCase()) && (!targetEffort || combined.includes(targetEffort.toLowerCase()))) {
            return { status: 'already_selected', currentText: trigger.innerText || triggerLabel };
          }

          // Open model selection panel if not already expanded
          if (trigger.getAttribute('aria-expanded') !== 'true') {
            trigger.click();
          }

          const panel = document.querySelector('[data-testid="model-selector-panel"]')
            || document.querySelector('[role="menu"]')
            || document.querySelector('div[data-radix-popper-content-wrapper]');

          // 1. Check standalone items first
          const standaloneItems = Array.from(document.querySelectorAll('[data-testid="model-selector-item"], [role="menuitemradio"], [role="menuitem"]'));
          const directMatch = standaloneItems.find(el => {
            const text = ((el.innerText || '') + ' ' + (el.getAttribute('data-model-id') || '')).toLowerCase();
            return text.includes(targetBase.toLowerCase()) && (!targetEffort || text.includes(targetEffort.toLowerCase()));
          });
          if (directMatch && !directMatch.matches('[data-testid="model-selector-effort-group"]')) {
            directMatch.click();
            return { status: 'selected', baseModel: targetBase, effort: targetEffort, current: trigger.innerText };
          }

          // 2. Check effort groups matching data-model-base or innerText
          const effortGroups = Array.from(document.querySelectorAll('[data-testid="model-selector-effort-group"], [role="menuitem"]'));
          const targetGroup = effortGroups.find(el => {
            const baseAttr = (el.getAttribute('data-model-base') || '').toLowerCase();
            const text = (el.innerText || '').toLowerCase();
            return baseAttr.includes(targetBase.toLowerCase()) || text.includes(targetBase.toLowerCase());
          });

          if (targetGroup) {
            const menuItem = targetGroup.closest('[role="menuitem"]') || targetGroup;
            if (typeof menuItem.focus === 'function') menuItem.focus();
            menuItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }));
            menuItem.click();

            const selectedEffort = targetEffort || 'low';

            // Find matching effort option in nested submenu
            const effortOption = document.querySelector('[data-testid="model-selector-effort-option"][data-effort="' + selectedEffort + '"]')
              || Array.from(document.querySelectorAll('[data-testid="model-selector-effort-option"], [role="menuitemradio"]'))
                   .find(el => (el.getAttribute('data-effort') || el.innerText || '').toLowerCase().includes(selectedEffort.toLowerCase()));

            if (effortOption) {
              effortOption.click();
              return { status: 'selected', baseModel: targetBase, effort: selectedEffort, current: trigger.innerText };
            }
          }

          // If neither matched, close menu before returning so UI is not obstructed
          if (trigger.getAttribute('aria-expanded') === 'true') {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            if (trigger.getAttribute('aria-expanded') === 'true') {
              trigger.click();
            }
          }

          return { status: 'not_found', targetBase, targetEffort, current: trigger.innerText };
        }`
      });

      return result || { status: 'unknown' };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  }

  async getConversationId() {
    if (!this.client || typeof this.client.evaluateScript !== 'function') {
      return null;
    }
    try {
      const href = await this.client.evaluateScript({
        pageId: this.pageId,
        format: 'function',
        function: '() => window.location.href'
      });
      const match = typeof href === 'string' ? href.match(/\/c\/([a-f0-9-]+)/i) : null;
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  async submitPrompt(promptText) {
    const tokenCount = LLMJudge.countTokens(promptText);
    if (tokenCount >= 45) {
      throw new Error(`Minimal Token Constraint Violated: prompt "${promptText}" has ${tokenCount} tokens (must be < 45 tokens).`);
    }

    // Automatically ensure target browser model is selected before submitting prompt
    await this.selectModel(this.browserModel);

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

    this.lastTurnTimestamp = new Date().toISOString();
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
              const cancelInputBtn = document.querySelector('button[data-tooltip-id="input-send-button-cancel-tooltip"]')
                || document.querySelector('button[data-testid="send-button-pending"]')
                || document.querySelector('[data-testid="input-box"] button[aria-label*="Cancel"]')
                || document.querySelector('form button[aria-label*="Cancel"]');
              const stopButtons = Array.from(document.querySelectorAll('button[aria-label="Stop execution"], button[aria-label="Stop agent"], button[aria-label="Force close agent overlay"]'));
              const activeStopBtn = stopButtons.find(btn => !btn.closest('nav, [role="navigation"], aside, [aria-label="Sidebar"], [data-testid*="sidebar"], [class*="sidebar"], [data-testid="conversation-list"]'));
              const hasRedSquare = Boolean(document.querySelector('.bg-agy-red'));
              const sendBtn = document.querySelector('button[data-testid="send-button"]')
                || document.querySelector('button[aria-label="Send message"]');
              const hasStopButton = Boolean(cancelInputBtn || activeStopBtn || hasRedSquare);
              const isExecuting = hasStopButton;
              const isInputReady = Boolean(sendBtn && !sendBtn.disabled);
              return { isExecuting, hasStopButton, isInputReady };
            }`
          });
        } catch (_) {
          /* ignore */
        }

        if (status && (status.isExecuting || status.hasStopButton)) {
          sawExecutionStart = true;
        }

        // If execution started and has now stopped
        if (sawExecutionStart && status && !status.isExecuting && !status.hasStopButton) {
          return { completed: true, durationMs: Date.now() - startTime };
        }

        // Fallback for fast completion when input is ready after initial debounce (>2000ms)
        if (Date.now() - startTime > 2000 && status && !status.isExecuting && !status.hasStopButton && status.isInputReady) {
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

        // Check if hook execution was already logged to disk for this turn
        if (this.lastTurnTimestamp && Date.now() - startTime > 2000 && this.sandboxDir) {
          try {
            const logs = getHookLogs(this.sandboxDir, this.lastTurnTimestamp);
            if (logs.length > 0 && status && !status.isExecuting && !status.hasStopButton) {
              await new Promise(r => setTimeout(r, 1000));
              return { completed: true, durationMs: Date.now() - startTime, hookLogged: true };
            }
          } catch (_) {
            /* ignore */
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
          const fullBodyText = (planner?.innerText || '') + ' ' + (step?.innerText || '') + ' ' + (document.body.innerText || '');
          if (fullBodyText.includes('BLOCKED:') || fullBodyText.includes('denied') || fullBodyText.includes('prohibited')) {
            return { denied: true, reason: fullBodyText.slice(0, 1000) };
          }
          return null;
        }`
      });

      if (domResult && domResult.reason) {
        return domResult.reason.slice(0, 1000);
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
            return { hasDenial, text: fullText.slice(0, 1000) };
          }`
        });

        if (domResult && (domResult.hasDenial || domResult.deniedInDom)) {
          domReason = (domResult.text || domResult.domText || '').slice(0, 1000);
          if (!expectedRegex || expectedRegex.test(domReason)) {
            domVerified = true;
          }
        }
      } catch (_) {
        /* ignore */
      }
    }

    const blocked = diskVerified || domVerified;
    const reason = (diskReason || domReason || 'Hook blocked execution').slice(0, 1000);

    return {
      blocked,
      diskVerified,
      domVerified,
      reason
    };
  }
}

module.exports = BrowserBridge;
