import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create a fresh, empty tmpdir and point XDG_CONFIG_HOME at it so that
// loadUserConfig() and any spawned subprocesses (e.g. eforge queue exec) never
// read the developer's real ~/.config/eforge/config.yaml during tests.
const isolatedConfigHome = mkdtempSync(join(tmpdir(), 'eforge-test-xdg-'));
process.env.XDG_CONFIG_HOME = isolatedConfigHome;
