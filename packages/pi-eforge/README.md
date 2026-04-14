# @eforge-build/eforge-pi

Pi package for [eforge](https://eforge.build).

Install in Pi:

```bash
pi install npm:@eforge-build/eforge-pi
```

Or install for the current project only:

```bash
pi install -l npm:@eforge-build/eforge-pi
```

Then, in your project:

```text
/eforge:init
```

## What this package provides

- Native Pi tools for eforge daemon operations
- Slash commands including `/eforge:build`, `/eforge:init`, `/eforge:status`, `/eforge:config`, `/eforge:restart`, and `/eforge:update`
- The `/eforge:plan` skill for structured handoff planning before build execution

## Requirements

- Node.js 22+
- [Pi](https://github.com/nicories/pi-mono)
- An LLM provider credential supported by your chosen eforge backend

## Relationship to the `@eforge-build/eforge` npm package

`@eforge-build/eforge-pi` is the Pi integration package.

The main [`@eforge-build/eforge`](https://www.npmjs.com/package/@eforge-build/eforge) npm package is the standalone CLI and daemon runtime that this Pi package invokes via `npx -y @eforge-build/eforge`.

For project docs and full setup guidance, see the main repository:

- GitHub: https://github.com/eforge-build/eforge
- Docs: https://eforge.build
