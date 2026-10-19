'use strict';

/**
 * Workspace primitives shared by the tool layer and the chat panel.
 *
 * Everything that touches the user's files goes through here so that path
 * resolution, workspace containment and undo behaviour stay consistent:
 * content changes are applied as a vscode.WorkspaceEdit (so Ctrl+Z works),
 * never by writing bytes behind VS Code's back.
 */

const vscode = require('vscode');
const path   = require('path');
const cp     = require('child_process');

const PROPOSED_SCHEME = 'oai-proposed';

/** Virtual documents backing the diff previews: uri.path -> text */
const _proposed = new Map();

/** Register the read-only provider used for "proposed content" diff views. */
function registerProposedProvider(context) {
  const provider = {
    provideTextDocumentContent: (uri) => _proposed.get(uri.path) ?? '',
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider)
  );
}

// ── Paths ─────────────────────────────────────────────────────────────────────

function workspaceFolders() {
  return vscode.workspace.workspaceFolders || [];
}

function workspaceRoot() {
  return workspaceFolders()[0]?.uri || null;
}

/**
 * Resolve a user/model supplied path to a Uri.
 * Relative paths resolve against the first workspace folder; a leading
 * "<folder-name>/" also matches a multi-root folder by name.
 */
function resolveUri(p) {
  const raw = String(p ?? '').trim();
  if (!raw || raw === '.') {
    const root = workspaceRoot();
    if (!root) throw new Error('No workspace folder is open.');
    return root;
  }
  if (path.isAbsolute(raw)) return vscode.Uri.file(path.normalize(raw));

  const folders = workspaceFolders();
  if (!folders.length) throw new Error('No workspace folder is open.');

  const [head, ...rest] = raw.split(/[\\/]/);
  if (folders.length > 1) {
    const named = folders.find((f) => f.name === head);
    if (named) return vscode.Uri.joinPath(named.uri, ...rest);
  }
  return vscode.Uri.joinPath(folders[0].uri, ...raw.split(/[\\/]/));
}

/** Workspace-relative label for display (falls back to the fsPath). */
function label(uri) {
  for (const f of workspaceFolders()) {
    const rel = path.relative(f.uri.fsPath, uri.fsPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return workspaceFolders().length > 1 ? `${f.name}/${rel}` : rel;
    }
  }
  return uri.fsPath;
}

