'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const os = require('os');

function resolveAgyBin() {
  const home = os.homedir();
  const candidates = [
    process.env.ECC_E2E_AGY_BIN,
    path.join(home, '.local', 'bin', 'agy'),
    path.join(home, '.ecc', 'bin', 'agy')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const whichAgy = execSync('which agy', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (whichAgy && fs.existsSync(whichAgy)) return whichAgy;
  } catch (_) {
    // ignore
  }

  return 'agy';
}

function parseDotEnv(filePath) {
  const envVars = {};
  if (!fs.existsSync(filePath)) return envVars;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) continue;

      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();

      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      envVars[key] = value;
    }
  } catch (_) {
    // ignore read errors
  }
  return envVars;
}

function loadConfig(envOverrides = {}, dotEnvPath = null) {
  const defaultEnvPath = path.resolve(__dirname, '../../.env');
  const targetEnvPath = dotEnvPath || defaultEnvPath;
  const fileEnv = parseDotEnv(targetEnvPath);

  // If a custom dotEnvPath is explicitly provided (e.g. in unit tests), its values
  // take precedence over ambient process.env so test fixtures are hermetic.
  const mergedEnv = dotEnvPath
    ? { ...process.env, ...fileEnv, ...envOverrides }
    : { ...fileEnv, ...process.env, ...envOverrides };

  const rawIsLocal = envOverrides.ECC_E2E_LOCAL !== undefined
    ? envOverrides.ECC_E2E_LOCAL
    : (dotEnvPath && fileEnv.ECC_E2E_LOCAL !== undefined)
      ? fileEnv.ECC_E2E_LOCAL
      : process.env.ECC_E2E_LOCAL;

  const isLocal = /^(true|1|yes)$/i.test(String(rawIsLocal || ''));
  const webUrl = mergedEnv.ECC_E2E_WEB_URL || 'https://127.0.0.1:37811/?section=fd24d189-63b2-438f-acd8-4025c11c78cf';
  const defaultSandbox = path.resolve(__dirname, '../../test-sandbox');
  const homeSandbox = path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test');
  const sandboxDir = mergedEnv.ECC_E2E_SANDBOX_DIR || (fs.existsSync(homeSandbox) ? homeSandbox : defaultSandbox);
  const evalModel = mergedEnv.ECC_E2E_EVAL_MODEL || 'gemini-3.8-flash-low';
  const browserModel = mergedEnv.ECC_E2E_BROWSER_MODEL || 'Gemini 3.8 Flash (Low)';
  const agyBin = mergedEnv.ECC_E2E_AGY_BIN || resolveAgyBin();
  const artifactsDir = mergedEnv.ECC_E2E_ARTIFACTS_DIR || path.resolve(__dirname, '../../test-artifacts');
  const timeoutMs = parseInt(mergedEnv.ECC_E2E_TIMEOUT_MS || '60000', 10);
  const localBin = path.resolve(__dirname, '../../node_modules/.bin/chrome-devtools-mcp');
  const hasLocalBin = fs.existsSync(localBin);
  const mcpCommand = mergedEnv.ECC_E2E_MCP_COMMAND || (hasLocalBin ? localBin : 'npx');

  let mcpArgs = hasLocalBin
    ? ['--categoryExtensions', '--isolated', '--headless', '--chrome-arg=--ignore-certificate-errors', '--allowUnrestrictedPaths']
    : ['-y', 'chrome-devtools-mcp@latest', '--categoryExtensions', '--isolated', '--headless', '--chrome-arg=--ignore-certificate-errors', '--allowUnrestrictedPaths'];
  if (mergedEnv.ECC_E2E_MCP_ARGS) {
    if (Array.isArray(mergedEnv.ECC_E2E_MCP_ARGS)) {
      mcpArgs = mergedEnv.ECC_E2E_MCP_ARGS;
    } else if (typeof mergedEnv.ECC_E2E_MCP_ARGS === 'string') {
      try {
        const parsed = JSON.parse(mergedEnv.ECC_E2E_MCP_ARGS);
        if (Array.isArray(parsed)) {
          mcpArgs = parsed;
        } else {
          mcpArgs = mergedEnv.ECC_E2E_MCP_ARGS.trim().split(/\s+/);
        }
      } catch (_) {
        mcpArgs = mergedEnv.ECC_E2E_MCP_ARGS.trim().split(/\s+/);
      }
    }
  }

  return {
    isLocal,
    webUrl,
    sandboxDir,
    evalModel,
    browserModel,
    agyBin,
    artifactsDir,
    timeoutMs,
    mcpCommand,
    mcpArgs
  };
}

const defaultConfig = loadConfig();

module.exports = {
  loadConfig,
  defaultConfig,
  resolveAgyBin
};
