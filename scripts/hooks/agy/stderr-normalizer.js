'use strict';

const SLASH_COMMAND_MAP = [
  [/(^|\s)run\s+\/compact\b/gi, "$1please summarise and clear context"],
  [/(^|\s)\/compact\b/gi, "$1compact context"],
  [/(^|\s)\/clear\b/gi, "$1clear context"],
  [/(^|\s)\/model\b/gi, "$1change model"],
  [/(^|\s)\/cost\b/gi, "$1show cost summary"],
  [/(^|\s)\/review\b/gi, "$1review the work"]
];

function normalizeStderr(text) {
  if (!text) return text;
  let result = text;
  for (const [regex, replacement] of SLASH_COMMAND_MAP) {
    result = result.replace(regex, replacement);
  }
  return result;
}

module.exports = {
  normalizeStderr
};
