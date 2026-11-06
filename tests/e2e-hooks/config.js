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

  const mergedEnv = {
    ...fileEnv,
    ...process.env,
    ...envOverrides
  };

  const isLocal = /^(true|1|yes)$/i.test(String(mergedEnv.ECC_E2E_LOCAL || ''));
  const webUrl = mergedEnv.ECC_E2E_WEB_URL || 'https://127.0.0.1:37811/';
  const defaultSandbox = path.resolve(__dirname, '../../test-sandbox');
  const homeSandbox = path.join(os.homedir(), 'Documents', 'ECC-Antigravity-test');
  const sandboxDir = mergedEnv.ECC_E2E_SANDBOX_DIR || (fs.existsSync(homeSandbox) ? homeSandbox : defaultSandbox);
  const evalModel = mergedEnv.ECC_E2E_EVAL_MODEL || 'gemini-3.8-flash-low';
  const agyBin = mergedEnv.ECC_E2E_AGY_BIN || resolveAgyBin();
  const artifactsDir = mergedEnv.ECC_E2E_ARTIFACTS_DIR || path.resolve(__dirname, '../../test-artifacts');
  const timeoutMs = parseInt(mergedEnv.ECC_E2E_TIMEOUT_MS || '60000', 10);

  return {
    isLocal,
    webUrl,
    sandboxDir,
    evalModel,
    agyBin,
    artifactsDir,
    timeoutMs
  };
}

const defaultConfig = loadConfig();

module.exports = {
  loadConfig,
  defaultConfig,
  resolveAgyBin
};
