import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPrompt, setPromptDir } from '@eforge-build/engine/prompts';

// Use a unique temp dir for each test run to avoid collisions
const TEST_DIR = resolve(tmpdir(), `eforge-prompt-test-${Date.now()}`);
const PROMPTS_DIR = resolve(TEST_DIR, 'prompts');

describe('prompt resolution', () => {
  beforeEach(async () => {
    await mkdir(PROMPTS_DIR, { recursive: true });
    // Reset prompt dir between tests
    setPromptDir(undefined, TEST_DIR);
  });

  afterEach(async () => {
    setPromptDir(undefined, TEST_DIR);
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  describe('loadPrompt with append', () => {
    it('appends text after variable substitution', async () => {
      // Load a bundled prompt (builder.md exists) and append custom text
      const prompt = await loadPrompt('builder', {
        plan_id: 'test-id',
        plan_name: 'test-name',
        plan_content: 'test plan content',
        parallelLanes: '',
        verification_scope: 'Run all checks.',
        continuation_context: '',
      }, '## Custom Append\nThis is appended.');

      expect(prompt).toContain('test-id');
      expect(prompt).toContain('## Custom Append\nThis is appended.');
      // Appended text should be at the end
      const appendIdx = prompt.indexOf('## Custom Append');
      expect(appendIdx).toBeGreaterThan(prompt.indexOf('test-id'));
    });

    it('returns prompt unchanged when append is undefined', async () => {
      const withAppend = await loadPrompt('builder', {
        plan_id: 'id',
        plan_name: 'name',
        plan_content: 'content',
        parallelLanes: '',
        verification_scope: '',
        continuation_context: '',
      });
      const withoutAppend = await loadPrompt('builder', {
        plan_id: 'id',
        plan_name: 'name',
        plan_content: 'content',
        parallelLanes: '',
        verification_scope: '',
        continuation_context: '',
      }, undefined);

      expect(withAppend).toBe(withoutAppend);
    });
  });

  describe('promptDir override', () => {
    it('loads from project prompt dir when file exists', async () => {
      const customContent = '# Custom Reviewer\nYou are a custom reviewer.\n{{plan_content}}\n{{attribution}}';
      await writeFile(resolve(PROMPTS_DIR, 'reviewer.md'), customContent);

      setPromptDir('prompts', TEST_DIR);

      const prompt = await loadPrompt('reviewer', {
        plan_content: 'My plan',
        base_branch: 'main',
        review_issue_schema: 'schema here',
      });

      expect(prompt).toContain('# Custom Reviewer');
      expect(prompt).toContain('My plan');
      expect(prompt).not.toContain('You are a code reviewer performing a **blind review**');
    });

    it('falls back to bundled prompt when file not in project dir', async () => {
      // Set a prompt dir that exists but has no reviewer.md
      setPromptDir('prompts', TEST_DIR);

      const prompt = await loadPrompt('reviewer', {
        plan_content: 'plan',
        base_branch: 'main',
        review_issue_schema: 'schema',
      });

      // Should load the bundled reviewer prompt
      expect(prompt).toContain('blind review');
    });

    it('does not use project dir when promptDir is not set', async () => {
      // Even if the file exists in the default location, it should not be used
      setPromptDir(undefined, TEST_DIR);

      const prompt = await loadPrompt('reviewer', {
        plan_content: 'plan',
        base_branch: 'main',
        review_issue_schema: 'schema',
      });

      expect(prompt).toContain('blind review');
    });

    it('combines promptDir override with append', async () => {
      const customContent = '# Custom Builder\nBuild things.\n{{plan_id}}';
      await writeFile(resolve(PROMPTS_DIR, 'builder.md'), customContent);

      setPromptDir('prompts', TEST_DIR);

      const prompt = await loadPrompt('builder', {
        plan_id: 'my-plan',
        plan_name: 'name',
        plan_content: 'content',
        parallelLanes: '',
        verification_scope: '',
        continuation_context: '',
      }, '## Extra Rules\nFollow these rules.');

      expect(prompt).toContain('# Custom Builder');
      expect(prompt).toContain('my-plan');
      expect(prompt).toContain('## Extra Rules\nFollow these rules.');
    });
  });

  describe('variable substitution', () => {
    it('substitutes {{variable}} placeholders', async () => {
      const customContent = 'Hello {{name}}, your role is {{role}}.';
      await writeFile(resolve(PROMPTS_DIR, 'test-vars.md'), customContent);

      setPromptDir('prompts', TEST_DIR);

      const prompt = await loadPrompt('test-vars', {
        name: 'Alice',
        role: 'reviewer',
      });

      expect(prompt).toBe('Hello Alice, your role is reviewer.');
    });

    it('throws when template variables remain unresolved after substitution', async () => {
      const customContent = 'Hello {{name}}, {{unknown}} stays.';
      await writeFile(resolve(PROMPTS_DIR, 'test-unmatched.md'), customContent);

      setPromptDir('prompts', TEST_DIR);

      await expect(
        loadPrompt('test-unmatched', { name: 'Bob' }),
      ).rejects.toThrow('loadPrompt(test-unmatched.md): unresolved template variables: unknown');
    });

    it('always provides {{attribution}} variable', async () => {
      const customContent = 'Built by {{attribution}}';
      await writeFile(resolve(PROMPTS_DIR, 'test-attribution.md'), customContent);

      setPromptDir('prompts', TEST_DIR);

      const prompt = await loadPrompt('test-attribution', {});

      expect(prompt).toContain('Built by');
      expect(prompt).not.toContain('{{attribution}}');
    });
  });
});
