'use strict';
 
const fs = require('fs');
const os = require('os');
const path = require('path');
const LLMJudge = require('./llm-judge');

function formatTimestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}${MM}${dd}-${HH}${mm}${ss}`;
}

function redactDeep(val) {
  if (typeof val === 'string') {
    return LLMJudge.redactSecrets(val);
  }
  if (Array.isArray(val)) {
    return val.map(redactDeep);
  }
  if (val && typeof val === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = redactDeep(v);
    }
    return res;
  }
  return val;
}

class EvidenceRecorder {
  constructor(options = {}) {
    const rawBaseDir = options.baseDir || path.resolve(__dirname, '../../../test-artifacts');
    const baseDir = path.resolve(rawBaseDir);
    const rawTimestamp = options.timestamp || process.env.ECC_E2E_ARTIFACTS_TIMESTAMP || formatTimestamp();
    const sanitizedTimestamp = path.basename(String(rawTimestamp)).replace(/[^a-zA-Z0-9._-]/g, '_');
    this.timestamp = sanitizedTimestamp || formatTimestamp();
    this.runDir = path.resolve(baseDir, this.timestamp);

    const basePrefix = baseDir + path.sep;
    if (!this.runDir.startsWith(basePrefix)) {
      throw new Error(`Path traversal detected: timestamp "${rawTimestamp}" escapes artifact directory`);
    }

    if (!fs.existsSync(this.runDir)) {
      fs.mkdirSync(this.runDir, { recursive: true });
    }

    this.results = [];
    this.activeScreencast = null;
  }

  _resolveSafePath(testName, ext) {
    const safeName = path.basename(String(testName || 'unnamed-test')).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${safeName || 'unnamed-test'}.${ext}`;
    const filePath = path.resolve(this.runDir, fileName);
    const expectedPrefix = path.resolve(this.runDir) + path.sep;
    if (!filePath.startsWith(expectedPrefix)) {
      throw new Error(`Path traversal detected: "${testName}" escapes artifact directory`);
    }
    return filePath;
  }

  async _callMcp(mcpClient, toolName, args) {
    if (!mcpClient) return null;
    if (toolName === 'screencast_start' && typeof mcpClient.screencastStart === 'function') {
      return await mcpClient.screencastStart(args);
    }
    if (toolName === 'screencast_stop' && typeof mcpClient.screencastStop === 'function') {
      return await mcpClient.screencastStop(args);
    }
    if (toolName === 'take_screenshot' && typeof mcpClient.takeScreenshot === 'function') {
      return await mcpClient.takeScreenshot(args);
    }
    if (typeof mcpClient.callTool === 'function') {
      try {
        return await mcpClient.callTool(toolName, args);
      } catch (_err) {
        return await mcpClient.callTool('chrome-devtools-mcp', toolName, args);
      }
    }
    return null;
  }

  _extractFilePathFromResponse(res) {
    if (!res) return null;
    let text = '';
    if (typeof res === 'string') {
      text = res;
    } else if (res.content && Array.isArray(res.content)) {
      text = res.content.map(c => c.text || '').join(' ');
    } else if (res.filePath) {
      return res.filePath;
    } else if (res.path) {
      return res.path;
    }

    const match = text.match(/([^\s"']+\.(?:mp4|png|webm|mkv))/i);
    return match ? match[1] : null;
  }

  _validateAndCopyTempFile(sourcePath, destPath) {
    if (!sourcePath || typeof sourcePath !== 'string') return false;
    try {
      const realTmpDir = fs.realpathSync(os.tmpdir());
      const resolvedSource = path.resolve(sourcePath);
      const tmpPrefix = realTmpDir + path.sep;
      const osTmpPrefix = path.resolve(os.tmpdir()) + path.sep;

      // Must start with os.tmpdir() or its realpath
      if (!resolvedSource.startsWith(tmpPrefix) && !resolvedSource.startsWith(osTmpPrefix)) {
        return false;
      }

      if (!fs.existsSync(resolvedSource)) return false;

      // Check realpath of source as well to prevent symlink bypass
      const realSource = fs.realpathSync(resolvedSource);
      if (!realSource.startsWith(tmpPrefix) && !realSource.startsWith(osTmpPrefix)) {
        return false;
      }

      // Must be regular file and not a symlink
      const lstat = fs.lstatSync(resolvedSource);
      if (!lstat.isFile() || lstat.isSymbolicLink()) {
        return false;
      }

      fs.copyFileSync(resolvedSource, destPath);
      return true;
    } catch (_) {
      return false;
    }
  }

  async startScreencast(pageId, testName, mcpClient = null) {
    const filePath = this._resolveSafePath(testName, 'mp4');
    this.activeScreencast = { pageId, filePath, testName };

    if (mcpClient) {
      try {
        await this._callMcp(mcpClient, 'screencast_start', {
          pageId,
          filePath
        });
      } catch (err) {
        fs.writeFileSync(filePath + '.log', LLMJudge.redactSecrets(`Screencast start error: ${err.message}\n`));
      }
    } else {
      // Stub marker if MCP is offline
      fs.writeFileSync(filePath + '.meta.json', JSON.stringify({ pageId, testName, startedAt: new Date().toISOString() }));
    }

    return filePath;
  }

  async stopScreencast(pageId, mcpClient = null) {
    if (!this.activeScreencast) return null;
    const { filePath } = this.activeScreencast;

    let res = null;
    if (mcpClient) {
      try {
        res = await this._callMcp(mcpClient, 'screencast_stop', { pageId });
      } catch (err) {
        fs.appendFileSync(filePath + '.log', LLMJudge.redactSecrets(`Screencast stop error: ${err.message}\n`));
      }
    }

    // Check if MCP returned a file path to relocate
    const returnedPath = this._extractFilePathFromResponse(res);
    if (returnedPath && returnedPath !== filePath) {
      this._validateAndCopyTempFile(returnedPath, filePath);
    }

    // If target video file doesn't exist yet, create placeholder metadata
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath + '.meta.json', JSON.stringify({ pageId, stoppedAt: new Date().toISOString() }));
    }

    const recorded = this.activeScreencast;
    this.activeScreencast = null;
    return recorded.filePath;
  }

  async captureScreenshot(pageId, testName, mcpClient = null) {
    const filePath = this._resolveSafePath(testName, 'png');

    if (mcpClient) {
      try {
        const res = await this._callMcp(mcpClient, 'take_screenshot', {
          pageId,
          filePath,
          fullPage: true
        });

        // Check if response contains image base64 data
        if (res && res.content && Array.isArray(res.content)) {
          const imgContent = res.content.find(c => c.type === 'image' && c.data);
          if (imgContent) {
            fs.writeFileSync(filePath, Buffer.from(imgContent.data, 'base64'));
          }
        }

        // Check if response referenced a temporary file path
        if (!fs.existsSync(filePath)) {
          const returnedPath = this._extractFilePathFromResponse(res);
          if (returnedPath && returnedPath !== filePath) {
            this._validateAndCopyTempFile(returnedPath, filePath);
          }
        }
      } catch (err) {
        fs.writeFileSync(filePath + '.err', LLMJudge.redactSecrets(`Screenshot error: ${err.message}\n`));
      }
    }

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from([])); // placeholder
    }

    return filePath;
  }

  async captureStructuredEvidence(testName, options = {}) {
    const opts = options || {};

    // 1. Hook trace JSONL
    const hookTracePath = this._resolveSafePath(testName, 'hook-trace.jsonl');
    const logs = opts.hookLogs || (opts.sideEffects && opts.sideEffects.hookLogs) || [];
    let hookTraceContent = '';
    if (Array.isArray(logs) && logs.length > 0) {
      hookTraceContent = logs.map(item => JSON.stringify(redactDeep(item))).join('\n') + '\n';
    }
    fs.writeFileSync(hookTracePath, hookTraceContent, 'utf8');

    // 2. Side effects JSON
    const sideEffectsPath = this._resolveSafePath(testName, 'side-effects.json');
    const sideEffectsData = redactDeep(opts.sideEffects || {});
    fs.writeFileSync(sideEffectsPath, JSON.stringify(sideEffectsData, null, 2), 'utf8');

    // 3. Accessibility snapshot TXT (truncated to 10k chars max)
    const a11ySnapshotPath = this._resolveSafePath(testName, 'a11y-snapshot.txt');
    let rawA11y = opts.a11ySnapshot || opts.snapshot || 'No accessibility snapshot captured';
    if (typeof rawA11y !== 'string') {
      try {
        rawA11y = JSON.stringify(rawA11y, null, 2);
      } catch (_) {
        rawA11y = String(rawA11y);
      }
    }
    const truncatedA11y = rawA11y.slice(0, 10000);
    const redactedA11y = LLMJudge.redactSecrets(truncatedA11y);
    fs.writeFileSync(a11ySnapshotPath, redactedA11y, 'utf8');

    // 4. DOM extract JSON
    const domExtractPath = this._resolveSafePath(testName, 'dom-extract.json');
    const domData = redactDeep(opts.domExtract || opts.dom || {});
    fs.writeFileSync(domExtractPath, JSON.stringify(domData, null, 2), 'utf8');

    // 5. Browser diagnostics JSON
    const browserDiagnosticsPath = this._resolveSafePath(testName, 'browser-diagnostics.json');
    let diagData = opts.browserDiagnostics;
    if (!diagData) {
      diagData = {
        consoleMessages: opts.consoleMessages || [],
        networkRequests: opts.networkRequests || []
      };
    }
    const sanitizedDiag = redactDeep(diagData);
    fs.writeFileSync(browserDiagnosticsPath, JSON.stringify(sanitizedDiag, null, 2), 'utf8');

    // 6. Verification receipt JSON
    const verificationReceiptPath = this._resolveSafePath(testName, 'verification-receipt.json');
    const receiptData = opts.verificationReceipt || opts.receipt || {
      testName,
      timestamp: new Date().toISOString()
    };
    const sanitizedReceipt = redactDeep(receiptData);
    fs.writeFileSync(verificationReceiptPath, JSON.stringify(sanitizedReceipt, null, 2), 'utf8');

    return {
      hookTrace: hookTracePath,
      sideEffects: sideEffectsPath,
      a11ySnapshot: a11ySnapshotPath,
      domExtract: domExtractPath,
      browserDiagnostics: browserDiagnosticsPath,
      verificationReceipt: verificationReceiptPath,
      allFiles: [
        hookTracePath,
        sideEffectsPath,
        a11ySnapshotPath,
        domExtractPath,
        browserDiagnosticsPath,
        verificationReceiptPath
      ]
    };
  }

  recordTestResult(result) {
    const sanitized = { ...result };
    if (typeof sanitized.reason === 'string') {
      sanitized.reason = LLMJudge.redactSecrets(sanitized.reason);
    }
    if (typeof sanitized.prompt === 'string') {
      sanitized.prompt = LLMJudge.redactSecrets(sanitized.prompt);
    }
    const entry = {
      timestamp: new Date().toISOString(),
      ...sanitized
    };
    this.results.push(entry);
    const jsonlPath = path.join(this.runDir, 'results.jsonl');
    try {
      fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {
      // Best-effort append to results.jsonl
    }
  }

  generateSummary(meta = {}, hookMatrix = []) {
    const reportPath = path.join(this.runDir, 'summary.md');
    const jsonlPath = path.join(this.runDir, 'results.jsonl');

    let allResults = [...this.results];
    if (fs.existsSync(jsonlPath)) {
      try {
        const lines = fs.readFileSync(jsonlPath, 'utf8').split(/\r?\n/).filter(Boolean);
        const map = new Map();
        for (const line of lines) {
          const parsed = JSON.parse(line);
          map.set(`${parsed.suite}:${parsed.testName}`, parsed);
        }
        allResults = Array.from(map.values());
      } catch (_) {
        // Best-effort fallback to in-memory results
      }
    }

    const totalTests = allResults.length;
    const passedTests = allResults.filter(r => r.status === 'pass').length;
    const failedTests = allResults.filter(r => r.status === 'fail').length;

    const finalHookMatrix = Array.isArray(hookMatrix) && hookMatrix.length > 0
      ? hookMatrix
      : (Array.isArray(meta.hookMatrix) ? meta.hookMatrix : []);

    // 1. Write evidence-manifest.json
    const manifestPath = path.join(this.runDir, 'evidence-manifest.json');
    const manifest = {
      timestamp: this.timestamp,
      runDir: this.runDir,
      generatedAt: new Date().toISOString(),
      summary: {
        total: totalTests,
        passed: passedTests,
        failed: failedTests
      },
      suites: allResults.map(r => ({
        suite: r.suite,
        testName: r.testName,
        status: r.status,
        prompt: LLMJudge.redactSecrets(r.prompt || ''),
        tokenCount: r.tokenCount,
        durationMs: r.durationMs,
        evidenceFiles: (r.evidenceFiles || []).map(f => path.basename(f)),
        structuredEvidence: r.structuredEvidence ? redactDeep(r.structuredEvidence) : undefined
      })),
      hookMatrix: finalHookMatrix
    };
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } catch (_) {
      // Best-effort write of manifest
    }

    // 2. Generate summary.md
    let md = `# Local E2E Hooks Test Report\n\n`;
    md += `- **Timestamp:** ${this.timestamp}\n`;
    md += `- **Artifacts Directory:** \`${this.runDir}\`\n`;
    md += `- **Evidence Manifest:** [\`evidence-manifest.json\`](./evidence-manifest.json)\n`;
    md += `- **Total Tests:** ${totalTests}\n`;
    md += `- **Passed:** ${passedTests} ✓\n`;
    md += `- **Failed:** ${failedTests} ${failedTests > 0 ? '✗' : ''}\n`;
    if (meta.totalDurationMs) {
      md += `- **Total Duration:** ${(meta.totalDurationMs / 1000).toFixed(2)}s\n`;
    }
    md += `\n## Suite Results\n\n`;
    md += `| Suite | Test | Prompt | Tokens | Status | Reason | Evidence |\n`;
    md += `|-------|------|--------|--------|--------|--------|----------|\n`;

    for (const r of allResults) {
      const evidence = (r.evidenceFiles || []).map(f => path.basename(f)).join(', ') || 'N/A';
      const cleanPrompt = LLMJudge.redactSecrets(r.prompt || '');
      const cleanReason = LLMJudge.redactSecrets(r.reason || '');
      md += `| ${r.suite} | ${r.testName} | \`${cleanPrompt}\` | ${r.tokenCount || '-'} | ${r.status.toUpperCase()} | ${cleanReason} | ${evidence} |\n`;
    }

    if (finalHookMatrix.length > 0) {
      md += `\n## Hook Coverage Matrix (${finalHookMatrix.length} units)\n\n`;
      md += `| Hook ID | Suite | Test | Status |\n`;
      md += `|---------|-------|------|--------|\n`;
      for (const h of finalHookMatrix) {
        md += `| ${h.id} | ${h.suite || '-'} | ${h.testName || '-'} | ${h.status || 'PASS'} |\n`;
      }
    }

    md += `\n## Token Count Verification (< 45 tokens directive ceiling)\n\n`;
    const tokenViolations = allResults.filter(r => r.tokenCount && r.tokenCount >= 45);
    if (tokenViolations.length === 0) {
      md += `✓ All test prompts satisfied the minimal token requirement (< 45 tokens).\n`;
    } else {
      md += `✗ Prompt token cap violated:\n`;
      for (const v of tokenViolations) {
        const cleanPrompt = LLMJudge.redactSecrets(v.prompt || '');
        md += `- \`${cleanPrompt}\` (${v.tokenCount} tokens) in suite ${v.suite}\n`;
      }
    }

    fs.writeFileSync(reportPath, md, 'utf8');
    return reportPath;
  }

}

module.exports = EvidenceRecorder;
