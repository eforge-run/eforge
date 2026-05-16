import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';

const docsUnderPlan = [
  'packages/extension-sdk/README.md',
  'docs/extensions.md',
  'docs/extensions-api.md',
  'docs/config.md',
];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('extension agent-tool documentation', () => {
  it('does not describe onAgentRun tool fields as unsupported or deferred', () => {
    const forbiddenPatterns = [
      /tools[^\n.]{0,120}(unsupported|not supported|deferred)/i,
      /(unsupported|not supported|deferred)[^\n.]{0,120}tools/i,
      /allowedTools[^\n.]{0,120}(unsupported|not supported|deferred)/i,
      /(unsupported|not supported|deferred)[^\n.]{0,120}allowedTools/i,
      /disallowedTools[^\n.]{0,120}(unsupported|not supported|deferred)/i,
      /(unsupported|not supported|deferred)[^\n.]{0,120}disallowedTools/i,
    ];

    for (const path of docsUnderPlan) {
      const contents = read(path);
      for (const pattern of forbiddenPatterns) {
        expect(contents, `${path} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('documents the supported registerTool plus per-run onAgentRun injection path', () => {
    for (const path of docsUnderPlan) {
      const contents = read(path);
      expect(contents, `${path} should mention loader-time registerTool provenance`).toMatch(
        /registerTool[^\n.]{0,160}(loader-time provenance|provenance)/i,
      );
      expect(contents, `${path} should mention onAgentRun as the per-run injection path`).toMatch(
        /onAgentRun[^\n.]{0,180}(per-run injection|injects? .*run|returning `?tools`?|tools:\s*\[)/i,
      );
    }
  });

  it('keeps toolbelts source-distinct from extension tools and built-ins', () => {
    for (const path of ['docs/extensions.md', 'docs/extensions-api.md', 'docs/config.md']) {
      const contents = read(path);
      expect(contents, `${path} should limit toolbelts to project MCP servers`).toMatch(
        /(Toolbelts?|Filtering applies)[\s\S]{0,900}(project MCP servers|project MCP tools)[\s\S]{0,300}\.mcp\.json/i,
      );
      expect(contents, `${path} should say toolbelts do not filter extension tools`).toMatch(
        /do(?:es)? not filter[\s\S]{0,800}(extension-contributed|extension tools)/i,
      );
      expect(contents, `${path} should say toolbelts do not filter built-ins`).toMatch(
        /do(?:es)? not filter[\s\S]{0,800}(built-ins|builtins)/i,
      );
    }
  });

  it('retains the trusted-code warning for native TypeScript extensions', () => {
    for (const path of ['docs/extensions.md', 'docs/config.md']) {
      const contents = read(path);
      expect(contents, `${path} should warn that loaded extensions execute trusted code`).toMatch(
        /(not sandboxed|without a sandbox|sources you trust|same Node process)/i,
      );
    }
  });

  it('keeps the agent-tools example wired as a runtime-supported example', () => {
    const example = read('examples/extensions/agent-tools.ts');
    expect(example).toMatch(/defineExtensionTool/);
    expect(example).toMatch(/registerTool\(/);
    expect(example).toMatch(/onAgentRun\(/);
    expect(example).toMatch(/ctx\.effectiveToolName\(/);
    expect(example).toMatch(/role !== 'builder'/);

    const readme = read('examples/extensions/README.md');
    expect(readme).toContain('agent-tools.ts');
    expect(readme).toMatch(/Runtime-supported per-run extension tool injection/i);
  });

  it('keeps the example import smoke test in sync with examples/extensions/*.ts', () => {
    const smokeTest = read('test/extension-sdk-example.test.ts');
    for (const file of ['agent-context.ts', 'agent-tools.ts', 'minimal-event-logger.ts', 'profile-router.ts', 'protected-paths.ts', 'slack-webhook-notifier.ts']) {
      expect(smokeTest, `${basename(file)} should be listed in importedExampleFiles`).toContain(file);
    }
  });
});
