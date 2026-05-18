import { describe, it, expect } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashExtensionFile, hashExtensionDirectory } from '@eforge-build/engine/extensions';
import { useTempDir } from './test-tmpdir.js';

describe('extension content hashing', () => {
  const makeTempDir = useTempDir('extension-hash-');

  describe('hashExtensionFile', () => {
    it('returns a 64-character hex SHA-256 hash', async () => {
      const root = makeTempDir();
      const file = resolve(root, 'ext.js');
      await writeFile(file, 'export default function extension() {}', 'utf-8');
      const hash = await hashExtensionFile(file);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same hash for the same content on repeated calls (determinism)', async () => {
      const root = makeTempDir();
      const file = resolve(root, 'ext.js');
      await writeFile(file, 'export default function extension() {}', 'utf-8');
      const hash1 = await hashExtensionFile(file);
      const hash2 = await hashExtensionFile(file);
      expect(hash1).toBe(hash2);
    });

    it('returns different hashes for different file content', async () => {
      const root = makeTempDir();
      const fileA = resolve(root, 'a.js');
      const fileB = resolve(root, 'b.js');
      await writeFile(fileA, 'export default function extA() {}', 'utf-8');
      await writeFile(fileB, 'export default function extB() {}', 'utf-8');
      const hashA = await hashExtensionFile(fileA);
      const hashB = await hashExtensionFile(fileB);
      expect(hashA).not.toBe(hashB);
    });

    it('returns a changed hash after the file content is modified', async () => {
      const root = makeTempDir();
      const file = resolve(root, 'ext.js');
      await writeFile(file, 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionFile(file);
      await writeFile(file, 'export default function extension() { /* changed */ }', 'utf-8');
      const hashAfter = await hashExtensionFile(file);
      expect(hashBefore).not.toBe(hashAfter);
    });
  });

  describe('hashExtensionDirectory', () => {
    it('returns a 64-character hex SHA-256 hash', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hash = await hashExtensionDirectory(dir);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same hash for the same directory content (determinism)', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'my-ext' }), 'utf-8');
      const hash1 = await hashExtensionDirectory(dir);
      const hash2 = await hashExtensionDirectory(dir);
      expect(hash1).toBe(hash2);
    });

    it('returns the same hash for identical manifests regardless of file creation order', async () => {
      const root = makeTempDir();
      const dirA = resolve(root, 'a');
      const dirB = resolve(root, 'b');
      await mkdir(resolve(dirA, 'src'), { recursive: true });
      await mkdir(resolve(dirB, 'src'), { recursive: true });

      await writeFile(resolve(dirA, 'package.json'), '{"type":"module"}\n', 'utf-8');
      await writeFile(resolve(dirA, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
      await writeFile(resolve(dirA, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');

      await writeFile(resolve(dirB, 'src', 'b.ts'), 'export const b = 2;\n', 'utf-8');
      await writeFile(resolve(dirB, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
      await writeFile(resolve(dirB, 'package.json'), '{"type":"module"}\n', 'utf-8');

      expect(await hashExtensionDirectory(dirB)).toBe(await hashExtensionDirectory(dirA));
    });

    it('separates manifest paths and contents so NUL bytes cannot alias different file sets', async () => {
      const root = makeTempDir();
      const dirA = resolve(root, 'framed-a');
      const dirB = resolve(root, 'framed-b');
      await mkdir(dirA, { recursive: true });
      await mkdir(dirB, { recursive: true });

      await writeFile(resolve(dirA, 'a.js'), Buffer.from('x'));
      await writeFile(resolve(dirA, 'b.js'), Buffer.from('z.js\0'));

      await writeFile(resolve(dirB, 'a.js'), Buffer.from('x\0b.js'));
      await writeFile(resolve(dirB, 'z.js'), Buffer.alloc(0));

      expect(await hashExtensionDirectory(dirA)).not.toBe(await hashExtensionDirectory(dirB));
    });

    it('returns a changed hash when a source file is added', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);
      await writeFile(resolve(dir, 'helper.ts'), 'export function helper() {}', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);
      expect(hashBefore).not.toBe(hashAfter);
    });

    it('returns a changed hash when a source file is modified', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() { /* modified */ }', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);
      expect(hashBefore).not.toBe(hashAfter);
    });

    it('returns a changed hash when package.json changes', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'my-ext', version: '1.0.0' }), 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);
      await writeFile(resolve(dir, 'package.json'), JSON.stringify({ name: 'my-ext', version: '2.0.0' }), 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);
      expect(hashBefore).not.toBe(hashAfter);
    });

    it('remains unchanged when only node_modules/ files change', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);

      // Add files inside node_modules/ — should not affect the hash
      const nodeModulesDir = resolve(dir, 'node_modules', 'some-dep');
      await mkdir(nodeModulesDir, { recursive: true });
      await writeFile(resolve(nodeModulesDir, 'index.js'), 'module.exports = {};', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);

      expect(hashBefore).toBe(hashAfter);
    });

    it('remains unchanged when only dist/ files change', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);

      // Add files inside dist/ — should not affect the hash
      const distDir = resolve(dir, 'dist');
      await mkdir(distDir, { recursive: true });
      await writeFile(resolve(distDir, 'index.js'), 'exports.default = function() {};', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);

      expect(hashBefore).toBe(hashAfter);
    });

    it('includes a resolved entrypoint under an otherwise excluded dist/ directory', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      const entrypoint = resolve(dir, 'dist', 'index.js');
      await mkdir(resolve(dir, 'dist'), { recursive: true });
      await writeFile(resolve(dir, 'package.json'), JSON.stringify({ main: './dist/index.js' }), 'utf-8');
      await writeFile(entrypoint, 'exports.default = function() {};', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir, entrypoint);

      await writeFile(entrypoint, 'exports.default = function() { return "changed"; };', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir, entrypoint);

      expect(hashBefore).not.toBe(hashAfter);
    });

    it('remains unchanged when only .git/ files change', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);

      const gitDir = resolve(dir, '.git');
      await mkdir(gitDir, { recursive: true });
      await writeFile(resolve(gitDir, 'HEAD'), 'ref: refs/heads/main\n', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);

      expect(hashBefore).toBe(hashAfter);
    });

    it('includes .js, .mts, and .mjs files in the hash', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');

      const baseline = await hashExtensionDirectory(dir);
      await writeFile(resolve(dir, 'helper.js'), 'export function helper() { return "js"; }', 'utf-8');
      const withJs = await hashExtensionDirectory(dir);
      await writeFile(resolve(dir, 'module.mts'), 'export const mts = true;', 'utf-8');
      const withMts = await hashExtensionDirectory(dir);
      await writeFile(resolve(dir, 'module.mjs'), 'export const mjs = true;', 'utf-8');
      const withMjs = await hashExtensionDirectory(dir);

      expect(withJs).not.toBe(baseline);
      expect(withMts).not.toBe(withJs);
      expect(withMjs).not.toBe(withMts);
    });

    it('does not include non-source files like README.md in the hash', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'export default function extension() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);

      // Adding a README.md should not affect the hash
      await writeFile(resolve(dir, 'README.md'), '# My Extension\n', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);

      expect(hashBefore).toBe(hashAfter);
    });

    it('rejects symbolic links so trusted hashes cannot omit mutable link targets', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      const outside = resolve(root, 'outside.js');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'index.ts'), 'import "./helper.js"; export default function extension() {}', 'utf-8');
      await writeFile(outside, 'export const helper = true;', 'utf-8');
      await symlink(outside, resolve(dir, 'helper.js'));

      await expect(hashExtensionDirectory(dir)).rejects.toThrow('unsupported symbolic link');
    });

    it('returns a stable hash for an empty directory', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'empty-ext');
      await mkdir(dir, { recursive: true });
      const hash1 = await hashExtensionDirectory(dir);
      const hash2 = await hashExtensionDirectory(dir);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('includes files in nested subdirectories (excluding excluded dirs)', async () => {
      const root = makeTempDir();
      const dir = resolve(root, 'my-ext');
      await mkdir(resolve(dir, 'src', 'utils'), { recursive: true });
      await writeFile(resolve(dir, 'src', 'index.ts'), 'export default function extension() {}', 'utf-8');
      await writeFile(resolve(dir, 'src', 'utils', 'helper.ts'), 'export function helper() {}', 'utf-8');
      const hashBefore = await hashExtensionDirectory(dir);

      // Modifying a nested file should change the hash
      await writeFile(resolve(dir, 'src', 'utils', 'helper.ts'), 'export function helper() { /* changed */ }', 'utf-8');
      const hashAfter = await hashExtensionDirectory(dir);

      expect(hashBefore).not.toBe(hashAfter);
    });
  });
});
