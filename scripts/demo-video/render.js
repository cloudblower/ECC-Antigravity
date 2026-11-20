#!/usr/bin/env node
'use strict';

/**
 * Deterministic 1080p 30fps Demo Video Renderer
 *
 * Drives headless Google Chrome over Chrome DevTools Protocol (CDP)
 * frame-by-frame (`window.renderAt(t)`), pipes lossless PNG frames into
 * FFmpeg, and muxes `docs/assets/voiceover.wav` with subtle UI sound effects.
 *
 * Usage:
 *   node scripts/demo-video/render.js
 *   node scripts/demo-video/render.js --mobile
 *   node scripts/demo-video/render.js --portrait
 *   node scripts/demo-video/render.js --out docs/assets/antigravity-hooks-demo.mp4
 *   node scripts/demo-video/render.js --preview-frame 25.5 --out /tmp/preview.png
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const TOOLKIT_DIR = __dirname;
const REPO_ROOT = path.resolve(TOOLKIT_DIR, '..', '..');
const ASSETS_DIR = path.join(TOOLKIT_DIR, 'assets');

const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'assets', 'antigravity-hooks-demo.mp4');
const DEFAULT_MOBILE_OUT = path.join(REPO_ROOT, 'docs', 'assets', 'antigravity-hooks-demo-mobile.mp4');
const DEFAULT_PORTRAIT_OUT = path.join(REPO_ROOT, 'docs', 'assets', 'antigravity-hooks-demo-portrait.mp4');
const DEFAULT_AUDIO = path.join(REPO_ROOT, 'docs', 'assets', 'voiceover.wav');
const DEFAULT_FPS = 30;
const DESKTOP_WIDTH = 1920;
const DESKTOP_HEIGHT = 1080;
const MOBILE_WIDTH = 1080;
const MOBILE_HEIGHT = 1920;
const PORTRAIT_WIDTH = 1080;
const PORTRAIT_HEIGHT = 1350;
const OUTRO_BUFFER_SEC = 1.54;

const SFX_CUES = [
  { file: 'sfx-block.wav', delayMs: 22900, gain: 0.14 },
  { file: 'sfx-success.wav', delayMs: 28600, gain: 0.13 },
  { file: 'sfx-gate.wav', delayMs: 38050, gain: 0.14 },
  { file: 'sfx-success.wav', delayMs: 47500, gain: 0.13 },
  { file: 'sfx-gate.wav', delayMs: 59540, gain: 0.14 },
  { file: 'sfx-success.wav', delayMs: 67300, gain: 0.13 },
  { file: 'sfx-instinct.wav', delayMs: 80400, gain: 0.14 },
  { file: 'sfx-instinct.wav', delayMs: 85700, gain: 0.13 },
  { file: 'sfx-success.wav', delayMs: 96400, gain: 0.12 }
];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.json': 'application/json'
};

const USAGE = [
  'Usage: node scripts/demo-video/render.js [options]',
  '',
  'Options:',
  '  --out <path>            Output file path (.mp4, or .png with --preview-frame)',
  '  --audio <path>          Voiceover audio WAV path (default: docs/assets/voiceover.wav)',
  '  --fps <number>          Output frame rate > 0 (default: 30)',
  '  --duration <seconds>    Override render duration > 0 (default: audio + 1.54s)',
  '  --preview-frame <sec>   Render a single PNG frame at timestamp >= 0',
  '  --player <file>         Player HTML filename inside scripts/demo-video/',
  '  --mobile                Render 9:16 vertical mobile (1080x1920)',
  '  --portrait              Render 4:5 portrait (1080x1350)',
  '  --no-sfx                Omit synthesized UI sound effects',
  '  -h, --help              Show this help message and exit'
].join('\n');

function printUsage() {
  console.log(USAGE);
}

function requireArgValue(argv, i, flag) {
  const val = argv[i + 1];
  if (val === undefined || val === '' || val.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return val;
}

function parseNumericOption(raw, flag, { allowZero = false } = {}) {
  const val = Number(raw);
  const valid = raw.trim() !== '' && Number.isFinite(val) && (allowZero ? val >= 0 : val > 0);
  if (!valid) {
    const expectation = allowZero ? 'a non-negative finite number' : 'a positive finite number';
    throw new Error(`Invalid ${flag} value "${raw}": must be ${expectation}`);
  }
  return val;
}

function parseArgs(argv) {
  const opts = {
    help: false,
    out: DEFAULT_OUT,
    outExplicit: false,
    audio: DEFAULT_AUDIO,
    fps: DEFAULT_FPS,
    duration: null,
    noSfx: false,
    previewFrame: null,
    mobile: false,
    portrait: false,
    player: 'player.html',
    playerExplicit: false,
    width: DESKTOP_WIDTH,
    height: DESKTOP_HEIGHT
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--out') {
      opts.out = path.resolve(process.cwd(), requireArgValue(argv, i, arg));
      i += 1;
      opts.outExplicit = true;
    } else if (arg === '--audio') {
      opts.audio = path.resolve(process.cwd(), requireArgValue(argv, i, arg));
      i += 1;
    } else if (arg === '--fps') {
      opts.fps = parseNumericOption(requireArgValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--duration') {
      opts.duration = parseNumericOption(requireArgValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--preview-frame') {
      opts.previewFrame = parseNumericOption(requireArgValue(argv, i, arg), arg, { allowZero: true });
      i += 1;
    } else if (arg === '--player') {
      opts.player = requireArgValue(argv, i, arg);
      i += 1;
      opts.playerExplicit = true;
    } else if (arg === '--mobile') {
      opts.mobile = true;
    } else if (arg === '--portrait') {
      opts.portrait = true;
    } else if (arg === '--no-sfx') {
      opts.noSfx = true;
    } else if (arg.startsWith('--') || arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (opts.mobile && opts.portrait) {
    throw new Error('Cannot combine --mobile and --portrait (mutually exclusive)');
  }

  if (opts.portrait) {
    opts.width = PORTRAIT_WIDTH;
    opts.height = PORTRAIT_HEIGHT;
    if (!opts.playerExplicit) opts.player = 'player-portrait.html';
    if (!opts.outExplicit) opts.out = DEFAULT_PORTRAIT_OUT;
  } else if (opts.mobile) {
    opts.width = MOBILE_WIDTH;
    opts.height = MOBILE_HEIGHT;
    if (!opts.playerExplicit) opts.player = 'player-mobile.html';
    if (!opts.outExplicit) opts.out = DEFAULT_MOBILE_OUT;
  }

  return opts;
}

function probeDuration(audioPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath
  ], { encoding: 'utf8' }).trim();
  const dur = parseFloat(out);
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`Could not determine audio duration from ${audioPath}`);
  }
  return dur;
}

function findChromeBinary() {
  const candidates = ['google-chrome', 'chromium', 'chromium-browser'];
  for (const bin of candidates) {
    try {
      const resolved = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
      if (resolved) return resolved;
    } catch (_err) {
      // try next
    }
  }
  throw new Error('Could not find google-chrome or chromium in PATH');
}

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const safeRel = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
      let target = path.join(rootDir, safeRel === '/' ? 'player.html' : safeRel);
      if (!target.startsWith(rootDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.readFile(target, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Minimal RFC6455 WebSocket client for Chrome DevTools Protocol (no npm deps).
 */
