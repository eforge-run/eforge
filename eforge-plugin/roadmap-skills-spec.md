# Roadmap Management Skills Spec

## What This Is

Four skills that manage the project roadmap lifecycle: governance rules, initialization, review, and pruning. These extend the eforge plugin's planning story — roadmap management is where planning starts (what to build next) and ends (removing shipped work).

## How This Relates to Core Skills

The core skills (`spec.md`) wrap the eforge CLI: plan, run, status. These roadmap skills operate at a higher level — they govern the strategic document that feeds into `/eforge:plan`. The flow:

```
roadmap-init → (roadmap exists) → /eforge:roadmap → /eforge:plan → /eforge:run → /eforge:roadmap-prune
```

The `roadmap-policy` skill auto-activates during any of these steps to enforce conventions.

## Plugin Structure (additions)

```
eforge-plugin/
└── skills/
    ├── ...                          # core skills from spec.md
    ├── roadmap-policy/              # Category B — auto-activates
    │   └── SKILL.md
    ├── roadmap-init/                # Category A — /eforge:roadmap-init
    │   ├── roadmap-init.md
    │   └── SKILL.md -> roadmap-init.md
    ├── roadmap/                     # Category A — /eforge:roadmap
    │   ├── roadmap.md
    │   └── SKILL.md -> roadmap.md
    └── roadmap-prune/               # Category A — /eforge:roadmap-prune
        ├── roadmap-prune.md
        └── SKILL.md -> roadmap-prune.md
```

User-invocable skills added to `plugin.json` commands array.

---

## Skills

### `roadmap-policy` (Category B — internal/policy)

**Frontmatter**:
```yaml
---
description: Roadmap document governance rules. Auto-activates when reading, modifying, or proposing changes to docs/roadmap.md, when planning new features or architectural changes, or when completing work that may affect roadmap items.
user-invocable: false
---
```

**Purpose**: Enforce roadmap conventions automatically. Claude loads this skill when context involves the roadmap — no user invocation needed.

**Trigger contexts**:
- Editing `docs/roadmap.md`
- Proposing new features or architectural changes
- Starting an eforge plan or EEE assess
- Completing work that may have shipped roadmap items
- Updating CLAUDE.md with completed features

**Core principles**:

| Principle | Rule |
|-----------|------|
| Read before proposing | Read `docs/roadmap.md` before proposing features or architecture changes. Surface conflicts explicitly. |
| Future only | Roadmap tracks what's ahead, not what's done. Shipped items move to CLAUDE.md/PRD/git history. |
| Keep lean | Goal + bullet points per section. No code, implementation details, frontmatter specs, or timelines. |
| Don't duplicate | Implementation details → PRDs, plan files, ADRs, CLAUDE.md. Roadmap points direction only. |

**What goes where**:

| Content | Belongs in |
|---------|-----------|
| Planned features, strategic direction | `docs/roadmap.md` |
| Completed features, current architecture | CLAUDE.md |
| Detailed requirements | PRD files |
| Implementation steps | Plan files (`plans/`) |
| Architecture decisions | ADRs (`docs/architecture/`) |
| History of what changed | Git log |

**When to add items**:

| Trigger | Example |
|---------|---------|
| New strategic direction from user discussion | "We should support multiple AI providers" |
| Architecture decision creates future obligations | ADR choosing plugin architecture → plugin migration work |
| Dependency discovered during planning | Planning reveals need for a CI mode |
| User explicitly requests | "Add X to the roadmap" |

Do NOT add: bug fixes, maintenance tasks, items already covered by an existing section, implementation-level tasks ("add Zod schema for X").

**When to remove items**:

| Trigger | Action |
|---------|--------|
| Feature shipped and documented in CLAUDE.md | Remove bullet or section |
| Direction abandoned after user discussion | Remove, note in commit message |
| Item superseded by different approach | Replace with new direction |

**Section structure convention**:

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

**Graduation lifecycle**:

