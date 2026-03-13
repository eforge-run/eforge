import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKToolUseSummaryMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { SCOPE_ASSESSMENTS } from '../events.js';
import type { ForgeEvent, AgentRole, AgentResultData, ClarificationQuestion, ScopeAssessment, ExpeditionModule } from '../events.js';

/**
 * Map an async iterable of SDK messages to ForgeEvents.
 * Bridges the SDK's message stream to the engine's typed event system.
 * Yields an `agent:result` event with usage/cost/model data when the SDK query completes.
 */
export async function* mapSDKMessages(
  messages: AsyncIterable<SDKMessage>,
  agent: AgentRole,
  planId?: string,
): AsyncGenerator<ForgeEvent> {
  // Track toolUseId → toolName for resolving tool results
  const toolNameMap = new Map<string, string>();

  for await (const msg of messages) {
    switch (msg.type) {
      case 'assistant': {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            yield { type: 'agent:message', planId, agent, content: block.text };
          } else if (block.type === 'tool_use') {
            toolNameMap.set(block.id, block.name);
            yield {
              type: 'agent:tool_use',
              planId,
              agent,
              tool: block.name,
              toolUseId: block.id,
              input: block.input,
            };
          }
        }
        break;
      }

      case 'tool_use_summary': {
        const summaryMsg = msg as SDKToolUseSummaryMessage;
        // Emit a tool_result for each preceding tool_use_id with the combined summary
        for (const toolUseId of summaryMsg.preceding_tool_use_ids) {
          const toolName = toolNameMap.get(toolUseId) ?? 'unknown';
          yield {
            type: 'agent:tool_result',
            planId,
            agent,
            tool: toolName,
            toolUseId,
            output: truncateOutput(summaryMsg.summary, 4096),
          };
        }
        break;
      }

      case 'stream_event': {
        const partial = msg as SDKPartialAssistantMessage;
        const event = partial.event;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'agent:message', planId, agent, content: event.delta.text };
        }
        break;
      }

      case 'result': {
        const result = msg as SDKResultMessage;
        if (result.subtype === 'success') {
          // Don't yield agent:message here — the text was already emitted
          // from the assistant message. Duplicating it causes double-parsing
          // of XML blocks (scope, clarification, review issues, verdicts).
          yield { type: 'agent:result', planId, agent, result: extractResultData(result, result.result) };
        } else {
          const errorResult = result as SDKResultMessage & { errors?: string[] };
          const errorMsg = errorResult.errors?.join('; ') ?? `Agent ${agent} failed: ${result.subtype}`;
          // Yield result data even on error (usage is still tracked)
          yield { type: 'agent:result', planId, agent, result: extractResultData(result) };
          throw new Error(errorMsg);
        }
        break;
      }

      default:
        // Other SDK message types (system, hooks, etc.) are not mapped
        break;
    }
  }
}

/**
 * Truncate tool output to prevent bloated traces.
 * Exported for testing.
 */
export function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + `... [truncated from ${output.length} chars]`;
}

/**
 * Extract tracing-relevant data from an SDK result message.
 * Defensive against missing fields (e.g. in test fixtures).
 */
function extractResultData(result: SDKResultMessage, resultText?: string): AgentResultData {
  const modelUsage: AgentResultData['modelUsage'] = {};
  let inputTokens = 0;
  let outputTokens = 0;

  if (result.modelUsage) {
    for (const [model, usage] of Object.entries(result.modelUsage)) {
      modelUsage[model] = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: usage.costUSD,
      };
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
    }
  }

  // Fall back to SDK aggregate if modelUsage was empty
  if (inputTokens === 0 && outputTokens === 0) {
    inputTokens = result.usage?.input_tokens ?? 0;
    outputTokens = result.usage?.output_tokens ?? 0;
  }

  return {
    durationMs: result.duration_ms ?? 0,
    durationApiMs: result.duration_api_ms ?? 0,
    numTurns: result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? 0,
    usage: {
      input: inputTokens,
      output: outputTokens,
      total: inputTokens + outputTokens,
    },
    modelUsage,
    resultText,
  };
}

