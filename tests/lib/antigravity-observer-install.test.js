'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createManifestInstallPlan,
  applyInstallPlan,
  previewInstallPlan,
} = require('../../scripts/lib/install-executor');
const {
  getPrivateAgyDirectory,
  getPrivateAgyBinaryPath,
  isAgyInstalled,
  installPrivateAgy,
  ensureAntigravityCliFallback,
  cleanShellProfiles,
} = require('../../scripts/lib/install/antigravity-cli-fallback');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('--- antigravity-observer-install.test.js ---');

const sourceRoot = path.join(__dirname, '..', '..');

test('antigravity install plan maps observer-loop.agy.sh to observer-loop.sh', () => {
  const plan = createManifestInstallPlan({
    sourceRoot,
    projectRoot: path.join(sourceRoot, 'test-project'),
    profileId: 'core',
    target: 'antigravity',
  });

  const observerOp = plan.operations.find(op => (
    op.destinationPath.endsWith(path.join('skills', 'continuous-learning-v2', 'agents', 'observer-loop.sh'))
  ));

  assert.ok(observerOp, 'Should find destination observer-loop.sh operation');
  assert.strictEqual(
    observerOp.sourceRelativePath,
    'skills/continuous-learning-v2/agents/observer-loop.agy.sh',
    'Antigravity should use observer-loop.agy.sh as source'
  );

  const looseAgyOp = plan.operations.find(op => (
    op.destinationPath.endsWith('observer-loop.agy.sh')
  ));
  assert.strictEqual(looseAgyOp, undefined, 'Should not install loose observer-loop.agy.sh file');
});

test('claude install plan keeps observer-loop.sh and excludes observer-loop.agy.sh', () => {
  const plan = createManifestInstallPlan({
    sourceRoot,
    projectRoot: path.join(sourceRoot, 'test-project'),
    profileId: 'core',
    target: 'claude',
  });

  const observerOp = plan.operations.find(op => (
    op.destinationPath.endsWith(path.join('skills', 'continuous-learning-v2', 'agents', 'observer-loop.sh'))
  ));

  assert.ok(observerOp, 'Should find destination observer-loop.sh operation');
  assert.strictEqual(
    observerOp.sourceRelativePath,
    'skills/continuous-learning-v2/agents/observer-loop.sh',
    'Claude should use original observer-loop.sh as source'
  );

  const looseAgyOp = plan.operations.find(op => (
    op.destinationPath.endsWith('observer-loop.agy.sh')
  ));
  assert.strictEqual(looseAgyOp, undefined, 'Claude should not install loose observer-loop.agy.sh file');
});

test('antigravity install plan maps llm-summary.agy.js to llm-summary.js', () => {
  const plan = createManifestInstallPlan({
    sourceRoot,
    projectRoot: path.join(sourceRoot, 'test-project'),
    profileId: 'core',
    target: 'antigravity',
  });

  const summaryOp = plan.operations.find(op => (
    op.destinationPath.endsWith(path.join('scripts', 'lib', 'llm-summary.js'))
  ));

  assert.ok(summaryOp, 'Should find destination llm-summary.js operation');
  assert.strictEqual(
    summaryOp.sourceRelativePath,
    'scripts/lib/llm-summary.agy.js',
    'Antigravity should use llm-summary.agy.js as source'
  );

  const looseAgyOp = plan.operations.find(op => (
    op.destinationPath.endsWith('llm-summary.agy.js')
  ));
  assert.strictEqual(looseAgyOp, undefined, 'Should not install loose llm-summary.agy.js file');
});

test('claude install plan keeps llm-summary.js and excludes llm-summary.agy.js', () => {
  const plan = createManifestInstallPlan({
    sourceRoot,
    projectRoot: path.join(sourceRoot, 'test-project'),
    profileId: 'core',
    target: 'claude',
  });

  const summaryOp = plan.operations.find(op => (
    op.destinationPath.endsWith(path.join('scripts', 'lib', 'llm-summary.js'))
  ));

  assert.ok(summaryOp, 'Should find destination llm-summary.js operation');
  assert.strictEqual(
    summaryOp.sourceRelativePath,
    'scripts/lib/llm-summary.js',
    'Claude should use original llm-summary.js as source'
  );

  const looseAgyOp = plan.operations.find(op => (
    op.destinationPath.endsWith('llm-summary.agy.js')
  ));
  assert.strictEqual(looseAgyOp, undefined, 'Claude should not install loose llm-summary.agy.js file');
});

