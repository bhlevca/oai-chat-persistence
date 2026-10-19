'use strict';

/**
 * Tool registry handed to the language model.
 *
 * Read tools run immediately. Mutating tools (write/create/delete/shell) must
 * clear ctx.requestApproval() first — the panel surfaces that as an approval
 * card in the chat, so the model can change the workspace but never silently.
 */

const vscode = require('vscode');
const ws     = require('./workspace');

const cfg = () => vscode.workspace.getConfiguration('oaiChatPersistence');

// ── Read tools ────────────────────────────────────────────────────────────────

const readTools = [
  {
    name: 'read_file',
    mutating: false,
    description:
      'Read a text file from the workspace. Returns the file content with line numbers. ' +
      'Use before editing a file so your edits match the real content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root, or absolute.' },
        start_line: { type: 'number', description: 'Optional 1-based first line to return.' },
        end_line: { type: 'number', description: 'Optional 1-based last line to return.' },
      },
      required: ['path'],
    },
    summary: (i) => `read ${i.path}`,
    async run(input) {
      const uri = ws.resolveUri(input.path);
      const { text, truncated } = await ws.readTextFile(uri);
      let lines = text.split('\n');
      const from = Math.max(1, Number(input.start_line) || 1);
      const to   = Math.min(lines.length, Number(input.end_line) || lines.length);
      lines = lines.slice(from - 1, to);
      const numbered = lines.map((l, idx) => `${from + idx}\t${l}`).join('\n');
      return `File: ${ws.label(uri)} (lines ${from}-${to})\n${numbered}` +
        (truncated ? '\n[… file truncated — read a line range for the rest]' : '');
    },
  },
  {
    name: 'list_directory',
    mutating: false,
    description: 'List files and subdirectories of a workspace directory. Use "" or "." for the root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path; "" or "." means the workspace root.' } },
    },
    summary: (i) => `list ${i.path || '.'}`,
    async run(input) {
      const uri = ws.resolveUri(input.path || '.');
      const entries = await ws.listDirectory(uri);
      if (!entries.length) return `${ws.label(uri)} is empty.`;
      return `Directory: ${ws.label(uri)}\n` +
        entries.map((e) => (e.dir ? `${e.name}/` : e.name)).join('\n');
    },
  },
  {
    name: 'find_files',
    mutating: false,
    description:
      'Find workspace files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). ' +
      'Respects the editor\'s exclude settings and skips node_modules/.git.',
    inputSchema: {
      type: 'object',
      properties: {
        glob: { type: 'string', description: 'Glob pattern, e.g. "**/*.json".' },
        limit: { type: 'number', description: 'Maximum number of results (default 200).' },
      },
      required: ['glob'],
    },
    summary: (i) => `find ${i.glob}`,
    async run(input) {
      const uris = await ws.findFiles(input.glob, Math.min(Number(input.limit) || 200, 500));
      if (!uris.length) return `No files match "${input.glob}".`;
      return `${uris.length} file(s) matching "${input.glob}":\n` +
        uris.map((u) => ws.label(u)).join('\n');
    },
  },
  {
    name: 'search_text',
    mutating: false,
    description:
      'Search the workspace for a string or regular expression and return matching lines ' +
      'with file names and line numbers. Use this to locate code before reading files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to search for.' },
        glob: { type: 'string', description: 'Optional glob restricting which files are searched.' },
        is_regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      },
      required: ['query'],
    },
    summary: (i) => `search "${i.query}"`,
    async run(input) {
      const hits = await ws.searchText(input.query, {
        glob: input.glob || '**/*',
        isRegex: !!input.is_regex,
      });
      if (!hits.length) return `No matches for "${input.query}".`;
      return `${hits.length} match(es) for "${input.query}":\n` +
        hits.map((h) => `${ws.label(h.uri)}:${h.line}: ${h.text}`).join('\n');
    },
  },
  {
    name: 'get_editor_context',
    mutating: false,
    description:
      'Get what the user is currently looking at: active file, cursor line, selected text and open tabs.',
    inputSchema: { type: 'object', properties: {} },
    summary: () => 'read editor context',
    async run() {
      const ctx = ws.editorContext();
      if (!ctx.file) return `No active editor. Open tabs:\n${ctx.tabs.join('\n') || '(none)'}`;
      const parts = [
        `Active file: ${ctx.file} (${ctx.language}, ${ctx.lineCount} lines)`,
        `Cursor on line ${ctx.cursorLine}`,
      ];
      if (ctx.selection) {
        parts.push(
          `Selection lines ${ctx.selection.startLine}-${ctx.selection.endLine}:\n` +
          '```\n' + ctx.selection.text.slice(0, 8000) + '\n```'
        );
      }
      if (ctx.tabs.length) parts.push(`Open tabs:\n${ctx.tabs.join('\n')}`);
      return parts.join('\n');
    },
  },
  {
    name: 'get_diagnostics',
    mutating: false,
    description:
      'Get errors and warnings reported by language servers and linters, for one file or the whole workspace. ' +
      'Use after an edit to check whether it compiles.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional file path; omit for the whole workspace.' } },
    },
    summary: (i) => `diagnostics ${i.path || '(workspace)'}`,
    async run(input) {
      const uri = input.path ? ws.resolveUri(input.path) : undefined;
      const diags = ws.diagnostics(uri);
      if (!diags.length) return 'No diagnostics reported.';
      return diags
        .map((d) => `${d.severity.toUpperCase()} ${d.file}:${d.line} ${d.message}${d.source ? ` [${d.source}]` : ''}`)
        .join('\n');
    },
  },
];