/**
 * Parse <clarification> XML blocks from assistant text into structured questions.
 *
 * Expected format:
 *   <clarification>
 *     <question id="q1">What database should we use?</question>
 *     <question id="q2" default="PostgreSQL">
 *       Which ORM do you prefer?
 *       <context>We need to support migrations</context>
 *       <option>Prisma</option>
 *       <option>Drizzle</option>
 *     </question>
 *   </clarification>
 */
export function parseClarificationBlocks(text: string): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const blockRegex = /<clarification>([\s\S]*?)<\/clarification>/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const blockContent = blockMatch[1];
    const questionRegex = /<question\s+([^>]*)>([\s\S]*?)<\/question>/g;
    let questionMatch: RegExpExecArray | null;

    while ((questionMatch = questionRegex.exec(blockContent)) !== null) {
      const attrs = questionMatch[1];
      const inner = questionMatch[2];

      const idMatch = attrs.match(/id="([^"]+)"/);
      const defaultMatch = attrs.match(/default="([^"]+)"/);

      if (!idMatch) continue;

      const contextMatch = inner.match(/<context>([\s\S]*?)<\/context>/);
      const optionRegex = /<option>([\s\S]*?)<\/option>/g;
      const options: string[] = [];
      let optionMatch: RegExpExecArray | null;
      while ((optionMatch = optionRegex.exec(inner)) !== null) {
        options.push(optionMatch[1].trim());
      }

      // Question text is inner content with tags stripped
      const questionText = inner
        .replace(/<context>[\s\S]*?<\/context>/g, '')
        .replace(/<option>[\s\S]*?<\/option>/g, '')
        .trim();

      const question: ClarificationQuestion = {
        id: idMatch[1],
        question: questionText,
      };

      if (contextMatch) {
        question.context = contextMatch[1].trim();
      }
      if (options.length > 0) {
        question.options = options;
      }
      if (defaultMatch) {
        question.default = defaultMatch[1];
      }

      questions.push(question);
    }
  }

  return questions;
}

/**
 * Scope assessment from planner.
 */
export interface ScopeDeclaration {
  assessment: ScopeAssessment;
  justification: string;
}

const VALID_ASSESSMENTS = new Set<string>(SCOPE_ASSESSMENTS);

/**
 * Parse a <modules> XML block from assistant text into ExpeditionModule[].
 *
 * Expected format:
 *   <modules>
 *     <module id="foundation" depends_on="">Core types and utilities</module>
 *     <module id="auth" depends_on="foundation">Auth system</module>
 *   </modules>
 */
export function parseModulesBlock(text: string): ExpeditionModule[] {
  const modules: ExpeditionModule[] = [];
  const blockMatch = text.match(/<modules>([\s\S]*?)<\/modules>/);
  if (!blockMatch) return modules;

  const blockContent = blockMatch[1];
  const moduleRegex = /<module\s+([^>]*)>([\s\S]*?)<\/module>/g;
  let moduleMatch: RegExpExecArray | null;

  while ((moduleMatch = moduleRegex.exec(blockContent)) !== null) {
    const attrs = moduleMatch[1];
    const description = moduleMatch[2].trim();

    const idMatch = attrs.match(/id="([^"]+)"/);
    const depsMatch = attrs.match(/depends_on="([^"]*)"/);

    if (!idMatch || !description) continue;

    const dependsOn = depsMatch && depsMatch[1].trim()
      ? depsMatch[1].split(',').map((d) => d.trim())
      : [];

    modules.push({ id: idMatch[1], description, dependsOn });
  }

  return modules;
}

/**
 * Parse a <scope> XML block from assistant text into a ScopeDeclaration.
 *
 * Expected format:
 *   <scope assessment="errand">
 *     Focused change adding a single CLI flag — one area, no migrations.
 *   </scope>
 */
export function parseScopeBlock(text: string): ScopeDeclaration | null {
  const match = text.match(/<scope\s+assessment="([^"]+)">([\s\S]*?)<\/scope>/);
  if (!match) return null;

  const assessment = match[1].trim();
  const justification = match[2].trim();

  if (!VALID_ASSESSMENTS.has(assessment)) return null;
  if (!justification) return null;

  return { assessment: assessment as ScopeAssessment, justification };
}
