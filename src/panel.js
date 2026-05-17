'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');
const lm = require('./ollama'); // VS Code LM API wrapper

/**
 * ChatPanel implements vscode.WebviewViewProvider so the panel lives in the
 * Activity-Bar sidebar instead of the editor-column area.
 */
class ChatPanel {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this._context = context;
    this._view   = null;   // vscode.WebviewView — set in resolveWebviewView
    this._cts    = null;   // CancellationTokenSource for the active request
  }

  /** Called by VS Code when the view first becomes visible (or is re-created). */
  resolveWebviewView(webviewView, _viewContext, _token) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    // Load HTML and inject a fresh nonce
    const nonce    = crypto.randomBytes(16).toString('hex');
    const htmlPath = path.join(this._context.extensionPath, 'src', 'webview.html');
    webviewView.webview.html = fs.readFileSync(htmlPath, 'utf8')
      .replace(/\{\{NONCE\}\}/g, nonce);

    webviewView.webview.onDidReceiveMessage(
      (msg) => this._handle(msg),
      null,
      this._context.subscriptions
    );

    webviewView.onDidDispose(
      () => {
        if (this._cts) this._cts.cancel();
        this._view = null;
      },
      null,
      this._context.subscriptions
    );

    // Re-send init data whenever the view becomes visible (e.g. switching back
    // from another sidebar panel). Also re-cache the view reference in case
    // onDidDispose cleared it while the webview was still technically alive.
    webviewView.onDidChangeVisibility(
      () => {
        if (webviewView.visible) {
          this._view = webviewView;
          this._sendInit();
        }
      },
      null,
      this._context.subscriptions
    );

    // Refresh the model list whenever available models change
    if (vscode.lm?.onDidChangeChatModels) {
      vscode.lm.onDidChangeChatModels(
        () => this._refreshModels(),
        null,
        this._context.subscriptions
      );
    }
  }

  /** Reveal the view in the sidebar. */
  focus() {
    vscode.commands.executeCommand('oaiChatPersistence.chatView.focus');
  }

  // ── Message dispatcher ────────────────────────────────────────────────────

  async _handle(msg) {
    switch (msg.type) {
      case 'init':           return this._sendInit();
      case 'loadSession':    return this._loadSession(msg.name);
      case 'createSession':  return this._createSession(msg.name, msg.modelId);
      case 'deleteSession':  return this._deleteSession(msg.name);
      case 'sendMessage':    return this._sendMessage(msg);
      case 'stopGeneration': return this._stopGeneration();
      case 'updateModel':    return this._updateModel(msg.name, msg.modelId);
      case 'setSystemPrompt':return this._setSystemPrompt(msg.name, msg.content);
      case 'clearSession':   return this._clearSession(msg.name);
      case 'exportSession':  return this._exportSession(msg.name);
      case 'refreshModels':  return this._refreshModels();
      case 'compactNow':     return this._compactNow(msg.name, msg.modelId);
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async _sendInit() {
    const [sessions, models] = await Promise.all([
      Promise.resolve(storage.listSessions()),
      lm.listModels(),
    ]);
    this._post({ type: 'init', sessions, models });
  }

  _loadSession(name) {
    const session = storage.loadSession(name);
    if (session) this._post({ type: 'sessionLoaded', session });
  }

  _createSession(name, modelId) {
    if (!name) return;
    const session = storage.createSession(name, modelId || '');
    this._post({ type: 'sessionLoaded', session });
    this._post({ type: 'sessions', sessions: storage.listSessions() });
  }

  _deleteSession(name) {
    storage.deleteSession(name);
    this._post({ type: 'sessions', sessions: storage.listSessions() });
  }

  _updateModel(name, modelId) {
    const session = storage.loadSession(name);
    if (!session) return;
    session.model = modelId;
    storage.saveSession(session);
  }

  _setSystemPrompt(name, content) {
    const session = storage.loadSession(name);
    if (!session) return;
    session.messages = session.messages.filter((m) => m.role !== 'system');
    if (content.trim()) {
      session.messages.unshift({
        role: 'system',
        content: content.trim(),
        timestamp: new Date().toISOString(),
      });
    }
    storage.saveSession(session);
    this._post({ type: 'sessionLoaded', session });
  }

  _clearSession(name) {
    const session = storage.loadSession(name);
    if (!session) return;
    session.messages = [];
    storage.saveSession(session);
    this._post({ type: 'sessionLoaded', session });
    this._post({ type: 'sessions', sessions: storage.listSessions() });
  }

  _exportSession(name) {
    const messages = storage.exportSession(name);
    if (!messages) return;
    vscode.workspace
      .openTextDocument({ content: JSON.stringify(messages, null, 2), language: 'json' })
      .then((doc) => vscode.window.showTextDocument(doc, { preview: false }));
  }

  _stopGeneration() {
    if (this._cts) this._cts.cancel();
  }

  // ── File injection helpers ────────────────────────────────────────────────

  /** Convert a glob pattern to a RegExp (supports * and **). */
  _globToRegex(pattern) {
    const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00')
      .replace(/\*/g, '[^/]*')
      .replace(/\x00/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(esc + '$', 'i');
  }

  /** Recursively collect file paths under dir, up to maxFiles. */
  async _walkDir(dir, results, maxFiles = 200, depth = 0) {
    if (depth > 10 || results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        await this._walkDir(full, results, maxFiles, depth + 1);
      } else {
        results.push(full);
      }
    }
  }

  /** @find:pattern  or  @find:/base/dir:pattern */
  async _handleFind(spec) {
    let base, pattern;
    const colon = spec.indexOf(':');
    if (colon > 0 && path.isAbsolute(spec.slice(0, colon))) {
      base    = spec.slice(0, colon);
      pattern = spec.slice(colon + 1);
    } else {
      const folders = vscode.workspace.workspaceFolders;
      base    = folders?.[0]?.uri.fsPath || '';
      pattern = spec;
    }
    const re      = this._globToRegex(pattern);
    const allFiles = [];
    await this._walkDir(base, allFiles, 500);
    const hits = allFiles.filter(f => re.test(f.replace(/\\/g, '/')));
    if (!hits.length) return `\n[find: no files matching "${pattern}" under ${base}]\n`;
    return `\n\`\`\`\n# find ${pattern} (base: ${base})\n${hits.join('\n')}\n\`\`\`\n`;
  }

  /** @search:term  or  @search:/base/dir:term */
  async _handleSearch(spec) {
    let base, term;
    const colon = spec.indexOf(':');
    if (colon > 0 && path.isAbsolute(spec.slice(0, colon))) {
      base = spec.slice(0, colon);
      term = spec.slice(colon + 1);
    } else {
      const folders = vscode.workspace.workspaceFolders;
      base = folders?.[0]?.uri.fsPath || '';
      term = spec;
    }
    const allFiles = [];
    await this._walkDir(base, allFiles, 300);
    const hits = [];
    for (const f of allFiles) {
      if (hits.length >= 50) break;
      try {
        const text  = fs.readFileSync(f, 'utf8');
        const lines = text.split('\n');
        const matched = lines
          .map((l, i) => ({ n: i + 1, l }))
          .filter(({ l }) => l.includes(term));
        if (matched.length) {
          hits.push(`\n## ${f}\n` + matched.map(({ n, l }) => `${n}: ${l}`).join('\n'));
        }
      } catch { /* binary / unreadable */ }
    }
    if (!hits.length) return `\n[search: "${term}" not found under ${base}]\n`;
    return `\n\`\`\`\n# search "${term}" (base: ${base})\n${hits.join('\n')}\n\`\`\`\n`;
  }

  /**
   * Resolve @-references in a message and return augmented content.
   *
   *   @src/panel.js          → inlines file content
   *   @src/                  → lists directory
   *   @/absolute/path        → same, anywhere on filesystem
   *   @find:*.js             → lists matching files in workspace
   *   @find:/dir:*.js        → lists matching files under /dir
   *   @search:myFunc         → grep for text in workspace
   *   @search:/dir:myFunc    → grep for text under /dir
   */
  async _injectFileRefs(content) {
    // Match @find:..., @search:..., or @path (no spaces)
    const RE = /@((?:find|search):[^\s]+|[\w.\-/\\]+)/g;
    const matches = [...content.matchAll(RE)];
    if (!matches.length) return content;

    const folders = vscode.workspace.workspaceFolders;
    const root    = folders?.[0]?.uri;

    let result = content;
    for (const m of matches) {
      const ref = m[1];
      let injected;

      if (ref.startsWith('find:')) {
        injected = await this._handleFind(ref.slice('find:'.length));
      } else if (ref.startsWith('search:')) {
        injected = await this._handleSearch(ref.slice('search:'.length));
      } else {
        const fsPath = path.isAbsolute(ref)
          ? ref.replace(/[\/\\]+$/, '')
          : root ? path.join(root.fsPath, ref) : null;
        if (!fsPath) { injected = `\n[No workspace open for: ${ref}]\n`; }
        else {
          try {
            const stat = fs.statSync(fsPath);
            if (stat.isDirectory()) {
              const entries = fs.readdirSync(fsPath, { withFileTypes: true });
              const listing = entries
                .map(e => (e.isDirectory() ? e.name + '/' : e.name))
                .sort().join('\n');
              injected = `\n\`\`\`\n# Directory: ${ref}\n${listing}\n\`\`\`\n`;
            } else {
              const text = fs.readFileSync(fsPath, 'utf8');
              const MAX  = 24_000;
              const body = text.length > MAX ? text.slice(0, MAX) + '\n[…truncated]' : text;
              const ext  = ref.split('.').pop() || '';
              injected = `\n\`\`\`${ext}\n# File: ${ref}\n${body}\n\`\`\`\n`;
            }
          } catch (e) {
            injected = `\n[Could not read: ${ref}: ${e.message}]\n`;
          }
        }
      }
      result = result.replace(m[0], injected);
    }
    return result;
  }

  async _sendMessage({ name, modelId, content }) {
    // Cancel any in-flight request
    if (this._cts) this._cts.cancel();
    this._cts = new vscode.CancellationTokenSource();
    const cancelToken = this._cts.token;

    const useModelId = modelId || storage.loadSession(name)?.model;
    if (!useModelId) {
      this._post({
        type: 'streamEnd',
        error: 'No model selected. Choose a model in the session header.',
        aborted: false,
        assistantContent: '',
      });
      return;
    }

    // Expand @file references before persisting or sending
    const expandedContent = await this._injectFileRefs(content);

    // Persist the user message (store expanded version so history is self-contained)
    let session = storage.appendMessage(name, 'user', expandedContent);
    this._post({ type: 'sessions', sessions: storage.listSessions() });

    // Compact context if token budget is exceeded (deferred — only saved to disk
    // after a successful stream, so a failed response never destroys history).
    const { session: workingSession, didCompact } =
      await this._compactIfNeeded(name, session, useModelId, cancelToken);
    session = workingSession;
    if (cancelToken.isCancellationRequested) {
      this._post({ type: 'streamEnd', error: null, aborted: true, assistantContent: '' });
      return;
    }

    // Strip internal fields — LM API only wants role + content
    const lmMessages = session.messages.map(({ role, content: c }) => ({ role, content: c }));

    this._post({ type: 'streamStart' });

    let fullResponse = '';
    let streamError = null;
    let aborted = false;

    try {
      fullResponse = await lm.streamChat(
        useModelId,
        lmMessages,
        (chunk) => this._post({ type: 'chunk', content: chunk }),
        cancelToken
      );
    } catch (err) {
      if (cancelToken.isCancellationRequested) {
        aborted = true;
      } else {
        streamError = err.code
          ? `${err.message} (code: ${err.code})`
          : err.message;
      }
    }

    if (fullResponse) {
      // Stream succeeded — commit any pending compaction, then save assistant msg.
      if (didCompact) storage.saveSession(session);
      storage.appendMessage(name, 'assistant', fullResponse);
    }
    // If stream failed / was aborted: compaction is discarded (session on disk
    // still has every original message).

    // streamEnd MUST arrive before sessionLoaded — finalizeStreamBubble must run
    // before renderChat() can wipe messages.innerHTML.
    this._post({
      type: 'streamEnd',
      error: streamError,
      aborted,
      assistantContent: fullResponse,
    });

    // Now it is safe to fire sessionLoaded (re-render with compact card).
    // Load fresh from storage so the session already contains the assistant reply.
    if (fullResponse && didCompact) {
      const finalSession = storage.loadSession(name);
      if (finalSession) this._post({ type: 'sessionLoaded', session: finalSession });
    }

    this._post({ type: 'sessions', sessions: storage.listSessions() });
  }

  /** Trigger compaction manually from the UI (ignores token limit). */
  async _compactNow(name, modelId) {
    if (this._cts) this._cts.cancel();
    this._cts = new vscode.CancellationTokenSource();
    const cancelToken = this._cts.token;

    const session = storage.loadSession(name);
    if (!session) return;

    const useModelId = modelId || session.model;
    if (!useModelId) {
      this._post({ type: 'streamEnd', error: 'No model selected.', aborted: false, assistantContent: '' });
      return;
    }

    const { session: compacted } =
      await this._compactIfNeeded(name, session, useModelId, cancelToken, /* force */ true);
    // Manual compact always saves and notifies immediately
    storage.saveSession(compacted);
    this._post({ type: 'sessionLoaded', session: compacted });
    this._post({ type: 'sessions', sessions: storage.listSessions() });
    // Send a terminal streamEnd so the webview re-enables input
    this._post({ type: 'streamEnd', error: null, aborted: cancelToken.isCancellationRequested, assistantContent: '' });
  }

  /**
   * Summarise the older portion of a session when the estimated token count
   * exceeds the configured limit, then persist the compacted session.
   *
   * @param {string} name
   * @param {object} session
   * @param {string} modelId
   * @param {vscode.CancellationToken} cancelToken
   * @param {boolean} [force=false]  bypass token-limit check
   * @returns {Promise<object>}  the (possibly compacted) session
   */
  async _compactIfNeeded(name, session, modelId, cancelToken, force = false) {
    const cfg        = vscode.workspace.getConfiguration('oaiChatPersistence');
    const tokenLimit = cfg.get('contextWindowTokens') || 6000;
    const keepCount  = cfg.get('compactionKeepMessages') || 8;

    if (!force && this._estimateTokens(session.messages) <= tokenLimit) {
      return { session, didCompact: false };
    }

    // Preserve explicit user-set system prompts (no _compact flag)
    const userSystem = session.messages.filter((m) => m.role === 'system' && !m._compact);
    // Everything else (regular chat + previous compact summaries)
    const chatHistory = session.messages.filter((m) => !(m.role === 'system' && !m._compact));

    if (chatHistory.length <= keepCount + 1) return { session, didCompact: false }; // not enough to compact

    const toSummarize = chatHistory.slice(0, -keepCount);
    const toKeep      = chatHistory.slice(-keepCount);

    // Signal the webview to show the compaction indicator
    this._post({ type: 'compacting' });

    const convText = toSummarize
      .map((m) => {
        const label = m._compact ? '[PREVIOUS SUMMARY]' : m.role.toUpperCase();
        return `${label}:\n${m.content}`;
      })
      .join('\n\n---\n\n');

    const summaryPrompt = [{
      role: 'user',
      content:
        'Summarise the following conversation history concisely. ' +
        'Preserve all important facts, decisions, code references, technical details, and outcomes. ' +
        'The summary will replace these messages as context for continuing the conversation. ' +
        'Output only the summary text, no preamble or headings.\n\n' + convText,
    }];

    let summary = '';
    try {
      summary = await lm.streamChat(modelId, summaryPrompt, () => {}, cancelToken);
    } catch {
      // Compaction failed — continue without it
      this._post({ type: 'compactDone', success: false });
      return { session, didCompact: false };
    }

    if (cancelToken.isCancellationRequested || !summary) {
      this._post({ type: 'compactDone', success: false });
      return { session, didCompact: false };
    }

    const compactMsg = {
      role: 'system',
      content: summary,
      _compact: true,
      compactedCount: toSummarize.length,
      timestamp: new Date().toISOString(),
    };

    session.messages = [...userSystem, compactMsg, ...toKeep];
    // NOTE: do NOT save here when called from _sendMessage — the caller commits
    // the compacted state only after the stream succeeds (see didCompact flag).
    // _compactNow (manual) passes force=true AND saves itself after this returns.

    this._post({ type: 'compactDone', success: true });

    return { session, didCompact: true };
  }

  /** Rough token estimate: ~4 chars per token + small role overhead. */
  _estimateTokens(messages) {
    return messages.reduce(
      (sum, m) => sum + Math.ceil((m.content || '').length / 4) + 4,
      0
    );
  }

  async _refreshModels() {
    const models = await lm.listModels();
    this._post({ type: 'models', models });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _post(msg) {
    this._view?.webview.postMessage(msg);
  }
}

module.exports = { ChatPanel };
