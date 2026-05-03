import { describe, it, expect } from 'vitest';
import { splitPlanContent, parseFrontmatterFields } from '@eforge-build/monitor-ui/lib/plan-content';

describe('splitPlanContent', () => {
  it('splits standard plan file with YAML frontmatter and markdown body', () => {
    const input = `---
id: plan-01
name: My Plan
depends_on:
  - plan-00
branch: feature/plan-01
---

# Plan Title

Some markdown body content.`;

    const result = splitPlanContent(input);
    expect(result.frontmatter).toBe(
      'id: plan-01\nname: My Plan\ndepends_on:\n  - plan-00\nbranch: feature/plan-01',
    );
    expect(result.body).toBe('# Plan Title\n\nSome markdown body content.');
  });

  it('returns null frontmatter for content without frontmatter', () => {
    const input = '# Just Markdown\n\nNo frontmatter here.';
    const result = splitPlanContent(input);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(input);
  });

  it('handles plan file with empty body (frontmatter only)', () => {
    const input = `---
id: plan-01
name: Frontmatter Only
---`;

    const result = splitPlanContent(input);
    expect(result.frontmatter).toBe('id: plan-01\nname: Frontmatter Only');
    expect(result.body).toBe('');
  });

  it('handles multiple --- delimiters in the body (only first pair delimits frontmatter)', () => {
    const input = `---
id: plan-01
name: My Plan
---

# Title

Some content with a --- horizontal rule.

---

More content after the rule.`;

    const result = splitPlanContent(input);
    expect(result.frontmatter).toBe('id: plan-01\nname: My Plan');
    expect(result.body).toContain('--- horizontal rule');
    expect(result.body).toContain('More content after the rule.');
  });

  it('returns null frontmatter and empty body for empty string', () => {
    const result = splitPlanContent('');
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe('');
  });
});

describe('parseFrontmatterFields', () => {
  it('parses all standard fields', () => {
    const yaml = `id: plan-01-foundation
name: Foundation module
depends_on:
  - plan-00-setup
  - plan-02-config
branch: feature/foundation`;

    const result = parseFrontmatterFields(yaml);
    expect(result.id).toBe('plan-01-foundation');
    expect(result.name).toBe('Foundation module');
    expect(result.dependsOn).toEqual(['plan-00-setup', 'plan-02-config']);
    expect(result.branch).toBe('feature/foundation');
  });

  it('returns empty arrays and strings for missing fields', () => {
    const yaml = 'id: minimal-plan';
    const result = parseFrontmatterFields(yaml);
    expect(result.id).toBe('minimal-plan');
    expect(result.name).toBe('');
    expect(result.dependsOn).toEqual([]);
    expect(result.branch).toBe('');
    expect(result.migrations).toEqual([]);
  });

  it('handles no dependencies', () => {
    const yaml = `id: plan-01
name: No Deps
branch: main`;

    const result = parseFrontmatterFields(yaml);
    expect(result.dependsOn).toEqual([]);
  });

  it('parses migrations block', () => {
    const yaml = `id: plan-02-db
name: DB migrations
branch: feature/db
migrations:
  - timestamp: "20260101120000"
    description: create users table
  - timestamp: "20260101130000"
    description: add index on email`;

    const result = parseFrontmatterFields(yaml);
    expect(result.migrations).toHaveLength(2);
    expect(result.migrations[0]).toEqual({ timestamp: '20260101120000', description: 'create users table' });
    expect(result.migrations[1]).toEqual({ timestamp: '20260101130000', description: 'add index on email' });
  });

  it('returns empty migrations for malformed YAML', () => {
    const yaml = 'this: is: not: valid: yaml: [[[';
    const result = parseFrontmatterFields(yaml);
    expect(result.migrations).toEqual([]);
    expect(result.id).toBe('');
  });
});
