'use strict';

const vscode  = require('vscode');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const storage = require('./storage');
const lm      = require('./lm');
const ws      = require('./workspace');

/**
 * ChatPanel implements vscode.WebviewViewProvider so the panel lives in the
 * Activity-Bar sidebar instead of the editor-column area.
 */
class ChatPanel {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this._context = context;
    this._view    = null;   // vscode.WebviewView — set in resolveWebviewView
    this._cts     = null;   // CancellationTokenSource for the active request
    this._pendingApprovals = new Map(); // id -> { resolve, req }
    this._approveAllForTurn = false;
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
        this._rejectAllApprovals();
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

    // Keep the workspace-context strip in the UI live
    const pushCtx = () => this._post({ type: 'editorContext', context: ws.editorContext() });
    vscode.window.onDidChangeActiveTextEditor(pushCtx, null, this._context.subscriptions);
    vscode.window.onDidChangeTextEditorSelection(pushCtx, null, this._context.subscriptions);
    pushCtx();
  }

  /** Reveal the view in the sidebar. */
  async focus() {
    await vscode.commands.executeCommand('oaiChatPersistence.chatView.focus');
  }

  /** Drop text into the message box (used by editor commands). */
  async insertIntoInput(text, { autoSend = false } = {}) {
    const ready = !!this._view;
    await this.focus();
    if (ready) {
      this._post({ type: 'insertIntoInput', text, autoSend });
      return;
    }
    // The webview is still booting — flush this once it asks for its init data.
    this._pendingInsert = { text, autoSend };
  }

  // ── Message dispatcher ────────────────────────────────────────────────────

  async _handle(msg) {
    switch (msg.type) {
      case 'init':             return this._sendInit();
      case 'loadSession':      return this._loadSession(msg.name);
      case 'createSession':    return this._createSession(msg.name, msg.modelId, msg.agent);
      case 'deleteSession':    return this._deleteSession(msg.name);
      case 'sendMessage':      return this._sendMessage(msg);
      case 'stopGeneration':   return this._stopGeneration();
      case 'updateModel':      return this._updateModel(msg.name, msg.modelId);
      case 'setAgentMode':     return this._setAgentMode(msg.name, msg.agent);
      case 'setSystemPrompt':  return this._setSystemPrompt(msg.name, msg.content);
      case 'clearSession':     return this._clearSession(msg.name);
      case 'exportSession':    return this._exportSession(msg.name);
      case 'refreshModels':    return this._refreshModels();
      case 'compactNow':       return this._compactNow(msg.name, msg.modelId);
      case 'approvalResponse': return this._resolveApproval(msg.id, msg.approved, msg.applyAll);
      case 'showApprovalDiff': return this._showApprovalDiff(msg.id);
      case 'applyBlock':       return this._applyBlock(msg);
      case 'insertBlock':      return this._insertBlock(msg);
      case 'newFileFromBlock': return this._newFileFromBlock(msg);
      case 'diffBlock':        return this._diffBlock(msg);
      case 'openFile':         return this._openFile(msg.path, msg.line);
      case 'pickFile':         return this._pickFile();
      case 'requestEditorContext': return this._post({ type: 'editorContext', context: ws.editorContext() });
    }
  }

  // ── Session handlers ──────────────────────────────────────────────────────

  async _sendInit() {
    const [sessions, models] = await Promise.all([
      Promise.resolve(storage.listSessions()),
      lm.listModels(),
    ]);
    const cfg = vscode.workspace.getConfiguration('oaiChatPersistence');
    this._post({
      type: 'init',
      sessions,
      models,
      context: ws.editorContext(),
      capabilities: {
        writeTools:    cfg.get('enableWriteTools') !== false,
        terminalTool:  cfg.get('enableTerminalTool') === true,
        autoApprove:   cfg.get('editApproval') === 'auto',
        defaultAgent:  cfg.get('defaultAgentMode') !== false,
        hasWorkspace:  ws.workspaceFolders().length > 0,
      },
    });
    if (this._pendingInsert) {
      const pending = this._pendingInsert;
      this._pendingInsert = null;
      this._post({ type: 'insertIntoInput', ...pending });
    }
  }

  _loadSession(name) {
    // Switching session re-renders the transcript, which would discard any
    // approval card still waiting for a click — end the turn first.
    this._stopGeneration();
    const session = storage.loadSession(name);
    if (session) this._post({ type: 'sessionLoaded', session: this._normalize(session) });
  }

  /** Sessions written before agent mode existed have no `agent` flag. */
  _normalize(session) {
    if (session.agent === undefined) {
      session.agent = vscode.workspace
        .getConfiguration('oaiChatPersistence').get('defaultAgentMode') !== false;
      storage.saveSession(session);
    }
    return session;
  }

  _createSession(name, modelId, agentFlag) {
    if (!name) return;
    const agent = agentFlag === undefined
      ? vscode.workspace.getConfiguration('oaiChatPersistence').get('defaultAgentMode') !== false
      : !!agentFlag;
    const session = storage.createSession(name, modelId || '', { agent });
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

  _setAgentMode(name, agent) {
    const session = storage.loadSession(name);
    if (!session) return;
    session.agent = !!agent;
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
    this._rejectAllApprovals();
  }

  // ── Tool approval bridge ──────────────────────────────────────────────────

  /**
   * Ask the user to approve a mutating tool call.
   * Resolves true when the change may be applied.
   */
  _requestApproval(req) {
    const auto = vscode.workspace
      .getConfiguration('oaiChatPersistence').get('editApproval') === 'auto';
    if (!req.neverAuto && (auto || this._approveAllForTurn)) {
      this._post({ type: 'toolApprovalAuto', req: { ...req, proposed: undefined } });
      return Promise.resolve(true);
    }
    if (!this._view) return Promise.resolve(false);

    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve) => {
      this._pendingApprovals.set(id, { resolve, req });
      this._post({
        type: 'toolApproval',
        id,
        req: {
          kind: req.kind,
          title: req.title,
          detail: req.detail || '',
          diff: req.diff || '',
          stats: req.stats || null,
          command: req.command || '',
          canDiff: !!req.uri,
          canApplyAll: !req.neverAuto,
        },
      });
    });
  }

  _resolveApproval(id, approved, applyAll) {
    const entry = this._pendingApprovals.get(id);
    if (!entry) return;
    this._pendingApprovals.delete(id);
    if (approved && applyAll) this._approveAllForTurn = true;
    entry.resolve(!!approved);
  }

  _rejectAllApprovals() {
    for (const [id, entry] of this._pendingApprovals) {
      this._pendingApprovals.delete(id);
      entry.resolve(false);
      this._post({ type: 'approvalClosed', id, approved: false });
    }
  }

  async _showApprovalDiff(id) {
    const entry = this._pendingApprovals.get(id);
    if (!entry?.req?.uri) return;
    try {
      await ws.showProposedDiff(
        vscode.Uri.parse(entry.req.uri),
        entry.req.proposed ?? '',
        entry.req.title
      );
    } catch (e) {
      vscode.window.showErrorMessage(`OAI Chat: could not open diff — ${e.message}`);
    }
  }

  // ── Code-block actions (replaces copy/paste) ──────────────────────────────

  /** Resolve the file a code block should act on. */
  async _resolveBlockTarget(hintPath) {
    if (hintPath) {
      try { return ws.resolveUri(hintPath); } catch { /* fall through */ }
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) return active;
    return null;
  }

  async _applyBlock({ code, path: hintPath }) {
    if (/^\s*(?:\{[\s\S]*?"(?:name|tool)"\s*:|\[TOOL_CALLS\])/.test(code)) {
      vscode.window.showWarningMessage('OAI Chat: This code block appears to be a tool call, not file content.');
      return;
    }
    const uri = await this._resolveBlockTarget(hintPath);
    if (!uri) {
      vscode.window.showWarningMessage(
        'OAI Chat: no target file. Open the file first, or use "New file".'
      );
      return;
    }
    try {
      ws.assertWritable(uri);
      const before = await ws.currentText(uri);
      if (before === code) {
        vscode.window.showInformationMessage(`OAI Chat: ${ws.label(uri)} already matches that block.`);
        return;
      }
      await ws.showProposedDiff(uri, code, `${ws.label(uri)} ↔ proposed`);
      const { added, removed } = ws.diffStats(before, code);
      const choice = await vscode.window.showInformationMessage(
        `Replace ${ws.label(uri)} with this block? (+${added}/-${removed})`,
        { modal: true },
        'Apply'
      );
      if (choice !== 'Apply') return;
      const { created } = await ws.writeWholeFile(uri, code);
      await ws.openFileAtLine(uri, 0);
      this._post({
        type: 'actionResult',
        text: `${created ? 'Created' : 'Updated'} ${ws.label(uri)} (+${added}/-${removed})`,
      });
    } catch (e) {
      this._post({ type: 'actionResult', text: `Failed: ${e.message}`, error: true });
    }
  }

  async _insertBlock({ code }) {
    try {
      const where = await ws.insertAtCursor(code);
      this._post({ type: 'actionResult', text: `Inserted into ${where}` });
    } catch (e) {
      this._post({ type: 'actionResult', text: `Failed: ${e.message}`, error: true });
    }
  }

  async _newFileFromBlock({ code, path: hintPath }) {
    const suggestion = hintPath || '';
    const answer = await vscode.window.showInputBox({
      prompt: 'New file path (relative to the workspace root)',
      value: suggestion,
      validateInput: (v) => (v.trim() ? null : 'Path required'),
    });
    if (!answer) return;
    try {
      const uri = ws.resolveUri(answer.trim());
      ws.assertWritable(uri);
      if (await ws.exists(uri)) {
        const choice = await vscode.window.showWarningMessage(
          `${ws.label(uri)} already exists. Overwrite?`, { modal: true }, 'Overwrite'
        );
        if (choice !== 'Overwrite') return;
      }
      await ws.writeWholeFile(uri, code);
      await ws.openFileAtLine(uri, 0);
      this._post({ type: 'actionResult', text: `Created ${ws.label(uri)}` });
    } catch (e) {
      this._post({ type: 'actionResult', text: `Failed: ${e.message}`, error: true });
    }
  }

  async _diffBlock({ code, path: hintPath }) {
    const uri = await this._resolveBlockTarget(hintPath);
    if (!uri) {
      vscode.window.showWarningMessage('OAI Chat: no target file to diff against.');
      return;
    }
    try {
      await ws.showProposedDiff(uri, code, `${ws.label(uri)} ↔ proposed`);
    } catch (e) {
      this._post({ type: 'actionResult', text: `Failed: ${e.message}`, error: true });
    }
  }

  async _openFile(p, line) {
    try {
      await ws.openFileAtLine(ws.resolveUri(p), Number(line) || 0);
    } catch (e) {
      vscode.window.showErrorMessage(`OAI Chat: ${e.message}`);
    }
  }

  /** Quick-pick a workspace file and drop an @reference into the input box. */
  async _pickFile() {
    const uris = await ws.findFiles('**/*', 3000);
    if (!uris.length) {
      vscode.window.showInformationMessage('OAI Chat: no workspace files found.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      uris.map((u) => ({ label: ws.label(u), uri: u })),
      { placeHolder: 'Attach a file to the chat', matchOnDescription: true }
    );
    if (picked) this._post({ type: 'insertIntoInput', text: `@${picked.label} ` });
  }

  // ── Context injection (@references) ───────────────────────────────────────

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
        if (ws.SKIP_DIRS.has(entry.name)) continue;
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
      base    = ws.workspaceRoot()?.fsPath || '';
      pattern = spec;
    }
    const re       = this._globToRegex(pattern);
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
      base = ws.workspaceRoot()?.fsPath || '';
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

  /** Live-editor pseudo references: @active, @selection, @tabs, @problems. */
  _handleEditorRef(keyword) {
    const ctx = ws.editorContext();
    if (keyword === 'active') {
      if (!ctx.file) return '\n[@active: no file is open in the editor]\n';
      try {
        const text = fs.readFileSync(ctx.fsPath, 'utf8');
        const MAX  = 24_000;
        const body = text.length > MAX ? text.slice(0, MAX) + '\n[…truncated]' : text;
        return `\n\`\`\`${ctx.language || ''}\n# File: ${ctx.file}\n${body}\n\`\`\`\n`;
      } catch (e) {
        return `\n[@active: could not read ${ctx.file}: ${e.message}]\n`;
      }
    }
    if (keyword === 'selection') {
      if (!ctx.selection) return '\n[@selection: nothing is selected in the editor]\n';
      return `\n\`\`\`${ctx.language || ''}\n# ${ctx.file} lines ` +
        `${ctx.selection.startLine}-${ctx.selection.endLine}\n${ctx.selection.text}\n\`\`\`\n`;
    }
    if (keyword === 'tabs') {
      return `\n\`\`\`\n# Open editor tabs\n${ctx.tabs.join('\n') || '(none)'}\n\`\`\`\n`;
    }
    if (keyword === 'problems') {
      const diags = ws.diagnostics();
      if (!diags.length) return '\n[@problems: no diagnostics reported]\n';
      return '\n```\n# Problems\n' + diags
        .map((d) => `${d.severity.toUpperCase()} ${d.file}:${d.line} ${d.message}`)
        .join('\n') + '\n```\n';
    }
    return null;
  }

  /**
   * Resolve @-references in a message and return augmented content.
   *
   *   @active / @selection / @tabs / @problems → live editor context
   *   @src/panel.js          → inlines file content
   *   @src/                  → lists directory
   *   @/absolute/path        → same, anywhere on filesystem
   *   @find:*.js             → lists matching files in workspace
   *   @search:myFunc         → grep for text in workspace
   */
  async _injectFileRefs(content) {
    const RE = /@((?:find|search):[^\s]+|[\w.\-/\\]+)/g;
    const matches = [...content.matchAll(RE)];
    if (!matches.length) return content;

    const root = ws.workspaceRoot();

    let result = content;
    for (const m of matches) {
      const ref = m[1];
      let injected;

      const editorRef = this._handleEditorRef(ref);
      if (editorRef !== null) {
        injected = editorRef;
      } else if (ref.startsWith('find:')) {
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
      // Function replacement: file content may contain $& / $1 patterns.
      result = result.replace(m[0], () => injected);
    }
    return result;
  }

  /** One-line note about what the user is looking at, appended to their turn. */
  _editorContextNote() {
    if (vscode.workspace.getConfiguration('oaiChatPersistence').get('includeEditorContext') === false) {
      return '';
    }
    const ctx = ws.editorContext();
    if (!ctx.file) return '';
    const sel = ctx.selection
      ? `, selection lines ${ctx.selection.startLine}-${ctx.selection.endLine}`
      : '';
    return `\n\n[workspace context: active file ${ctx.file} (${ctx.language}), ` +
      `cursor line ${ctx.cursorLine}${sel}]`;
  }

  // ── The request ───────────────────────────────────────────────────────────

  async _sendMessage({ name, modelId, content }) {
    // Cancel any in-flight request
    if (this._cts) this._cts.cancel();
    this._rejectAllApprovals();
    this._cts = new vscode.CancellationTokenSource();
    const cancelToken = this._cts.token;
    this._approveAllForTurn = false;

    const stored     = storage.loadSession(name);
    if (stored) this._normalize(stored);
    const useModelId = modelId || stored?.model;
    const agent      = stored?.agent !== false;
    if (!useModelId) {
      this._post({
        type: 'streamEnd',
        error: 'No model selected. Choose a model in the session header.',
        aborted: false,
        assistantContent: '',
      });
      return;
    }

    // Expand @file references, then note what the user is looking at
    const expandedContent = (await this._injectFileRefs(content)) + this._editorContextNote();

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

    this._post({ type: 'streamStart' });

    const toolEntries = [];   // persisted after the turn, in call order
    let result      = { text: '', toolCalls: [] };
    let streamError = null;
    let aborted     = false;

    try {
      result = await lm.streamChat(
        useModelId,
        session.messages,
        {
          onChunk: (chunk) => this._post({ type: 'chunk', content: chunk }),
          onResetStream: (content) => this._post({ type: 'resetStream', content: content || '' }),
          onNotice: (text) => this._post({ type: 'notice', text }),
          onToolStart: (info) => this._post({
            type: 'toolStart', id: info.id, name: info.name, label: info.label,
          }),
          onToolEnd: (info) => {
            toolEntries.push({
              role: 'tool',
              _tool: true,
              name: info.name,
              label: info.label,
              ok: info.ok,
              content: info.result,
              timestamp: new Date().toISOString(),
            });
            this._post({
              type: 'toolEnd', id: info.id, name: info.name, label: info.label,
              ok: info.ok, result: info.result.slice(0, 4000),
            });
          },
          requestApproval: (req) => this._requestApproval(req),
        },
        cancelToken,
        { agent }
      );
    } catch (err) {
      if (cancelToken.isCancellationRequested) {
        aborted = true;
      } else {
        streamError = err.code ? `${err.message} (code: ${err.code})` : err.message;
      }
    }

    this._rejectAllApprovals();

    const didWork = !!(result.text && result.text.trim()) || toolEntries.length > 0;

    if (didWork) {
      // Commit: the compacted session if compaction ran, otherwise whatever is
      // on disk now, then the tool activity and the assistant reply in order.
      const base = didCompact ? session : (storage.loadSession(name) || session);
      base.messages.push(...toolEntries);
      if (result.text && result.text.trim()) {
        base.messages.push({
          role: 'assistant',
          content: result.text,
          timestamp: new Date().toISOString(),
        });
      }
      storage.saveSession(base);
    }
    // Nothing happened (error before any output): compaction is discarded and
    // the session on disk still has every original message.

    // streamEnd MUST arrive before sessionLoaded — finalizeStreamBubble must run
    // before renderChat() can wipe messages.innerHTML.
    this._post({
      type: 'streamEnd',
      error: streamError,
      aborted,
      assistantContent: result.text,
      toolCount: toolEntries.length,
    });

    // Re-render from disk whenever the stored history diverged from what the
    // webview rendered incrementally (compaction and/or tool activity).
    if (didWork && (didCompact || toolEntries.length)) {
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
   * exceeds the configured limit.
   *
   * @param {string} name
   * @param {object} session
   * @param {string} modelId
   * @param {vscode.CancellationToken} cancelToken
   * @param {boolean} [force=false]  bypass token-limit check
   * @returns {Promise<{ session: object, didCompact: boolean }>}
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
    // Everything else (regular chat, tool activity, previous compact summaries)
    const chatHistory = session.messages.filter((m) => !(m.role === 'system' && !m._compact));

    if (chatHistory.length <= keepCount + 1) return { session, didCompact: false };

    const toSummarize = chatHistory.slice(0, -keepCount);
    const toKeep      = chatHistory.slice(-keepCount);

    // Signal the webview to show the compaction indicator
    this._post({ type: 'compacting' });

    const convText = toSummarize
      .map((m) => {
        const label = m._compact ? '[PREVIOUS SUMMARY]'
          : m._tool ? `[TOOL ${m.label || m.name}]`
          : m.role.toUpperCase();
        return `${label}:\n${m.content}`;
      })
      .join('\n\n---\n\n');

    const summaryPrompt = [{
      role: 'user',
      content:
        'Summarise the following conversation history concisely. ' +
        'Preserve all important facts, decisions, code references, technical details, ' +
        'file paths that were changed, and outcomes. ' +
        'The summary will replace these messages as context for continuing the conversation. ' +
        'Output only the summary text, no preamble or headings.\n\n' + convText,
    }];

    let summary = '';
    try {
      const res = await lm.streamChat(
        modelId, summaryPrompt, { onChunk: () => {} }, cancelToken,
        { agent: false, toolsEnabled: false }
      );
      summary = res.text;
    } catch {
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
    // the compacted state only after the turn produced something.

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