class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.closeListeners = [];
    this.closed = false;
  }

  rejectAllPending(reason) {
    if (this.pending.size === 0) return;
    const err = reason instanceof Error ? reason : new Error(String(reason || 'CDP connection closed'));
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  handleDisconnect(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || 'CDP connection closed'));
    const wasClosed = this.closed;
    this.closed = true;
    this.rejectAllPending(err);
    if (!wasClosed && this.closeListeners.length > 0) {
      const listeners = this.closeListeners.splice(0, this.closeListeners.length);
      for (const fn of listeners) fn(err);
    }
  }

  onClose(fn) {
    if (this.closed) {
      queueMicrotask(() => fn(new Error('CDP connection closed')));
      return;
    }
    this.closeListeners.push(fn);
  }

  connect() {
    if (this.closed) {
      return Promise.reject(new Error('CDP client is closed'));
    }
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      let settled = false;
      const failConnect = err => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const socket = net.createConnection(Number(parsed.port), parsed.hostname, () => {
        const req = [
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n');
        socket.write(req);
      });

      this.socket = socket;

      socket.on('error', err => {
        this.handleDisconnect(err);
        failConnect(err);
      });

      socket.on('close', hadError => {
        const err = new Error(hadError ? 'CDP socket closed due to error' : 'CDP socket closed');
        this.socket = null;
        this.handleDisconnect(err);
        failConnect(err);
      });

      socket.on('data', chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!settled) {
          const idx = this.buffer.indexOf('\r\n\r\n');
          if (idx === -1) return;
          const header = this.buffer.subarray(0, idx).toString('utf8');
          if (!header.includes('101')) {
            const err = new Error(`WebSocket upgrade failed: ${header}`);
            this.handleDisconnect(err);
            socket.destroy();
            failConnect(err);
            return;
          }
          this.buffer = this.buffer.subarray(idx + 4);
          settled = true;
          this.drainFrames();
          resolve();
          return;
        }
        this.drainFrames();
      });
    });
  }

  drainFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      this.buffer = this.buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        this.close('CDP WebSocket closed by remote peer');
        return;
      }
      if (opcode === 0x9) {
        this.sendRawFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }

      this.fragments.push(payload);
      if (fin) {
        const full = Buffer.concat(this.fragments).toString('utf8');
        this.fragments = [];
        this.handleMessage(full);
      }
    }
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_err) {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP error (${msg.error.code}): ${msg.error.message}`));
      } else {
        resolve(msg.result || {});
      }
    } else if (msg.method && this.events.has(msg.method)) {
      const handlers = this.events.get(msg.method);
      for (const fn of handlers) fn(msg.params || {});
    }
  }

  sendRawFrame(opcode, dataBuf) {
    if (this.closed || !this.socket || this.socket.destroyed) {
      throw new Error('Cannot send CDP frame: socket is closed');
    }
    const len = dataBuf.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      mask.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      mask.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(header, 10);
    }

    const maskedPayload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) {
      maskedPayload[i] = dataBuf[i] ^ mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, maskedPayload]));
  }

  send(method, params = {}) {
    if (this.closed || !this.socket || this.socket.destroyed) {
      return Promise.reject(new Error(`Cannot send CDP command "${method}": connection is closed`));
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
        this.sendRawFrame(0x1, payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }

  close(reason = 'CDP connection closed') {
    this.handleDisconnect(reason);
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.destroy();
    }
  }
}

async function evaluateFrame(cdp, expr, extraParams = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: expr,
    ...extraParams
  });
  if (res && res.exceptionDetails) {
    const details = res.exceptionDetails;
    const desc =
      (details.exception && (details.exception.description || details.exception.value)) ||
      details.text ||
      'Unknown Runtime.evaluate exception';
    throw new Error(`Page evaluation failed: ${desc}`);
  }
  return res;
}

function killChildProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGKILL');
    } catch (_err) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function launchChrome(chromeBin, userDataDir, opts, onSpawn) {
  const proc = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',
    `--window-size=${opts.width},${opts.height}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  if (typeof onSpawn === 'function') {
    onSpawn(proc);
  }

  try {
    const devToolsUrl = await new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;

      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stderr.off('data', onData);
        proc.off('error', onError);
        proc.off('exit', onExit);
        fn(val);
      };

      const timer = setTimeout(() => {
        finish(reject, new Error(`Timed out waiting for Chrome DevTools: ${stderr}`));
      }, 15000);

      const onData = chunk => {
        stderr += chunk.toString();
        const match = stderr.match(/DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)/);
        if (match) {
          finish(resolve, `http://${match[1]}`);
        }
      };

      const onError = err => {
        finish(reject, new Error(`Failed to start Chrome: ${err.message}`));
      };

      const onExit = (code, signal) => {
        finish(reject, new Error(`Chrome exited early with code ${code}${signal ? ` (signal ${signal})` : ''}: ${stderr}`));
      };

      proc.stderr.on('data', onData);
      proc.on('error', onError);
      proc.on('exit', onExit);
    });

    const targets = await httpGetJson(`${devToolsUrl}/json/list`);
    const pageTarget = targets.find(t => t.type === 'page') || targets[0];
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No debuggable page target returned by Chrome');
    }

    return { proc, wsUrl: pageTarget.webSocketDebuggerUrl };
  } catch (err) {
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch (_killErr) {
        // ignore if already exited
      }
    }
    throw err;
  }
}

