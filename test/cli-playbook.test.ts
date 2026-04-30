/**
 * CLI argument-parsing tests for `eforge playbook` subcommands and `eforge play` alias.
 *
 * Tests verify that each subcommand dispatches to the correct daemon API helper
 * with the expected arguments. No live daemon is required — all client helpers
 * are mocked at the import boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Module-level mock variables (hoisted via vi.fn() for reassignment)
// ---------------------------------------------------------------------------

const mockApiPlaybookList = vi.fn();
const mockApiPlaybookShow = vi.fn();
const mockApiPlaybookSave = vi.fn();
const mockApiPlaybookEnqueue = vi.fn();
const mockApiPlaybookPromote = vi.fn();
const mockApiPlaybookDemote = vi.fn();
const mockApiPlaybookValidate = vi.fn();
const mockExecFileSync = vi.fn();
const mockSpawnSync = vi.fn();
const mockWriteFile = vi.fn();
const mockReadFile = vi.fn();
const mockUnlink = vi.fn();

// Wrap raw mock return values in the { data, port } envelope that daemonRequest returns
function wrap<T>(value: T): Promise<{ data: T; port: number }> {
  return Promise.resolve({ data: value, port: 4567 });
}

vi.mock('@eforge-build/client', () => ({
  apiPlaybookList: (...args: unknown[]) => mockApiPlaybookList(...args),
  apiPlaybookShow: (...args: unknown[]) => mockApiPlaybookShow(...args),
  apiPlaybookSave: (...args: unknown[]) => mockApiPlaybookSave(...args),
  apiPlaybookEnqueue: (...args: unknown[]) => mockApiPlaybookEnqueue(...args),
  apiPlaybookPromote: (...args: unknown[]) => mockApiPlaybookPromote(...args),
  apiPlaybookDemote: (...args: unknown[]) => mockApiPlaybookDemote(...args),
  apiPlaybookValidate: (...args: unknown[]) => mockApiPlaybookValidate(...args),
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

vi.mock('yaml', () => ({
  parse: (input: string) => {
    // Minimal YAML parser for frontmatter in tests
    const result: Record<string, string> = {};
    for (const line of input.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { registerPlaybookCommand } from '../packages/eforge/src/cli/playbook.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a fresh Commander instance with exitOverride (no real process.exit). */
function makeProgram(): Command {
  const program = new Command().exitOverride();
  registerPlaybookCommand(program);
  return program;
}

const CWD = process.cwd();

