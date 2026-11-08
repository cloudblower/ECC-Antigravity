'use strict';

const { spawn } = require('child_process');

class McpStdioClient {
  constructor(options = {}) {
    this.command = options.command || 'npx';
    this.args = options.args || ['-y', 'chrome-devtools-mcp@latest', '--categoryExtensions', '--isolated', '--headless', '--chrome-arg=--ignore-certificate-errors', '--allowUnrestrictedPaths'];
    this.cwd = options.cwd || process.cwd();
    this.env = options.env || { ...process.env };
    this.timeout = options.timeout || 30000;
    this.spawnFn = options.spawnFn || spawn;

    this.process = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.isInitialized = false;
    this.serverInfo = null;
    this.serverCapabilities = null;
  }

  _attachProcess(proc) {
    this.process = proc;

    if (this.process.stdin) {
      this.process.stdin.on('error', err => {
        // Prevent unhandled EPIPE / ERR_STREAM_DESTROYED if process terminates abruptly
        this._rejectAllPending(new Error(`MCP stdin error: ${err.message}`));
      });
    }

    this.process.stdout.on('data', chunk => {
      this._handleStdoutData(chunk);
    });

    this.process.stderr.on('data', () => {});

    this.process.on('error', err => {
      this._rejectAllPending(new Error(`MCP server process error: ${err.message}`));
    });

    this.process.on('close', (code, signal) => {
      this.isInitialized = false;
      this._rejectAllPending(new Error(`MCP server process closed with code ${code} (${signal || 'none'})`));
    });

    this.process.on('exit', (code, signal) => {
      this.isInitialized = false;
      this._rejectAllPending(new Error(`MCP server process exited with code ${code} (${signal || 'none'})`));
    });

    this._sigintHandler = () => {
      try {
        if (this.process) this.process.kill('SIGTERM');
      } catch (_) {}
    };
    this._exitHandler = () => {
      try {
        if (this.process) this.process.kill('SIGKILL');
      } catch (_) {}
    };

    process.once('SIGINT', this._sigintHandler);
    process.once('exit', this._exitHandler);
  }

  async start() {
    if (this.process) return;

    const proc = this.spawnFn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this._attachProcess(proc);

    // Handshake step 1: initialize
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {
        roots: { listChanged: false }
      },
      clientInfo: {
        name: 'ecc-e2e-test-runner',
        version: '1.0.0'
      }
    });

    this.serverInfo = initResult.serverInfo || null;
    this.serverCapabilities = initResult.capabilities || null;

    // Handshake step 2: notifications/initialized
    this.sendNotification('notifications/initialized', {});
    this.isInitialized = true;

    return initResult;
  }

  _handleStdoutData(chunk) {
    this.buffer += chunk.toString('utf8');
    let lineEndIdx;
    while ((lineEndIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, lineEndIdx).trim();
      this.buffer = this.buffer.slice(lineEndIdx + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this._handleMessage(message);
      } catch (err) {
        // Not a valid JSON-RPC line (might be a log from tool or process)
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timer } = this.pendingRequests.get(msg.id);
      clearTimeout(timer);
      this.pendingRequests.delete(msg.id);

      if (msg.error) {
        const err = new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        reject(err);
      } else {
        resolve(msg.result);
      }
    }
  }

  _rejectAllPending(error) {
    for (const [id, req] of this.pendingRequests.entries()) {
      clearTimeout(req.timer);
      req.reject(error);
    }
    this.pendingRequests.clear();
  }

  sendNotification(method, params = {}) {
    if (!this.process || !this.process.stdin) {
      throw new Error('MCP client is not running');
    }
    const msg = {
      jsonrpc: '2.0',
      method,
      params
    };
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  sendRequest(method, params = {}, timeoutMs = this.timeout) {
    if (!this.process || !this.process.stdin) {
      return Promise.reject(new Error('MCP client is not running'));
    }

    const id = this.nextRequestId++;
    const msg = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request timeout (${timeoutMs}ms) for method "${method}" (id: ${id})`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  async callTool(name, toolArgs = {}) {
    const res = await this.sendRequest('tools/call', {
      name,
      arguments: toolArgs
    });

    if (res && res.isError) {
      const textMsg = (res.content || [])
        .map(c => c.text || '')
        .filter(Boolean)
        .join(' ');
      throw new Error(`Tool call "${name}" returned error: ${textMsg || 'Unknown error'}`);
    }

    return res;
  }

  async listPages() {
    const res = await this.callTool('list_pages', {});
    if (res && res.content && res.content[0] && res.content[0].text) {
      try {
        return JSON.parse(res.content[0].text);
      } catch (_) {
        return res.content[0].text;
      }
    }
    return [];
  }

  async navigatePage(params = {}) {
    return await this.callTool('navigate_page', params);
  }

  async evaluateScript(params = {}) {
    const callArgs = { ...params };
    if (!callArgs.function && callArgs.fn) {
      callArgs.function = callArgs.fn;
      delete callArgs.fn;
    }
    const res = await this.callTool('evaluate_script', callArgs);
    if (res && res.content && res.content[0] && res.content[0].text !== undefined) {
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch (_) {
        const fenceMatch = typeof text === 'string' && text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenceMatch) {
          try {
            return JSON.parse(fenceMatch[1]);
          } catch (_) {}
        }
        return text;
      }
    }
    return res;
  }

  async typeText(params = {}) {
    return await this.callTool('type_text', params);
  }

  async takeScreenshot(params = {}) {
    return await this.callTool('take_screenshot', params);
  }

  async screencastStart(params = {}) {
    return await this.callTool('screencast_start', params);
  }

  async screencastStop(params = {}) {
    return await this.callTool('screencast_stop', params);
  }

  async takeSnapshot(params = {}) {
    const callArgs = { pageId: 1, ...params };
    const res = await this.callTool('take_snapshot', callArgs);
    if (res && res.content && res.content[0] && res.content[0].text !== undefined) {
      return res.content[0].text;
    }
    return res;
  }

  async listConsoleMessages(params = {}) {
    const callArgs = { pageId: 1, ...params };
    const res = await this.callTool('list_console_messages', callArgs);
    if (res && res.content && res.content[0] && res.content[0].text !== undefined) {
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    }
    return [];
  }

  async listNetworkRequests(params = {}) {
    const callArgs = { pageId: 1, ...params };
    const res = await this.callTool('list_network_requests', callArgs);
    if (res && res.content && res.content[0] && res.content[0].text !== undefined) {
      const text = res.content[0].text;
      try {
        return JSON.parse(text);
      } catch (_) {
        return text;
      }
    }
    return [];
  }

  async stop() {
    this._rejectAllPending(new Error('McpStdioClient stopped'));
    this.isInitialized = false;

    if (this._sigintHandler) {
      process.removeListener('SIGINT', this._sigintHandler);
      this._sigintHandler = null;
    }
    if (this._exitHandler) {
      process.removeListener('exit', this._exitHandler);
      this._exitHandler = null;
    }

    if (!this.process) return;

    return new Promise(resolve => {
      const proc = this.process;
      this.process = null;

      let killTimer = null;
      const onExit = () => {
        if (killTimer) clearTimeout(killTimer);
        resolve();
      };

      proc.once('exit', onExit);
      proc.once('close', onExit);

      try {
        proc.kill('SIGTERM');
      } catch (_) {
        resolve();
        return;
      }

      killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch (_) {}
        resolve();
      }, 1000);
    });
  }
}

module.exports = McpStdioClient;
