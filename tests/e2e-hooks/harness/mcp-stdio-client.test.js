'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

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

console.log('=== Testing e2e-hooks/harness/mcp-stdio-client.js ===');

// Lazy require to verify RED phase failure if mcp-stdio-client does not exist
let McpStdioClient;
try {
  McpStdioClient = require('./mcp-stdio-client');
} catch (_e) {
  // RED phase expected
}

// Helper mock process
function createMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter();
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = (sig) => {
    proc.killed = true;
    proc.emit('exit', 0, sig || 'SIGTERM');
    proc.emit('close', 0);
  };
  return proc;
}

(async () => {
  await test('McpStdioClient is exported as a class', () => {
    assert.ok(McpStdioClient, 'McpStdioClient must be defined');
    assert.strictEqual(typeof McpStdioClient, 'function');
  });

  await test('McpStdioClient performs handshake with initialize and notifications/initialized', async () => {
    const mockProc = createMockProcess();
    const sentMessages = [];

    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        sentMessages.push(msg);
        if (msg.method === 'initialize') {
          // Respond to initialize
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'mock-chrome-devtools-mcp', version: '1.0.0' }
            }
          }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({
      spawnFn: () => mockProc
    });

    await client.start();
    assert.strictEqual(client.isInitialized, true);
    assert.strictEqual(client.serverInfo.name, 'mock-chrome-devtools-mcp');
    assert.strictEqual(sentMessages.length, 2);
    assert.strictEqual(sentMessages[0].method, 'initialize');
    assert.strictEqual(sentMessages[1].method, 'notifications/initialized');
    await client.stop();
  });

  await test('McpStdioClient handles NDJSON chunk fragmentation and multiple lines', async () => {
    const mockProc = createMockProcess();

    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } }
          }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({
      spawnFn: () => mockProc
    });
    await client.start();

    // Send two requests
    const p1 = client.sendRequest('ping', { index: 1 });
    const p2 = client.sendRequest('ping', { index: 2 });

    // Send response 1 split across multiple chunk writes
    const fullResp1 = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { pong: 1 } }) + '\n';
    mockProc.stdout.write(fullResp1.slice(0, 10));
    await new Promise(r => setTimeout(r, 10));
    mockProc.stdout.write(fullResp1.slice(10));

    // Send response 2
    mockProc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { pong: 2 } }) + '\n');

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, { pong: 1 });
    assert.deepStrictEqual(r2, { pong: 2 });
    await client.stop();
  });

  await test('McpStdioClient routes tools/call and handles JSON-RPC errors', async () => {
    const mockProc = createMockProcess();

    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } }
          }) + '\n');
        } else if (msg.method === 'tools/call') {
          if (msg.params.name === 'error_tool') {
            mockProc.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32603, message: 'Tool failed with internal error' }
            }) + '\n');
          } else {
            mockProc.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ status: 'ok' }) }]
              }
            }) + '\n');
          }
        }
      }
    });

    const client = new McpStdioClient({
      spawnFn: () => mockProc
    });
    await client.start();

    const okResult = await client.callTool('good_tool', { foo: 'bar' });
    assert.ok(okResult.content);

    let errCaught = null;
    try {
      await client.callTool('error_tool', {});
    } catch (err) {
      errCaught = err;
    }
    assert.ok(errCaught, 'Expected error to be thrown');
    assert.ok(errCaught.message.includes('Tool failed with internal error'));
    await client.stop();
  });

  await test('McpStdioClient provides convenience methods for devtools tools', async () => {
    const mockProc = createMockProcess();
    const calls = [];

    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } }
          }) + '\n');
        } else if (msg.method === 'tools/call') {
          calls.push({ name: msg.params.name, args: msg.params.arguments });
          let text = '';
          if (msg.params.name === 'list_pages') {
            text = JSON.stringify([{ id: 42, url: 'https://127.0.0.1:37811/?section=fd24d189-63b2-438f-acd8-4025c11c78cf' }]);
          } else if (msg.params.name === 'evaluate_script') {
            text = JSON.stringify({ evalDone: true });
          } else if (msg.params.name === 'screencast_stop') {
            text = 'Screencast saved to /tmp/screencast-123.mp4';
          }
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text }] }
          }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({
      spawnFn: () => mockProc
    });
    await client.start();

    // 1. listPages
    const pages = await client.listPages();
    assert.strictEqual(pages.length, 1);
    assert.strictEqual(pages[0].id, 42);

    // 2. navigatePage
    await client.navigatePage({ pageId: 42, url: 'https://127.0.0.1:37811/' });

    // 3. evaluateScript (testing fn mapping to function)
    const evalRes = await client.evaluateScript({
      pageId: 42,
      fn: '() => 123'
    });
    assert.deepStrictEqual(evalRes, { evalDone: true });
    const lastCall = calls.find(c => c.name === 'evaluate_script');
    assert.strictEqual(lastCall.args.function, '() => 123');

    // 4. typeText
    await client.typeText({ pageId: 42, text: 'run dev server' });

    // 5. takeScreenshot
    await client.takeScreenshot({ pageId: 42, filePath: '/tmp/test.png' });

    // 6. screencastStart & screencastStop
    await client.screencastStart({ pageId: 42 });
    const stopRes = await client.screencastStop({ pageId: 42 });
    assert.ok(stopRes.content[0].text.includes('/tmp/screencast-123.mp4'));

    await client.stop();
  });

  await test('McpStdioClient rejects on request timeout', async () => {
    const mockProc = createMockProcess();
    const client = new McpStdioClient({
      spawnFn: () => mockProc,
      timeout: 100 // 100ms timeout
    });
    client.process = mockProc;

    let timeoutError = null;
    try {
      await client.sendRequest('unanswered', {});
    } catch (err) {
      timeoutError = err;
    }
    assert.ok(timeoutError, 'Expected timeout error');
    assert.ok(timeoutError.message.includes('timeout'), `Expected message to include 'timeout', got: ${timeoutError.message}`);
  });

  await test('McpStdioClient throws when tools/call has isError: true', async () => {
    const mockProc = createMockProcess();
    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.method === 'tools/call') {
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Browser execution blocked' }]
            }
          }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({ spawnFn: () => mockProc });
    client._attachProcess(mockProc);

    let errCaught = null;
    try {
      await client.callTool('any_tool', {});
    } catch (err) {
      errCaught = err;
    }
    assert.ok(errCaught);
    assert.ok(errCaught.message.includes('Browser execution blocked'));
  });

  await test('McpStdioClient parses markdown-fenced json from evaluate_script', async () => {
    const mockProc = createMockProcess();
    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.method === 'tools/call' && msg.params.name === 'evaluate_script') {
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{
                type: 'text',
                text: 'Script ran on page and returned:\n```json\n{"foo":"bar","num":42}\n```'
              }]
            }
          }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({ spawnFn: () => mockProc });
    client._attachProcess(mockProc);

    const parsed = await client.evaluateScript({ pageId: 1, fn: '() => ({ foo: "bar", num: 42 })' });
    assert.deepStrictEqual(parsed, { foo: 'bar', num: 42 });
  });

  await test('McpStdioClient ignores malformed lines on stdout', async () => {
    const mockProc = createMockProcess();
    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.id) {
          mockProc.stdout.write('INVALID JSON LINE NOT A PROTOCOL MSG\n');
          mockProc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { ok: true } }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({ spawnFn: () => mockProc });
    client._attachProcess(mockProc);

    const res = await client.sendRequest('testMethod', {});
    assert.deepStrictEqual(res, { ok: true });
  });

  await test('McpStdioClient handles stop() gracefully when already stopped', async () => {
    const client = new McpStdioClient();
    await client.stop(); // should not throw
    assert.strictEqual(client.isInitialized, false);
  });

  await test('McpStdioClient provides takeSnapshot, listConsoleMessages, and listNetworkRequests diagnostic wrappers', async () => {
    const mockProc = createMockProcess();
    const calls = [];

    mockProc.stdin.on('data', chunk => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: '2024-11-05', serverInfo: { name: 'mock' } }
          }) + '\n');
        } else if (msg.method === 'tools/call') {
          calls.push({ name: msg.params.name, args: msg.params.arguments });
          let text = '';
          if (msg.params.name === 'take_snapshot') {
            text = 'AXTree: root [button "Submit", textbox "Prompt"]';
          } else if (msg.params.name === 'list_console_messages') {
            text = JSON.stringify([{ level: 'log', text: 'app initialized' }]);
          } else if (msg.params.name === 'list_network_requests') {
            text = JSON.stringify([{ url: 'https://127.0.0.1:37811/api/state', status: 200 }]);
          }
          mockProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text }] }
          }) + '\n');
        }
      }
    });

    const client = new McpStdioClient({
      spawnFn: () => mockProc
    });
    await client.start();

    // 1. takeSnapshot with default pageId
    const snapshot = await client.takeSnapshot();
    assert.strictEqual(typeof snapshot, 'string');
    assert.ok(snapshot.includes('AXTree: root'));
    const snapCall = calls.find(c => c.name === 'take_snapshot');
    assert.strictEqual(snapCall.args.pageId, 1);

    // 2. listConsoleMessages
    const consoleMsgs = await client.listConsoleMessages({ pageId: 2 });
    assert.ok(Array.isArray(consoleMsgs));
    assert.strictEqual(consoleMsgs.length, 1);
    assert.strictEqual(consoleMsgs[0].text, 'app initialized');
    const consoleCall = calls.find(c => c.name === 'list_console_messages');
    assert.strictEqual(consoleCall.args.pageId, 2);

    // 3. listNetworkRequests
    const netReqs = await client.listNetworkRequests();
    assert.ok(Array.isArray(netReqs));
    assert.strictEqual(netReqs.length, 1);
    assert.strictEqual(netReqs[0].status, 200);
    const netCall = calls.find(c => c.name === 'list_network_requests');
    assert.strictEqual(netCall.args.pageId, 1);

    await client.stop();
  });

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
})();
