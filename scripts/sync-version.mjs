import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkgPath = join(root, 'package.json');
const pluginPath = join(root, 'eforge-plugin', '.claude-plugin', 'plugin.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));

plugin.version = pkg.version;

writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n', 'utf8');

console.log(`Synced plugin.json version to ${pkg.version}`);
