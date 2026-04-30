/**
 * Wiring tests for plan-03-skills-docs.
 *
 * Plan-03 is documentation/content-only: skill file updates (scope column,
 * Step 0 scope prompt, precedence docs), docs/config.md backend profiles
 * section, init skill one-liners, and a plugin version bump. These tests
 * verify file content statically - no runtime behavior to test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to the repo root (one dir up from `test/`).
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readRepoFile(relative: string): string {
  return readFileSync(resolve(REPO_ROOT, relative), 'utf-8');
}

// ---------------------------------------------------------------------------
// Plugin profile skill - scope column and precedence docs
// ---------------------------------------------------------------------------

describe('eforge-plugin/skills/profile/profile.md - user-scope updates', () => {
  const raw = readRepoFile('eforge-plugin/skills/profile/profile.md');

  it('contains "Scope" in the list output table header', () => {
    // The table header should include a Scope column
    expect(raw).toMatch(/\|\s*Name\s*\|\s*Scope\s*\|\s*Harness\s*\|\s*Active\s*\|/);
  });

  it('shows project and user scope values in the example table', () => {
    expect(raw).toContain('`project`');
    expect(raw).toContain('`user`');
  });

  it('documents user (shadowed) in the Scope column', () => {
    expect(raw).toContain('user (shadowed)');
  });

  it('documents all 6 precedence steps', () => {
    expect(raw).toContain('## Active Profile Precedence');
    expect(raw).toMatch(/1\.\s+\*\*Project-local marker\*\*/);
    expect(raw).toMatch(/2\.\s+\*\*Project marker\*\*/);
    expect(raw).toMatch(/3\.\s+\*\*Project config\*\*/);
    expect(raw).toMatch(/4\.\s+\*\*User marker\*\*/);
    expect(raw).toMatch(/5\.\s+\*\*User config\*\*/);
    expect(raw).toMatch(/6\.\s+\*\*None\*\*/);
  });

  it('documents the scope parameter section', () => {
    expect(raw).toContain('## Scope Parameter');
    expect(raw).toContain('"project"');
    expect(raw).toContain('"user"');
    expect(raw).toContain('"all"');
    expect(raw).toContain('default `"all"`');
    expect(raw).toContain('default `"project"`');
  });

  it('mentions user-scope paths', () => {
    expect(raw).toContain('~/.config/eforge/profiles/');
    expect(raw).toContain('~/.config/eforge/.active-profile');
  });

  it('notes scope parameter availability on list, use, create, delete', () => {
    const scopeSection = raw.slice(raw.indexOf('## Scope Parameter'));
    expect(scopeSection).toContain('list');
    expect(scopeSection).toContain('use');
    expect(scopeSection).toContain('create');
    expect(scopeSection).toContain('delete');
  });
});

// ---------------------------------------------------------------------------
// Plugin profile-new skill - Step 0 scope prompt
// ---------------------------------------------------------------------------

