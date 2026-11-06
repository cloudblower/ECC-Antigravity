'use strict';

const fs = require('fs');
const path = require('path');

const os = require('os');

const DANGEROUS_DIRS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib64',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/tmp',
  '/usr',
  '/var'
]);

function assertSafeSandboxDir(sandboxDir) {
  if (!sandboxDir || typeof sandboxDir !== 'string') {
    throw new Error('Sandbox directory must be a valid non-empty string');
  }

  const resolved = path.resolve(sandboxDir);
  const repoRoot = path.resolve(__dirname, '../../..');

  if (resolved === repoRoot) {
    throw new Error(`Unsafe sandbox directory: "${sandboxDir}" cannot be the repository root`);
  }

  if (DANGEROUS_DIRS.has(resolved) || resolved === os.homedir()) {
    throw new Error(`Unsafe sandbox directory: "${sandboxDir}" is a protected system or home directory`);
  }

  const root = path.parse(resolved).root;
  if (resolved === root) {
    throw new Error(`Unsafe sandbox directory: "${sandboxDir}" cannot be the filesystem root`);
  }
}

function seedSandbox(sandboxDir) {
  assertSafeSandboxDir(sandboxDir);
  if (!fs.existsSync(sandboxDir)) {
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  // 1. Ensure scripts symlink / directory exists
  const scriptsLink = path.join(sandboxDir, 'scripts');
  const agentsScripts = path.join(sandboxDir, '.agents', 'scripts');
  if (!fs.existsSync(scriptsLink)) {
    if (fs.existsSync(agentsScripts)) {
      try {
        fs.symlinkSync('.agents/scripts', scriptsLink);
      } catch (_) {
        // Fallback: try relative symlink
        try {
          fs.symlinkSync(agentsScripts, scriptsLink);
        } catch (_) {}
      }
    }
  }

  // 2. Ensure package.json exists with dev server script
  const pkgPath = path.join(sandboxDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const pkgContent = {
      name: 'ecc-antigravity-test-sandbox',
      version: '1.0.0',
      description: 'E2E test sandbox for Antigravity hooks',
      main: 'index.js',
      scripts: {
        dev: 'node -e \'console.log("dev server running")\'',
        build: 'node -e \'console.log("build complete")\'',
        test: 'node -e \'console.log("test complete")\''
      }
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkgContent, null, 2) + '\n', 'utf8');
  }

  // 3. Ensure index.js exists
  const indexPath = path.join(sandboxDir, 'index.js');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, '// Test sandbox entry point\nmodule.exports = { name: "sandbox" };\n', 'utf8');
  }

  // 4. Ensure docs/guide.md exists
  const docsDir = path.join(sandboxDir, 'docs');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }
  const guidePath = path.join(docsDir, 'guide.md');
  if (!fs.existsSync(guidePath)) {
    fs.writeFileSync(guidePath, '# Guide\nDocumentation for test project.\n', 'utf8');
  }

  // 5. Ensure .claude.json exists for config-protection testing
  const claudeJsonPath = path.join(sandboxDir, '.claude.json');
  if (!fs.existsSync(claudeJsonPath)) {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ allowedTools: ['Bash', 'Write', 'Edit'] }, null, 2) + '\n', 'utf8');
  }

  return {
    scriptsLink,
    pkgPath,
    indexPath,
    guidePath,
    claudeJsonPath
  };
}

function cleanSandbox(sandboxDir) {
  assertSafeSandboxDir(sandboxDir);
  // Re-seed clean versions of edited files
  const indexPath = path.join(sandboxDir, 'index.js');
  if (fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, '// Test sandbox entry point\nmodule.exports = { name: "sandbox" };\n', 'utf8');
  }

  const guidePath = path.join(sandboxDir, 'docs', 'guide.md');
  if (fs.existsSync(guidePath)) {
    fs.writeFileSync(guidePath, '# Guide\nDocumentation for test project.\n', 'utf8');
  }
}

function getHookLogs(sandboxDir, sinceTimestamp = null) {
  const logFile = path.join(sandboxDir, '.agents', 'hooks-execution.log');
  if (!fs.existsSync(logFile)) return [];

  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (sinceTimestamp) {
        const itemTime = new Date(parsed.timestamp).getTime();
        const sinceTime = new Date(sinceTimestamp).getTime();
        if (itemTime < sinceTime) continue;
      }
      events.push(parsed);
    } catch (_) {
      // Ignore unparseable lines
    }
  }

  return events;
}

function findLastDenial(sandboxDir, sinceTimestamp = null) {
  const logs = getHookLogs(sandboxDir, sinceTimestamp);
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i];
    if (entry.result && entry.result.decision === 'deny') {
      return entry;
    }
  }
  return null;
}

function findHookEvents(sandboxDir, hookName, sinceTimestamp = null) {
  const logs = getHookLogs(sandboxDir, sinceTimestamp);
  return logs.filter(entry => entry.hook === hookName);
}

module.exports = {
  assertSafeSandboxDir,
  seedSandbox,
  cleanSandbox,
  getHookLogs,
  findLastDenial,
  findHookEvents
};
