'use strict';

/**
 * Wrapper around the VS Code Language Model API (vscode.lm).
 *
 * Models are provided by extensions such as GitHub Copilot or an Ollama
 * extension. This module runs the agentic loop: it streams text, executes any
 * tool calls the model makes against the workspace, feeds the results back and
 * keeps going until the model stops asking for tools.
 */

const crypto = require('crypto');
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

const STREAM_TIMEOUT_MS = 45_000;

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

/** Convert stored messages to Ollama chat format. */
function toOllamaMessages(messages, preamble) {
  const systemContent = [
    preamble,
    ...messages.filter((m) => m.role === 'system').map((m) => m.content),
  ].filter(Boolean).join('\n\n');

  const result = [];
  if (systemContent) {
    result.push({ role: 'system', content: systemContent });
  }

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg._tool) {
      const head = (msg.content || '').split('\n').slice(0, 3).join(' ').slice(0, 300);
      result.push({
        role: 'tool',
        content: `[tool ${msg.label || msg.name}: ${msg.ok === false ? 'failed' : 'ok'}] ${head}`,
      });
      continue;
    }
    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content || '' });
    } else if (msg.role === 'assistant' && (msg.content || '').trim()) {
      result.push({ role: 'assistant', content: msg.content });
    }
  }
  return result;
}

// ── Stream timeout wrapper ───────────────────────────────────────────────────

async function* withStreamTimeout(stream, timeoutMs, cancellationToken) {
  const iterator = stream[Symbol.asyncIterator]();
  while (true) {
    if (cancellationToken.isCancellationRequested) break;
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Model response timed out — no data received for ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
    });

    try {
      const nextPromise = iterator.next();
      const res = await Promise.race([nextPromise, timeoutPromise]);
      clearTimeout(timer);
      if (res.done) break;
      yield res.value;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}

// ── Ollama Provider ───────────────────────────────────────────────────────────

function getOllamaHost() {
  const host = vscode.workspace
    .getConfiguration('oaiChatPersistence').get('ollamaHost') || 'http://127.0.0.1:11434';
  return host.replace(/\/+$/, '');
}

/**
 * List models directly available from the local Ollama daemon.
 */
async function listOllamaModels() {
  const host = getOllamaHost();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.models)) return [];
    return data.models.map((m) => {
      const name = m.name || m.model;
      return {
        id:     `ollama:${name}`,
        label:  `${name} (Ollama)`,
        vendor: 'Ollama',
        family: m.details?.family || '',
      };
    });
  } catch {
    return [];
  }
}

/** Check if text contains Mistral [TOOL_CALLS] or JSON blocks */
function extractTextToolCalls(text) {
  const calls = [];
  const idx = text.indexOf('[TOOL_CALLS]');
  if (idx !== -1) {
    const after = text.slice(idx + '[TOOL_CALLS]'.length).trim();
    try {
      const parsed = JSON.parse(after);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item?.name) {
            calls.push({
              callId: crypto.randomBytes(6).toString('hex'),
              name: item.name,
              input: item.arguments || {},
            });
          }
        }
      }
    } catch {
      // not JSON
    }
  }
  return calls;
}

/**
 * Direct stream chat completion against Ollama /api/chat.
 */