function isInsideWorkspace(uri) {
  return workspaceFolders().some((f) => {
    const rel = path.relative(f.uri.fsPath, uri.fsPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** Throw unless this uri may be modified under the current settings. */
function assertWritable(uri) {
  if (isInsideWorkspace(uri)) return;
  const allow = vscode.workspace
    .getConfiguration('oaiChatPersistence')
    .get('allowWritesOutsideWorkspace');
  if (!allow) {
    throw new Error(
      `Refusing to modify "${uri.fsPath}" — it is outside the open workspace. ` +
      'Enable oaiChatPersistence.allowWritesOutsideWorkspace to permit this.'
    );
  }
}

// ── Reading ───────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'out', 'build',
  '.venv', 'venv', '__pycache__', '.next', '.cache', 'target',
]);

async function exists(uri) {
  try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
}

async function stat(uri) {
  return vscode.workspace.fs.stat(uri);
}

/** Read a text file, honouring the configured byte cap. */
async function readTextFile(uri, maxBytes) {
  const cap = maxBytes ?? (vscode.workspace
    .getConfiguration('oaiChatPersistence').get('maxFileBytes') || 64_000);
  const bytes = await vscode.workspace.fs.readFile(uri);
  if (bytes.includes(0)) throw new Error('File appears to be binary.');
  const text = Buffer.from(bytes).toString('utf8');
  return text.length > cap
    ? { text: text.slice(0, cap), truncated: true, bytes: bytes.length }
    : { text, truncated: false, bytes: bytes.length };
}

/** Current on-disk-or-dirty text of a file ('' when it does not exist). */
async function currentText(uri) {
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString()
  );
  if (open) return open.getText();
  if (!(await exists(uri))) return '';
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

async function listDirectory(uri) {
  const entries = await vscode.workspace.fs.readDirectory(uri);
  return entries
    .map(([name, type]) => ({
      name,
      dir: type === vscode.FileType.Directory,
      link: !!(type & vscode.FileType.SymbolicLink),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

/** Glob search through VS Code's file index (respects files.exclude). */
async function findFiles(glob, limit = 200) {
  const pattern = glob.includes('/') || glob.includes('\\') ? glob : `**/${glob}`;
  const uris = await vscode.workspace.findFiles(
    pattern,
    `**/{${[...SKIP_DIRS].join(',')}}/**`,
    limit
  );
  return uris;
}

/**
 * Plain-text / regex search across workspace files.
 * Uses the file index, then scans candidates in-process.
 */
async function searchText(term, { glob = '**/*', isRegex = false, maxHits = 80 } = {}) {
  const re = isRegex
    ? new RegExp(term, 'gi')
    : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

  const uris = await findFiles(glob, 1500);
  const hits = [];
  for (const uri of uris) {
    if (hits.length >= maxHits) break;
    let text;
    try {
      const st = await stat(uri);
      if (st.size > 2_000_000) continue;
      text = await currentText(uri);
    } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && hits.length < maxHits; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        hits.push({ uri, line: i + 1, text: lines[i].trim().slice(0, 300) });
      }
    }
  }
  return hits;
}

// ── Writing ───────────────────────────────────────────────────────────────────

async function ensureParentDir(uri) {
  const parent = uri.with({ path: path.posix.dirname(uri.path) });
  if (!(await exists(parent))) {
    await vscode.workspace.fs.createDirectory(parent);
  }
}

/**
 * Replace a file's entire content through a WorkspaceEdit so the change lands
 * in the editor's undo stack. Creates the file (and parents) when missing.
 *
 * @returns {Promise<{ created: boolean, uri: vscode.Uri }>}
 */
async function writeWholeFile(uri, content, { save = true } = {}) {
  assertWritable(uri);
  const created = !(await exists(uri));
  if (created) {
    await ensureParentDir(uri);
    await vscode.workspace.fs.writeFile(uri, Buffer.from('', 'utf8'));
  }
  const doc  = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(
      new vscode.Position(0, 0),
      doc.lineAt(Math.max(doc.lineCount - 1, 0)).range.end
    ),
    content
  );
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error(`VS Code refused the edit to ${label(uri)}.`);
  if (save && !doc.isUntitled) await doc.save();
  return { created, uri };
}

/** Delete a file or directory (moves to trash when supported). */
async function deleteEntry(uri, { recursive = false } = {}) {
  assertWritable(uri);
  await vscode.workspace.fs.delete(uri, { recursive, useTrash: true });
}

/** Insert text at the active editor's cursor (or replace its selection). */
async function insertAtCursor(text) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('No active editor to insert into.');
  await editor.edit((b) => {
    for (const sel of editor.selections) {
      if (sel.isEmpty) b.insert(sel.active, text);
      else b.replace(sel, text);
    }
  });
  if (!editor.document.isUntitled) {
    editor.document.save().then(undefined, () => {});
  }
  return label(editor.document.uri);
}

// ── Diff preview ──────────────────────────────────────────────────────────────

/** Open a side-by-side diff of the current file against proposed content. */
async function showProposedDiff(uri, proposedContent, title) {
  const key = `/${Date.now()}-${path.basename(uri.fsPath)}`;
  _proposed.set(key, proposedContent);
  const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: key });
  const left  = (await exists(uri))
    ? uri
    : vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `${key}-empty` });
  if (left.scheme === PROPOSED_SCHEME) _proposed.set(left.path, '');
  await vscode.commands.executeCommand(
    'vscode.diff', left, right, title || `${label(uri)} ↔ proposed`,
    { preview: true, preserveFocus: true }
  );
}

