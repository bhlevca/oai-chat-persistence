# Changelog

All notable changes to OAI Chat Persistence are documented here.

## [0.3.0] — 2026-10-18

### Added
- **Direct local Ollama client**: directly stream from local Ollama (`/api/chat` and `/api/tags`) with full context window (`num_ctx: 8192`) without needing any third-party bridge extension.
- **Dedicated Git tools**: first-class `git_status`, `git_diff`, `git_log`, and `git_commit` (with interactive diff approval before committing).
- **Grouped Model Selector**: dropdown cleanly categorizes models into `⚡ Local Ollama (Direct)` and `VS Code Models (Extensions)`.
- **Robust tool call parser for local LLMs**: brace-depth balancing parser (`extractJsonObjects`) supporting multi-format tool calling (native Ollama, Mistral `[TOOL_CALLS]`, and nested JSON code blocks from models like Qwen2.5-coder).
- **Clean tool stream handling**: automatically intercepts raw tool JSON emitted in text streams, strips them from the assistant chat bubble, and executes them cleanly as interactive approval cards.
- **Stream timeout protection**: automatic 45-second watchdog so stalled or deadlocked model streams abort cleanly instead of hanging the UI.
- **Model compatibility guide**: comprehensive documentation in `README.md` covering tested local models, tool support, and recommended agent workflows.

### Fixed
- **Stop generation button**: fixed CSS issue where `#input-area.disabled` prevented mouse clicks on the Stop button.
- **Code block safety guard**: prevented tool call JSON blocks from accidentally being applied to active editor files.

## [0.2.0] — 2026-10-18

### Added — workspace interaction
- **Agent mode**: the model can now change the workspace through `write_file`, `edit_file` and `delete_file`
  tools instead of printing patches for you to copy. Toggle agent / read-only per session.
- **Approval cards**: every change arrives in the chat as a coloured diff with `+added/-removed` counts and
  Apply / Reject / Open diff / Apply all. `oaiChatPersistence.editApproval: auto` skips the card for edits;
  deletions and shell commands always ask.
- **New read tools**: `find_files` (glob), `search_text` (text/regex with `file:line` hits),
  `get_editor_context` (active file, cursor, selection, open tabs) and `get_diagnostics` (errors/warnings).
- **Optional shell tool** `run_shell_command` for tests, builds and git — disabled by default, never
  auto-approved (`oaiChatPersistence.enableTerminalTool`).
- **Code block actions**: every code block in a reply has `copy`, `apply`, `insert`, `new` and `diff`
  buttons. The target file comes from the fence info string, a leading `# File:` line, or the active editor.
- **Live editor references**: `@active`, `@selection`, `@tabs` and `@problems`, plus a 📎 quick-pick of
  workspace files and a context strip showing what the model can see.
- **Editor/explorer commands**: Add Selection to Chat (`Ctrl+Alt+O`), Explain Selection, Add Active File to
  Chat, Add to OAI Chat (explorer, multi-select) and Fix Workspace Problems.
- **Tool activity cards** in the transcript, collapsible to show exactly what the model read, saved with the
  session for later auditing.
- Test suite against a mocked VS Code API: `npm test` (no editor required).

### Changed
- Edits are applied via `vscode.WorkspaceEdit`, so `Ctrl+Z` undoes anything the model did.
- Models without tool-calling support no longer fail: the request is retried without tools and a notice
  explains to use `@` references.
- Context compaction now also summarises tool activity, and its own summarisation request runs tool-free.
- `src/ollama.js` became `src/lm.js`; the workspace primitives and tool registry live in `src/workspace.js`
  and `src/tools.js`.

### Fixed
- `engines.vscode` raised to `^1.95.0`, the version that introduced the language-model tool API. Older
  builds previously threw on the tool-part `instanceof` checks; the stream handler now degrades to plain
  chat if the tool API is absent.

### Security
- Writes outside the open workspace folders are refused unless
  `oaiChatPersistence.allowWritesOutsideWorkspace` is enabled.
- **Stop** now also rejects any pending approval.
- Injected file content can no longer corrupt a message through `$&`-style replacement patterns.

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