async function streamOllamaChat(modelId, messages, handlers, cancellationToken, opts = {}) {
  const onChunk = handlers.onChunk || (() => {});
  const agent   = opts.agent !== false;
  const host    = getOllamaHost();
  const model   = modelId.replace(/^ollama:/, '');

  const numCtx = vscode.workspace
    .getConfiguration('oaiChatPersistence').get('ollamaContextWindow') || 8192;
  const maxRounds = vscode.workspace
    .getConfiguration('oaiChatPersistence').get('maxToolRounds') || 12;

  const activeTools = opts.toolsEnabled !== false ? tools.toolsFor({ agent }) : [];
  const ollamaTools = activeTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));

  const preamble = !activeTools.length ? '' : agent ? AGENT_PREAMBLE : READONLY_PREAMBLE;
  let currentMessages = toOllamaMessages(messages, preamble);

  let fullText = '';
  const toolRecords = [];
  let toolsDisabled = !activeTools.length;

  for (let round = 0; round < maxRounds; round++) {
    if (cancellationToken.isCancellationRequested) break;

    const controller = new AbortController();
    const cancelSub = cancellationToken.onCancellationRequested?.(() => controller.abort());

    let res;
    try {
      res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: currentMessages,
          stream: true,
          options: { num_ctx: numCtx },
          ...(toolsDisabled ? {} : { tools: ollamaTools }),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      cancelSub?.dispose?.();
      if (cancellationToken.isCancellationRequested) break;
      if (err.name === 'AbortError') {
        throw new Error('Request was cancelled.');
      }
      throw new Error(`Could not connect to Ollama at ${host}. Make sure Ollama is running ('ollama serve').`);
    }

    if (!res.ok) {
      cancelSub?.dispose?.();
      const errText = await res.text().catch(() => '');
      if (!toolsDisabled && (errText.includes('tool') || res.status === 400)) {
        toolsDisabled = true;
        handlers.onNotice?.('This Ollama model does not support tool calling — continuing without tools.');
        currentMessages = toOllamaMessages(messages, '');
        round--;
        continue;
      }
      throw new Error(`Ollama error (${res.status}): ${errText || res.statusText}`);
    }

    let roundText = '';
    const toolCalls = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        if (cancellationToken.isCancellationRequested) break;

        let timer;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Ollama response stalled — no data received for ${Math.round(STREAM_TIMEOUT_MS / 1000)}s.`));
          }, STREAM_TIMEOUT_MS);
        });

        const readPromise = reader.read();
        const { value, done } = await Promise.race([readPromise, timeoutPromise]);
        clearTimeout(timer);

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // save incomplete line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.message?.content) {
              roundText += data.message.content;
              fullText += data.message.content;
              onChunk(data.message.content);
            }
            if (Array.isArray(data.message?.tool_calls)) {
              for (const tc of data.message.tool_calls) {
                let args = tc.function?.arguments;
                if (typeof args === 'string') {
                  try { args = JSON.parse(args); } catch {}
                }
                toolCalls.push({
                  callId: crypto.randomBytes(6).toString('hex'),
                  name: tc.function?.name,
                  input: args || {},
                });
              }
            }
          } catch {
            // ignore malformed JSON chunk
          }
        }
      }
    } finally {
      cancelSub?.dispose?.();
      reader.releaseLock();
    }

    // Fallback: extract Mistral text tool calls if the model outputted them into content
    if (!toolCalls.length && roundText.includes('[TOOL_CALLS]')) {
      toolCalls.push(...extractTextToolCalls(roundText));
    }

    if (!toolCalls.length || cancellationToken.isCancellationRequested) break;

    const assistantMsg = {
      role: 'assistant',
      content: roundText,
      tool_calls: toolCalls.map((c) => ({
        function: { name: c.name, arguments: c.input },
      })),
    };

    const toolResultMsgs = [];
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

      toolResultMsgs.push({
        role: 'tool',
        content: text,
      });
    }

    currentMessages = [
      ...currentMessages,
      assistantMsg,
      ...toolResultMsgs,
    ];

    if (round === maxRounds - 1) {
      handlers.onNotice?.(`Stopped after ${maxRounds} tool rounds (oaiChatPersistence.maxToolRounds).`);
    }
  }

  return { text: fullText, toolCalls: toolRecords };
}

// ── VS Code LM Provider ───────────────────────────────────────────────────────

/**
 * List all language models registered with VS Code.
 * @returns {Promise<{ id: string, label: string, vendor: string, family: string }[]>}
 */
async function listVSCodeModels() {
  if (!vscode.lm?.selectChatModels) return [];
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
 * List all language models (VS Code LM API + local Ollama daemon).
 * @returns {Promise<{ id: string, label: string, vendor: string, family: string }[]>}
 */
async function listModels() {
  const [vscodeModels, ollamaModels] = await Promise.all([
    listVSCodeModels(),
    listOllamaModels(),
  ]);
  return [...vscodeModels, ...ollamaModels];
}

function _looksLikeToolUnsupported(err) {
  const msg = `${err?.message || ''} ${err?.code || ''}`.toLowerCase();
  return msg.includes('tool') && (
    msg.includes('not support') || msg.includes('unsupported') ||
    msg.includes('invalid') || msg.includes('unknown')
  );
}

/**
 * Stream a chat completion via VS Code LM API, running tool calls against workspace.
 */
async function streamVSCodeLmChat(modelId, messages, handlers, cancellationToken, opts = {}) {
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

    // Stream with idle timeout protection against deadlocked providers
    const timedStream = withStreamTimeout(response.stream, STREAM_TIMEOUT_MS, cancellationToken);

    for await (const chunk of timedStream) {
      if (cancellationToken.isCancellationRequested) break;

      if (vscode.LanguageModelTextPart && chunk instanceof vscode.LanguageModelTextPart) {
        roundText.push(chunk.value);
        onChunk(chunk.value);
        fullText += chunk.value;
      } else if (toolApi && chunk instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(chunk);
      } else if (typeof chunk?.value === 'string') {
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

/**
 * Unified stream chat completion: routes to direct Ollama or VS Code LM provider.
 */
async function streamChat(modelId, messages, handlers, cancellationToken, opts = {}) {
  if (modelId.startsWith('ollama:')) {
    return streamOllamaChat(modelId, messages, handlers, cancellationToken, opts);
  }
  return streamVSCodeLmChat(modelId, messages, handlers, cancellationToken, opts);
}

module.exports = {
  listModels,
  listOllamaModels,
  streamChat,
  streamOllamaChat,
  AGENT_PREAMBLE,
  READONLY_PREAMBLE,
};

