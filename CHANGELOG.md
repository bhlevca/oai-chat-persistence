# Changelog

All notable changes to OAI Chat Persistence are documented here.

## [0.1.0] — 2026-05-16

### Added
- Persistent sidebar chat panel (Activity Bar) with multi-session support
- Works with any VS Code LM API model: Ollama, GitHub Copilot, and others
- Automatic context compaction: summarises old messages when token budget is exceeded; only commits to disk after a successful response
- File injection via `@` syntax: `@path/file`, `@dir/`, `@/absolute/path`, `@find:*.ext`, `@search:term`
- System prompt per session (survives compaction)
- Session export as JSON
- Streaming responses with stop button and cancellation
- Keyboard shortcut: `Ctrl+Shift+O` / `Cmd+Shift+O`
- Configurable token budget and compaction keep-count