// ── Write tools ───────────────────────────────────────────────────────────────

const writeTools = [
  {
    name: 'write_file',
    mutating: true,
    description:
      'Create a file or replace its entire content. Provide the complete final content — ' +
      'no placeholders or "rest unchanged" comments. The user reviews a diff before it is applied.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root, or absolute.' },
        content: { type: 'string', description: 'Full new content of the file.' },
      },
      required: ['path', 'content'],
    },
    summary: (i) => `write ${i.path}`,
    async run(input, ctx) {
      const uri      = ws.resolveUri(input.path);
      ws.assertWritable(uri);
      const before   = await ws.currentText(uri);
      const after    = String(input.content ?? '');
      if (before === after) return `${ws.label(uri)} already has that exact content — nothing to do.`;

      const approved = await ctx.requestApproval({
        kind: before ? 'write' : 'create',
        title: `${before ? 'Replace' : 'Create'} ${ws.label(uri)}`,
        diff: ws.unifiedDiff(before, after, ws.label(uri)),
        stats: ws.diffStats(before, after),
        uri: uri.toString(),
        proposed: after,
      });
      if (!approved) return `User rejected the change to ${ws.label(uri)}. Do not retry it; ask what to do differently.`;

      const { created } = await ws.writeWholeFile(uri, after);
      const { added, removed } = ws.diffStats(before, after);
      return `${created ? 'Created' : 'Updated'} ${ws.label(uri)} (+${added}/-${removed}).`;
    },
  },
  {
    name: 'edit_file',
    mutating: true,
    description:
      'Make a targeted edit by replacing an exact snippet of a file. old_text must match the file ' +
      'byte-for-byte (include surrounding lines to make it unique). Prefer this over write_file for ' +
      'small changes to large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root, or absolute.' },
        old_text: { type: 'string', description: 'Exact existing snippet to replace.' },
        new_text: { type: 'string', description: 'Replacement text (empty string deletes the snippet).' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
    summary: (i) => `edit ${i.path}`,
    async run(input, ctx) {
      const uri = ws.resolveUri(input.path);
      ws.assertWritable(uri);
      if (!(await ws.exists(uri))) return `${ws.label(uri)} does not exist — use write_file to create it.`;

      const before  = await ws.currentText(uri);
      const oldText = String(input.old_text ?? '');
      const newText = String(input.new_text ?? '');
      if (!oldText) return 'old_text must not be empty — use write_file to replace a whole file.';

      const occurrences = before.split(oldText).length - 1;
      if (occurrences === 0) {
        return `old_text was not found in ${ws.label(uri)}. Read the file again and copy the snippet exactly.`;
      }
      if (occurrences > 1 && !input.replace_all) {
        return `old_text occurs ${occurrences} times in ${ws.label(uri)}. ` +
          'Add surrounding context to make it unique, or pass replace_all: true.';
      }
      const after = input.replace_all
        ? before.split(oldText).join(newText)
        : before.replace(oldText, newText);

      const approved = await ctx.requestApproval({
        kind: 'edit',
        title: `Edit ${ws.label(uri)}`,
        diff: ws.unifiedDiff(before, after, ws.label(uri)),
        stats: ws.diffStats(before, after),
        uri: uri.toString(),
        proposed: after,
      });
      if (!approved) return `User rejected the edit to ${ws.label(uri)}. Do not retry it; ask what to do differently.`;

      await ws.writeWholeFile(uri, after);
      const { added, removed } = ws.diffStats(before, after);
      return `Edited ${ws.label(uri)} (+${added}/-${removed})${occurrences > 1 ? ` in ${occurrences} places` : ''}.`;
    },
  },
  {
    name: 'delete_file',
    mutating: true,
    description: 'Delete a file (moved to the trash). Requires explicit user approval.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path of the file to delete.' } },
      required: ['path'],
    },
    summary: (i) => `delete ${i.path}`,
    async run(input, ctx) {
      const uri = ws.resolveUri(input.path);
      ws.assertWritable(uri);
      if (!(await ws.exists(uri))) return `${ws.label(uri)} does not exist.`;
      const before = await ws.currentText(uri);
      const approved = await ctx.requestApproval({
        kind: 'delete',
        title: `Delete ${ws.label(uri)}`,
        diff: ws.unifiedDiff(before, '', ws.label(uri)),
        stats: ws.diffStats(before, ''),
        uri: uri.toString(),
        neverAuto: true,
      });
      if (!approved) return `User rejected deleting ${ws.label(uri)}.`;
      await ws.deleteEntry(uri);
      return `Deleted ${ws.label(uri)} (moved to trash).`;
    },
  },
];

