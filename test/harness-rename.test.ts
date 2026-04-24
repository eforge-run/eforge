/**
 * Tests for plan-03-harness-rename acceptance criteria.
 *
 * Validates that the mechanical Backend -> Harness rename is complete:
 * - Old files (backend.ts, backends/) no longer exist
 * - New files (harness.ts, harnesses/) are present with all required files
 * - Exported class/type names use Harness terminology
 * - AGENTS.md references the new paths and names
 * - StubHarness works as the test helper implementing AgentHarness
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Top-level imports using the renamed module paths
import {
  AgentTerminalError,
  PlannerSubmissionError,
  pickSdkOptions,
  isMaxTurnsError,
  isPlannerSubmissionError,
} from '@eforge-build/engine/harness';

import {
  ClaudeSDKHarness,
  resolveDisallowedTools,
  SUBAGENT_TOOL_NAME,
} from '@eforge-build/engine/harnesses/claude-sdk';

import {
  buildAgentStartEvent,
  normalizeToolUseId,
} from '@eforge-build/engine/harnesses/common';

import { StubHarness } from './stub-harness.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const ROOT = resolve(process.cwd());
const ENGINE_SRC = resolve(ROOT, 'packages/engine/src');
const TEST_DIR = resolve(ROOT, 'test');
const HARNESSES_DIR = resolve(ENGINE_SRC, 'harnesses');

// ---------------------------------------------------------------------------
// 1. Directory structure: backends/ removed, harnesses/ present
// ---------------------------------------------------------------------------

describe('directory structure: backends/ removed', () => {
  it('packages/engine/src/backends/ directory does not exist', () => {
    expect(existsSync(resolve(ENGINE_SRC, 'backends'))).toBe(false);
  });

  it('packages/engine/src/backend.ts file does not exist', () => {
    expect(existsSync(resolve(ENGINE_SRC, 'backend.ts'))).toBe(false);
  });
});

describe('directory structure: harnesses/ present with all required files', () => {
  const REQUIRED_FILES = [
    'claude-sdk.ts',
    'pi.ts',
    'common.ts',
    'eforge-resource-filter.ts',
    'pi-extensions.ts',
    'pi-mcp-bridge.ts',
    'usage.ts',
  ] as const;

  it('packages/engine/src/harnesses/ directory exists', () => {
    expect(existsSync(HARNESSES_DIR)).toBe(true);
  });

  it('packages/engine/src/harness.ts file exists', () => {
    expect(existsSync(resolve(ENGINE_SRC, 'harness.ts'))).toBe(true);
  });

  for (const file of REQUIRED_FILES) {
    it(`packages/engine/src/harnesses/${file} exists`, () => {
      expect(existsSync(resolve(HARNESSES_DIR, file))).toBe(true);
    });
  }

  it('harnesses/ contains exactly 7 TypeScript source files', () => {
    const tsFiles = readdirSync(HARNESSES_DIR).filter(f => f.endsWith('.ts'));
    expect(tsFiles).toHaveLength(REQUIRED_FILES.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Test helper rename: stub-backend.ts removed, stub-harness.ts present
// ---------------------------------------------------------------------------

describe('test helper rename: StubBackend -> StubHarness', () => {
  it('test/stub-backend.ts does not exist', () => {
    expect(existsSync(resolve(TEST_DIR, 'stub-backend.ts'))).toBe(false);
  });

  it('test/stub-harness.ts exists', () => {
    expect(existsSync(resolve(TEST_DIR, 'stub-harness.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. harness.ts module exports the renamed runtime values
// ---------------------------------------------------------------------------

describe('harness.ts exports renamed runtime values', () => {
  it('AgentTerminalError is a constructor function', () => {
    expect(typeof AgentTerminalError).toBe('function');
  });

  it('PlannerSubmissionError is a constructor function', () => {
    expect(typeof PlannerSubmissionError).toBe('function');
  });

  it('pickSdkOptions is a function', () => {
    expect(typeof pickSdkOptions).toBe('function');
  });

  it('isMaxTurnsError is a function', () => {
    expect(typeof isMaxTurnsError).toBe('function');
  });

  it('isPlannerSubmissionError is a function', () => {
    expect(typeof isPlannerSubmissionError).toBe('function');
  });

  it('AgentTerminalError carries a machine-readable subtype', () => {
    const err = new AgentTerminalError('error_max_turns', 'Max turns exceeded');
    expect(err.subtype).toBe('error_max_turns');
    expect(err.message).toBe('Max turns exceeded');
    expect(err).toBeInstanceOf(Error);
  });

  it('isMaxTurnsError returns true for error_max_turns terminal errors', () => {
    const err = new AgentTerminalError('error_max_turns', 'Max turns');
    expect(isMaxTurnsError(err)).toBe(true);
  });

  it('isMaxTurnsError returns false for non-terminal errors', () => {
    expect(isMaxTurnsError(new Error('ordinary'))).toBe(false);
  });

  it('isPlannerSubmissionError returns true for PlannerSubmissionError', () => {
    const err = new PlannerSubmissionError('No submission tool called');
    expect(isPlannerSubmissionError(err)).toBe(true);
  });

  it('pickSdkOptions strips undefined values and non-SDK keys', () => {
    const result = pickSdkOptions({ model: undefined, promptAppend: 'extra' });
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('promptAppend');
  });
});

// ---------------------------------------------------------------------------
// 4. harnesses/claude-sdk.ts exports ClaudeSDKHarness (not ClaudeSDKBackend)
// ---------------------------------------------------------------------------

describe('harnesses/claude-sdk.ts exports ClaudeSDKHarness', () => {
  it('ClaudeSDKHarness is a constructor function (class)', () => {
    expect(typeof ClaudeSDKHarness).toBe('function');
  });

  it('ClaudeSDKHarness can be instantiated without arguments', () => {
    const harness = new ClaudeSDKHarness();
    expect(harness).toBeDefined();
  });

  it('ClaudeSDKHarness instance has run() method (satisfies AgentHarness)', () => {
    const harness = new ClaudeSDKHarness();
    expect(typeof harness.run).toBe('function');
  });

  it('ClaudeSDKHarness instance has effectiveCustomToolName() method', () => {
    const harness = new ClaudeSDKHarness();
    expect(typeof harness.effectiveCustomToolName).toBe('function');
  });

  it('SUBAGENT_TOOL_NAME is a non-empty string constant', () => {
    expect(typeof SUBAGENT_TOOL_NAME).toBe('string');
    expect(SUBAGENT_TOOL_NAME.length).toBeGreaterThan(0);
  });

  it('resolveDisallowedTools is a function', () => {
    expect(typeof resolveDisallowedTools).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 5. harnesses/common.ts exports shared utilities
// ---------------------------------------------------------------------------

describe('harnesses/common.ts exports shared utilities', () => {
  it('buildAgentStartEvent is a function', () => {
    expect(typeof buildAgentStartEvent).toBe('function');
  });

  it('normalizeToolUseId is a function', () => {
    expect(typeof normalizeToolUseId).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 6. AGENTS.md references new harness terminology
// ---------------------------------------------------------------------------

describe('AGENTS.md SDK-import restriction uses harness terminology', () => {
  it('references packages/engine/src/harnesses/ (not backends/)', async () => {
    const content = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('packages/engine/src/harnesses/');
    expect(content).not.toContain('packages/engine/src/backends/');
  });

  it('references AgentHarness interface (not AgentBackend)', async () => {
    const content = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('AgentHarness');
    expect(content).not.toContain('AgentBackend');
  });

  it('references StubHarness test helper (not StubBackend)', async () => {
    const content = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('StubHarness');
    expect(content).not.toContain('StubBackend');
  });

  it('references stub-harness.ts file (not stub-backend.ts)', async () => {
    const content = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('stub-harness.ts');
    expect(content).not.toContain('stub-backend.ts');
  });

  it('references ClaudeSDKHarness (not ClaudeSDKBackend)', async () => {
    const content = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('ClaudeSDKHarness');
    expect(content).not.toContain('ClaudeSDKBackend');
  });

  it('says harness implementations (not backend implementations) in testing section', async () => {
    const content = await readFile(resolve(ROOT, 'AGENTS.md'), 'utf-8');
    expect(content).toContain("harness implementations");
    expect(content).not.toContain("backend implementations");
  });
});

// ---------------------------------------------------------------------------
// 7. harness.ts source content uses new names throughout
// ---------------------------------------------------------------------------

describe('harness.ts source content uses Harness terminology', () => {
  it('exports interface AgentHarness', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).toContain('export interface AgentHarness');
  });

  it('exports HarnessDebugPayload', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).toContain('HarnessDebugPayload');
  });

  it('exports HarnessDebugCallback', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).toContain('HarnessDebugCallback');
  });

  it('does not export AgentBackend (old interface name)', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).not.toMatch(/export\s+(interface|type)\s+AgentBackend\b/);
  });

  it('does not contain BackendDebugCallback (old type name)', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).not.toContain('BackendDebugCallback');
  });

  it('does not contain BackendDebugPayload (old type name)', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).not.toContain('BackendDebugPayload');
  });

  it('comment mentions harness abstraction (not backend abstraction)', async () => {
    const content = await readFile(resolve(ENGINE_SRC, 'harness.ts'), 'utf-8');
    expect(content).toContain('Harness abstraction for running AI agents');
  });
});

// ---------------------------------------------------------------------------
// 8. harnesses/claude-sdk.ts source uses ClaudeSDKHarness
// ---------------------------------------------------------------------------

describe('harnesses/claude-sdk.ts source uses ClaudeSDKHarness class name', () => {
  it('contains "class ClaudeSDKHarness"', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'claude-sdk.ts'), 'utf-8');
    expect(content).toContain('class ClaudeSDKHarness');
  });

  it('does not contain "class ClaudeSDKBackend"', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'claude-sdk.ts'), 'utf-8');
    expect(content).not.toContain('class ClaudeSDKBackend');
  });

  it('imports from harness.js (not backend.js)', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'claude-sdk.ts'), 'utf-8');
    expect(content).toContain("from '../harness.js'");
    expect(content).not.toContain("from '../backend.js'");
  });

  it('imports AgentHarness (not AgentBackend)', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'claude-sdk.ts'), 'utf-8');
    expect(content).toContain('AgentHarness');
    expect(content).not.toContain('AgentBackend');
  });

  it('mentions ClaudeSDKHarnessOptions (not ClaudeSDKBackendOptions)', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'claude-sdk.ts'), 'utf-8');
    expect(content).toContain('ClaudeSDKHarnessOptions');
    expect(content).not.toContain('ClaudeSDKBackendOptions');
  });
});

// ---------------------------------------------------------------------------
// 9. harnesses/pi.ts source uses PiHarness class name
// ---------------------------------------------------------------------------

describe('harnesses/pi.ts source uses PiHarness class name', () => {
  it('contains "class PiHarness"', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'pi.ts'), 'utf-8');
    expect(content).toContain('class PiHarness');
  });

  it('does not contain "class PiBackend"', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'pi.ts'), 'utf-8');
    expect(content).not.toContain('class PiBackend');
  });

  it('imports from harness.js (not backend.js)', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'pi.ts'), 'utf-8');
    expect(content).toContain("from '../harness.js'");
    expect(content).not.toContain("from '../backend.js'");
  });

  it('imports AgentHarness (not AgentBackend)', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'pi.ts'), 'utf-8');
    expect(content).toContain('AgentHarness');
    expect(content).not.toContain('AgentBackend');
  });

  it('mentions PiHarnessOptions (not PiBackendOptions)', async () => {
    const content = await readFile(resolve(HARNESSES_DIR, 'pi.ts'), 'utf-8');
    expect(content).toContain('PiHarnessOptions');
    expect(content).not.toContain('PiBackendOptions');
  });
});

// ---------------------------------------------------------------------------
// 10. StubHarness correctly implements AgentHarness
// ---------------------------------------------------------------------------

describe('StubHarness implements AgentHarness interface', () => {
  it('can be constructed with an empty responses array', () => {
    const stub = new StubHarness([]);
    expect(stub).toBeDefined();
  });

  it('has run() generator method', () => {
    const stub = new StubHarness([]);
    expect(typeof stub.run).toBe('function');
  });

  it('has effectiveCustomToolName() method', () => {
    const stub = new StubHarness([]);
    expect(typeof stub.effectiveCustomToolName).toBe('function');
  });

  it('effectiveCustomToolName returns name unchanged (Pi identity convention)', () => {
    const stub = new StubHarness([]);
    expect(stub.effectiveCustomToolName('submit_plan_set')).toBe('submit_plan_set');
    expect(stub.effectiveCustomToolName('submit_architecture')).toBe('submit_architecture');
    expect(stub.effectiveCustomToolName('any_tool')).toBe('any_tool');
  });

  it('run() yields agent:start as first event', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const gen = stub.run({ prompt: 'hello', cwd: '/tmp', maxTurns: 1, tools: 'none' }, 'builder');
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value.type).toBe('agent:start');
  });

  it('run() yields agent:stop as final event (including on error)', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const events: { type: string }[] = [];
    for await (const event of stub.run(
      { prompt: 'hello', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'builder',
    )) {
      events.push(event);
    }
    expect(events.at(-1)?.type).toBe('agent:stop');
  });

  it('run() always emits agent:result event', async () => {
    const stub = new StubHarness([{ text: 'Done.' }]);
    const events: { type: string }[] = [];
    for await (const event of stub.run(
      { prompt: 'hello', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'planner',
    )) {
      events.push(event);
    }
    expect(events.some(e => e.type === 'agent:result')).toBe(true);
  });

  it('run() records prompts in .prompts array for assertion', async () => {
    const stub = new StubHarness([{ text: 'Output.' }]);
    for await (const _ of stub.run(
      { prompt: 'test prompt content', cwd: '/tmp', maxTurns: 1, tools: 'none' },
      'reviewer',
    )) { /* drain */ }
    expect(stub.prompts).toHaveLength(1);
    expect(stub.prompts[0]).toBe('test prompt content');
  });

  it('run() records options in .calls array for assertion', async () => {
    const stub = new StubHarness([{ text: 'Out.' }]);
    const opts = { prompt: 'p', cwd: '/tmp', maxTurns: 5, tools: 'coding' as const };
    for await (const _ of stub.run(opts, 'builder')) { /* drain */ }
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toStrictEqual(opts);
  });

  it('run() consumes responses sequentially across multiple calls', async () => {
    const stub = new StubHarness([
      { text: 'First response.' },
      { text: 'Second response.' },
    ]);
    const opts = { prompt: 'p', cwd: '/tmp', maxTurns: 1, tools: 'none' as const };
    for await (const _ of stub.run(opts, 'builder')) { /* drain */ }
    for await (const _ of stub.run(opts, 'builder')) { /* drain */ }
    expect(stub.prompts).toHaveLength(2);
  });

  it('run() re-throws scripted errors', async () => {
    const stub = new StubHarness([{ error: new Error('Scripted failure') }]);
    await expect(async () => {
      for await (const _ of stub.run(
        { prompt: 'p', cwd: '/tmp', maxTurns: 1, tools: 'none' },
        'builder',
      )) { /* drain */ }
    }).rejects.toThrow('Scripted failure');
  });

  it('run() emits agent:stop even when an error is thrown', async () => {
    const stub = new StubHarness([{ error: new Error('Crash') }]);
    const events: { type: string }[] = [];
    try {
      for await (const event of stub.run(
        { prompt: 'p', cwd: '/tmp', maxTurns: 1, tools: 'none' },
        'builder',
      )) {
        events.push(event);
      }
    } catch { /* expected */ }
    expect(events.at(-1)?.type).toBe('agent:stop');
  });

  it('run() emits agent:tool_use and agent:tool_result for scripted tool calls', async () => {
    const stub = new StubHarness([{
      toolCalls: [{
        tool: 'Read',
        toolUseId: 'tu-123',
        input: { path: '/tmp/foo.ts' },
        output: 'file contents',
      }],
    }]);
    const events: { type: string }[] = [];
    for await (const event of stub.run(
      { prompt: 'p', cwd: '/tmp', maxTurns: 1, tools: 'coding' },
      'builder',
    )) {
      events.push(event);
    }
    expect(events.some(e => e.type === 'agent:tool_use')).toBe(true);
    expect(events.some(e => e.type === 'agent:tool_result')).toBe(true);
  });
});