test('antigravity install plan maps project-detect.agy.js to project-detect.js', () => {
  const plan = createManifestInstallPlan({
    sourceRoot,
    projectRoot: path.join(sourceRoot, 'test-project'),
    profileId: 'core',
    target: 'antigravity',
  });

  const detectOp = plan.operations.find(op => (
    op.destinationPath.endsWith(path.join('scripts', 'lib', 'project-detect.js'))
  ));

  assert.ok(detectOp, 'Should find destination project-detect.js operation');
  assert.strictEqual(
    detectOp.sourceRelativePath,
    'scripts/lib/project-detect.agy.js',
    'Antigravity should use project-detect.agy.js as source'
  );

  const looseAgyOp = plan.operations.find(op => (
    op.destinationPath.endsWith('project-detect.agy.js')
  ));
  assert.strictEqual(looseAgyOp, undefined, 'Should not install loose project-detect.agy.js file');
});

test('claude install plan keeps project-detect.js and excludes project-detect.agy.js', () => {
  const plan = createManifestInstallPlan({
    sourceRoot,
    projectRoot: path.join(sourceRoot, 'test-project'),
    profileId: 'core',
    target: 'claude',
  });

  const detectOp = plan.operations.find(op => (
    op.destinationPath.endsWith(path.join('scripts', 'lib', 'project-detect.js'))
  ));

  assert.ok(detectOp, 'Should find destination project-detect.js operation');
  assert.strictEqual(
    detectOp.sourceRelativePath,
    'scripts/lib/project-detect.js',
    'Claude should use original project-detect.js as source'
  );

  const looseAgyOp = plan.operations.find(op => (
    op.destinationPath.endsWith('project-detect.agy.js')
  ));
  assert.strictEqual(looseAgyOp, undefined, 'Claude should not install loose project-detect.agy.js file');
});

test('getPrivateAgyDirectory resolves .ecc/bin under homeDir', () => {
  const fakeHome = '/test/user/home';
  assert.strictEqual(
    getPrivateAgyDirectory(fakeHome),
    path.join(fakeHome, '.ecc', 'bin')
  );
});

test('getPrivateAgyBinaryPath handles win32 and posix platforms', () => {
  const fakeHome = '/test/user/home';
  assert.strictEqual(
    getPrivateAgyBinaryPath(fakeHome, 'win32'),
    path.join(fakeHome, '.ecc', 'bin', 'agy.exe')
  );
  assert.strictEqual(
    getPrivateAgyBinaryPath(fakeHome, 'linux'),
    path.join(fakeHome, '.ecc', 'bin', 'agy')
  );
  assert.strictEqual(
    getPrivateAgyBinaryPath(fakeHome, 'darwin'),
    path.join(fakeHome, '.ecc', 'bin', 'agy')
  );
});

