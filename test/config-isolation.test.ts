import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadUserConfig } from '@eforge-build/engine/config';
import { useTempDir } from './test-tmpdir.js';

describe('user-tier config isolation', () => {
  const makeTempDir = useTempDir('eforge-test-config-isolation-');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loadUserConfig() returns {} under the global test isolation', async () => {
    const result = await loadUserConfig();
    expect(result).toEqual({});
  });

  it('loadUserConfig() returns parsed config when XDG_CONFIG_HOME points at a real config', async () => {
    const tmpDir = makeTempDir();
    const configDir = join(tmpDir, 'eforge');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.yaml'), 'maxConcurrentBuilds: 7\n', 'utf-8');

    vi.stubEnv('XDG_CONFIG_HOME', tmpDir);

    const result = await loadUserConfig();
    expect(result.maxConcurrentBuilds).toBe(7);
  });
});