```
Roadmap bullet → PRD → Plan files → Implementation → CLAUDE.md
     ↑ present                                         ↑ remove from roadmap
```

| Stage | Document | On roadmap? |
|-------|----------|-------------|
| Idea / direction | Roadmap bullet | Yes |
| Requirements defined | PRD file | Yes (not yet built) |
| Plans generated | Plan files | Yes (not yet built) |
| Implementation complete | Code + tests | No — remove, document in CLAUDE.md |

**Planning integration**:

Before starting `/eforge:plan` or EEE assess:
1. Read `docs/roadmap.md`
2. Check alignment with proposed work
3. Surface conflicts if any

After expedition/excursion completion:
1. Check if roadmap items were delivered
2. Suggest `/eforge:roadmap-prune` if so

**Format validation checklist**:

- [ ] Each section has a `**Goal**:` line
- [ ] Content is bullet points, not paragraphs
- [ ] No code examples or implementation details
- [ ] No frontmatter specs or API definitions
- [ ] Sections ordered by proximity to current work
- [ ] No items that have already shipped
- [ ] Thematic groups separated by `---`

**Good example**:

```markdown
## Provider Abstraction

**Goal**: Support multiple AI backends beyond Claude Agent SDK.

- Second `AgentBackend` implementation for non-SDK environments
- Provider selection via configuration
- Cost tracking per provider
```

**Bad example**:

```markdown
## Provider Abstraction

We need to add a new backend implementation. The interface is in
`src/engine/backend.ts`:

\`\`\`typescript
interface AgentBackend {
  query(options: QueryOptions): Promise<QueryResult>;
}
\`\`\`

Steps:
1. Create `src/engine/backends/openai.ts`
2. Implement the AgentBackend interface
3. Add provider config to `eforge.yaml`
```

Why it's bad: Contains implementation details, code examples, and step-by-step instructions. These belong in a PRD or plan file.

---

### `/eforge:roadmap-init <theme...>`

**Frontmatter**:
```yaml
---
description: Create an initial project roadmap document
disable-model-invocation: true
argument-hint: "[theme...]"
---
```

**Purpose**: Scaffold a new `docs/roadmap.md` following the policy conventions. A one-time setup skill for projects that don't have a roadmap yet.

**Workflow**:

1. **Check existence** — If `docs/roadmap.md` already exists, abort and suggest `/eforge:roadmap` for review instead.

2. **Gather context** — Read CLAUDE.md, README, and scan project structure to understand:
   - What the project does
   - Current architecture and tech stack
   - Existing planning artifacts (PRDs, plan files)

3. **Identify themes** — If `theme` arguments provided, use those. Otherwise, ask the user about 2-4 high-level directions for the project. Examples: "plugin architecture", "CI/CD support", "multi-provider", "monitoring dashboard".

4. **Generate roadmap** — Create `docs/roadmap.md` following `roadmap-policy` conventions:
   - One section per theme
   - Each section: `## Title` → `**Goal**:` → 3-5 bullet points
   - Ordered by proximity to current work
   - Thematic groups separated by `---`
   - Lean — no implementation details

5. **Write** — Save to `docs/roadmap.md`. Create `docs/` directory if it doesn't exist.

6. **Suggest CLAUDE.md update** — If CLAUDE.md doesn't already have roadmap conventions, suggest adding a `## Roadmap` section pointing to `docs/roadmap.md` with the governance rules.

---

### `/eforge:roadmap [topic]`

**Frontmatter**:
```yaml
---
description: Review current roadmap for alignment, staleness, and structural quality
disable-model-invocation: true
argument-hint: "[topic]"
---
```

**Purpose**: Health check for the roadmap. Detects stale items, structural issues, and optionally checks alignment with a proposed topic.

**Workflow**:

1. **Load context** — Read `docs/roadmap.md` and CLAUDE.md. If roadmap doesn't exist, suggest `/eforge:roadmap-init`.

