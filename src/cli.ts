// Allow running as a subprocess from within Claude Code sessions
delete process.env.CLAUDECODE;

import { run } from './cli/index.js';
run();
