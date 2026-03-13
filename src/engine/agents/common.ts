import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ForgeEvent, AgentRole, ClarificationQuestion } from '../events.js';

/**
 * Map an async iterable of SDK messages to ForgeEvents.
 * Bridges the SDK's message stream to the engine's typed event system.
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
        } else {
          const errorResult = result as SDKResultMessage & { errors?: string[] };
          const errorMsg = errorResult.errors?.join('; ') ?? `Agent ${agent} failed: ${result.subtype}`;
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