// ── Shell tool (opt-in) ───────────────────────────────────────────────────────

const shellTool = {
  name: 'run_shell_command',
  mutating: true,
  description:
    'Run a shell command in the workspace root and return its output — tests, builds, git, linters. ' +
    'Every call needs explicit user approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      why: { type: 'string', description: 'One short sentence on why this command is needed.' },
    },
    required: ['command'],
  },
  summary: (i) => `run ${i.command}`,
  async run(input, ctx) {
    const command = String(input.command || '').trim();
    if (!command) return 'No command given.';
    const approved = await ctx.requestApproval({
      kind: 'shell',
      title: `Run: ${command}`,
      detail: input.why || '',
      command,
      neverAuto: true,
    });
    if (!approved) return `User rejected running "${command}".`;

    const res = await ws.runShell(command);
    const body = [
      res.stdout.trim() ? `stdout:\n${res.stdout.trim().slice(0, 20_000)}` : null,
      res.stderr.trim() ? `stderr:\n${res.stderr.trim().slice(0, 8_000)}` : null,
    ].filter(Boolean).join('\n\n');
    return `exit ${res.code}${res.killed ? ' (timed out)' : ''}\n${body || '(no output)'}`;
  },
};

// ── Git tools ─────────────────────────────────────────────────────────────────

const gitReadTools = [
  {
    name: 'git_status',
    mutating: false,
    description: 'Show working tree status: branch, staged, unstaged and untracked files.',
    inputSchema: { type: 'object', properties: {} },
    summary: () => 'git status',
    async run() {
      const res = await ws.runShell('git status --short --branch');
      if (res.code !== 0) {
        return res.stderr.toLowerCase().includes('not a git repository')
          ? 'Not a git repository.'
          : `Git error: ${res.stderr || res.stdout}`;
      }
      return res.stdout.trim() || 'Working tree clean (no changes).';
    },
  },
  {
    name: 'git_diff',
    mutating: false,
    description:
      'Show changes in the working tree or staging area. Set staged: true to inspect staged changes.',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged diff (--cached).' },
        path: { type: 'string', description: 'Optional path to inspect.' },
      },
    },
    summary: (i) => `git diff${i.staged ? ' (staged)' : ''}${i.path ? ` ${i.path}` : ''}`,
    async run(input) {
      const args = ['git', 'diff'];
      if (input.staged) args.push('--cached');
      if (input.path) args.push('--', input.path);
      const res = await ws.runShell(args.join(' '));
      if (res.code !== 0) return `Git diff error: ${res.stderr || res.stdout}`;
      return res.stdout.trim() || '(no changes)';
    },
  },
  {
    name: 'git_log',
    mutating: false,
    description: 'Show recent git commit history with commit hashes, dates and messages.',
    inputSchema: {
      type: 'object',
      properties: {
        max_count: { type: 'number', description: 'Number of commits to retrieve (default 10).' },
      },
    },
    summary: (i) => `git log (${i.max_count || 10})`,
    async run(input) {
      const count = Math.max(1, Math.min(Number(input.max_count) || 10, 50));
      const res = await ws.runShell(`git log -n ${count} --pretty=format:"%h %ad | %s%d [%an]" --date=short`);
      if (res.code !== 0) return `Git log error: ${res.stderr || res.stdout}`;
      return res.stdout.trim() || 'No commits yet.';
    },
  },
];

