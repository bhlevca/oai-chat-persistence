'use strict';

/**
 * Wrapper around the VS Code Language Model API (vscode.lm).
 *
 * Models are provided by extensions such as GitHub Copilot or an Ollama
 * extension. This module runs the agentic loop: it streams text, executes any
 * tool calls the model makes against the workspace, feeds the results back and
 * keeps going until the model stops asking for tools.
 */

const vscode = require('vscode');
const tools  = require('./tools');

const AGENT_PREAMBLE = [
  'You are working inside the user\'s VS Code workspace and you have tools that read and change it.',
  '',
  'Rules:',
  '- Use the tools instead of telling the user what to type. Read a file before editing it.',
  '- Use search_text / find_files to locate code rather than guessing paths.',
  '- Apply changes with edit_file (targeted) or write_file (whole file). Never print a patch and ask the user to apply it by hand.',
  '- write_file needs the complete final content; never use placeholders like "... rest unchanged".',
  '- Every change is shown to the user as a diff for approval. If a change is rejected, stop and ask what to do differently.',
  '- After editing code, consider get_diagnostics to verify it still compiles.',
  '- Keep prose short; the work happens in the files.',
].join('\n');

const READONLY_PREAMBLE = [
  'You are working inside the user\'s VS Code workspace. You have read-only tools.',
  'Use them to inspect real files instead of guessing, and use search_text / find_files to locate code.',
  'You cannot modify files in this mode: when you propose a change, emit a fenced code block whose',
  'info string is the target path (for example ```js src/panel.js) so the user can apply it in one click.',
].join('\n');

// ── Message conversion ────────────────────────────────────────────────────────

/**
 * Convert stored messages to VS Code LM messages.
 * The LM API has no system role, so system content is folded into the first
 * user message. Internal entries (tool activity) are skipped.
 */
function toVSCodeMessages(messages, preamble) {
  const systemContent = [
    preamble,
    ...messages.filter((m) => m.role === 'system').map((m) => m.content),
  ].filter(Boolean).join('\n\n');

  const result = [];
  let systemApplied = false;

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg._tool) {
      // Replayed history: keep a one-line trace so the model remembers what it
      // already did, without re-feeding entire file dumps into the context.
      const head = (msg.content || '').split('\n').slice(0, 3).join(' ').slice(0, 300);
      result.push(vscode.LanguageModelChatMessage.Assistant(
        `[tool ${msg.label || msg.name}: ${msg.ok === false ? 'failed' : 'ok'}] ${head}`
      ));
      continue;
    }
    if (msg.role === 'user') {
      const text = !systemApplied && systemContent
        ? `${systemContent}\n\n${msg.content}`
        : msg.content;
      result.push(vscode.LanguageModelChatMessage.User(text));
      systemApplied = true;
    } else if (msg.role === 'assistant' && (msg.content || '').trim()) {
      result.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
    }
  }

  // A conversation that starts with an assistant turn (or has no user turn at
  // all) would drop the system content entirely — prepend it as a user turn.
  if (!systemApplied && systemContent) {
    result.unshift(vscode.LanguageModelChatMessage.User(systemContent));
  }
  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List all language models registered with VS Code.
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

function _looksLikeToolUnsupported(err) {
  const msg = `${err?.message || ''} ${err?.code || ''}`.toLowerCase();
  return msg.includes('tool') && (
    msg.includes('not support') || msg.includes('unsupported') ||
    msg.includes('invalid') || msg.includes('unknown')
  );
}

/**
 * Stream a chat completion, running tool calls against the workspace.
 *
 * @param {string} modelId
 * @param {{ role: string, content: string }[]} messages
 * @param {{
 *   onChunk: (text: string) => void,
 *   onToolStart?: (info: { id: string, name: string, label: string, input: object }) => void,
 *   onToolEnd?: (info: { id: string, name: string, label: string, ok: boolean, result: string }) => void,
 *   onNotice?: (text: string) => void,
 *   requestApproval?: (req: object) => Promise<boolean>,
 * }} handlers
 * @param {vscode.CancellationToken} cancellationToken
 * @param {{ agent?: boolean, toolsEnabled?: boolean }} [opts]
 * @returns {Promise<{ text: string, toolCalls: object[] }>}
 */
