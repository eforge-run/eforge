import type { AgentBackend, SdkPassthroughConfig } from '../backend.js';
import { pickSdkOptions } from '../backend.js';
import { isAlwaysYieldedAgentEvent, type EforgeEvent, type TestIssue } from '../events.js';
import { loadPrompt } from '../prompts.js';
import { getTestIssueSchemaYaml } from '../schemas.js';
import { parseTestIssues } from './common.js';

export interface TestWriterOptions extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  planId: string;
  planContent: string;
  implementationContext?: string;
  verbose?: boolean;
  abortController?: AbortController;
  maxTurns?: number;
}

/**
 * Parse `<test-write-summary count="N">` from agent output.
 * Returns the count of tests written, or 0 if no summary block is found.
 */
function parseTestWriteSummary(text: string): number {
  const match = text.match(/<test-write-summary\s+count="(\d+)">/);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

/**
 * Parse `<test-summary passed="N" failed="N" test_bugs_fixed="N">` from agent output.
 * Returns parsed counts, or zeros if no summary block is found.
 */
function parseTestSummary(text: string): { passed: number; failed: number; testBugsFixed: number } {
  const match = text.match(/<test-summary\s+([^>]*)>/);
  if (!match) return { passed: 0, failed: 0, testBugsFixed: 0 };

  const attrs = match[1];
  const passedMatch = attrs.match(/passed="(\d+)"/);
  const failedMatch = attrs.match(/failed="(\d+)"/);
  const fixedMatch = attrs.match(/test_bugs_fixed="(\d+)"/);

  return {
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    testBugsFixed: fixedMatch ? parseInt(fixedMatch[1], 10) : 0,
  };
}

/**
 * Test-writer agent — writes tests for a plan's acceptance criteria.
 * One-shot coding agent that discovers test infra and writes tests.
 * Non-fatal: errors are caught (except AbortError), complete event always yielded.
 */
export async function* runTestWriter(
  options: TestWriterOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'build:test:write:start', planId: options.planId };

  let testsWritten = 0;

  try {
    const vars: Record<string, string> = {
      plan_id: options.planId,
      plan_content: options.planContent,
      implementation_context: options.implementationContext ?? '',
    };

    const prompt = await loadPrompt('test-writer', vars, options.promptAppend);

    let fullText = '';

    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: options.maxTurns ?? 30,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
        ...pickSdkOptions(options),
      },
      'test-writer',
      options.planId,
    )) {
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }

      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }

    testsWritten = parseTestWriteSummary(fullText);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other test-writer failures are non-fatal
  }

  yield { timestamp: new Date().toISOString(), type: 'build:test:write:complete', planId: options.planId, testsWritten };
}

export interface TesterOptions extends SdkPassthroughConfig {
  backend: AgentBackend;
  cwd: string;
  planId: string;
  planContent: string;
  verbose?: boolean;
  abortController?: AbortController;
  maxTurns?: number;
}

/**
 * Tester agent — runs tests, classifies failures, fixes test bugs, reports production bugs.
 * One-shot coding agent that runs the test suite and triages results.
 * Non-fatal: errors are caught (except AbortError), complete event always yielded.
 */
export async function* runTester(
  options: TesterOptions,
): AsyncGenerator<EforgeEvent> {
  yield { timestamp: new Date().toISOString(), type: 'build:test:start', planId: options.planId };

  let passed = 0;
  let failed = 0;
  let testBugsFixed = 0;
  let productionIssues: TestIssue[] = [];

  try {
    const prompt = await loadPrompt('tester', {
      plan_id: options.planId,
      plan_content: options.planContent,
      test_issue_schema: getTestIssueSchemaYaml(),
    }, options.promptAppend);

    let fullText = '';

    for await (const event of options.backend.run(
      {
        prompt,
        cwd: options.cwd,
        maxTurns: options.maxTurns ?? 40,
        tools: 'coding',
        abortSignal: options.abortController?.signal,
        ...pickSdkOptions(options),
      },
      'tester',
      options.planId,
    )) {
      if (event.type === 'agent:message' && event.content) {
        fullText += event.content;
      }

      if (isAlwaysYieldedAgentEvent(event) || options.verbose) {
        yield event;
      }
    }

    productionIssues = parseTestIssues(fullText);
    const summary = parseTestSummary(fullText);
    passed = summary.passed;
    failed = summary.failed;
    testBugsFixed = summary.testBugsFixed;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Other tester failures are non-fatal
  }

  yield { timestamp: new Date().toISOString(), type: 'build:test:complete', planId: options.planId, passed, failed, testBugsFixed, productionIssues };
}