// ---------------------------------------------------------------------------
// Global process.exit spy
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit(${code ?? 0})`);
  });
});

afterEach(() => {
  exitSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// eforge playbook list
// ---------------------------------------------------------------------------

describe('eforge playbook list', () => {
  it('calls apiPlaybookList with cwd', async () => {
    mockApiPlaybookList.mockImplementation(() => wrap({ playbooks: [], warnings: [] }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'list']);

    expect(mockApiPlaybookList).toHaveBeenCalledOnce();
    expect(mockApiPlaybookList).toHaveBeenCalledWith({ cwd: CWD });
  });

  it('calls apiPlaybookList and renders playbooks (non-empty)', async () => {
    mockApiPlaybookList.mockImplementation(() => wrap({
      playbooks: [
        { name: 'docs-sync', description: 'Sync docs', source: 'project-team', shadows: [], path: '/eforge/playbooks/docs-sync.md' },
      ],
      warnings: [],
    }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'list']);

    expect(mockApiPlaybookList).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// eforge playbook new
// ---------------------------------------------------------------------------

describe('eforge playbook new', () => {
  it('calls apiPlaybookSave with required fields', async () => {
    mockApiPlaybookSave.mockImplementation(() => wrap({ path: '/eforge/playbooks/my-feature.md' }));

    const program = makeProgram();
    await program.parseAsync([
      'node', 'eforge', 'playbook', 'new',
      '--scope', 'project-team',
      '--name', 'my-feature',
      '--description', 'Add my-feature capability',
    ]);

    expect(mockApiPlaybookSave).toHaveBeenCalledOnce();
    expect(mockApiPlaybookSave).toHaveBeenCalledWith(expect.objectContaining({
      cwd: CWD,
      body: expect.objectContaining({
        scope: 'project-team',
        playbook: expect.objectContaining({
          frontmatter: expect.objectContaining({
            name: 'my-feature',
            description: 'Add my-feature capability',
            scope: 'project-team',
          }),
        }),
      }),
    }));
  });

  it('reads body from --from file when provided', async () => {
    mockReadFile.mockResolvedValue('Do the thing.\n');
    mockApiPlaybookSave.mockImplementation(() => wrap({ path: '/eforge/playbooks/my-feature.md' }));

    const program = makeProgram();
    await program.parseAsync([
      'node', 'eforge', 'playbook', 'new',
      '--scope', 'project-local',
      '--name', 'my-feature',
      '--from', '/tmp/goal.md',
    ]);

    expect(mockReadFile).toHaveBeenCalledWith('/tmp/goal.md', 'utf-8');
    expect(mockApiPlaybookSave).toHaveBeenCalledOnce();
    expect(mockApiPlaybookSave).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        playbook: expect.objectContaining({
          body: expect.objectContaining({ goal: 'Do the thing.\n' }),
        }),
      }),
    }));
  });

  it('exits 1 for invalid scope', async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync([
        'node', 'eforge', 'playbook', 'new',
        '--scope', 'invalid-scope',
        '--name', 'my-feature',
      ]),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockApiPlaybookSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// eforge playbook edit
// ---------------------------------------------------------------------------

describe('eforge playbook edit', () => {
  it('exits 1 with guidance when $EDITOR is not set', async () => {
    const origEditor = process.env['EDITOR'];
    delete process.env['EDITOR'];

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'eforge', 'playbook', 'edit', 'my-pb']),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockApiPlaybookShow).not.toHaveBeenCalled();

    if (origEditor !== undefined) process.env['EDITOR'] = origEditor;
  });

  it('validates edited content and saves to the same tier', async () => {
    const origEditor = process.env['EDITOR'];
    process.env['EDITOR'] = 'vim';

    const playbookData = {
      name: 'my-pb',
      description: 'A playbook',
      scope: 'project-local',
      goal: 'Do thing.',
      outOfScope: '',
      acceptanceCriteria: '',
      plannerNotes: '',
    };

    mockApiPlaybookShow.mockImplementation(() => wrap({
      playbook: playbookData,
      source: 'project-local',
      shadows: [],
    }));
    mockWriteFile.mockResolvedValue(undefined);
    mockSpawnSync.mockReturnValue({ status: 0 });
    mockReadFile.mockResolvedValue(
      '---\nname: my-pb\ndescription: A playbook\nscope: project-local\n---\n\n## Goal\n\nDo thing.\n',
    );
    mockUnlink.mockResolvedValue(undefined);
    mockApiPlaybookValidate.mockImplementation(() => wrap({ ok: true }));
    mockApiPlaybookSave.mockImplementation(() => wrap({ path: '/.eforge/playbooks/my-pb.md' }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'edit', 'my-pb']);

    expect(mockApiPlaybookShow).toHaveBeenCalledWith({ cwd: CWD, name: 'my-pb' });
    expect(mockSpawnSync).toHaveBeenCalledWith('vim', expect.any(Array), { stdio: 'inherit' });
    expect(mockApiPlaybookValidate).toHaveBeenCalledOnce();
    expect(mockApiPlaybookSave).toHaveBeenCalledOnce();
    expect(mockApiPlaybookSave).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ scope: 'project-local' }),
    }));

    if (origEditor !== undefined) process.env['EDITOR'] = origEditor;
    else delete process.env['EDITOR'];
  });

  it('exits 1 and does not save when validation fails', async () => {
    const origEditor = process.env['EDITOR'];
    process.env['EDITOR'] = 'vim';

    mockApiPlaybookShow.mockImplementation(() => wrap({
      playbook: { name: 'my-pb', description: 'A pb', scope: 'project-team', goal: 'Do.', outOfScope: '', acceptanceCriteria: '', plannerNotes: '' },
      source: 'project-team',
      shadows: [],
    }));
    mockWriteFile.mockResolvedValue(undefined);
    mockSpawnSync.mockReturnValue({ status: 0 });
    mockReadFile.mockResolvedValue('---\nname: INVALID NAME\nscope: bad\n---\n## Goal\n\nDo.\n');
    mockUnlink.mockResolvedValue(undefined);
    mockApiPlaybookValidate.mockImplementation(() => wrap({ ok: false, errors: ['name must be kebab-case'] }));

    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'eforge', 'playbook', 'edit', 'my-pb']),
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockApiPlaybookSave).not.toHaveBeenCalled();

    if (origEditor !== undefined) process.env['EDITOR'] = origEditor;
    else delete process.env['EDITOR'];
  });
});

// ---------------------------------------------------------------------------
// eforge playbook run
// ---------------------------------------------------------------------------

describe('eforge playbook run', () => {
  it('calls apiPlaybookEnqueue with name only', async () => {
    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-123' }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'run', 'docs-sync']);

    expect(mockApiPlaybookEnqueue).toHaveBeenCalledOnce();
    expect(mockApiPlaybookEnqueue).toHaveBeenCalledWith({ cwd: CWD, body: { name: 'docs-sync' } });
  });

  it('passes afterQueueId when --after is provided', async () => {
    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-456' }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'run', 'docs-sync', '--after', 'q-abc']);

    expect(mockApiPlaybookEnqueue).toHaveBeenCalledWith({
      cwd: CWD,
      body: { name: 'docs-sync', afterQueueId: 'q-abc' },
    });
  });

  it('prints the returned queue id', async () => {
    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-xyz' }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'run', 'my-pb']);

    expect(logSpy).toHaveBeenCalledWith('q-xyz');
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// eforge play (alias for eforge playbook run)
// ---------------------------------------------------------------------------

describe('eforge play', () => {
  it('calls apiPlaybookEnqueue — same observable result as playbook run', async () => {
    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-alias' }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'play', 'docs-sync']);

    expect(mockApiPlaybookEnqueue).toHaveBeenCalledOnce();
    expect(mockApiPlaybookEnqueue).toHaveBeenCalledWith({ cwd: CWD, body: { name: 'docs-sync' } });
  });

  it('passes afterQueueId via --after flag', async () => {
    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-alias-after' }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'play', 'docs-sync', '--after', 'q-abc']);

    expect(mockApiPlaybookEnqueue).toHaveBeenCalledWith({
      cwd: CWD,
      body: { name: 'docs-sync', afterQueueId: 'q-abc' },
    });
  });

  it('produces the same call as playbook run for identical args', async () => {
    const playExpected = { cwd: CWD, body: { name: 'tech-debt-sweep', afterQueueId: 'q-prev' } };

    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-1' }));
    const prog1 = makeProgram();
    await prog1.parseAsync(['node', 'eforge', 'playbook', 'run', 'tech-debt-sweep', '--after', 'q-prev']);
    const call1 = mockApiPlaybookEnqueue.mock.calls[0];

    vi.clearAllMocks();
    exitSpy.mockRestore();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code ?? 0})`);
    });

    mockApiPlaybookEnqueue.mockImplementation(() => wrap({ id: 'q-2' }));
    const prog2 = makeProgram();
    await prog2.parseAsync(['node', 'eforge', 'play', 'tech-debt-sweep', '--after', 'q-prev']);
    const call2 = mockApiPlaybookEnqueue.mock.calls[0];

    expect(call1).toEqual([playExpected]);
    expect(call2).toEqual([playExpected]);
  });
});

