// Allow running as a subprocess from within Claude Code sessions
delete process.env.CLAUDECODE;

process.title = 'eforge';

// Ignore SIGPIPE - prevents exit code 13 when a pipe reader (e.g. eval harness) closes early
process.on('SIGPIPE', () => {});

import { run } from './cli/index.js';

try {
  await run();
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
}