2. **Staleness check** — For each bullet point:
   - Search codebase for key terms (grep for function names, file paths, features)
   - Check recent git history for related commits
   - Check CLAUDE.md for documentation of the capability
   - Flag items with shipping evidence as potentially stale

3. **Structural quality check** — Validate against `roadmap-policy`:
   - Each section has a `**Goal**:` line
   - Content is bullet points (not prose or code)
   - No implementation details
   - Sections ordered by proximity
   - Thematic separators present

4. **Alignment check** (if `topic` argument provided):
   - Find which roadmap section(s) relate to the topic
   - Assess alignment, extension, or conflict with roadmap direction
   - If no section covers it, assess whether it should be added

5. **Report** — Structured output:

```markdown
## Roadmap Review

### Staleness ({count} items may be stale)

| Item | Section | Evidence |
|------|---------|----------|
| {bullet text} | {section} | {code/commit/CLAUDE.md evidence} |

### Structural Issues ({count})

- {issue description and fix suggestion}

### Alignment (if topic provided)

{assessment of topic vs roadmap direction}

### Recommendations

1. {Priority action — e.g., "Run /eforge:roadmap-prune to remove 3 shipped items"}
2. {Next action}
```

**When to use**:
- Before proposing a new feature (check alignment)
- Periodically to catch stale items
- After a major release or milestone
- When onboarding to understand project direction

---

### `/eforge:roadmap-prune [--auto]`

**Frontmatter**:
```yaml
---
description: Identify and remove shipped items from the project roadmap
disable-model-invocation: true
argument-hint: "[--auto]"
---
```

**Purpose**: Keep the roadmap future-focused by removing items that have shipped. The counterpart to graduation — when code reaches CLAUDE.md, it leaves the roadmap.

**Workflow**:

1. **Parse roadmap** — Read `docs/roadmap.md`, extract sections and individual bullet points.

2. **Check each item** — Gather evidence from multiple sources:

   | Source | What to check |
   |--------|--------------|
   | Codebase | Grep for key terms, check file existence |
   | Git history | Recent commits matching the capability |
   | CLAUDE.md | Feature documented in architecture/commands sections |
   | Plan files | Completed plans that addressed this item |
   | `.eforge/state.json` | Completed build sets |

3. **Classify**:

   | Classification | Criteria |
   |---------------|---------|
   | Shipped | Strong evidence in code AND documented in CLAUDE.md |
   | Partially shipped | Some evidence but not fully delivered |
   | Pending | No evidence of implementation |
   | Uncertain | Ambiguous — needs user judgment |

4. **Present findings**:

   ```markdown
   ## Roadmap Prune Analysis

   ### Ready to Remove ({count})

   | Item | Section | Evidence |
   |------|---------|----------|
   | {bullet} | {section} | {evidence summary} |

   ### Partially Shipped ({count})

   | Item | Section | Done | Remaining |
   |------|---------|------|-----------|
   | {bullet} | {section} | {what's done} | {what remains} |

   ### Still Pending ({count})

   These stay on the roadmap.

   ### Uncertain ({count})

   | Item | Section | Question |
   |------|---------|----------|
   | {bullet} | {section} | {what's ambiguous} |
   ```

5. **Confirm and remove**:
   - Default (interactive): confirm each removal with the user
   - `--auto`: remove items classified as "Shipped" without asking
   - "Uncertain" items always require confirmation

6. **Clean up** — If all bullets removed from a section, remove the entire section (heading, goal, content, separator).

7. **Suggest CLAUDE.md updates** — If a shipped item isn't yet documented in CLAUDE.md, suggest where to add it.

8. **Summary**:

   ```markdown
   ## Prune Complete

   Removed: {N} items
   Kept: {M} items
   Sections removed: {K}

   ### Suggested CLAUDE.md Updates (if any)

   - {item} → add to {CLAUDE.md section}
   ```

**When to use**:
- After completing an eforge build or EEE expedition/excursion
- When `/eforge:roadmap` reports stale items
- After a release milestone
- Periodic housekeeping
