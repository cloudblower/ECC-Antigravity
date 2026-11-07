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
      } catch (err) {
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
    } catch (_) {}
  }

  generateSummary(meta = {}) {
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
      } catch (_) {}
    }

    const totalTests = allResults.length;
    const passedTests = allResults.filter(r => r.status === 'pass').length;
    const failedTests = allResults.filter(r => r.status === 'fail').length;

    let md = `# Local E2E Hooks Test Report\n\n`;
    md += `- **Timestamp:** ${this.timestamp}\n`;
    md += `- **Artifacts Directory:** \`${this.runDir}\`\n`;
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

    md += `\n## Token Count Verification (< 45 tokens directive ceiling)\n\n`;
    const tokenViolations = allResults.filter(r => r.tokenCount && r.tokenCount >= 45);
    if (tokenViolations.length === 0) {
      md += `✓ All test prompts satisfied the minimal token requirement (< 45 tokens).\n`;
    } else {
      md += `✗ Prompt token cap violated:\n`;
      for (const v of tokenViolations) {
        md += `- \`${v.prompt}\` (${v.tokenCount} tokens) in suite ${v.suite}\n`;
      }
    }

    fs.writeFileSync(reportPath, md, 'utf8');
    return reportPath;
  }

}

module.exports = EvidenceRecorder;