test('isAgyInstalled detects system vs private vs absent', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-test-home-'));
  try {
    // 1. System command exists
    const resSystem = isAgyInstalled(
      { homeDir: tempHome },
      { commandExists: () => true, platform: 'linux' }
    );
    assert.strictEqual(resSystem.installed, true);
    assert.strictEqual(resSystem.location, 'system');

    // 2. Not in system, but exists in .ecc/bin
    const privateBinDir = path.join(tempHome, '.ecc', 'bin');
    fs.mkdirSync(privateBinDir, { recursive: true });
    const privateAgy = path.join(privateBinDir, 'agy');
    fs.writeFileSync(privateAgy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const resPrivate = isAgyInstalled(
      { homeDir: tempHome },
      { commandExists: () => false, platform: 'linux' }
    );
    assert.strictEqual(resPrivate.installed, true);
    assert.strictEqual(resPrivate.location, 'private');
    assert.strictEqual(resPrivate.binaryPath, privateAgy);

    // 3. Neither exists
    fs.unlinkSync(privateAgy);
    const resAbsent = isAgyInstalled(
      { homeDir: tempHome },
      { commandExists: () => false, platform: 'linux' }
    );
    assert.strictEqual(resAbsent.installed, false);
    assert.strictEqual(resAbsent.location, null);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installPrivateAgy executes install command targeting .ecc/bin with --dir', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-install-exec-'));
  try {
    const executedCommands = [];
    const mockInstaller = (cmd, opts) => {
      executedCommands.push({ cmd, opts });
      // Create mock binary so the installer check passes
      const expectedBinary = path.join(tempHome, '.ecc', 'bin', 'agy');
      fs.writeFileSync(expectedBinary, '#!/bin/sh\n', { mode: 0o755 });
      return { status: 0 };
    };

    const result = installPrivateAgy(
      { homeDir: tempHome, quiet: true },
      {
        installer: mockInstaller,
        platform: 'linux',
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(executedCommands.length, 1);
    const invokedCmd = executedCommands[0].cmd;
    assert.ok(invokedCmd.includes('--dir'), `Command should pass --dir: ${invokedCmd}`);
    assert.ok(invokedCmd.includes(path.join(tempHome, '.ecc', 'bin')), `Command should point to private bin dir: ${invokedCmd}`);
    assert.ok(invokedCmd.includes("sed '/# 7. Native Setup Handoff/,$d'"), 'Command should strip Step 7 on Unix to prevent shell pollution and glog errors');
    assert.ok(!invokedCmd.includes('--skip-path'), 'Command should not pass unsupported --skip-path parameter');
    assert.ok(!invokedCmd.includes('--skip-aliases'), 'Command should not pass unsupported --skip-aliases parameter');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('cleanShellProfiles strips private bin directory from shell profiles', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-clean-profiles-'));
  try {
    const bashrc = path.join(tempHome, '.bashrc');
    const zshrc = path.join(tempHome, '.zshrc');
    fs.writeFileSync(bashrc, 'alias ll="ls -l"\nexport PATH="/custom/bin:$PATH"\nexport PATH="/test/home/.ecc/bin:$PATH"\n');
    fs.writeFileSync(zshrc, 'export PATH="/test/home/.ecc/bin:$PATH"\n');

    cleanShellProfiles(tempHome, '/test/home/.ecc/bin');

    const cleanedBashrc = fs.readFileSync(bashrc, 'utf8');
    const cleanedZshrc = fs.readFileSync(zshrc, 'utf8');
    assert.ok(!cleanedBashrc.includes('/test/home/.ecc/bin'), '.bashrc should have .ecc/bin removed');
    assert.ok(cleanedBashrc.includes('alias ll="ls -l"'), '.bashrc should retain other entries');
    assert.ok(cleanedBashrc.includes('/custom/bin'), '.bashrc should retain other PATH entries');
    assert.ok(!cleanedZshrc.includes('/test/home/.ecc/bin'), '.zshrc should have .ecc/bin removed');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installPrivateAgy shows installation progress through logger and stdio', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-progress-'));
  try {
    const logs = [];
    let passedStdio = null;
    const mockInstaller = (cmd, opts) => {
      passedStdio = opts.stdio;
      const expectedBinary = path.join(tempHome, '.ecc', 'bin', 'agy');
      fs.writeFileSync(expectedBinary, '#!/bin/sh\n', { mode: 0o755 });
      return { status: 0 };
    };

    const result = installPrivateAgy(
      { homeDir: tempHome },
      {
        installer: mockInstaller,
        logger: msg => logs.push(msg),
        platform: 'linux',
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(passedStdio, 'inherit', 'Should use inherit stdio to stream installer progress');
    assert.ok(
      logs.some(m => m.includes('Installing agy to ECC private storage')),
      'Should log start of agy installation'
    );
    assert.ok(
      logs.some(m => m.includes('Antigravity CLI installed successfully')),
      'Should log completion of agy installation'
    );
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('installPrivateAgy suppresses progress when quiet is enabled', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-quiet-'));
  try {
    const logs = [];
    let passedStdio = null;
    const mockInstaller = (cmd, opts) => {
      passedStdio = opts.stdio;
      const expectedBinary = path.join(tempHome, '.ecc', 'bin', 'agy');
      fs.writeFileSync(expectedBinary, '#!/bin/sh\n', { mode: 0o755 });
      return { status: 0 };
    };

    const result = installPrivateAgy(
      { homeDir: tempHome, quiet: true },
      {
        installer: mockInstaller,
        logger: msg => logs.push(msg),
        platform: 'linux',
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(passedStdio, 'pipe', 'Should use pipe stdio when quiet');
    assert.strictEqual(logs.length, 0, 'Should not log messages when quiet');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('ensureAntigravityCliFallback installs to .ecc/bin when missing and skips when present', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-fallback-'));
  try {
    let installCalled = false;
    const mockInstaller = () => {
      installCalled = true;
      const expectedBinary = path.join(tempHome, '.ecc', 'bin', 'agy');
      fs.writeFileSync(expectedBinary, '#!/bin/sh\n', { mode: 0o755 });
      return { status: 0 };
    };

    const plan = {
      adapter: { target: 'antigravity' },
      homeDir: tempHome,
    };

    // Case 1: agy is missing -> installs
    const res1 = ensureAntigravityCliFallback(plan, {
      homeDir: tempHome,
      quiet: true,
      commandExists: () => false,
      installer: mockInstaller,
      platform: 'linux',
    });
    assert.strictEqual(res1.installed, true);
    assert.strictEqual(installCalled, true);

    // Case 2: agy is already available -> skips install
    installCalled = false;
    const res2 = ensureAntigravityCliFallback(plan, {
      homeDir: tempHome,
      commandExists: () => true,
      installer: mockInstaller,
      platform: 'linux',
    });
    assert.strictEqual(res2.installed, false);
    assert.strictEqual(res2.alreadyAvailable, true);
    assert.strictEqual(installCalled, false);

    // Case 3: target is claude -> skips entirely
    const claudePlan = {
      adapter: { target: 'claude' },
      homeDir: tempHome,
    };
    const res3 = ensureAntigravityCliFallback(claudePlan, {
      homeDir: tempHome,
      commandExists: () => false,
      installer: mockInstaller,
    });
    assert.strictEqual(res3.skipped, true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('observer-loop.agy.sh includes $HOME/.ecc/bin in PATH', () => {
  const observerPath = path.join(
    sourceRoot,
    'skills',
    'continuous-learning-v2',
    'agents',
    'observer-loop.agy.sh'
  );
  const content = fs.readFileSync(observerPath, 'utf8');
  assert.ok(
    content.includes('.ecc/bin'),
    'observer-loop.agy.sh should reference .ecc/bin'
  );
  assert.ok(
    content.includes('PATH='),
    'observer-loop.agy.sh should update PATH with private storage'
  );
});

test('observer-loop.agy.sh dynamically resolves models via agy models without hardcoding models', () => {
  const observerPath = path.join(
    sourceRoot,
    'skills',
    'continuous-learning-v2',
    'agents',
    'observer-loop.agy.sh'
  );
  const content = fs.readFileSync(observerPath, 'utf8');
  assert.ok(
    content.includes('agy models'),
    'observer-loop.agy.sh should query agy models dynamically'
  );
  assert.ok(
    !content.includes('gemini-3.5-flash-medium'),
    'observer-loop.agy.sh should not hardcode specific model slugs like gemini-3.5-flash-medium'
  );
  assert.ok(
    !content.includes('claude-opus-4-6-thinking'),
    'observer-loop.agy.sh should not hardcode specific model slugs like claude-opus-4-6-thinking'
  );
});

test('llm-summary.agy.js dynamically resolves models via agy models without hardcoding models', () => {
  const summaryPath = path.join(
    sourceRoot,
    'scripts',
    'lib',
    'llm-summary.agy.js'
  );
  const content = fs.readFileSync(summaryPath, 'utf8');
  assert.ok(
    content.includes("'agy', ['models']"),
    'llm-summary.agy.js should query agy models dynamically'
  );
  assert.ok(
    !content.includes('gemini-3.5-flash-medium'),
    'llm-summary.agy.js should not hardcode specific model slugs like gemini-3.5-flash-medium'
  );
  assert.ok(
    !content.includes('claude-opus-4-6-thinking'),
    'llm-summary.agy.js should not hardcode specific model slugs like claude-opus-4-6-thinking'
  );
});

test('end-to-end antigravity core install writes Antigravity observer-loop.sh and handles agy fallback', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-install-'));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-home-'));
  try {
    let installInvoked = false;
    const mockInstaller = () => {
      installInvoked = true;
      const expectedBinary = path.join(tempHome, '.ecc', 'bin', 'agy');
      fs.mkdirSync(path.dirname(expectedBinary), { recursive: true });
      fs.writeFileSync(expectedBinary, '#!/bin/sh\n', { mode: 0o755 });
      return { status: 0 };
    };

    const plan = createManifestInstallPlan({
      sourceRoot,
      projectRoot: tempProject,
      homeDir: tempHome,
      profileId: 'core',
      target: 'antigravity',
    });

    applyInstallPlan(plan, {
      homeDir: tempHome,
      quiet: true,
      commandExists: () => false,
      installer: mockInstaller,
    });

    assert.strictEqual(installInvoked, true, 'Should invoke agy fallback installer when agy is missing');

    const installedObserverPath = path.join(
      tempProject,
      '.agents',
      'skills',
      'continuous-learning-v2',
      'agents',
      'observer-loop.sh'
    );
    assert.ok(fs.existsSync(installedObserverPath), 'observer-loop.sh should be installed under .agents');

    const content = fs.readFileSync(installedObserverPath, 'utf8');
    assert.ok(content.includes('command -v agy'), 'Installed file should check for agy CLI');
    assert.ok(content.includes('.ecc/bin'), 'Installed file should reference .ecc/bin');
    assert.ok(content.includes('write_to_file'), 'Installed file should refer to write_to_file tool');
    assert.ok(content.includes('--dangerously-skip-permissions'), 'Installed file should invoke agy with --dangerously-skip-permissions');

    const looseAgyPath = path.join(
      tempProject,
      '.agents',
      'skills',
      'continuous-learning-v2',
      'agents',
      'observer-loop.agy.sh'
    );
    assert.ok(!fs.existsSync(looseAgyPath), 'Loose observer-loop.agy.sh should not exist');

    const installedSummaryPath = path.join(
      tempProject,
      '.agents',
      'scripts',
      'lib',
      'llm-summary.js'
    );
    assert.ok(fs.existsSync(installedSummaryPath), 'llm-summary.js should be installed under .agents/scripts/lib');

    const summaryContent = fs.readFileSync(installedSummaryPath, 'utf8');
    assert.ok(summaryContent.includes("spawnSync('agy'"), 'Installed llm-summary.js should invoke agy CLI');
    assert.ok(!summaryContent.includes("spawnSync('claude'"), 'Installed llm-summary.js should not invoke claude CLI');

    const looseSummaryPath = path.join(
      tempProject,
      '.agents',
      'scripts',
      'lib',
      'llm-summary.agy.js'
    );
    assert.ok(!fs.existsSync(looseSummaryPath), 'Loose llm-summary.agy.js should not exist');

    const installedDetectPath = path.join(
      tempProject,
      '.agents',
      'scripts',
      'lib',
      'project-detect.js'
    );
    assert.ok(fs.existsSync(installedDetectPath), 'project-detect.js should be installed under .agents/scripts/lib');

    const detectContent = fs.readFileSync(installedDetectPath, 'utf8');
    assert.ok(detectContent.includes('resolveProjectDir'), 'Installed project-detect.js should contain Antigravity resolveProjectDir');
    assert.ok(detectContent.includes('CLAUDE_PROJECT_DIR'), 'Installed project-detect.js should check CLAUDE_PROJECT_DIR');

    const looseDetectPath = path.join(
      tempProject,
      '.agents',
      'scripts',
      'lib',
      'project-detect.agy.js'
    );
    assert.ok(!fs.existsSync(looseDetectPath), 'Loose project-detect.agy.js should not exist');
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('previewInstallPlan handles dry-run without mutating target or private bin', () => {
  const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-dryrun-proj-'));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-agy-dryrun-home-'));
  try {
    const rawPlan = createManifestInstallPlan({
      sourceRoot,
      projectRoot: tempProject,
      homeDir: tempHome,
      profileId: 'core',
      target: 'antigravity',
    });

    const preview = previewInstallPlan(rawPlan);
    assert.strictEqual(preview.applied, false);
    const privateAgy = path.join(tempHome, '.ecc', 'bin', 'agy');
    assert.ok(!fs.existsSync(privateAgy), 'Dry run must not create private binary');
  } finally {
    fs.rmSync(tempProject, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

console.log(`\nPassed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