describe('eforge-plugin/skills/profile-new/profile-new.md - user-scope updates', () => {
  const raw = readRepoFile('eforge-plugin/skills/profile-new/profile-new.md');

  it('contains Step 0 scope prompt before Step 1', () => {
    const step0Idx = raw.indexOf('Step 0');
    const step1Idx = raw.indexOf('Step 1');
    expect(step0Idx).toBeGreaterThan(-1);
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step0Idx).toBeLessThan(step1Idx);
  });

  it('Step 0 asks about scope with both project and user options', () => {
    const step0Start = raw.indexOf('Step 0');
    const step1Start = raw.indexOf('Step 1');
    const step0Content = raw.slice(step0Start, step1Start);
    expect(step0Content).toContain('Project scope');
    expect(step0Content).toContain('User scope');
    expect(step0Content).toContain('eforge/profiles/');
    expect(step0Content).toContain('~/.config/eforge/profiles/');
  });

  it('passes scope to create action in Step 7', () => {
    expect(raw).toMatch(/scope:\s*["']<local\|project\|user>["']/);
  });

  it('passes scope to use action in Step 8', () => {
    const step8Start = raw.indexOf('Step 8');
    expect(step8Start).toBeGreaterThan(-1);
    const step8Content = raw.slice(step8Start);
    expect(step8Content).toContain('scope');
  });

  it('mentions user scope in the file path description', () => {
    expect(raw).toContain('user: `~/.config/eforge/profiles/<name>.yaml`');
  });
});

// ---------------------------------------------------------------------------
// Pi profile skill - mirrors plugin profile changes
// ---------------------------------------------------------------------------

describe('packages/pi-eforge/skills/eforge-profile/SKILL.md - user-scope updates', () => {
  const raw = readRepoFile('packages/pi-eforge/skills/eforge-profile/SKILL.md');

  it('contains "Scope" in the list output table header', () => {
    expect(raw).toMatch(/\|\s*Name\s*\|\s*Scope\s*\|\s*Harness\s*\|\s*Active\s*\|/);
  });

  it('documents user (shadowed) in the Scope column', () => {
    expect(raw).toContain('user (shadowed)');
  });

  it('documents all 6 precedence steps', () => {
    expect(raw).toContain('## Active Profile Precedence');
    expect(raw).toMatch(/1\.\s+\*\*Project-local marker\*\*/);
    expect(raw).toMatch(/2\.\s+\*\*Project marker\*\*/);
    expect(raw).toMatch(/3\.\s+\*\*Project config\*\*/);
    expect(raw).toMatch(/4\.\s+\*\*User marker\*\*/);
    expect(raw).toMatch(/5\.\s+\*\*User config\*\*/);
    expect(raw).toMatch(/6\.\s+\*\*None\*\*/);
  });

  it('documents the scope parameter section', () => {
    expect(raw).toContain('## Scope Parameter');
    expect(raw).toContain('"project"');
    expect(raw).toContain('"user"');
    expect(raw).toContain('"all"');
    expect(raw).toContain('default `"all"`');
    expect(raw).toContain('default `"project"`');
  });

  it('uses bare tool names (no mcp__eforge__ prefix) - Pi convention', () => {
    expect(raw).not.toContain('mcp__eforge__');
  });

  it('mentions user-scope paths', () => {
    expect(raw).toContain('~/.config/eforge/profiles/');
    expect(raw).toContain('~/.config/eforge/.active-profile');
  });
});

// ---------------------------------------------------------------------------
// Pi profile-new skill - mirrors plugin profile-new changes
// ---------------------------------------------------------------------------

describe('packages/pi-eforge/skills/eforge-profile-new/SKILL.md - user-scope updates', () => {
  const raw = readRepoFile('packages/pi-eforge/skills/eforge-profile-new/SKILL.md');

  it('contains Step 0 scope prompt before Step 1', () => {
    const step0Idx = raw.indexOf('Step 0');
    const step1Idx = raw.indexOf('Step 1');
    expect(step0Idx).toBeGreaterThan(-1);
    expect(step1Idx).toBeGreaterThan(-1);
    expect(step0Idx).toBeLessThan(step1Idx);
  });

  it('Step 0 asks about scope with both project and user options', () => {
    const step0Start = raw.indexOf('Step 0');
    const step1Start = raw.indexOf('Step 1');
    const step0Content = raw.slice(step0Start, step1Start);
    expect(step0Content).toContain('Project scope');
    expect(step0Content).toContain('User scope');
    expect(step0Content).toContain('~/.config/eforge/profiles/');
  });

  it('passes scope to create action in Step 7', () => {
    expect(raw).toMatch(/scope:\s*["']<local\|project\|user>["']/);
  });

  it('uses bare tool names (no mcp__eforge__ prefix) - Pi convention', () => {
    expect(raw).not.toContain('mcp__eforge__');
  });
});

// ---------------------------------------------------------------------------
// Plugin init skill - user-scope one-liner
// ---------------------------------------------------------------------------

describe('eforge-plugin/skills/init/init.md - user-scope one-liner', () => {
  const raw = readRepoFile('eforge-plugin/skills/init/init.md');

  it('mentions ~/.config/eforge/profiles/ for user-scope profiles', () => {
    expect(raw).toContain('~/.config/eforge/profiles/');
  });

  it('mentions scope in the context of /eforge:profile-new', () => {
    expect(raw).toContain('/eforge:profile-new');
    expect(raw).toMatch(/scope/i);
  });
});

// ---------------------------------------------------------------------------
// Pi init skill - mirrors plugin init one-liner
// ---------------------------------------------------------------------------

describe('packages/pi-eforge/skills/eforge-init/SKILL.md - user-scope one-liner', () => {
  const raw = readRepoFile('packages/pi-eforge/skills/eforge-init/SKILL.md');

  it('mentions ~/.config/eforge/profiles/ for user-scope profiles', () => {
    expect(raw).toContain('~/.config/eforge/profiles/');
  });

  it('mentions scope in the context of /eforge:profile-new', () => {
    expect(raw).toContain('/eforge:profile-new');
    expect(raw).toMatch(/scope/i);
  });
});

// ---------------------------------------------------------------------------
// docs/config.md - Backend Profiles section with User-Scoped Profiles
// ---------------------------------------------------------------------------

describe('docs/config.md - Backend Profiles section', () => {
  const raw = readRepoFile('docs/config.md');

  it('contains a ## Backend Profiles section', () => {
    expect(raw).toContain('## Backend Profiles');
  });

  it('contains a ### User-Scoped Profiles subsection', () => {
    expect(raw).toContain('### User-Scoped Profiles');
  });

  it('documents user-scope profile path', () => {
    expect(raw).toContain('~/.config/eforge/backends/');
  });

  it('documents user-scope active-backend marker', () => {
    expect(raw).toContain('~/.config/eforge/.active-backend');
  });

  it('documents the 6-step precedence chain', () => {
    // Find the Backend Profiles section
    const sectionStart = raw.indexOf('## Backend Profiles');
    expect(sectionStart).toBeGreaterThan(-1);
    // Find the next ## section to bound the search
    const nextSection = raw.indexOf('\n## ', sectionStart + 1);
    const section = raw.slice(sectionStart, nextSection > -1 ? nextSection : undefined);

    expect(section).toMatch(/1\.\s+\*\*Project-local marker\*\*/);
    expect(section).toMatch(/2\.\s+\*\*Project marker\*\*/);
    expect(section).toMatch(/3\.\s+\*\*Project config\*\*/);
    expect(section).toMatch(/4\.\s+\*\*User marker\*\*/);
    expect(section).toMatch(/5\.\s+\*\*User config\*\*/);
    expect(section).toMatch(/6\.\s+\*\*None\*\*/);
  });

  it('documents the scope parameter for create, use, delete', () => {
    const sectionStart = raw.indexOf('## Backend Profiles');
    const nextSection = raw.indexOf('\n## ', sectionStart + 1);
    const section = raw.slice(sectionStart, nextSection > -1 ? nextSection : undefined);

    expect(section).toContain('scope: "project"');
    expect(section).toContain('scope: "user"');
  });

  it('documents that project profiles shadow user profiles', () => {
    const sectionStart = raw.indexOf('## Backend Profiles');
    const nextSection = raw.indexOf('\n## ', sectionStart + 1);
    const section = raw.slice(sectionStart, nextSection > -1 ? nextSection : undefined);

    expect(section).toMatch(/shadow/i);
  });

  it('mentions shadowedBy: project annotation', () => {
    expect(raw).toContain('shadowedBy: project');
  });
});

// ---------------------------------------------------------------------------
// Parity checks: plugin <-> Pi skills should contain matching content
// ---------------------------------------------------------------------------

describe('plugin <-> Pi skill parity for user-scope updates', () => {
  const pluginBackend = readRepoFile('eforge-plugin/skills/profile/profile.md');
  const piBackend = readRepoFile('packages/pi-eforge/skills/eforge-profile/SKILL.md');
  const pluginBackendNew = readRepoFile('eforge-plugin/skills/profile-new/profile-new.md');
  const piBackendNew = readRepoFile('packages/pi-eforge/skills/eforge-profile-new/SKILL.md');
  const pluginInit = readRepoFile('eforge-plugin/skills/init/init.md');
  const piInit = readRepoFile('packages/pi-eforge/skills/eforge-init/SKILL.md');

  it('both profile skills have the same 6-step precedence list', () => {
    // Both should document all 6 steps
    for (const raw of [pluginBackend, piBackend]) {
      expect(raw).toMatch(/1\.\s+\*\*Project-local marker\*\*/);
      expect(raw).toMatch(/2\.\s+\*\*Project marker\*\*/);
      expect(raw).toMatch(/6\.\s+\*\*None\*\*/);
    }
  });

  it('both profile skills have the Scope column in the table', () => {
    for (const raw of [pluginBackend, piBackend]) {
      expect(raw).toMatch(/\|\s*Scope\s*\|/);
    }
  });

  it('both profile-new skills have Step 0 scope prompt', () => {
    for (const raw of [pluginBackendNew, piBackendNew]) {
      expect(raw).toContain('Step 0');
      expect(raw).toContain('~/.config/eforge/profiles/');
    }
  });

  it('both init skills mention ~/.config/eforge/profiles/', () => {
    for (const raw of [pluginInit, piInit]) {
      expect(raw).toContain('~/.config/eforge/profiles/');
    }
  });
});

// ---------------------------------------------------------------------------
// Enum drift: piThinkingLevel and effortLevel values in consumer-facing docs
// ---------------------------------------------------------------------------

describe('enum drift - piThinkingLevel and effortLevel values', () => {
  const piBackendNew = readRepoFile('packages/pi-eforge/skills/eforge-profile-new/SKILL.md');
  const pluginBackendNew = readRepoFile('eforge-plugin/skills/profile-new/profile-new.md');
  const piConfig = readRepoFile('packages/pi-eforge/skills/eforge-config/SKILL.md');
  const pluginConfig = readRepoFile('eforge-plugin/skills/config/config.md');
  const docsConfig = readRepoFile('docs/config.md');

  it('Pi backend-new skill contains xhigh for both thinkingLevel and effort', () => {
    // thinkingLevel line should contain xhigh
    expect(piBackendNew).toMatch(/thinkingLevel.*xhigh/i);
    // effort line should contain xhigh
    expect(piBackendNew).toMatch(/effort.*xhigh/i);
  });

  it('Plugin backend-new skill contains xhigh for both thinkingLevel and effort', () => {
    expect(pluginBackendNew).toMatch(/thinkingLevel.*xhigh/i);
    expect(pluginBackendNew).toMatch(/effort.*xhigh/i);
  });

  it('Pi config skill contains xhigh for both effort and thinkingLevel', () => {
    expect(piConfig).toMatch(/effort.*xhigh/i);
    expect(piConfig).toMatch(/thinkingLevel.*xhigh/i);
  });

  it('Plugin config skill contains xhigh for both effort and thinkingLevel', () => {
    expect(pluginConfig).toMatch(/effort.*xhigh/i);
    expect(pluginConfig).toMatch(/thinkingLevel.*xhigh/i);
  });

  it('docs/config.md contains xhigh for both thinkingLevel and effort', () => {
    expect(docsConfig).toMatch(/effort.*xhigh/i);
    expect(docsConfig).toMatch(/thinkingLevel.*xhigh/i);
  });

  it('Pi and plugin backend-new skills contain low as a thinkingLevel option', () => {
    // Both should list 'low' in the thinkingLevel line
    expect(piBackendNew).toMatch(/thinkingLevel.*`low`/);
    expect(pluginBackendNew).toMatch(/thinkingLevel.*`low`/);
  });

  // --- Occurrence count assertions (catch partial fixes) ---

  it('Pi config skill contains xhigh at least 3 times (body + YAML comments for effort and thinkingLevel)', () => {
    const matches = piConfig.match(/xhigh/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it('Plugin config skill contains xhigh at least 3 times (body + YAML comments for effort and thinkingLevel)', () => {
    const matches = pluginConfig.match(/xhigh/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });

  it('docs/config.md contains xhigh at least 2 times (effort + thinkingLevel)', () => {
    const matches = docsConfig.match(/xhigh/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('Pi and plugin config skills contain low as a thinkingLevel option', () => {
    // thinkingLevel line in body text and/or YAML comment should include 'low'
    expect(piConfig).toMatch(/thinkingLevel.*low/);
    expect(pluginConfig).toMatch(/thinkingLevel.*low/);
  });

  it('docs/config.md contains low as a thinkingLevel option', () => {
    expect(docsConfig).toMatch(/thinkingLevel.*low/);
  });

  // --- Complete enum sequence validation (backend-new skills) ---

  it('Pi backend-new skill lists the full thinkingLevel enum: off | low | medium | high | xhigh', () => {
    expect(piBackendNew).toMatch(/off.*low.*medium.*high.*xhigh/);
  });

  it('Pi backend-new skill lists the full effort enum: low | medium | high | xhigh | max', () => {
    expect(piBackendNew).toMatch(/low.*medium.*high.*xhigh.*max/);
  });

  it('Plugin backend-new skill lists the full thinkingLevel enum: off | low | medium | high | xhigh', () => {
    expect(pluginBackendNew).toMatch(/off.*low.*medium.*high.*xhigh/);
  });

  it('Plugin backend-new skill lists the full effort enum: low | medium | high | xhigh | max', () => {
    expect(pluginBackendNew).toMatch(/low.*medium.*high.*xhigh.*max/);
  });
});
