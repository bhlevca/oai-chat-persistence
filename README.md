# OAI Chat Persistence

**Persistent, multi-session AI chat for Ollama, local LLMs, and any VS Code-compatible model.**

Chat history survives restarts, sessions are stored as plain JSON files you own, and any VS Code-compatible model works — Ollama, GitHub Copilot, LM Studio, and more.

## 🚀 Why This Extension?

✅ **Persistent Sessions** — Chats saved to `~/.vscode/oai-chat-persistence/<session-name>.json`, reload automatically  
✅ **Works with Any Model** — Uses the standard `vscode.lm` API (same as GitHub Copilot Chat)  
✅ **Automatic Context Compaction** — Summarises old messages when the token budget is exceeded; never destroys history on a failed response  
✅ **File Injection** — Inject files, directories, or search results with `@` syntax  
✅ **Offline-Friendly** — No cloud dependency; works with local models like Ollama  

## 🔥 How It Compares

| Feature | OAI Chat Persistence | Ollama Chat | Copilot Chat |
|---|---|---|---|
| Persists chats | ✅ Yes | ❌ No | ✅ Yes (cloud) |
| Works with Ollama | ✅ Yes | ✅ Yes | ❌ No |
| Offline-capable | ✅ Yes | ✅ Yes | ❌ No |
| File injection (`@`) | ✅ Yes | ❌ No | ✅ Yes |
| Multi-session | ✅ Yes | ❌ No | ✅ Yes |

## 📝 Features

### Persistent Sessions
- Create unlimited sessions, switch between them instantly
- Export any session as JSON
- Sessions survive VS Code restarts and reloads

### Multi-Model Support
Works with any extension that contributes language models via `vscode.lm`:
- **Ollama** — local models (llama3, devstral, qwen, etc.)
- **GitHub Copilot** — GPT-4o, Claude, and more
- **LM Studio**, **Continue**, and others

### Automatic Context Compaction
- When a conversation exceeds the token budget, the extension summarises old messages using the model itself
- The most recent messages are always kept verbatim (configurable)
- Compaction only commits to disk **after a successful response** — failed requests never destroy history

### File Injection with `@` References
| Syntax | What it injects |
|---|---|
| `@src/panel.js` | Full file contents |
| `@src/` | Directory listing |
| `@/home/user/.vscode/` | Absolute directory listing |
| `@find:*.ts` | All `.ts` files in workspace |
| `@find:/path:*.json` | All `.json` files under any directory |
| `@search:myFunction` | All lines containing `myFunction` |
| `@search:/path:term` | Grep under any directory |

**No tool calling required — works with every model.**

### System Prompts per Session
Set a persistent system prompt for each session. Survives context compaction.

### Streaming with Cancellation
- Responses stream token-by-token with a stop button
- Partial responses are displayed; failed responses leave history intact

## 🛠️ Requirements

