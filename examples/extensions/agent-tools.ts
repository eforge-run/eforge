/**
 * Example: Runtime-supported extension tool injection.
 *
 * This extension defines and registers a small TypeBox-backed tool, then
 * exposes it only to builder agent runs through `onAgentRun`. Registration is
 * loader-time provenance; returning the tool from `onAgentRun` is what makes it
 * available to a specific run.
 */

import { defineEforgeExtension, defineExtensionTool, Type } from '@eforge-build/extension-sdk';

const lookupProjectConvention = defineExtensionTool({
  name: 'project_convention_lookup',
  description: 'Look up a short project convention reminder by topic.',
  inputSchema: Type.Object({
    topic: Type.String({ description: 'Convention topic, such as exports, immutability, or tests.' }),
  }),
  handler: async ({ topic }) => {
    const normalizedTopic = topic.trim().toLowerCase();

    const conventions: Record<string, string> = {
      exports: 'Add a JSDoc comment for each new public export.',
      immutability: 'Prefer readonly arrays and objects when mutation is not required.',
      tests: 'Keep tests focused on observable behavior and avoid broad mocks.',
    };

    return conventions[normalizedTopic] ?? `No specific convention is registered for "${topic}".`;
  },
});

export default defineEforgeExtension((eforge) => {
  // Loader-time provenance/validation. This does not inject the tool globally.
  eforge.registerTool(lookupProjectConvention);

  eforge.onAgentRun((ctx) => {
    // Expose the tool only to builder runs. Other roles do not receive it.
    if (ctx.role !== 'builder') {
      return undefined;
    }

    const toolName = ctx.effectiveToolName(lookupProjectConvention.name);

    return {
      tools: [lookupProjectConvention],
      disallowedTools: ['dangerous_shell_escape'],
      promptAppend: [
        '**Extension tool available**',
        '',
        `Use ${toolName} when you need a quick reminder of project conventions before editing code.`,
      ].join('\n'),
    };
  });
});
