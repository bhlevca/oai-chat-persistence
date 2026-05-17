'use strict';

// Wraps the VS Code Language Model API (vscode.lm).
// Models are provided by extensions like GitHub Copilot or the Ollama VS Code extension.
// Tool calling gives the model read access to the workspace file system.

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description:
      'Read the full text content of a file in the open VS Code workspace. ' +
      'Use this whenever the user asks about specific files, code, configs, or logs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'File path relative to the workspace root (e.g. "src/app.js") or an absolute path.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description:
      'List the files and subdirectories inside a workspace directory. ' +
      'Use this to explore project structure before reading specific files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Directory path relative to workspace root. Use "" or "." for the root.',
        },
      },
    },
  },
];

/** Execute a tool call and return its text result. */
function _executeTool(name, input) {
  const folders = vscode.workspace.workspaceFolders;

  if (name === 'read_file') {
    let fsPath;
    if (path.isAbsolute(input.path || '')) {
      fsPath = input.path;
    } else if (folders?.length) {
      fsPath = path.join(folders[0].uri.fsPath, input.path || '');
    } else {
      return 'Error: no workspace folder is open.';
    }
    try {
      const content = fs.readFileSync(fsPath, 'utf8');
      const MAX     = 24_000;
      return content.length > MAX
        ? content.slice(0, MAX) + `\n\n[… truncated at ${MAX} chars]`
        : content;
    } catch (e) {
      return `Error reading "${input.path}": ${e.message}`;
    }
  }

  if (name === 'list_directory') {
    const dirPath = input.path ?? '';
    let fsPath;
    if (path.isAbsolute(dirPath)) {
      fsPath = dirPath.replace(/[/\\]+$/, '');
    } else if (folders?.length) {
      fsPath = (!dirPath || dirPath === '.')
        ? folders[0].uri.fsPath
        : path.join(folders[0].uri.fsPath, dirPath);
    } else {
      return 'Error: no workspace folder is open.';
    }
    try {
      const entries = fs.readdirSync(fsPath, { withFileTypes: true });
      if (!entries.length) return '(empty directory)';
      return entries
        .map(e => (e.isDirectory() ? e.name + '/' : e.name))
        .sort()
        .join('\n');
    } catch (e) {
      return `Error listing "${dirPath || '.'}": ${e.message}`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ── VS Code message conversion ────────────────────────────────────────────────

/**
 * Convert stored messages (with optional 'system' role) to VS Code LM message objects.
 * The LM API has no system role — system content is prepended to the first user message.
 */
function toVSCodeMessages(messages) {
  const systemContent = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');

  const result = [];
  let systemApplied = false;

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const text =
        !systemApplied && systemContent
          ? `${systemContent}\n\n${msg.content}`
          : msg.content;
      result.push(vscode.LanguageModelChatMessage.User(text));
      systemApplied = true;
    } else if (msg.role === 'assistant') {
      result.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
    }
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List all language models registered with VS Code (Copilot, Ollama extension, etc.)
 * @returns {Promise<{ id: string, label: string, vendor: string, family: string }[]>}
 */
async function listModels() {
  if (!vscode.lm) return [];
  try {
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({
      id:     m.id,
      label:  m.name || `${m.vendor} / ${m.family}`,
      vendor: m.vendor || '',
      family: m.family || '',
    }));
  } catch {
    return [];
  }
}

/**
 * Stream a chat completion via the VS Code LM API.
 *
 * If the model invokes tools (read_file / list_directory), this function
 * handles the full agentic round-trip automatically: executes the tool,
 * feeds the result back, and continues streaming — up to 10 rounds.
 *
 * @param {string}   modelId
 * @param {{ role: string, content: string }[]} messages
 * @param {(token: string) => void} onChunk
 * @param {vscode.CancellationToken} cancellationToken
 * @returns {Promise<string>}  full accumulated response
 */
async function streamChat(modelId, messages, onChunk, cancellationToken) {
  if (!vscode.lm) {
    throw new Error('vscode.lm API is not available. Requires VS Code 1.90+.');
  }

  const [model] = await vscode.lm.selectChatModels({ id: modelId });
  if (!model) {
    throw new Error(
      `Model "${modelId}" is not available. Make sure the extension providing it is active.`
    );
  }

  let currentMessages = toVSCodeMessages(messages);
  let fullResponse    = '';
  const MAX_ROUNDS    = 10; // guard against infinite tool-call loops

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (cancellationToken.isCancellationRequested) break;

    const response = await model.sendRequest(
      currentMessages,
      {
        justification: 'OAI Chat Persistence: continuing a saved conversation',
        tools: TOOLS,
      },
      cancellationToken
    );

    const roundText  = [];
    const toolCalls  = [];

    for await (const chunk of response.stream) {
      if (cancellationToken.isCancellationRequested) break;

      if (chunk instanceof vscode.LanguageModelTextPart) {
        roundText.push(chunk.value);
        onChunk(chunk.value);
        fullResponse += chunk.value;
      } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(chunk);
      } else if (typeof chunk?.value === 'string') {
        // Fallback for older VS Code builds
        roundText.push(chunk.value);
        onChunk(chunk.value);
        fullResponse += chunk.value;
      }
    }

    if (toolCalls.length === 0) break; // No tool calls — conversation finished

    // Build the assistant turn (text so far + tool call requests)
    const assistantMsg = vscode.LanguageModelChatMessage.Assistant([
      ...roundText.map((t) => new vscode.LanguageModelTextPart(t)),
      ...toolCalls,
    ]);

    // Execute every tool and collect results
    const toolResultParts = [];
    for (const call of toolCalls) {
      const result = await _executeTool(call.name, call.input);
      toolResultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(result),
        ])
      );
    }

    // Tool results go back as a User message
    const toolResultMsg = vscode.LanguageModelChatMessage.User(toolResultParts);
    currentMessages = [...currentMessages, assistantMsg, toolResultMsg];
  }

  return fullResponse;
}

module.exports = { listModels, streamChat };

