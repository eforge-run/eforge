/**
 * Static wiring tests for the /eforge:extend authoring workflow.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function repoPath(relative: string): string {
  return resolve(REPO_ROOT, relative);
}

function readRepoFile(relative: string): string {
  return readFileSync(repoPath(relative), 'utf-8');
}

function frontmatterOf(relative: string): Record<string, unknown> {
  const source = readRepoFile(relative);
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  expect(match, `${relative} should have YAML frontmatter`).toBeTruthy();
  return parseYaml(match![1]) as Record<string, unknown>;
}

function compareSemver(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part));
  const right = b.split('.').map((part) => Number(part));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe('/eforge:extend skill files and manifests', () => {
  it('declares the Claude Code plugin authoring skill with required frontmatter', () => {
    const relative = 'eforge-plugin/skills/extend/extend.md';
    expect(existsSync(repoPath(relative))).toBe(true);

    const source = readRepoFile(relative);
    const frontmatter = frontmatterOf(relative);
    expect(frontmatter.description).toEqual(expect.any(String));
    expect(frontmatter.description).not.toBe('');
    expect(frontmatter['argument-hint']).toEqual(expect.any(String));
    expect(frontmatter['argument-hint']).not.toBe('');
    expect(source).not.toContain('disable-model-invocation: true');
  });

  it('declares the Pi authoring skill with required frontmatter', () => {
    const relative = 'packages/pi-eforge/skills/eforge-extend/SKILL.md';
    expect(existsSync(repoPath(relative))).toBe(true);

    const source = readRepoFile(relative);
    const frontmatter = frontmatterOf(relative);
    expect(frontmatter.name).toBe('eforge-extend');
    expect(frontmatter.description).toEqual(expect.any(String));
    expect(frontmatter.description).not.toBe('');
    expect(source).not.toContain('disable-model-invocation: true');
  });

  it('registers the plugin skill and bumps the plugin version', () => {
    const manifestPath = repoPath('eforge-plugin/.claude-plugin/plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      version: string;
      commands: string[];
    };

    expect(compareSemver(manifest.version, '0.25.7')).toBeGreaterThan(0);
    expect(manifest.commands).toContain('./skills/extend/extend.md');

    const pluginRoot = repoPath('eforge-plugin');
    for (const command of manifest.commands) {
      expect(existsSync(resolve(pluginRoot, command)), `${command} should exist`).toBe(true);
    }
  });
});

describe('/eforge:extend command and parity wiring', () => {
  it('adds a Pi command alias through the skill forwarding loop', () => {
    const source = readRepoFile('packages/pi-eforge/extensions/eforge/index.ts');
    const blockStart = source.indexOf('const skillCommands');
    const blockEnd = source.indexOf('for (const cmd of skillCommands)', blockStart);
    expect(blockStart).toBeGreaterThanOrEqual(0);
    expect(blockEnd).toBeGreaterThan(blockStart);

    const skillCommandsBlock = source.slice(blockStart, blockEnd);
    expect(skillCommandsBlock).toMatch(
      /\{\s*name: "eforge:extend",[\s\S]*?skill: "eforge-extend",[\s\S]*?\}/,
    );

    const forwardingLoopEnd = source.indexOf('// ------------------------------------------------------------------', blockEnd);
    expect(forwardingLoopEnd).toBeGreaterThan(blockEnd);
    const forwardingLoop = source.slice(blockEnd, forwardingLoopEnd);
    expect(forwardingLoop).toContain('`/skill:${cmd.skill}${args ? " " + args : ""}`');
    expect(forwardingLoop).toContain('pi.sendUserMessage(message.trim())');
  });

  it('adds the extend skill to explicit parity lists', () => {
    const parityScript = readRepoFile('scripts/check-skill-parity.mjs');
    expect(parityScript).toContain('{ plugin: "extend", pi: "eforge-extend" }');

    const docsGenerator = readRepoFile('packages/docs-gen/src/generators/tools.ts');
    expect(docsGenerator).toContain("{ plugin: 'extend', pi: 'eforge-extend' }");
  });

  it('documents the Pi command in the package README', () => {
    const readme = readRepoFile('packages/pi-eforge/README.md');
    expect(readme).toContain('/eforge:extend');
    expect(readme).toContain('assisted eforge TypeScript extension authoring');
  });

  it('includes the generated skill surfaces row in both tools references', () => {
    for (const relative of ['web/content/reference/tools.md', 'web/public/reference/tools.md']) {
      const source = readRepoFile(relative);
      expect(source).toContain('| `extend` | `eforge-extend` | Author eforge TypeScript extensions from a natural-language request using the existing extension tooling and docs/examples |');
    }
  });
});

describe('/eforge:extend workflow content', () => {
  const skillFiles = [
    'eforge-plugin/skills/extend/extend.md',
    'packages/pi-eforge/skills/eforge-extend/SKILL.md',
  ] as const;

  function extractPolicyGuidance(source: string): string {
    const start = source.indexOf('Runtime-supported capability families:');
    const end = source.indexOf('### Step 4: Scope selection', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end).trim();
  }

  it('documents the required authoring workflow in both skills', () => {
    const requiredTerms = [
      'docs/extensions.md',
      'docs/extensions-api.md',
      'examples/extensions/README.md',
      'examples/extensions/minimal-event-logger.ts',
      'examples/extensions/slack-webhook-notifier.ts',
      'examples/extensions/agent-context.ts',
      'examples/extensions/agent-tools.ts',
      'examples/extensions/profile-router.ts',
      'examples/extensions/protected-paths.ts',
      'onEvent',
      'onAgentRun',
      'defineExtensionTool',
      'registerTool',
      'registerProfileRouter',
      'beforeQueueDispatch',
      'beforePlanMerge',
      'beforeFinalMerge',
      'beforeEnqueue',
      'beforeValidation',
      'supported policy-gate subset',
      'Approval workflow/UI/state and `modify` policy decisions',
      'require-approval` blocks',
      'unsandboxed trusted code',
      'registerInputSource',
      'registerReviewerPerspective',
      'registerValidationProvider',
      'scope: "local"',
      'event-logger',
      'blank',
      'action: "new"',
      'action: "validate"',
      'action: "test"',
      'action: "reload"',
      'unsandboxed',
      'project/team scope requires explicit trust',
      'environment variables',
      'Extension name, scope, returned path, selected template, and capability families used',
      'Validation result, optional test result or skipped-test reason, and reload result',
    ];

    for (const relative of skillFiles) {
      const source = readRepoFile(relative);
      for (const term of requiredTerms) {
        expect(source, `${relative} should mention ${term}`).toContain(term);
      }
    }
  });

  it('keeps Claude and Pi policy-gate guidance text in sync', () => {
    const pluginSkill = readRepoFile('eforge-plugin/skills/extend/extend.md');
    const piSkill = readRepoFile('packages/pi-eforge/skills/eforge-extend/SKILL.md');

    expect(extractPolicyGuidance(pluginSkill)).toBe(extractPolicyGuidance(piSkill));
  });

  it('uses platform-appropriate eforge_extension tool names', () => {
    const pluginSkill = readRepoFile('eforge-plugin/skills/extend/extend.md');
    expect(pluginSkill).toContain('mcp__eforge__eforge_extension');

    const piSkill = readRepoFile('packages/pi-eforge/skills/eforge-extend/SKILL.md');
    expect(piSkill).toContain('eforge_extension');
    expect(piSkill).not.toContain('mcp__eforge__');
  });
});