async function streamChat(modelId, messages, handlers, cancellationToken, opts = {}) {
  if (!vscode.lm) {
    throw new Error('vscode.lm API is not available. Requires VS Code 1.90+.');
  }
  const onChunk = handlers.onChunk || (() => {});
  const agent   = opts.agent !== false;

  const [model] = await vscode.lm.selectChatModels({ id: modelId });
  if (!model) {
    throw new Error(
      `Model "${modelId}" is not available. Make sure the extension providing it is active.`
    );
  }

  // Tool calling needs VS Code 1.95+. On older builds the part classes are
  // missing, so run plain chat rather than throwing on `instanceof undefined`.
  const toolApi = !!(vscode.LanguageModelToolCallPart && vscode.LanguageModelToolResultPart);
  if (!toolApi && opts.toolsEnabled !== false) {
    handlers.onNotice?.(
      'This VS Code build has no language-model tool API (needs 1.95+) — ' +
      'running without workspace tools. Use @file references to supply context.'
    );
  }
  const useTools    = opts.toolsEnabled !== false && toolApi;
  const activeTools = useTools ? tools.toolsFor({ agent }) : [];
  const lmTools     = tools.toLmTools(activeTools);

  const preamble = !useTools ? '' : agent ? AGENT_PREAMBLE : READONLY_PREAMBLE;
  let currentMessages = toVSCodeMessages(messages, preamble);

  const maxRounds = vscode.workspace
    .getConfiguration('oaiChatPersistence').get('maxToolRounds') || 12;

  let fullText      = '';
  const toolRecords = [];
  let toolsDisabled = !useTools;

  for (let round = 0; round < maxRounds; round++) {
    if (cancellationToken.isCancellationRequested) break;

    let response;
    try {
      response = await model.sendRequest(
        currentMessages,
        {
          justification: 'OAI Chat Persistence: continuing a saved conversation',
          ...(toolsDisabled ? {} : { tools: lmTools }),
        },
        cancellationToken
      );
    } catch (err) {
      // Some providers (notably small local models) reject the tools payload.
      // Retry once without tools so the conversation still works.
      if (!toolsDisabled && _looksLikeToolUnsupported(err)) {
        toolsDisabled = true;
        handlers.onNotice?.(
          'This model does not support tool calling — continuing without workspace tools. ' +
          'Use @file references to supply context.'
        );
        currentMessages = toVSCodeMessages(messages, '');
        round--;
        continue;
      }
      throw err;
    }

    const roundText = [];
    const toolCalls = [];

    for await (const chunk of response.stream) {
      if (cancellationToken.isCancellationRequested) break;

      if (vscode.LanguageModelTextPart && chunk instanceof vscode.LanguageModelTextPart) {
        roundText.push(chunk.value);
        onChunk(chunk.value);
        fullText += chunk.value;
      } else if (toolApi && chunk instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(chunk);
      } else if (typeof chunk?.value === 'string') {
        // Fallback for older VS Code builds
        roundText.push(chunk.value);
        onChunk(chunk.value);
        fullText += chunk.value;
      }
    }

    if (!toolCalls.length || cancellationToken.isCancellationRequested) break;

    const assistantMsg = vscode.LanguageModelChatMessage.Assistant([
      ...roundText.map((t) => new vscode.LanguageModelTextPart(t)),
      ...toolCalls,
    ]);

    const resultParts = [];
    for (const call of toolCalls) {
      const label = tools.summarize(activeTools, call.name, call.input);
      handlers.onToolStart?.({ id: call.callId, name: call.name, label, input: call.input });

      const { ok, text } = await tools.execute(
        call.name,
        call.input,
        { requestApproval: handlers.requestApproval || (async () => false) },
        activeTools
      );

      handlers.onToolEnd?.({ id: call.callId, name: call.name, label, ok, result: text });
      toolRecords.push({ name: call.name, label, ok, result: text });

      resultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(text),
        ])
      );
    }

    currentMessages = [
      ...currentMessages,
      assistantMsg,
      vscode.LanguageModelChatMessage.User(resultParts),
    ];

    if (round === maxRounds - 1) {
      handlers.onNotice?.(`Stopped after ${maxRounds} tool rounds (oaiChatPersistence.maxToolRounds).`);
    }
  }

  return { text: fullText, toolCalls: toolRecords };
}

module.exports = { listModels, streamChat, AGENT_PREAMBLE, READONLY_PREAMBLE };
