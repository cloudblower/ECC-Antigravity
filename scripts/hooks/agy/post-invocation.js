'use strict';
const fs = require('fs');
const { setupEnvironment } = require('./agy-adapter');

function main() {
  const input = fs.readFileSync(0, 'utf8');
  let payload;
  try {
    payload = JSON.parse(input);
  } catch (_error) {
    console.error('post-invocation: failed to parse input JSON');
    console.log(JSON.stringify({}));
    process.exit(1);
  }

  // Setup environment for the session context
  setupEnvironment(payload);

  // PostInvocation runs after each model invocation completes.
  // Note: Stop-event hooks (delivery gates, linters, session-end) are executed by stop.js
  // when the session reaches terminal state (fullyIdle) to prevent duplicate execution.
  console.log(JSON.stringify({}));
}

main();

