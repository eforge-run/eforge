---
id: plan-01-license-section
name: Expand License Section with Third-Party Notices
depends_on: []
branch: add-third-party-license-notices-to-readme/license-section
---

# Expand License Section with Third-Party Notices

## Architecture Context

eforge is Apache 2.0 licensed but depends on the proprietary Claude Agent SDK as its default backend. The README's License section currently says only "Apache-2.0" on a single line. Users need to understand that using eforge with the Claude SDK backend carries additional license obligations beyond Apache 2.0.

## Implementation

### Overview

Replace the single-line `## License` section in README.md (lines 104-106) with an expanded section that documents eforge's own license, the Claude Agent SDK's proprietary terms with links, an authentication note for third-party product builders, and a clarifying statement about license scope.

### Key Decisions

1. Use the exact content specified in the PRD - the language has been reviewed for accuracy regarding Anthropic's terms.
2. Do not include the Pi backend bullet yet - the PRD specifies adding it only when that backend ships.

## Scope

### In Scope
- `README.md` - Replace the `## License` section content

### Out of Scope
- The `LICENSE` file itself (covers eforge's own code, unchanged)
- Pi backend license bullet (deferred until that backend ships)
- Any other files

## Files

### Modify
- `README.md` - Replace lines 104-106 (`## License` / blank / `Apache-2.0`) with the expanded license section containing eforge's Apache 2.0 declaration, Claude Agent SDK proprietary terms with links, authentication note, and license scope clarification.

## Verification

- [ ] README.md `## License` section contains "eforge is licensed under [Apache-2.0](LICENSE)"
- [ ] README.md contains "Third-party backend licenses" subsection header
- [ ] README.md contains link to Anthropic Commercial Terms at `https://www.anthropic.com/legal/commercial-terms`
- [ ] README.md contains link to Anthropic Consumer Terms at `https://www.anthropic.com/legal/consumer-terms`
- [ ] README.md contains link to Acceptable Use Policy at `https://www.anthropic.com/legal/aup`
- [ ] README.md contains link to Anthropic legal page at `https://code.claude.com/docs/en/legal-and-compliance`
- [ ] README.md contains link to Claude Console at `https://platform.claude.com/`
- [ ] README.md contains authentication note about API key requirement for third-party products
- [ ] README.md contains "eforge's Apache 2.0 license applies to eforge's own source code" scope clarification
- [ ] `LICENSE` file is unchanged
- [ ] No other files are modified
