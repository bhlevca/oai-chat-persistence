'use strict';
// Minimal stand-in for the VS Code extension API, backed by the real fs.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

class Uri {
  constructor(scheme, fsPath) { this.scheme = scheme; this.fsPath = fsPath; this.path = fsPath; }
  static file(p) { return new Uri('file', p); }
  static parse(v) { return Uri.file(v.replace(/^file:\/\//, '')); }
  static from({ scheme, path: p }) { return new Uri(scheme, p); }
  static joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }
  toString() { return `${this.scheme}://${this.fsPath}`; }
  with(o) { return new Uri(o.scheme || this.scheme, o.path || this.fsPath); }
}

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
class Selection extends Range {
  constructor(a, b) { super(a, b); this.active = b; this.anchor = a; }
  get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
}

class WorkspaceEdit {
  constructor() { this.edits = []; }
  replace(uri, range, text) { this.edits.push({ uri, range, text }); }
  createFile(uri) { this.edits.push({ uri, create: true }); }
}

const docs = new Map();
function makeDoc(uri) {
  const text = fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8') : '';
  const lines = text.split('\n');
  return {
    uri, isUntitled: false, languageId: 'javascript',
    lineCount: lines.length,
    getText: () => (docs.get(uri.fsPath) ?? text),
    lineAt: (n) => ({ range: new Range(new Position(n, 0), new Position(n, (lines[n] || '').length)) }),
    save: async () => { fs.writeFileSync(uri.fsPath, docs.get(uri.fsPath) ?? text); return true; },
  };
}

const config = {
  contextWindowTokens: 6000,
  compactionKeepMessages: 8,
  maxFileBytes: 64000,
  allowWritesOutsideWorkspace: false,
  maxToolRounds: 12,
  editApproval: 'ask',
  enableWriteTools: true,
  enableTerminalTool: true,
  includeEditorContext: true,
  defaultAgentMode: true,
  ollamaHost: 'http://127.0.0.1:11434',
  ollamaContextWindow: 8192,
  enableGitTools: true,
};

const state = { folders: [], activeEditor: null, diagnostics: [], infoMessages: [] };

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(full, out, depth + 1); }
    else out.push(full);
  }
  return out;
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\?/g, '[^/]')
    .replace(/\*\*\//g, '\x01').replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*').replace(/\x00/g, '.*').replace(/\x01/g, '(?:.*/)?');
  return new RegExp('^' + esc + '$');
}

class LanguageModelTextPart { constructor(value) { this.value = value; } }
class LanguageModelToolCallPart {
  constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; }
}
class LanguageModelToolResultPart {
  constructor(callId, parts) { this.callId = callId; this.content = parts; }
}
const LanguageModelChatMessage = {
  User: (content) => ({ role: 'user', content }),
  Assistant: (content) => ({ role: 'assistant', content }),
};

class CancellationTokenSource {
  constructor() {
    this._cancelled = false;
    const self = this;
    this.token = { get isCancellationRequested() { return self._cancelled; } };
  }
  cancel() { this._cancelled = true; }
  dispose() {}
}

const vscode = {
  CancellationTokenSource,
  LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart,
  LanguageModelChatMessage,
  FileType, Uri, Position, Range, Selection, WorkspaceEdit,
  EndOfLine: { LF: 1 },
  TextEditorRevealType: { InCenter: 2 },
  workspace: {
    get workspaceFolders() { return state.folders; },
    textDocuments: [],
    getConfiguration: () => ({ get: (k) => config[k] }),
    fs: {
      readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
      writeFile: async (uri, bytes) => fs.writeFileSync(uri.fsPath, Buffer.from(bytes)),
      stat: async (uri) => {
        const st = fs.statSync(uri.fsPath);
        return { size: st.size, type: st.isDirectory() ? FileType.Directory : FileType.File };
      },
      readDirectory: async (uri) => fs.readdirSync(uri.fsPath, { withFileTypes: true })
        .map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File]),
      createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
      delete: async (uri, opts) => fs.rmSync(uri.fsPath, { recursive: !!opts?.recursive, force: true }),
    },
    openTextDocument: async (uri) => makeDoc(uri),
    applyEdit: async (edit) => {
      for (const e of edit.edits) {
        if (e.create) { fs.writeFileSync(e.uri.fsPath, ''); continue; }
        docs.set(e.uri.fsPath, e.text);
        fs.writeFileSync(e.uri.fsPath, e.text);
      }
      return true;
    },
    findFiles: async (glob, exclude, limit) => {
      const root = state.folders[0]?.uri.fsPath;
      if (!root) return [];
      const re = globToRe(glob);
      return walk(root)
        .filter((f) => re.test(path.relative(root, f).split(path.sep).join('/')))
        .slice(0, limit || 100)
        .map((f) => Uri.file(f));
    },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }),
  },
  window: {
    get activeTextEditor() { return state.activeEditor; },
    tabGroups: { all: [] },
    showInformationMessage: async (m) => { state.infoMessages.push(m); return undefined; },
    showWarningMessage: async (m) => { state.infoMessages.push(m); return undefined; },
    showErrorMessage: async (m) => { state.infoMessages.push(m); return undefined; },
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => ({ selection: null, revealRange() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeTextEditorSelection: () => ({ dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
  },
  languages: { getDiagnostics: (uri) => (uri ? [] : state.diagnostics) },
  commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose() {} }) },
  lm: null,
  _state: state, _config: config, _docs: docs,
};

module.exports = vscode;