- **VS Code 1.90+**
- At least one extension that contributes language models:
  - [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
  - [Ollama for VS Code](https://marketplace.visualstudio.com/items?itemName=ms-vscode.ollama)
  - [Continue](https://marketplace.visualstudio.com/items?itemName=Continue.continue) or similar

## 📦 Installation

Search for **OAI Chat Persistence** in the VS Code Extensions view, or:

```
ext install bhlevca.oai-chat-persistence
```

## 🎯 Usage

1. Click the chat bubble icon in the **Activity Bar** (or press `Ctrl+Shift+O` / `Cmd+Shift+O`)
2. Click **＋** to create a new session and give it a name
3. Select a model from the dropdown
4. Start chatting — history is saved automatically

### Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+O` / `Cmd+Shift+O` | Open / focus chat panel |
| `Enter` | Send message |
| `Shift+Enter` | New line in message |

## ⚙️ Configuration

| Setting | Default | Description |
|---|---|---|
| `oaiChatPersistence.defaultModel` | `""` | Model ID to pre-select for new sessions |
| `oaiChatPersistence.contextWindowTokens` | `6000` | Token budget before auto-compaction triggers (~4 chars/token). Set to `0` to disable. |
| `oaiChatPersistence.compactionKeepMessages` | `8` | Number of most-recent messages kept verbatim after compaction |

## 💾 Session Storage

Sessions are stored as plain JSON files at:

```
~/.vscode/oai-chat-persistence/<session-name>.json
```

Back them up, version-control them, or copy them between machines.

## 🔄 Side-by-Side with Copilot Chat

If the OAI Chat panel conflicts with Copilot Chat in the Activity Bar, right-click the OAI Chat icon → **Move to Secondary Side Bar** to have both visible simultaneously.

## 🐛 Feedback & Issues

Found a bug or have a feature request? Open an issue on [GitHub](https://github.com/bhlevca/oai-chat-persistence/issues).

## 📜 License

MIT — see [LICENSE](LICENSE)


## Features

### Persistent sessions
Conversations are saved to `~/.vscode/oai-chat-persistence/<session-name>.json` and reloaded automatically. Create as many sessions as you like, switch between them instantly, export any session as JSON.

### Works with any VS Code language model
Uses the standard `vscode.lm` API — it sees the same models as GitHub Copilot Chat: local Ollama models, Copilot models, or any other extension that contributes language models.

### Automatic context compaction
When a conversation grows beyond the configured token budget, the extension summarises the oldest messages using the model itself, replacing them with a compact card. The most recent N messages are always kept verbatim. Compaction only commits to disk after a successful response — a failed request never destroys history.

### File injection with `@` references
Attach any file, directory listing, or search result directly into your message:

| Syntax | What it injects |
|---|---|
| `@src/panel.js` | Full file contents |
| `@src/` | Directory listing |
| `@/home/user/.vscode/` | Absolute directory listing |
| `@find:*.ts` | All `.ts` files in workspace |
| `@find:/path:*.json` | All `.json` files under a path |
| `@search:myFunction` | All lines containing `myFunction` |
| `@search:/path:term` | Grep under any directory |

The model receives the actual content — no tool calling required, works with every model.

### System prompts per session
Set a persistent system prompt for each session via the toolbar button. Survives compaction.

### Streaming with cancellation
Responses stream token-by-token with a stop button. Partial responses are displayed; failed responses leave history intact.

## Requirements

- VS Code 1.90+
- At least one extension that contributes language models:
  - [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) — GPT-4o, Claude, etc.
  - [Ollama for VS Code](https://marketplace.visualstudio.com/items?itemName=Continue.continue) or similar — local models

## Installation

Search for **OAI Chat Persistence** in the VS Code Extensions view, or:

```
ext install bhlevca.oai-chat-persistence
```

## Usage

1. Click the chat bubble icon in the Activity Bar (or press `Ctrl+Shift+O` / `Cmd+Shift+O`)
2. Click **＋** to create a new session and give it a name
3. Select a model from the dropdown
4. Start chatting — history is saved automatically

### Keyboard shortcut

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+O` / `Cmd+Shift+O` | Open / focus the chat panel |
| `Enter` | Send message |
| `Shift+Enter` | New line in message |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `oaiChatPersistence.defaultModel` | `""` | Model ID to pre-select for new sessions |
| `oaiChatPersistence.contextWindowTokens` | `6000` | Token budget before auto-compaction triggers (~4 chars/token). Set to `0` to disable. |
| `oaiChatPersistence.compactionKeepMessages` | `8` | Number of most-recent messages kept verbatim after compaction |

## Session storage

Sessions are stored as plain JSON files at:
```
~/.vscode/oai-chat-persistence/<session-name>.json
```
You can back them up, version-control them, or copy them between machines.

## Tip: Side-by-side with Copilot Chat

If the OAI Chat panel conflicts with Copilot Chat in the Activity Bar, right-click the OAI Chat icon → **Move to Secondary Side Bar** to have both visible simultaneously.

## License

MIT — see [LICENSE](LICENSE)
