'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandExists: defaultCommandExists } = require('../utils');

const UNIX_INSTALL_URL = 'https://antigravity.google/cli/install.sh';
const WINDOWS_INSTALL_URL = 'https://antigravity.google/cli/install.ps1';

function resolveHomeDirectory(homeDir) {
  return homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function getPrivateAgyDirectory(homeDir) {
  const resolvedHome = resolveHomeDirectory(homeDir);
  return path.join(resolvedHome, '.ecc', 'bin');
}

function getPrivateAgyBinaryPath(homeDir, platform = process.platform) {
  const binaryName = platform === 'win32' ? 'agy.exe' : 'agy';
  return path.join(getPrivateAgyDirectory(homeDir), binaryName);
}

function isAgyInstalled(options = {}, dependencies = {}) {
  const homeDir = resolveHomeDirectory(options.homeDir || dependencies.homeDir);
  const platform = dependencies.platform || process.platform;
  const commandExists = dependencies.commandExists || defaultCommandExists;
  const fsInstance = dependencies.fs || fs;

  if (typeof commandExists === 'function' && commandExists('agy')) {
    return {
      installed: true,
      location: 'system',
      binaryPath: 'agy',
    };
  }

  const privatePath = getPrivateAgyBinaryPath(homeDir, platform);
  try {
    if (fsInstance.existsSync(privatePath)) {
      return {
        installed: true,
        location: 'private',
        binaryPath: privatePath,
      };
    }
  } catch (_error) {
    // Ignore filesystem read errors and fall through
  }

  return {
    installed: false,
    location: null,
    binaryPath: null,
  };
}

function cleanShellProfiles(homeDir, privateBinDir, fsInstance = fs) {
  const resolvedHome = resolveHomeDirectory(homeDir);
  const targetPattern = privateBinDir || path.join(resolvedHome, '.ecc', 'bin');
  const profileNames = [
    '.bashrc',
    '.bash_profile',
    '.profile',
    '.zshrc',
    path.join('Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join('Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join('Documents', 'PowerShell', 'profile.ps1'),
    path.join('Documents', 'WindowsPowerShell', 'profile.ps1')
  ];

  for (const name of profileNames) {
    const profilePath = path.join(resolvedHome, name);
    try {
      if (fsInstance.existsSync(profilePath)) {
        const content = fsInstance.readFileSync(profilePath, 'utf8');
        if (content.includes(targetPattern)) {
          const cleaned = content
            .split('\n')
            .filter(line => {
              if (!line.includes(targetPattern)) return true;
              return !/(?:export\s+PATH=|PATH=|\$env:Path\s*=|alias\s+agy=)/.test(line);
            })
            .join('\n');
          fsInstance.writeFileSync(profilePath, cleaned);
        }
      }
    } catch (_error) {
      // Ignore filesystem errors for profile cleanup
      if (process.env.ECC_DEBUG) {
        console.error(`[DEBUG] Failed to clean shell profile at ${profilePath}:`, _error);
      }
    }
  }
}

function installPrivateAgy(options = {}, dependencies = {}) {
  const homeDir = resolveHomeDirectory(options.homeDir || dependencies.homeDir);
  const platform = dependencies.platform || process.platform;
  const privateBinDir = getPrivateAgyDirectory(homeDir);
  const privateBinaryPath = getPrivateAgyBinaryPath(homeDir, platform);
  const fsInstance = dependencies.fs || fs;
  const quiet = Boolean(options.quiet || dependencies.quiet);
  const logger = quiet
    ? null
    : (dependencies.logger !== undefined ? dependencies.logger : console.error);
  const stdio = dependencies.stdio || (quiet ? 'pipe' : 'inherit');

  // Prevent path injection via shell metacharacters
  if (/[;&|`$><\n\r]/.test(privateBinDir)) {
    throw new Error(`Invalid characters in privateBinDir: ${privateBinDir}`);
  }

  try {
    if (typeof logger === 'function') {
      logger('\nAntigravity CLI (agy) not found on system.');
      logger(`Installing agy to ECC private storage (${privateBinDir})...\n`);
    }

    fsInstance.mkdirSync(privateBinDir, { recursive: true });

    if (typeof dependencies.installer === 'function') {
      // SECURITY: When providing a custom installer, the caller is responsible
      // for safely executing the command string. These string commands contain
      // interpolated paths and should be executed carefully.
      const result = dependencies.installer(
        platform === 'win32'
          ? `irm ${WINDOWS_INSTALL_URL} | iex --dir "${privateBinDir}" --skip-path --skip-aliases`
          : `curl -fsSL ${UNIX_INSTALL_URL} | sed '/# 7. Native Setup Handoff/,$d' | bash -s -- --dir "${privateBinDir}"`,
        { cwd: privateBinDir, stdio }
      );
      if (result && result.status !== undefined && result.status !== 0) {
        return {
          success: false,
          error: `Installer exited with code ${result.status}`,
        };
      }
    } else {
      if (platform === 'win32') {
        const expectedSha256 = options.expectedSha256 || dependencies.expectedSha256 || process.env.ECC_AGY_INSTALL_SHA256;
        const escapedDir = privateBinDir.replace(/'/g, "''");

        if (expectedSha256) {
          const downloadCmd = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; (irm ${WINDOWS_INSTALL_URL})`;
          const scriptText = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', downloadCmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });
          const actualSha256 = crypto.createHash('sha256').update(scriptText).digest('hex');
          if (actualSha256 !== expectedSha256) {
            throw new Error(`Integrity check failed for Antigravity installer: expected ${expectedSha256}, got ${actualSha256}`);
          }
          const args = [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `& { $script = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($script)) -d '${escapedDir}' --skip-path --skip-aliases }`
          ];
          execFileSync('powershell', args, { input: scriptText, stdio, timeout: 120000 });
        } else {
          const args = [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            `& { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((irm ${WINDOWS_INSTALL_URL}))) -d '${escapedDir}' --skip-path --skip-aliases }`
          ];
          execFileSync('powershell', args, { stdio, timeout: 120000 });
        }
      } else {
        const curlResult = execFileSync('curl', ['-fsSL', UNIX_INSTALL_URL], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 });

        const expectedSha256 = options.expectedSha256 || dependencies.expectedSha256 || process.env.ECC_AGY_INSTALL_SHA256;
        if (expectedSha256) {
          const actualSha256 = crypto.createHash('sha256').update(curlResult).digest('hex');
          if (actualSha256 !== expectedSha256) {
            throw new Error(`Integrity check failed for Antigravity installer: expected ${expectedSha256}, got ${actualSha256}`);
          }
        }

        const filteredScript = curlResult.split('# 7. Native Setup Handoff')[0];
        const bashStdio = stdio === 'inherit'
          ? ['pipe', 'inherit', 'inherit']
          : (Array.isArray(stdio) ? ['pipe', stdio[1] || 'pipe', stdio[2] || 'pipe'] : 'pipe');
        execFileSync('bash', ['-s', '--', '--dir', privateBinDir], { input: filteredScript, stdio: bashStdio, timeout: 120000 });
      }
    }

    cleanShellProfiles(homeDir, privateBinDir, fsInstance);

    if (fsInstance.existsSync(privateBinaryPath)) {
      if (platform !== 'win32') {
        try {
          fsInstance.chmodSync(privateBinaryPath, 0o755);
        } catch (_chmodError) {
          // Ignore chmod failures on non-POSIX or read-only mounted filesystems
          if (!quiet && process.env.ECC_DEBUG) {
            console.error(`[DEBUG] Failed to chmod binary at ${privateBinaryPath}:`, _chmodError);
          }
        }
      }
      if (typeof logger === 'function') {
        logger(`\n✓ Antigravity CLI installed successfully to ${privateBinaryPath}\n`);
      }
      return {
        success: true,
        binaryPath: privateBinaryPath,
      };
    }

    return {
      success: false,
      error: `Binary not found at ${privateBinaryPath} after installation`,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}

function ensureAntigravityCliFallback(appliedPlan, dependencies = {}) {
  if (
    !appliedPlan
    || !appliedPlan.adapter
    || appliedPlan.adapter.target !== 'antigravity'
  ) {
    return { skipped: true };
  }

  if (
    process.env.ECC_SKIP_AGY_FALLBACK === '1'
    || dependencies.skipFallback
  ) {
    return { skipped: true, fallbackDisabled: true };
  }

  const homeDir = resolveHomeDirectory(
    dependencies.homeDir
    || appliedPlan.homeDir
    || (appliedPlan.statePreview && appliedPlan.statePreview.homeDir)
  );

  const status = isAgyInstalled({ homeDir }, dependencies);
  if (status.installed) {
    return {
      installed: false,
      alreadyAvailable: true,
      location: status.location,
      binaryPath: status.binaryPath,
    };
  }

  const quiet = Boolean(
    dependencies.quiet
    || (appliedPlan && (
      appliedPlan.quiet
      || (appliedPlan.options && (appliedPlan.options.quiet || appliedPlan.options.json))
    ))
    || (typeof process !== 'undefined' && process.argv && (
      process.argv.includes('--json') || process.argv.includes('--quiet')
    ))
  );
  const result = installPrivateAgy({ homeDir, quiet }, dependencies);
  if (result.success) {
    return {
      installed: true,
      alreadyAvailable: false,
      location: 'private',
      binaryPath: result.binaryPath,
    };
  }

  return {
    installed: false,
    alreadyAvailable: false,
    warning: `Antigravity CLI (agy) was not found and automated installation to ${getPrivateAgyDirectory(homeDir)} failed: ${result.error}`,
  };
}

module.exports = {
  getPrivateAgyDirectory,
  getPrivateAgyBinaryPath,
  isAgyInstalled,
  installPrivateAgy,
  ensureAntigravityCliFallback,
  cleanShellProfiles,
};
