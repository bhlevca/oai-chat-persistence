# OAI Chat Persistence

**A persistent, multi-session AI chat sidebar that actually works *on* your workspace — for Ollama, local LLMs, and any VS Code-compatible model.**

The model reads your files, searches your code, and applies edits as diffs you approve. Chat history survives restarts and lives in plain JSON files you own.

## 🚀 Why This Extension?

✅ **Works on your workspace** — the model reads, searches and edits real files; no copy/paste round-trips
✅ **You approve every change** — each edit arrives as a diff with Apply / Reject (or open it in VS Code's diff editor)
✅ **Persistent Sessions** — chats saved to `~/.vscode/oai-chat-persistence/<session-name>.json`, reloaded automatically
✅ **Works with Any Model** — uses the standard `vscode.lm` API (same models as GitHub Copilot Chat); falls back gracefully for models without tool calling
✅ **Automatic Context Compaction** — summarises old messages when the token budget is exceeded; never destroys history on a failed response
✅ **Offline-Friendly** — no cloud dependency; works with local models like Ollama

## 🔥 How It Compares

| Feature | OAI Chat Persistence | Ollama Chat | Copilot Chat |
|---|---|---|---|
| Persists chats | ✅ Yes | ❌ No | ✅ Yes (cloud) |
| Works with Ollama | ✅ Yes | ✅ Yes | ❌ No |
| Offline-capable | ✅ Yes | ✅ Yes | ❌ No |
| Edits your files | ✅ Yes (approved diffs) | ❌ No | ✅ Yes |
| Reads / searches workspace | ✅ Yes | ❌ No | ✅ Yes |
| Multi-session | ✅ Yes | ❌ No | ✅ Yes |

---

## 🛠 Workspace Interaction

### Agent mode

Every session has a mode, toggled with the **🛠 agent / 👁 read-only** button in the session header:

| Mode | What the model can do |
|---|---|
| **🛠 agent** | Read, search *and* change files — every change needs your approval |
| **👁 read-only** | Only inspect the workspace; proposed changes come back as code blocks you apply with one click |

### Tools the model can call

| Tool | Purpose | Approval |
|---|---|---|
| `read_file` | Read a file (optionally a line range), with line numbers | — |
| `list_directory` | List a directory | — |
| `find_files` | Find files by glob (`**/*.ts`) | — |
| `search_text` | Search the workspace for text or a regex, with `file:line` hits | — |
| `get_editor_context` | See the active file, cursor line, selection and open tabs | — |
| `get_diagnostics` | Read errors/warnings from language servers and linters | — |
| `git_status` | Show branch, staged, unstaged and untracked files | — |
| `git_diff` | Show working tree or staged changes (`staged: true`) | — |
| `git_log` | Show recent commit history with hashes and messages | — |
| `write_file` | Create a file or replace its whole content | ✋ diff + Apply |
| `edit_file` | Replace an exact snippet inside a file | ✋ diff + Apply |
| `delete_file` | Delete a file (to trash) | ✋ always asks |
| `git_commit` | Commit changes to git | ✋ diff + Apply |
| `run_shell_command` | Run tests/builds/scripts in the workspace root | ✋ always asks — **off by default** |

Edits are applied as a `WorkspaceEdit`, so **Ctrl+Z undoes them** like any other edit. Writes outside the open workspace folders are refused unless you opt in.

### Approving changes

When the model wants to change something, an approval card appears in the chat with a coloured diff and `+added/-removed` counts:

- **Apply** — make the change
- **Reject** — refuse it; the model is told and asked to reconsider
- **Open diff** — review it side-by-side in VS Code's diff editor first
- **Apply all** — auto-apply the remaining changes *in this reply only*

Set `oaiChatPersistence.editApproval` to `auto` to skip the card for edits (deletions and shell commands always ask).

### Code block actions

Every code block in a reply gets a toolbar — no more copy/paste:

| Button | Action |
|---|---|
| `copy` | Copy to clipboard |
| `apply` | Replace the target file with the block (shows a diff and asks first) |
| `insert` | Insert at the cursor / replace the selection in the active editor |
| `new` | Save the block as a new file |
| `diff` | Open a diff against the target file |

The target file is taken from the fence (` ```js src/panel.js `), from a leading `# File: src/panel.js` line, or from the active editor.

### Attaching context

Chips above the message box, plus `@` references anywhere in your message:

| Reference | What it injects |
|---|---|
| `@active` | The whole active editor file |
| `@selection` | The current editor selection with its line numbers |
| `@tabs` | The list of open editor tabs |
| `@problems` | All errors and warnings in the workspace |
| `@src/panel.js` | Full file contents |
| `@src/` | Directory listing |
| `@/home/user/.vscode/` | Absolute directory listing |
| `@find:*.ts` | All `.ts` files in the workspace |
| `@find:/path:*.json` | All `.json` files under any directory |
| `@search:myFunction` | All lines containing `myFunction` |
| `@search:/path:term` | Grep under any directory |

📎 **file** opens a quick-pick of workspace files. A one-line note about the active file, cursor line and selection is attached to every message (turn it off with `oaiChatPersistence.includeEditorContext`).

### Editor & explorer commands

| Command | Where |
|---|---|
| **OAI Chat: Add Selection to Chat** | editor right-click, `Ctrl+Alt+O` |
| **OAI Chat: Explain Selection** | editor right-click (sends immediately) |
| **OAI Chat: Add Active File to Chat** | editor right-click |
| **OAI Chat: Add to OAI Chat** | explorer right-click (multi-select works) |
| **OAI Chat: Fix Workspace Problems** | command palette |

---

## 📝 Other Features

### Persistent sessions
- Create unlimited sessions, switch between them instantly
- Export any session as JSON
- Sessions survive VS Code restarts and reloads

### Multi-model support
Supports both direct local models and VS Code hosted models:
- **Direct Local Ollama** — auto-detects all models pulled in your local Ollama daemon (`http://127.0.0.1:11434`), streaming with full context window (`num_ctx: 8192`) and native function calling without needing any bridge extension (`devstral-small`, `qwen2.5-coder`, `llama3.1`, etc.).
- **VS Code Language Model API** — works with GitHub Copilot (GPT-4o, Claude 3.5 Sonnet), Continue, LM Studio, and any other extension providing models to VS Code.

Models that don't support tool calling still work: the extension notices, retries without tools, and tells you to use `@` references instead.

### Dedicated Git integration
Inspect and manage Git without leaving the chat:
- Check working tree changes (`git_status`, `git_diff`)
- Browse recent commits (`git_log`)
- Safely commit changes (`git_commit`) with full diff preview and interactive approval

### Automatic context compaction
- When a conversation exceeds the token budget, the extension summarises old messages using the model itself
- The most recent messages are always kept verbatim (configurable)
- Compaction is only committed after a successful response — failed requests never destroy history

### Tool activity in the transcript
Each tool call appears as a collapsible card (`✓ read src/app.js`) you can expand to see exactly what the model saw. Activity is saved with the session, so you can audit a conversation later.

### System prompts per session
Set a persistent system prompt for each session. Survives context compaction.

### Streaming with cancellation & timeout protection
Responses stream token-by-token with an always-clickable **■ Stop** button. An idle timeout watchdog prevents stalled streams from locking the UI. Partial responses are displayed; failed responses leave history intact.

## 🛠️ Requirements

- **VS Code 1.95+** (1.95 is where the language-model tool API landed)
- Either:
  - Local [Ollama](https://ollama.com/) running locally (`ollama serve`), OR
  - An extension that contributes language models (such as [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)).

For file editing, the model must support tool calling. Most hosted models do; among local models, tool-capable builds (e.g. `qwen2.5-coder`, `devstral`, `llama3.1`) work best.

## 📦 Installation

Search for **OAI Chat Persistence** in the VS Code Extensions view, or:

```
ext install bhlevca.oai-chat-persistence
```

## 🎯 Usage

1. Click the chat bubble icon in the **Activity Bar** (or press `Ctrl+Shift+O` / `Cmd+Shift+O`)
2. Click **＋** to create a new session, name it, and choose whether it starts in agent mode
3. Select a model from the dropdown
4. Ask for what you want — e.g. *"rename `hello` to `greet` everywhere and update the tests"* — then approve the diffs

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+O` / `Cmd+Shift+O` | Open / focus chat panel |
| `Ctrl+Alt+O` / `Cmd+Alt+O` | Add the editor selection to the chat |
| `Enter` | Send message |
| `Shift+Enter` | New line in message |

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| `oaiChatPersistence.defaultModel` | `""` | Model ID to pre-select for new sessions |
| `oaiChatPersistence.defaultAgentMode` | `true` | Start new sessions in agent mode |
| `oaiChatPersistence.enableWriteTools` | `true` | Expose `write_file` / `edit_file` / `delete_file` to the model |
| `oaiChatPersistence.editApproval` | `ask` | `ask` shows a diff card per change; `auto` applies edits immediately |
| `oaiChatPersistence.enableTerminalTool` | `false` | Let the model run shell commands (always individually approved) |
| `oaiChatPersistence.enableGitTools` | `true` | Expose dedicated git tools (`git_status`, `git_diff`, `git_log`, `git_commit`) |
| `oaiChatPersistence.ollamaHost` | `http://127.0.0.1:11434` | Base URL of local Ollama server for direct local model communication |
| `oaiChatPersistence.ollamaContextWindow` | `8192` | Context window (`num_ctx`) sent to Ollama for local model chat completions |
| `oaiChatPersistence.includeEditorContext` | `true` | Attach a one-line note about the active file to each message |
| `oaiChatPersistence.maxToolRounds` | `12` | Maximum tool-call rounds per reply |
| `oaiChatPersistence.maxFileBytes` | `64000` | Byte cap for files handed to the model |
| `oaiChatPersistence.allowWritesOutsideWorkspace` | `false` | Permit edits outside the open workspace folders |
| `oaiChatPersistence.contextWindowTokens` | `6000` | Token budget before auto-compaction triggers (~4 chars/token). `0` disables |
| `oaiChatPersistence.compactionKeepMessages` | `8` | Most-recent messages kept verbatim after compaction |

## 💾 Session Storage

Sessions are stored as plain JSON files at:

```
~/.vscode/oai-chat-persistence/<session-name>.json
```

Back them up, version-control them, or copy them between machines.

## 🔒 Safety Notes

- Nothing is written without your approval unless you set `editApproval` to `auto`
- Deletions and shell commands are **never** auto-approved
- Edits go through VS Code's edit API, so `Ctrl+Z` works
- Files outside the open workspace folders are off-limits by default
- The shell tool is disabled until you enable it

## 🧪 Development

```bash
npm test          # mocked-API test suite (no VS Code needed)
npm run lint      # syntax check all sources
./dev.sh          # package and install into VS Code
```

Press `F5` in VS Code to launch the extension host.

## 🔄 Side-by-Side with Copilot Chat

If the OAI Chat panel conflicts with Copilot Chat in the Activity Bar, right-click the OAI Chat icon → **Move to Secondary Side Bar** to have both visible simultaneously.

## 🐛 Feedback & Issues

Found a bug or have a feature request? Open an issue on [GitHub](https://github.com/bhlevca/oai-chat-persistence/issues).

## 📜 License

MIT — see [LICENSE](LICENSE)
