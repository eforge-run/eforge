import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { ORCHESTRATION_MODES } from '../events.js';
import type { ForgeEvent, AgentRole, AgentResultData, ClarificationQuestion, OrchestrationConfig } from '../events.js';

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
  for await (const msg of messages) {
    switch (msg.type) {
      case 'assistant': {
        const assistantMsg = msg as SDKAssistantMessage;
        for (const block of assistantMsg.message.content) {
          if (block.type === 'text') {
            yield { type: 'agent:message', planId, agent, content: block.text };
          } else if (block.type === 'tool_use') {
            yield {
              type: 'agent:tool_use',
              planId,
              agent,
              tool: block.name,
              input: block.input,
            };
          }
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
          yield { type: 'agent:message', planId, agent, content: result.result };
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
        // Other SDK message types (system, user, hooks, etc.) are not mapped
        break;
    }
  }
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
  assessment: OrchestrationConfig['mode'];
  justification: string;
}

const VALID_ASSESSMENTS = new Set<string>(ORCHESTRATION_MODES);

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

  return { assessment: assessment as OrchestrationConfig['mode'], justification };
}