function buildFfmpegArgs(opts, duration) {
  const args = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'png',
    '-r', String(opts.fps),
    '-i', '-'
  ];

  args.push('-i', opts.audio);

  const activeSfx = opts.noSfx
    ? []
    : SFX_CUES.filter(c => fs.existsSync(path.join(ASSETS_DIR, c.file)));

  for (const cue of activeSfx) {
    args.push('-i', path.join(ASSETS_DIR, cue.file));
  }

  const targetDur = duration.toFixed(3);

  if (activeSfx.length > 0) {
    const filterParts = ['[1:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[vo]'];
    const mixLabels = ['[vo]'];
    activeSfx.forEach((cue, idx) => {
      const inputIdx = idx + 2;
      const lbl = `[s${idx}]`;
      filterParts.push(
        `[${inputIdx}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${cue.gain},adelay=${cue.delayMs}|${cue.delayMs}${lbl}`
      );
      mixLabels.push(lbl);
    });
    filterParts.push(
      `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:normalize=0,alimiter=limit=0.95,apad=whole_dur=${targetDur}[aout]`
    );

    args.push('-filter_complex', filterParts.join(';'));
    args.push('-map', '0:v', '-map', '[aout]');
  } else {
    args.push('-af', `apad=whole_dur=${targetDur}`);
    args.push('-map', '0:v', '-map', '1:a');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-r', String(opts.fps),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-t', targetDur,
    '-movflags', '+faststart',
    opts.out
  );

  return args;
}

