#!/usr/bin/env node
// Check parity between Claude Code plugin skills and Pi extension skills.
//
// Strips YAML frontmatter from both files, normalizes tool-reference syntax
// so plugin-form (`mcp__eforge__eforge_<x>`, `/eforge:<name>`) matches
// Pi-form (`eforge_<x>`, `eforge_<name>`), then diffs the remaining narrative.
// Exits 0 on full match across all pairs; 1 on any divergence.
//
// Normalization rules beyond plain tool-reference alignment:
//
//   1. `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` blocks are
//      stripped on both sides. This is the escape hatch for genuine
//      platform-affordance divergence — e.g., Pi's `eforge_confirm_build`
//      TUI overlay vs the plugin's plain-text preview + confirm/edit/cancel
//      prompt, or `/plugin update eforge@eforge` vs `pi update`. Wrap only
//      the minimum number of lines that legitimately cannot be unified;
//      everything outside the markers must match post-normalization.
//
//      IMPORTANT: Content inside `parity-skip-*` markers must describe the
//      *owning* platform only. A plugin file (`eforge-plugin/**`) must not
//      contain Pi-specific content inside a skip block, and a Pi file
//      (`packages/pi-eforge/**`) must not contain Claude-Code-plugin-specific
//      content inside a skip block. Skip blocks tolerate divergence, not
//      duplication — they are not a place to mirror the other platform's
//      narrative. Because the HTML comments render nothing, duplicated
//      skip blocks produce ungrammatical output and mislead agents reading
//      the file. Each file should carry only its own platform's Step /
//      table row / inline phrase inside a skip block.
//
//   2. A leading Pi-side `> **Note:** In Pi, ...` paragraph is stripped on
//      the Pi side only. These notes explain that Pi additionally exposes
//      a richer native interactive command (overlay-driven) and the SKILL
//      file serves as a model-readable fallback. They don't apply to the
//      Claude Code plugin, so the narrative beneath them must still match.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Explicit pairing — the 9 consumer-facing skills that must stay in sync.
const SKILL_PAIRS = [
  { plugin: "backend", pi: "eforge-backend" },
  { plugin: "backend-new", pi: "eforge-backend-new" },
  { plugin: "build", pi: "eforge-build" },
  { plugin: "config", pi: "eforge-config" },
  { plugin: "init", pi: "eforge-init" },
  { plugin: "plan", pi: "eforge-plan" },
  { plugin: "restart", pi: "eforge-restart" },
  { plugin: "status", pi: "eforge-status" },
  { plugin: "update", pi: "eforge-update" },
];

function pluginSkillPath(name) {
  return resolve(repoRoot, "eforge-plugin", "skills", name, `${name}.md`);
}

function piSkillPath(name) {
  return resolve(repoRoot, "packages", "pi-eforge", "skills", name, "SKILL.md");
}

// Strip the leading YAML frontmatter block delimited by `---` lines.
function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const lines = text.split("\n");
  // first line is `---`
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return text;
  return lines.slice(end + 1).join("\n");
}

// Strip `<!-- parity-skip-start --> ... <!-- parity-skip-end -->` blocks
// (including the marker lines and a single trailing blank line if present).
// Used on both sides to gate legitimate platform-affordance content.
function stripSkipBlocks(text) {
  // Multiline, non-greedy; also consume the newline after the end marker.
  return text.replace(
    /<!--\s*parity-skip-start\s*-->[\s\S]*?<!--\s*parity-skip-end\s*-->\n?/g,
    "",
  );
}

// Strip a leading Pi-side `> **Note:** In Pi, ...` paragraph (single
// blockquote paragraph plus the blank line that follows). Only applied
// to Pi bodies — the plugin never has these.
function stripPiNoteBlock(text) {
  return text.replace(
    /^(?:[ \t]*\n)*> \*\*Note:\*\* In Pi,[^\n]*\n\n?/,
    "",
  );
}

// Normalize plugin-style tool references into Pi-style so bodies can be
// compared byte-for-byte once frontmatter is gone.
//   mcp__eforge__eforge_<x>  →  eforge_<x>
//   /eforge:<name>           →  eforge_<name>
function normalizePluginBody(text) {
  return stripSkipBlocks(text)
    .replace(/mcp__eforge__eforge_([a-zA-Z0-9_-]+)/g, "eforge_$1")
    .replace(/\/eforge:([a-zA-Z0-9_-]+)/g, (_, name) =>
      // Convert the `-` in command names (e.g. backend-new) to `_`
      // so it matches `eforge_backend_new` or the natural form; keep
      // hyphens otherwise. Pi uses `eforge_<name>` with original
      // punctuation preserved in the tables, so just prefix.
      `eforge_${name.replace(/-/g, "_")}`,
    );
}

// Pi bodies: `/eforge:<name>` occasionally appears in prose; keep the same
// normalization so both sides converge.
function normalizePiBody(text) {
  return stripPiNoteBlock(stripSkipBlocks(text)).replace(
    /\/eforge:([a-zA-Z0-9_-]+)/g,
    (_, name) => `eforge_${name.replace(/-/g, "_")}`,
  );
}

// Minimal line-level diff. Good enough to point a human at the drift.
function lineDiff(a, b) {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const max = Math.max(aLines.length, bLines.length);
  const out = [];
  for (let i = 0; i < max; i++) {
    const la = aLines[i] ?? "";
    const lb = bLines[i] ?? "";
    if (la !== lb) {
      out.push(`  @@ line ${i + 1} @@`);
      out.push(`  - plugin: ${la}`);
      out.push(`  + pi:     ${lb}`);
    }
  }
  return out.join("\n");
}

let failed = 0;
let checked = 0;

for (const { plugin, pi } of SKILL_PAIRS) {
  const pluginPath = pluginSkillPath(plugin);
  const piPath = piSkillPath(pi);

  if (!existsSync(pluginPath)) {
    console.error(`MISSING plugin skill: ${pluginPath}`);
    failed++;
    continue;
  }
  if (!existsSync(piPath)) {
    console.error(`MISSING pi skill: ${piPath}`);
    failed++;
    continue;
  }

  const pluginRaw = readFileSync(pluginPath, "utf8");
  const piRaw = readFileSync(piPath, "utf8");

  // Trim both ends — frontmatter stripping leaves a leading newline on the
  // plugin side that the Pi-note stripper incidentally consumes on the Pi
  // side. Trimming is simpler than normalizing whitespace at both boundaries.
  const pluginBody = normalizePluginBody(stripFrontmatter(pluginRaw)).trim();
  const piBody = normalizePiBody(stripFrontmatter(piRaw)).trim();

  checked++;

  if (pluginBody !== piBody) {
    failed++;
    console.log(`\n✗ DRIFT: ${plugin} ↔ ${pi}`);
    console.log(lineDiff(pluginBody, piBody));
  } else {
    console.log(`✓ ${plugin} ↔ ${pi}`);
  }
}

console.log(`\n${checked - failed}/${checked} pairs in sync.`);
process.exit(failed > 0 ? 1 : 0);