async function openFileAtLine(uri, line) {
  const doc    = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  if (line > 0) {
    const pos = new vscode.Position(Math.max(line - 1, 0), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

// ── Unified diff (for approval previews) ──────────────────────────────────────

/** Line-based diff, trimmed to common prefix/suffix and capped for big files. */
function unifiedDiff(oldText, newText, name = 'file', context = 3) {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  if (start === endA && start === endB) return `--- ${name}\n(no changes)`;

  // Keep a few untouched lines around the change so the hunk is reviewable.
  const preStart = Math.max(0, start - context);
  const pre      = a.slice(preStart, start);
  const post     = a.slice(endA, Math.min(a.length, endA + context));

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const head = [
    `--- ${name}`,
    `+++ ${name} (proposed)`,
    `@@ -${preStart + 1},${pre.length + midA.length + post.length} ` +
      `+${preStart + 1},${pre.length + midB.length + post.length} @@`,
  ];
  const frame = (body) => [...head, ...pre.map((l) => ` ${l}`), ...body, ...post.map((l) => ` ${l}`)].join('\n');

  // Too large for an O(n²) LCS — show it as one replaced block.
  if (midA.length > 1200 || midB.length > 1200) {
    return frame([
      ...midA.slice(0, 40).map((l) => `-${l}`),
      midA.length > 40 ? `-… ${midA.length - 40} more removed lines` : null,
      ...midB.slice(0, 40).map((l) => `+${l}`),
      midB.length > 40 ? `+… ${midB.length - 40} more added lines` : null,
    ].filter(Boolean));
  }

  // LCS table over the differing middle only.
  const n = midA.length, m = midB.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { out.push(` ${midA[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`-${midA[i]}`); i++; }
    else { out.push(`+${midB[j]}`); j++; }
  }
  while (i < n) out.push(`-${midA[i++]}`);
  while (j < m) out.push(`+${midB[j++]}`);

  // Collapse long runs of unchanged context.
  const trimmed = [];
  let run = 0;
  for (const line of out) {
    if (line.startsWith(' ')) {
      run++;
      if (run <= context) trimmed.push(line);
      else if (run === context + 1) trimmed.push(' …');
    } else { run = 0; trimmed.push(line); }
  }
  return frame(trimmed);
}

function diffStats(oldText, newText) {
  const diff = unifiedDiff(oldText, newText, 'x', 0).split('\n');
  let added = 0, removed = 0;
  for (const l of diff) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed };
}

// ── Editor context & diagnostics ──────────────────────────────────────────────

/** Active file, selection and open tabs — the "what am I looking at" payload. */
function editorContext() {
  const editor = vscode.window.activeTextEditor;
  const tabs = vscode.window.tabGroups?.all
    ?.flatMap((g) => g.tabs)
    .map((t) => t.input?.uri)
    .filter(Boolean)
    .map((u) => label(u))
    .slice(0, 40) || [];

  if (!editor) return { file: null, language: null, selection: null, tabs };

  const sel = editor.selection;
  return {
    file: label(editor.document.uri),
    fsPath: editor.document.uri.fsPath,
    language: editor.document.languageId,
    lineCount: editor.document.lineCount,
    cursorLine: sel.active.line + 1,
    selection: sel.isEmpty
      ? null
      : {
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
          text: editor.document.getText(sel),
        },
    tabs,
  };
}

const SEVERITY = ['error', 'warning', 'info', 'hint'];

function diagnostics(uri) {
  const entries = uri
    ? [[uri, vscode.languages.getDiagnostics(uri)]]
    : vscode.languages.getDiagnostics();
  const out = [];
  for (const [u, diags] of entries) {
    for (const d of diags) {
      out.push({
        file: label(u),
        line: d.range.start.line + 1,
        severity: SEVERITY[d.severity] || 'info',
        message: d.message,
        source: d.source || '',
      });
    }
  }
  return out.sort((a, b) => a.severity.localeCompare(b.severity)).slice(0, 200);
}

// ── Shell ─────────────────────────────────────────────────────────────────────

/** Run a command in the workspace root and capture its output. */
function runShell(command, { cwd, timeout = 60_000, maxBuffer = 200_000 } = {}) {
  const root = workspaceRoot();
  return new Promise((resolve) => {
    cp.exec(
      command,
      { cwd: cwd || root?.fsPath || process.cwd(), timeout, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          code: err?.code ?? 0,
          killed: !!err?.killed,
          stdout: String(stdout || ''),
          stderr: String(stderr || (err && !err.code ? err.message : '')),
        });
      }
    );
  });
}

module.exports = {
  PROPOSED_SCHEME,
  registerProposedProvider,
  workspaceFolders,
  workspaceRoot,
  resolveUri,
  label,
  isInsideWorkspace,
  assertWritable,
  exists,
  stat,
  readTextFile,
  currentText,
  listDirectory,
  findFiles,
  searchText,
  writeWholeFile,
  deleteEntry,
  insertAtCursor,
  showProposedDiff,
  openFileAtLine,
  unifiedDiff,
  diffStats,
  editorContext,
  diagnostics,
  runShell,
  SKIP_DIRS,
};
