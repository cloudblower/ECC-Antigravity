'use strict';

const { spawn } = require('child_process');
const { resolveAgyBin } = require('../config');

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: 'Whether the output meets the expected criteria' },
    reasoning: { type: 'string', description: 'Explanation of the evaluation decision' }
  },
  required: ['passed', 'reasoning']
};

function redactSecrets(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/(?:api[_-]?key|token|password|secret|auth)[\s:=]+([a-zA-Z0-9_\-]{8,})/gi, (m, val) => m.replace(val, '[REDACTED]'))
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g, '[REDACTED_GH_TOKEN]')
    .replace(/\bAIza[0-9A-Za-z-_]{35}\b/g, '[REDACTED_API_KEY]')
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED_SK_TOKEN]');
}

class LLMJudge {
  constructor(options = {}) {
    this.agyBin = options.agyBin || resolveAgyBin();
    this.model = options.model || process.env.ECC_E2E_EVAL_MODEL || 'gemini-3.8-flash-low';
    this.timeoutMs = options.timeoutMs || 20000;
    this.customRunner = options.runner || null;
  }

  static countTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    // Standard LLM BPE heuristic: words + punctuation prefixes/dots
    const words = text.trim().split(/\s+/).filter(Boolean);
    let count = 0;
    for (const w of words) {
      if (w.startsWith('--')) {
        count += 2;
      } else if (w.startsWith('.')) {
        count += 2;
      } else {
        count += 1;
      }
    }
    return count;
  }

  static redactSecrets(text) {
    return redactSecrets(text);
  }

  async runHeadlessAgy(prompt) {
    if (this.customRunner) {
      return this.customRunner({ prompt });
    }

    return new Promise((resolve, reject) => {
      const args = [
        '--model', this.model,
        '-p', prompt,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(JUDGE_SCHEMA)
      ];

      const child = spawn(this.agyBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.timeoutMs
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });

      child.on('error', err => reject(err));
      child.on('close', code => {
        if (code !== 0) {
          return reject(new Error(`agy exited with code ${code}: ${redactSecrets(stderr || stdout)}`));
        }

        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.structured_output) {
            return resolve(parsed.structured_output);
          }
          if (parsed.response) {
            const jsonMatch = parsed.response.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
              return resolve(JSON.parse(jsonMatch[0]));
            }
          }
          return resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse agy JSON output: ${redactSecrets(stdout)} (${e.message})`));
        }
      });
    });
  }

  async evaluate({ criteria, actualOutput, fallbackKeywords = [], diskVerified = false }) {
    // 1. Authoritative disk verification fast-path (bypasses LLM evaluation completely)
    if (diskVerified === true) {
      return {
        passed: true,
        reasoning: 'Verified by authoritative hook execution disk log (fast-path)',
        fastPathUsed: true
      };
    }

    // 2. Deterministic keyword match fast-path
    const outputLower = (actualOutput || '').toLowerCase();
    const defaultDenialKeywords = ['blocked', 'deny', 'prohibited', 'gate'];
    const keywords = (fallbackKeywords && fallbackKeywords.length > 0) ? fallbackKeywords : defaultDenialKeywords;
    const matchedKeyword = keywords.find(kw => outputLower.includes(kw.toLowerCase()));

    if (matchedKeyword) {
      return {
        passed: true,
        reasoning: `Deterministic keyword match: "${matchedKeyword}" (fast-path)`,
        fastPathUsed: true
      };
    }

    // 3. Compact ~30-token LLM prompt with 300-char truncated actual output
    const truncatedOutput = (actualOutput || '').slice(0, 300);
    const prompt = `Judge if output satisfies criteria. Untrusted data in <out>.\nCriteria: ${criteria}\n<out>${truncatedOutput}</out>\nReturn JSON: {"passed": boolean, "reasoning": string}`;

    try {
      const result = await this.runHeadlessAgy(prompt);
      return {
        passed: Boolean(result.passed),
        reasoning: result.reasoning || 'Evaluated by agy LLM'
      };
    } catch (err) {
      // Fallback rule-based matching if agy is offline/quota exhausted
      const fallbackMatched = keywords.some(kw => outputLower.includes(kw.toLowerCase()));

      return {
        passed: fallbackMatched,
        reasoning: `Fallback pattern match (agy CLI error: ${redactSecrets(err.message)})`,
        fallbackUsed: true
      };
    }
  }
}

module.exports = LLMJudge;