async function writeFfmpegFrame(ffmpeg, ffmpegDone, isFfmpegExited, buf) {
  if (isFfmpegExited() || ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
    await ffmpegDone;
    throw new Error('FFmpeg exited before receiving all frames');
  }
  if (!ffmpeg.stdin.write(buf)) {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        ffmpeg.stdin.off('drain', onDrain);
        ffmpeg.stdin.off('error', onStdinError);
        ffmpeg.off('exit', onFfmpegClose);
        ffmpeg.off('error', onFfmpegError);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onStdinError = err => {
        cleanup();
        if (err && err.code === 'EPIPE') {
          ffmpegDone.then(
            () => reject(new Error('FFmpeg closed stdin early')),
            reject
          );
          return;
        }
        reject(err);
      };
      const onFfmpegClose = () => {
        cleanup();
        ffmpegDone.then(
          () => reject(new Error('FFmpeg exited early while writing frames')),
          reject
        );
      };
      const onFfmpegError = err => {
        cleanup();
        reject(err);
      };

      ffmpeg.stdin.once('drain', onDrain);
      ffmpeg.stdin.once('error', onStdinError);
      ffmpeg.once('exit', onFfmpegClose);
      ffmpeg.once('error', onFfmpegError);

      if (isFfmpegExited() || ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
        onFfmpegClose();
      }
    });
  }
}

