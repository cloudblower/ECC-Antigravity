'use strict';

const fs = require('fs');
const path = require('path');

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
    const baseDir = options.baseDir || path.resolve(__dirname, '../../../test-artifacts');
    this.timestamp = options.timestamp || formatTimestamp();
    this.runDir = path.join(baseDir, this.timestamp);

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

  async startScreencast(pageId, testName, mcpClient = null) {
    const filePath = this._resolveSafePath(testName, 'mp4');
    this.activeScreencast = { pageId, filePath, testName };

    if (mcpClient && typeof mcpClient.callTool === 'function') {
      try {
        await mcpClient.callTool('chrome-devtools-mcp', 'screencast_start', {
          pageId,
          filePath
        });
      } catch (err) {
        // Fallback or log error
        fs.writeFileSync(filePath + '.log', `Screencast start error: ${err.message}\n`);
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

    if (mcpClient && typeof mcpClient.callTool === 'function') {
      try {
        await mcpClient.callTool('chrome-devtools-mcp', 'screencast_stop', { pageId });
      } catch (err) {
        fs.appendFileSync(filePath + '.log', `Screencast stop error: ${err.message}\n`);
      }
    }

    const recorded = this.activeScreencast;
    this.activeScreencast = null;
    return recorded.filePath;
  }

  async captureScreenshot(pageId, testName, mcpClient = null) {
    const filePath = this._resolveSafePath(testName, 'png');

    if (mcpClient && typeof mcpClient.callTool === 'function') {
      try {
        await mcpClient.callTool('chrome-devtools-mcp', 'take_screenshot', {
          pageId,
          filePath,
          fullPage: true
        });
      } catch (err) {
        fs.writeFileSync(filePath + '.err', `Screenshot error: ${err.message}\n`);
      }
    } else {
      fs.writeFileSync(filePath, Buffer.from([])); // placeholder
    }

    return filePath;
  }

  recordTestResult(result) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...result
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
      md += `| ${r.suite} | ${r.testName} | \`${r.prompt}\` | ${r.tokenCount || '-'} | ${r.status.toUpperCase()} | ${r.reason || ''} | ${evidence} |\n`;
    }

    md += `\n## Token Count Verification (< 12 tokens rule)\n\n`;
    const tokenViolations = allResults.filter(r => r.tokenCount && r.tokenCount >= 12);
    if (tokenViolations.length === 0) {
      md += `✓ All test prompts satisfied the minimal token requirement (< 12 tokens).\n`;
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
