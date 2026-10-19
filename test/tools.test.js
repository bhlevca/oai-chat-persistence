'use strict';
const Module = require('module');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const mock = require('./mock-vscode');
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return mock;
  return orig.call(this, request, ...rest);
};

const SRC = path.join(__dirname, '..', 'src');
const ws    = require(path.join(SRC, 'workspace.js'));
const tools = require(path.join(SRC, 'tools.js'));

// ── fixture workspace ──
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-ws-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'app.js'),
  'function hello() {\n  return "world";\n}\n\nmodule.exports = { hello };\n');
fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n\nNeedle here.\n');
mock._state.folders = [{ name: path.basename(root), uri: mock.Uri.file(root) }];

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${String(extra).replace(/\n/g, '\n       ')}` : ''}`); }
};

const approveAll  = { requestApproval: async () => true };
const rejectAll   = { requestApproval: async () => false };
const captured    = [];
const capturing   = { requestApproval: async (req) => { captured.push(req); return true; } };

(async () => {
  const all = tools.toolsFor({ agent: true });
  console.log('\n# tool registry');
  ok(all.some(t => t.name === 'write_file'), 'write tools exposed in agent mode');
  ok(!tools.toolsFor({ agent: false }).some(t => t.name === 'write_file'), 'read-only mode hides write tools');
  ok(tools.toLmTools(all).every(t => t.name && t.description && t.inputSchema), 'LM tool shape complete');

  const run = (name, input, ctx = approveAll) => tools.execute(name, input, ctx, all);

  console.log('\n# read tools');
  let r = await run('read_file', { path: 'src/app.js' });
  ok(r.ok && r.text.includes('1\tfunction hello()'), 'read_file numbers lines', r.text);
  r = await run('read_file', { path: 'src/app.js', start_line: 2, end_line: 2 });
  ok(r.text.includes('2\t  return "world";') && !r.text.includes('module.exports'), 'read_file honours line range', r.text);
  r = await run('read_file', { path: 'nope.js' });
  ok(r.text.startsWith('Error in read_file'), 'read_file reports a missing file', r.text);

  r = await run('list_directory', { path: '.' });
  ok(r.text.includes('src/') && r.text.includes('README.md'), 'list_directory lists entries', r.text);

  r = await run('find_files', { glob: '**/*.js' });
  ok(r.text.includes('src/app.js'), 'find_files matches a glob', r.text);

  r = await run('search_text', { query: 'Needle' });
  ok(r.text.includes('README.md:3'), 'search_text reports file:line', r.text);
  r = await run('search_text', { query: 'ret.rn', is_regex: true });
  ok(r.text.includes('src/app.js:2'), 'search_text supports regex', r.text);

  r = await run('get_editor_context', {});
  ok(r.text.includes('No active editor'), 'get_editor_context without an editor', r.text);

  console.log('\n# write tools');
  r = await run('write_file', { path: 'src/new.js', content: 'const a = 1;\n' }, capturing);
  ok(r.text.startsWith('Created src/new.js'), 'write_file creates a file', r.text);
  ok(fs.readFileSync(path.join(root, 'src', 'new.js'), 'utf8') === 'const a = 1;\n', 'created content on disk');
  ok(captured.at(-1).kind === 'create' && captured.at(-1).diff.includes('+const a = 1;'), 'approval carried a diff', captured.at(-1).diff);

  r = await run('write_file', { path: 'src/new.js', content: 'const a = 2;\n' }, rejectAll);
  ok(r.text.startsWith('User rejected'), 'rejected write is not applied', r.text);
  ok(fs.readFileSync(path.join(root, 'src', 'new.js'), 'utf8') === 'const a = 1;\n', 'file untouched after rejection');

  r = await run('write_file', { path: 'src/new.js', content: 'const a = 1;\n' });
  ok(r.text.includes('already has that exact content'), 'no-op write short-circuits', r.text);

  r = await run('edit_file', { path: 'src/app.js', old_text: '"world"', new_text: '"workspace"' }, capturing);
  ok(r.text.startsWith('Edited src/app.js'), 'edit_file applies a targeted edit', r.text);
  ok(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8').includes('"workspace"'), 'edit landed on disk');

  r = await run('edit_file', { path: 'src/app.js', old_text: 'not-there', new_text: 'x' });
  ok(r.text.includes('was not found'), 'edit_file reports a bad anchor', r.text);

  fs.writeFileSync(path.join(root, 'dup.txt'), 'a\na\n');
  r = await run('edit_file', { path: 'dup.txt', old_text: 'a', new_text: 'b' });
  ok(r.text.includes('occurs 2 times'), 'edit_file refuses an ambiguous anchor', r.text);
  r = await run('edit_file', { path: 'dup.txt', old_text: 'a', new_text: 'b', replace_all: true });
  ok(fs.readFileSync(path.join(root, 'dup.txt'), 'utf8') === 'b\nb\n', 'replace_all replaces every occurrence');

  r = await run('edit_file', { path: 'missing.txt', old_text: 'a', new_text: 'b' });
  ok(r.text.includes('does not exist'), 'edit_file on a missing file points at write_file', r.text);

  console.log('\n# containment');
  const outside = path.join(os.tmpdir(), 'oai-outside.txt');
  r = await run('write_file', { path: outside, content: 'x' });
  ok(r.text.includes('outside the open workspace'), 'writes outside the workspace are refused', r.text);
  ok(!fs.existsSync(outside), 'outside file was not created');
  mock._config.allowWritesOutsideWorkspace = true;
  r = await run('write_file', { path: outside, content: 'x\n' });
  ok(r.text.startsWith('Created'), 'opt-in allows outside writes', r.text);
  mock._config.allowWritesOutsideWorkspace = false;
  fs.rmSync(outside, { force: true });

  console.log('\n# delete + shell');
  r = await run('delete_file', { path: 'dup.txt' }, rejectAll);
  ok(r.text.startsWith('User rejected') && fs.existsSync(path.join(root, 'dup.txt')), 'rejected delete keeps the file', r.text);
  const delReq = [];
  r = await run('delete_file', { path: 'dup.txt' }, { requestApproval: async (q) => { delReq.push(q); return true; } });
  ok(!fs.existsSync(path.join(root, 'dup.txt')), 'approved delete removes the file', r.text);
  ok(delReq[0].neverAuto === true, 'delete can never be auto-approved');

  const shReq = [];
  r = await run('run_shell_command', { command: 'echo hi' }, { requestApproval: async (q) => { shReq.push(q); return true; } });
  ok(r.text.includes('exit 0') && r.text.includes('hi'), 'shell tool returns output', r.text);
  ok(shReq[0].neverAuto === true, 'shell commands can never be auto-approved');
  r = await run('run_shell_command', { command: 'echo nope' }, rejectAll);
  ok(r.text.startsWith('User rejected'), 'rejected command does not run', r.text);

  console.log('\n# diff helpers');
  const d = ws.unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
  ok(d.includes('-b') && d.includes('+B') && d.includes(' a'), 'unifiedDiff marks the changed line', d);
  ok(JSON.stringify(ws.diffStats('a\nb\n', 'a\nb\nc\n')) === '{"added":1,"removed":0}', 'diffStats counts an append',
     JSON.stringify(ws.diffStats('a\nb\n', 'a\nb\nc\n')));
  ok(ws.unifiedDiff('x\n', 'x\n').includes('no changes'), 'unifiedDiff detects equality');
  const big = ws.unifiedDiff(Array.from({length: 3000}, (_, i) => `l${i}`).join('\n'), 'one line', 'big.txt');
  ok(big.includes('more removed lines'), 'unifiedDiff degrades gracefully on big files');

  console.log('\n# labels');
  ok(ws.label(ws.resolveUri('src/app.js')) === 'src/app.js', 'label round-trips a relative path',
     ws.label(ws.resolveUri('src/app.js')));
  ok(ws.isInsideWorkspace(ws.resolveUri('src/app.js')), 'containment check accepts a workspace file');
  ok(!ws.isInsideWorkspace(mock.Uri.file('/etc/passwd')), 'containment check rejects /etc');

  console.log('\n# git tools');
  r = await run('git_status', {});
  ok(r.text.includes('Not a git repository'), 'git_status reports non-repo workspace', r.text);
  await ws.runShell('git init -b main && git config user.name "Test" && git config user.email "test@example.com"', { cwd: root });
  r = await run('git_status', {});
  ok(r.text.includes('src/app.js') || r.text.includes('??'), 'git_status reports untracked files', r.text);

  r = await run('git_log', {});
  ok(r.text.includes('No commits yet') || r.text.includes('Git log error'), 'git_log handles empty repo', r.text);

  r = await run('git_commit', { message: 'initial' }, rejectAll);
  ok(r.text.startsWith('User rejected'), 'rejected git_commit does not commit', r.text);

  const commitReq = [];
  r = await run('git_commit', { message: 'initial commit', all: true, files: ['src/app.js'] }, {
    requestApproval: async (q) => { commitReq.push(q); return true; },
  });
  ok(commitReq.length > 0 && commitReq[0].title.includes('initial commit'), 'git_commit requests approval');
  ok(r.text.includes('initial commit') || r.ok, 'git_commit creates commit', r.text);

  r = await run('git_log', { max_count: 5 });
  ok(r.text.includes('initial commit'), 'git_log shows new commit', r.text);

  // Modify file to test git_diff
  fs.appendFileSync(path.join(root, 'src', 'app.js'), '// added line\n');
  r = await run('git_diff', {});
  ok(r.text.includes('+ // added line') || r.text.includes('added line'), 'git_diff reports working tree changes', r.text);

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