const gitWriteTools = [
  {
    name: 'git_commit',
    mutating: true,
    description:
      'Commit changes to git. Always requires user approval. Shows the changes to be committed before committing.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Git commit message.' },
        all: { type: 'boolean', description: 'Stage all modified/deleted tracked files (-a).' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths to stage before committing.',
        },
      },
      required: ['message'],
    },
    summary: (i) => `git commit: "${i.message || ''}"`,
    async run(input, ctx) {
      const statusRes = await ws.runShell('git status --short');
      if (statusRes.code !== 0) return `Not a git repository: ${statusRes.stderr}`;
      if (!statusRes.stdout.trim()) return 'Nothing to commit (working tree clean).';

      const message = String(input.message || '').trim();
      if (!message) return 'Commit message cannot be empty.';

      // Get diff for preview
      const diffCmd = input.all ? 'git diff HEAD' : 'git diff --cached';
      const diffRes = await ws.runShell(diffCmd);
      const diffText = diffRes.stdout.trim() || statusRes.stdout.trim();

      const approved = await ctx.requestApproval({
        kind: 'shell',
        title: `git commit: "${message}"`,
        detail: `Status:\n${statusRes.stdout.trim()}`,
        diff: diffText,
        command: `git commit -m "${message}"`,
        neverAuto: true,
      });
      if (!approved) return 'User rejected git commit.';

      if (Array.isArray(input.files) && input.files.length) {
        const addCmd = `git add ${input.files.map((f) => `"${f.replace(/"/g, '\\"')}"`).join(' ')}`;
        const addRes = await ws.runShell(addCmd);
        if (addRes.code !== 0) return `git add failed: ${addRes.stderr}`;
      }

      const safeMsg = message.replace(/"/g, '\\"');
      const commitCmd = input.all ? `git commit -a -m "${safeMsg}"` : `git commit -m "${safeMsg}"`;
      const commitRes = await ws.runShell(commitCmd);
      if (commitRes.code !== 0) {
        if (commitRes.stdout.includes('no changes added to commit') || commitRes.stderr.includes('no changes added to commit')) {
          return 'Nothing was staged for commit. Stage files first or pass all: true to commit tracked modified files.';
        }
        return `git commit failed: ${commitRes.stderr || commitRes.stdout}`;
      }
      return commitRes.stdout.trim();
    },
  },
];

// ── Registry ──────────────────────────────────────────────────────────────────

/**
 * Tools available for one request.
 * @param {{ agent?: boolean }} opts  agent=false exposes read-only tools
 */
function toolsFor({ agent = true } = {}) {
  const list = [...readTools];
  if (cfg().get('enableGitTools') !== false) {
    list.push(...gitReadTools);
    if (agent) list.push(...gitWriteTools);
  }
  if (agent && cfg().get('enableWriteTools') !== false) list.push(...writeTools);
  if (agent && cfg().get('enableTerminalTool') === true) list.push(shellTool);
  return list;
}

/** Shape expected by vscode.lm sendRequest({ tools }). */
function toLmTools(tools) {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * Execute a tool call by name.
 * @param {string} name
 * @param {object} input
 * @param {{ requestApproval: (req: object) => Promise<boolean> }} ctx
 * @returns {Promise<{ text: string, ok: boolean }>}
 */
async function execute(name, input, ctx, available) {
  const tool = (available || toolsFor()).find((t) => t.name === name);
  if (!tool) return { ok: false, text: `Unknown tool "${name}".` };
  try {
    const text = await tool.run(input || {}, ctx);
    return { ok: true, text: String(text) };
  } catch (err) {
    return { ok: false, text: `Error in ${name}: ${err.message}` };
  }
}

/** Short human label for the activity card in the chat. */
function summarize(tools, name, input) {
  const tool = tools.find((t) => t.name === name);
  try { return tool?.summary?.(input || {}) || name; } catch { return name; }
}

module.exports = {
  toolsFor,
  toLmTools,
  execute,
  summarize,
  readTools,
  writeTools,
  shellTool,
  gitReadTools,
  gitWriteTools,
};