// ---------------------------------------------------------------------------
// eforge playbook promote
// ---------------------------------------------------------------------------

describe('eforge playbook promote', () => {
  it('calls apiPlaybookPromote and stages the new path with git add', async () => {
    mockApiPlaybookPromote.mockImplementation(() => wrap({ path: '/project/eforge/playbooks/tech-debt-sweep.md' }));
    mockExecFileSync.mockReturnValue(undefined);

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'promote', 'tech-debt-sweep']);

    expect(mockApiPlaybookPromote).toHaveBeenCalledOnce();
    expect(mockApiPlaybookPromote).toHaveBeenCalledWith({ cwd: CWD, body: { name: 'tech-debt-sweep' } });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['add', '/project/eforge/playbooks/tech-debt-sweep.md'],
      { cwd: CWD },
    );
  });

  it('continues if git add fails (non-fatal)', async () => {
    mockApiPlaybookPromote.mockImplementation(() => wrap({ path: '/eforge/playbooks/my-pb.md' }));
    mockExecFileSync.mockImplementation(() => { throw new Error('git not found'); });

    const program = makeProgram();
    // Should NOT throw — git failure is non-fatal
    await expect(
      program.parseAsync(['node', 'eforge', 'playbook', 'promote', 'my-pb']),
    ).resolves.not.toThrow();

    expect(mockApiPlaybookPromote).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// eforge playbook demote
// ---------------------------------------------------------------------------

describe('eforge playbook demote', () => {
  it('calls apiPlaybookDemote and does not stage (non-git file)', async () => {
    mockApiPlaybookDemote.mockImplementation(() => wrap({ path: '/project/.eforge/playbooks/my-pb.md' }));

    const program = makeProgram();
    await program.parseAsync(['node', 'eforge', 'playbook', 'demote', 'my-pb']);

    expect(mockApiPlaybookDemote).toHaveBeenCalledOnce();
    expect(mockApiPlaybookDemote).toHaveBeenCalledWith({ cwd: CWD, body: { name: 'my-pb' } });

    // demote must NOT call git add
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});
