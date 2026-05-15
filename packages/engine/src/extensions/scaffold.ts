import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { getScopeDirectory, type Scope } from '@eforge-build/scopes';

import { getConfigDir, getConventionalConfigDir } from '../config.js';

export const SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES = ['event-logger', 'blank'] as const;

export type ExtensionScaffoldTemplate = (typeof SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES)[number];
export type ExtensionScaffoldRequestScope = 'local' | 'project' | 'user';
export type ExtensionScaffoldErrorCode = 'invalid-name' | 'unknown-template' | 'conflict' | 'invalid-scope';

export interface ScaffoldNativeExtensionOptions {
  cwd: string;
  name: string;
  scope?: ExtensionScaffoldRequestScope;
  template?: ExtensionScaffoldTemplate;
  force?: boolean;
}

export interface ScaffoldNativeExtensionResult {
  name: string;
  template: ExtensionScaffoldTemplate;
  requestScope: ExtensionScaffoldRequestScope;
  scope: Scope;
  configDir: string;
  scopeDir: string;
  extensionsDir: string;
  path: string;
  created: true;
  overwritten: boolean;
  message: string;
}

export class ScaffoldNativeExtensionError extends Error {
  readonly code: ExtensionScaffoldErrorCode;
  readonly status: number;

  constructor(code: ExtensionScaffoldErrorCode, message: string) {
    super(message);
    this.name = 'ScaffoldNativeExtensionError';
    this.code = code;
    this.status = code === 'conflict' ? 409 : 400;
  }
}

export async function scaffoldNativeExtension(options: ScaffoldNativeExtensionOptions): Promise<ScaffoldNativeExtensionResult> {
  const requestScope = options.scope ?? 'local';
  const scope = mapRequestScope(requestScope);
  const template = options.template ?? 'event-logger';
  validateExtensionName(options.name);
  validateTemplate(template);

  const configDir = await getConfigDir(options.cwd) ?? getConventionalConfigDir(options.cwd);
  const scopeDir = getScopeDirectory(scope, { cwd: options.cwd, configDir });
  const extensionsDir = resolve(scopeDir, 'extensions');
  const targetPath = resolve(extensionsDir, `${options.name}.ts`);
  if (!isWithinDirectory(targetPath, extensionsDir)) {
    throw new ScaffoldNativeExtensionError('invalid-name', 'Invalid extension name: target path escapes the extensions directory');
  }

  await assertNotSymbolicLinkIfExists(scopeDir, 'Extension scope directory');
  await assertNotSymbolicLinkIfExists(extensionsDir, 'Extension target directory');
  await mkdir(extensionsDir, { recursive: true });
  await assertNotSymbolicLink(scopeDir, 'Extension scope directory');
  await assertNotSymbolicLink(extensionsDir, 'Extension target directory');
  const content = renderNativeExtensionTemplate(template, options.name);
  const force = options.force === true;
  const existedBefore = force ? await pathExists(targetPath) : false;
  try {
    await writeNativeExtensionFile(targetPath, content, force);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ScaffoldNativeExtensionError('conflict', `Extension already exists at ${targetPath}. Pass force: true to overwrite it.`);
    }
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new ScaffoldNativeExtensionError('conflict', `Extension target at ${targetPath} is a symbolic link and will not be overwritten.`);
    }
    throw err;
  }

  return {
    name: options.name,
    template,
    requestScope,
    scope,
    configDir,
    scopeDir,
    extensionsDir,
    path: targetPath,
    created: true,
    overwritten: existedBefore,
    message: existedBefore
      ? `Overwrote ${requestScope} extension "${options.name}" at ${targetPath}`
      : `Created ${requestScope} extension "${options.name}" at ${targetPath}`,
  };
}

async function assertNotSymbolicLink(path: string, label: string): Promise<void> {
  const fileStat = await lstat(path);
  if (fileStat.isSymbolicLink()) {
    throw new ScaffoldNativeExtensionError('conflict', `${label} is a symbolic link and will not be used for scaffolding.`);
  }
}

async function assertNotSymbolicLinkIfExists(path: string, label: string): Promise<void> {
  try {
    await assertNotSymbolicLink(path, label);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeNativeExtensionFile(path: string, content: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    await writeFile(path, content, { encoding: 'utf-8', flag: 'wx' });
    return;
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      await writeFile(path, content, { encoding: 'utf-8', flag: 'wx' });
      return;
    }
    if (code === 'EISDIR') {
      throw new ScaffoldNativeExtensionError('conflict', `Extension target at ${path} is not a regular file and will not be overwritten.`);
    }
    throw err;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new ScaffoldNativeExtensionError('conflict', `Extension target at ${path} is not a regular file and will not be overwritten.`);
    }
    if (fileStat.nlink > 1) {
      throw new ScaffoldNativeExtensionError('conflict', `Extension target at ${path} has multiple hard links and will not be overwritten.`);
    }
    await handle.truncate(0);
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}

function mapRequestScope(scope: ExtensionScaffoldRequestScope): Scope {
  switch (scope) {
    case 'local':
      return 'project-local';
    case 'project':
      return 'project-team';
    case 'user':
      return 'user';
    default:
      throw new ScaffoldNativeExtensionError('invalid-scope', 'Invalid extension scope. Supported scopes: local, project, user');
  }
}

function validateExtensionName(name: string): void {
  if (name.length === 0) {
    throw new ScaffoldNativeExtensionError('invalid-name', 'Invalid extension name: name must not be empty');
  }
  if (name.includes('\0')) {
    throw new ScaffoldNativeExtensionError('invalid-name', 'Invalid extension name: name must not contain NUL bytes');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new ScaffoldNativeExtensionError('invalid-name', 'Invalid extension name: name must not contain path separators');
  }
  if (name === '.' || name === '..') {
    throw new ScaffoldNativeExtensionError('invalid-name', 'Invalid extension name: . and .. are not allowed');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new ScaffoldNativeExtensionError('invalid-name', 'Invalid extension name: use only letters, numbers, dot, underscore, and dash');
  }
}

function validateTemplate(template: string): asserts template is ExtensionScaffoldTemplate {
  if ((SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES as readonly string[]).includes(template)) return;
  throw new ScaffoldNativeExtensionError(
    'unknown-template',
    `Unknown extension template: ${template}. Supported templates: ${SUPPORTED_EXTENSION_SCAFFOLD_TEMPLATES.join(', ')}`,
  );
}

function isWithinDirectory(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function renderNativeExtensionTemplate(template: ExtensionScaffoldTemplate, name: string): string {
  switch (template) {
    case 'event-logger':
      return renderEventLoggerTemplate(name);
    case 'blank':
      return renderBlankTemplate();
  }
}

function renderEventLoggerTemplate(name: string): string {
  return `import { defineEforgeExtension } from '@eforge-build/extension-sdk';

export default defineEforgeExtension((eforge) => {
  eforge.onEvent('*', async (event, ctx) => {
    ctx.logger.info(\`[extension:${name}] ${'${event.type}'}\`, { event });
  });
});
`;
}

function renderBlankTemplate(): string {
  return `import { defineEforgeExtension } from '@eforge-build/extension-sdk';

export default defineEforgeExtension((_eforge) => {
  // Register extension capabilities here.
});
`;
}
