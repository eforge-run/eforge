---
description: Roadmap document governance rules. Auto-activates when reading, modifying, or proposing changes to docs/roadmap.md, when planning new features or architectural changes, or when completing work that may affect roadmap items.
user-invocable: false
---

# Roadmap Policy

Governance rules for `docs/roadmap.md`. This policy auto-activates when context involves the roadmap — editing it, proposing features, starting planning, or completing work that may have shipped roadmap items.

## Core Principles

| Principle | Rule |
|-----------|------|
| Read before proposing | Read `docs/roadmap.md` before proposing features or architecture changes. Surface conflicts explicitly. |
| Future only | Roadmap tracks what's ahead, not what's done. Shipped items move to CLAUDE.md/PRD/git history. |
| Keep lean | Goal + bullet points per section. No code, implementation details, frontmatter specs, or timelines. |
| Don't duplicate | Implementation details belong in PRDs, plan files, ADRs, CLAUDE.md. Roadmap points direction only. |

## What Goes Where

| Content | Belongs in |
|---------|-----------|
| Planned features, strategic direction | `docs/roadmap.md` |
| Completed features, current architecture | CLAUDE.md |
| Detailed requirements | PRD files |
| Implementation steps | Plan files (`plans/`) |
| Architecture decisions | ADRs (`docs/architecture/`) |
| History of what changed | Git log |

## When to Add Items

| Trigger | Example |
|---------|---------|
| New strategic direction from user discussion | "We should support multiple AI providers" |
| Architecture decision creates future obligations | ADR choosing plugin architecture -> plugin migration work |
| Dependency discovered during planning | Planning reveals need for a CI mode |
| User explicitly requests | "Add X to the roadmap" |

Do NOT add: bug fixes, maintenance tasks, items already covered by an existing section, implementation-level tasks ("add Zod schema for X").

## When to Remove Items

| Trigger | Action |
|---------|--------|
| Feature shipped and documented in CLAUDE.md | Remove bullet or section |
| Direction abandoned after user discussion | Remove, note in commit message |
| Item superseded by different approach | Replace with new direction |

## Section Structure Convention

Each section follows:

```markdown
## Section Title

**Goal**: One sentence describing the desired outcome.

- Capability or direction bullet
- Another capability
- Another capability
```

Sections ordered by proximity to current work:
1. Strategic context (why decisions were made)
2. Immediate next phase
3. Near-term enhancements
4. Longer-term vision

Thematic groups separated by horizontal rules (`---`).

## Graduation Lifecycle

```
Roadmap bullet -> PRD -> Plan files -> Implementation -> CLAUDE.md
     ^ present                                          ^ remove from roadmap
```

| Stage | Document | On roadmap? |
|-------|----------|-------------|
| Idea / direction | Roadmap bullet | Yes |
| Requirements defined | PRD file | Yes (not yet built) |
| Plans generated | Plan files | Yes (not yet built) |
| Implementation complete | Code + tests | No — remove, document in CLAUDE.md |

## Planning Integration

Before starting `/eforge:plan` or EEE assess:
1. Read `docs/roadmap.md`
2. Check alignment with proposed work
3. Surface conflicts if any

After expedition/excursion completion:
1. Check if roadmap items were delivered
2. Suggest `/eforge:roadmap-prune` if so

## Format Validation Checklist

- [ ] Each section has a `**Goal**:` line
- [ ] Content is bullet points, not paragraphs
- [ ] No code examples or implementation details
- [ ] No frontmatter specs or API definitions
- [ ] Sections ordered by proximity to current work
- [ ] No items that have already shipped
- [ ] Thematic groups separated by `---`

## Good Example

```markdown
## Provider Abstraction

**Goal**: Support multiple AI backends beyond Claude Agent SDK.

- Second `AgentBackend` implementation for non-SDK environments
- Provider selection via configuration
- Cost tracking per provider
```

## Bad Example

````markdown
## Provider Abstraction

We need to add a new backend implementation. The interface is in
`src/engine/backend.ts`:

```typescript
interface AgentBackend {
  query(options: QueryOptions): Promise<QueryResult>;
}
```

Steps:
1. Create `src/engine/backends/openai.ts`
2. Implement the AgentBackend interface
3. Add provider config to `eforge.yaml`
````

Why it's bad: Contains implementation details, code examples, and step-by-step instructions. These belong in a PRD or plan file.