async function removeTempDir(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (_err) {
      if (attempt < 4) {
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  }
}

async function run() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printUsage();
    return;
  }

  const chromeBin = findChromeBinary();

  let userDataDir = null;
  let server = null;
  let chromeProc = null;
  let cdp = null;
  let ffmpeg = null;
  let interrupted = false;
  let cleanupPromise = null;

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (cdp) cdp.close('Render cleanup');
      if (ffmpeg && ffmpeg.stdin && !ffmpeg.stdin.destroyed) {
        ffmpeg.stdin.destroy();
      }
      await killChildProcess(ffmpeg);
      await killChildProcess(chromeProc);
      if (server) {
        await new Promise(resolve => {
          server.close(() => resolve());
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
        });
      }
      await removeTempDir(userDataDir);
    })();
    return cleanupPromise;
  };

  const handleSignal = sig => {
    if (interrupted) return;
    interrupted = true;
    const exitCode = sig === 'SIGINT' ? 130 : 143;
    console.error(`\nReceived ${sig}, cleaning up...`);
    cleanup().finally(() => {
      process.exit(exitCode);
    });
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  try {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-demo-chrome-'));
    const started = await startStaticServer(TOOLKIT_DIR);
    server = started.server;
    const port = started.port;

    const launched = await launchChrome(chromeBin, userDataDir, opts, proc => {
      chromeProc = proc;
    });
    chromeProc = launched.proc;
    chromeProc.on('error', () => {});

    cdp = new CdpClient(launched.wsUrl);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: opts.mobile || opts.portrait
    });

    const loadDone = new Promise((resolve, reject) => {
      cdp.on('Page.loadEventFired', resolve);
      cdp.onClose(reject);
    });

    const playerUrl = `http://127.0.0.1:${port}/${opts.player}?headless=1`;
    await cdp.send('Page.navigate', { url: playerUrl });
    await loadDone;

    // Ensure images and fonts have finished loading
    await evaluateFrame(
      cdp,
      `(async () => {
        await document.fonts.ready;
        const imgs = Array.from(document.images);
        await Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise(r => { img.onload = r; img.onerror = r; })));
        return imgs.length;
      })()`,
      { awaitPromise: true }
    );

    if (opts.previewFrame !== null && Number.isFinite(opts.previewFrame)) {
      await evaluateFrame(cdp, `window.renderAt(${opts.previewFrame});`);
      const snap = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, Buffer.from(snap.data, 'base64'));
      console.log(`Preview frame @ ${opts.previewFrame}s (${opts.width}x${opts.height}) written to ${opts.out}`);
      return;
    }

    if (!fs.existsSync(opts.audio)) {
      throw new Error(`Audio track not found: ${opts.audio}`);
    }

    const audioDur = probeDuration(opts.audio);
    const duration = opts.duration || Number((audioDur + OUTRO_BUFFER_SEC).toFixed(2));
    const totalFrames = Math.ceil(duration * opts.fps);
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });

    console.log(`Rendering ${totalFrames} frames (${duration.toFixed(2)}s @ ${opts.fps}fps, ${opts.width}x${opts.height}, ${opts.player}) -> ${opts.out}`);

    const ffmpegArgs = buildFfmpegArgs(opts, duration);
    ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

    let ffmpegStderr = '';
    let ffmpegExited = false;
    let ffmpegFailed = null;
    ffmpeg.stderr.on('data', d => {
      ffmpegStderr += d.toString();
    });

    ffmpeg.stdin.on('error', err => {
      if (err && err.code === 'EPIPE') return;
      if (!ffmpegFailed) ffmpegFailed = err;
    });

    const ffmpegDone = new Promise((resolve, reject) => {
      ffmpeg.on('error', err => {
        ffmpegExited = true;
        const wrapped = new Error(`Failed to spawn FFmpeg: ${err.message}`);
        ffmpegFailed = wrapped;
        reject(wrapped);
      });
      ffmpeg.on('exit', (code, signal) => {
        ffmpegExited = true;
        if (code === 0) {
          resolve();
        } else {
          const wrapped = new Error(
            `FFmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}:\n${ffmpegStderr.slice(-1500)}`
          );
          ffmpegFailed = wrapped;
          reject(wrapped);
        }
      });
    });
    ffmpegDone.catch(() => {});

    const startTime = Date.now();
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (interrupted) {
        throw new Error('Render interrupted by signal');
      }
      if (ffmpegFailed) {
        throw ffmpegFailed;
      }

      const t = frame / opts.fps;
      await evaluateFrame(cdp, `window.renderAt(${t.toFixed(4)});`);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true
      });

      const buf = Buffer.from(data, 'base64');
      await writeFfmpegFrame(ffmpeg, ffmpegDone, () => ffmpegExited, buf);

      if (frame % 150 === 0 || frame === totalFrames - 1) {
        const pct = (((frame + 1) / totalFrames) * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`  [${pct}%] frame ${frame + 1}/${totalFrames} (t=${t.toFixed(2)}s, elapsed=${elapsed}s)`);
      }
    }

    ffmpeg.stdin.end();
    await ffmpegDone;
    console.log(`Render complete: ${opts.out}`);
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    await cleanup();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Render failed:', err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  buildFfmpegArgs,
  CdpClient,
  evaluateFrame
};
