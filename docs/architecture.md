# Architecture

`eforge` is **library-first**. The engine is a pure TypeScript library that communicates through typed `EforgeEvent`s via `AsyncGenerator` - it never writes to stdout. CLI, web monitor, and Claude Code plugin are thin consumers of the same event stream.

Each build phase gets its own agent role: formatter, planner, builder, reviewer, evaluator, fixer, doc-updater, validation-fixer. Agent runners use an `AgentBackend` interface - all LLM interaction is isolated behind a single adapter, making the engine provider-swappable.

A web monitor records all events to SQLite and serves a real-time dashboard over SSE, tracking progress, cost, and token usage.
