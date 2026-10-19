'use strict';
const Module = require('module');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// storage.js resolves its base dir from the home directory at require time
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-home-'));
process.env.HOME = HOME;

const mock = require('./mock-vscode');
const orig = Module._load;
Module._load = function (r, ...x) { return r === 'vscode' ? mock : orig.call(this, r, ...x); };

const SRC = path.join(__dirname, '..', 'src');
const { ChatPanel } = require(path.join(SRC, 'panel.js'));
const storage = require(path.join(SRC, 'storage.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-panel-'));
fs.mkdirSync(path.join(root, 'src'));
fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const price = "$& $1";\nlet y = 2;\n');
mock._state.folders = [{ name: path.basename(root), uri: mock.Uri.file(root) }];

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${String(extra).replace(/\n/g, '\n       ')}` : ''}`); }
};

/** Panel wired to a fake webview that records posts and can answer approvals. */
function makePanel({ autoApprove = true } = {}) {
  const panel = new ChatPanel({ extensionPath: path.dirname(SRC), subscriptions: [] });
  const posted = [];
  panel._view = {
    webview: {
      postMessage: (m) => {
        posted.push(m);
        if (m.type === 'toolApproval') {
          // answer on the next tick, like a user clicking the card
          setImmediate(() => panel._handle({
            type: 'approvalResponse', id: m.id, approved: autoApprove, applyAll: false,
          }));
        }
        return true;
      },
    },
  };
  return { panel, posted };
}

function scriptModel(rounds) {
  const seen = [];
  mock.lm = {
    selectChatModels: async () => [{
      id: 'test', name: 'Test', vendor: 'mock', family: 'mock',
      sendRequest: async (messages, options) => {
        seen.push({ messages, options });
        const parts = rounds.shift() || [];
        return { stream: (async function* () { for (const p of parts) yield p; })() };
      },
    }],
  };
  return seen;
}
const T = (t) => new mock.LanguageModelTextPart(t);
const C = (id, n, i) => new mock.LanguageModelToolCallPart(id, n, i);

(async () => {
  console.log('\n# @-references');
  const { panel } = makePanel();

  mock._state.activeEditor = {
    document: {
      uri: mock.Uri.file(path.join(root, 'src', 'app.js')),
      languageId: 'javascript', lineCount: 2,
      getText: () => 'let y = 2;',
    },
    selection: new mock.Selection(new mock.Position(1, 0), new mock.Position(1, 10)),
  };

  let out = await panel._injectFileRefs('look at @active please');
  ok(out.includes('# File: src/app.js') && out.includes('let y = 2;'), '@active inlines the open file', out);
  out = await panel._injectFileRefs('explain @selection');
  ok(out.includes('src/app.js lines 2-2') && out.includes('let y = 2;'), '@selection inlines the selection', out);

  mock._state.diagnostics = [[mock.Uri.file(path.join(root, 'src', 'app.js')),
    [{ range: { start: { line: 0 } }, severity: 0, message: 'Unused variable', source: 'eslint' }]]];
  out = await panel._injectFileRefs('fix @problems');
  ok(out.includes('ERROR src/app.js:1 Unused variable'), '@problems inlines diagnostics', out);
  mock._state.diagnostics = [];

  out = await panel._injectFileRefs('see @src/app.js');
  ok(out.includes('const price = "$& $1";'), 'file content with $-patterns is injected verbatim', out);

  out = await panel._injectFileRefs('no refs here');
  ok(out === 'no refs here', 'plain text is untouched');

  const note = panel._editorContextNote();
  ok(note.includes('active file src/app.js') && note.includes('selection lines 2-2'), 'editor context note', note);

  console.log('\n# a turn that edits a file');
  storage.createSession('t1', 'test', { agent: true });
  let seen = scriptModel([
    [T('Renaming.'), C('c1', 'edit_file', { path: 'src/app.js', old_text: 'let y = 2;', new_text: 'let z = 2;' })],
    [T(' Done.')],
  ]);
  const a = makePanel({ autoApprove: true });
  await a.panel._handle({ type: 'sendMessage', name: 't1', modelId: 'test', content: 'rename y to z' });

  const types = a.posted.map(m => m.type);
  ok(types.includes('streamStart') && types.includes('toolStart') && types.includes('toolEnd') && types.includes('streamEnd'),
     'webview saw the full event sequence', types.join(','));
  ok(types.includes('toolApproval'), 'an approval card was requested');
  ok(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8').includes('let z = 2;'), 'the edit reached the file');

  const s1 = storage.loadSession('t1');
  const roles = s1.messages.map(m => (m._tool ? `tool:${m.name}` : m.role));
  ok(roles.join(',') === 'user,tool:edit_file,assistant', 'history: user, tool activity, assistant', roles.join(','));
  ok(s1.messages[1].ok === true && s1.messages[1].label === 'edit src/app.js', 'tool entry carries its label', JSON.stringify(s1.messages[1].label));
  ok(s1.messages[2].content === 'Renaming. Done.', 'assistant text persisted whole', s1.messages[2].content);
  ok(a.posted.at(-1).type === 'sessions' && a.posted.some(m => m.type === 'sessionLoaded'),
     'session re-sent so the UI matches disk');
  const endMsg = a.posted.find(m => m.type === 'streamEnd');
  ok(!endMsg.error && endMsg.toolCount === 1, 'streamEnd reports no error and one tool call', JSON.stringify(endMsg));

  console.log('\n# a rejected edit');
  scriptModel([
    [C('c2', 'write_file', { path: 'src/new.js', content: 'nope\n' })],
    [T('Understood, leaving it alone.')],
  ]);
  const b = makePanel({ autoApprove: false });
  await b.panel._handle({ type: 'sendMessage', name: 't1', modelId: 'test', content: 'create src/new.js' });
  ok(!fs.existsSync(path.join(root, 'src', 'new.js')), 'rejected write created no file');
  const s2 = storage.loadSession('t1');
  ok(s2.messages.at(-2).content.includes('User rejected'), 'rejection recorded in history', s2.messages.at(-2).content);
  ok(s2.messages.at(-1).content === 'Understood, leaving it alone.', 'model reply after rejection persisted');

  console.log('\n# read-only session');
  storage.createSession('t2', 'test', { agent: false });
  seen = scriptModel([[T('Here is a patch instead.')]]);
  const c = makePanel();
  await c.panel._handle({ type: 'sendMessage', name: 't2', modelId: 'test', content: 'change it' });
  ok(!seen[0].options.tools.some(t => t.name === 'write_file'), 'read-only session offers no write tools');
  ok(String(seen[0].messages[0].content).includes('read-only tools'), 'read-only preamble sent');

  console.log('\n# agent toggle + session flags');
  await c.panel._handle({ type: 'setAgentMode', name: 't2', agent: true });
  ok(storage.loadSession('t2').agent === true, 'agent mode persists on the session');
  const created = storage.createSession('t3', 'test', { agent: false });
  ok(created.agent === false, 'new session honours the agent choice');
  ok(storage.listSessions().every(s => typeof s.agent === 'boolean'), 'session list exposes the agent flag');

  console.log('\n# context compaction');
  mock._config.contextWindowTokens = 50;
  mock._config.compactionKeepMessages = 2;
  storage.createSession('t4', 'test', { agent: true });
  const long = storage.loadSession('t4');
  for (let i = 0; i < 8; i++) {
    long.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(120), timestamp: '' });
  }
  long.messages.unshift({ role: 'system', content: 'Keep me.', timestamp: '' });
  storage.saveSession(long);

  const compSeen = scriptModel([[T('SUMMARY OF EARLIER TURNS')], [T('fresh answer')]]);
  const f = makePanel();
  await f.panel._handle({ type: 'sendMessage', name: 't4', modelId: 'test', content: 'next question' });
  const s4 = storage.loadSession('t4');
  ok(f.posted.some(m => m.type === 'compacting') && f.posted.some(m => m.type === 'compactDone'),
     'compaction is announced to the UI');
  ok(s4.messages[0].content === 'Keep me.', 'user system prompt survives compaction', s4.messages[0].content);
  ok(s4.messages[1]._compact && s4.messages[1].content === 'SUMMARY OF EARLIER TURNS',
     'summary card replaces the old turns', JSON.stringify(s4.messages[1]?.content));
  ok(s4.messages.at(-1).content === 'fresh answer', 'the new reply is appended after compaction', s4.messages.at(-1).content);
  ok(s4.messages.length < 11, 'history actually shrank', String(s4.messages.length));
  ok(!compSeen[0].options.tools, 'the summarisation request carries no tools');

  console.log('\n# a failed turn keeps history intact');
  mock.lm = { selectChatModels: async () => [{
    id: 'test', sendRequest: async () => { throw Object.assign(new Error('model exploded'), { code: 'oops' }); },
  }] };
  const before5 = storage.loadSession('t4').messages.length;
  const g = makePanel();
  await g.panel._handle({ type: 'sendMessage', name: 't4', modelId: 'test', content: 'this will fail' });
  const end5 = g.posted.find(m => m.type === 'streamEnd');
  ok(end5.error.includes('model exploded'), 'the error is surfaced', end5.error);
  ok(storage.loadSession('t4').messages.length === before5 + 1, 'only the user turn was stored', String(storage.loadSession('t4').messages.length - before5));
  mock._config.contextWindowTokens = 6000;

  console.log('\n# stop cancels a pending approval');
  const d = new ChatPanel({ extensionPath: path.dirname(SRC), subscriptions: [] });
  const dPosted = [];
  d._view = { webview: { postMessage: (m) => dPosted.push(m) } };
  const pending = d._requestApproval({ kind: 'write', title: 'Write x', diff: '+x' });
  d._handle({ type: 'stopGeneration' });
  ok((await pending) === false, 'stopping rejects the open approval');
  ok(dPosted.some(m => m.type === 'approvalClosed'), 'the card is told it was closed');

  console.log('\n# legacy sessions');
  const legacy = storage.createSession('old', 'test');
  delete legacy.agent;
  storage.saveSession(legacy);
  mock._config.defaultAgentMode = false;
  const h = makePanel();
  h.panel._handle({ type: 'loadSession', name: 'old' });
  ok(storage.loadSession('old').agent === false, 'a session with no agent flag adopts the setting',
     String(storage.loadSession('old').agent));
  ok(h.posted.find(m => m.type === 'sessionLoaded').session.agent === false, 'and the UI is told');
  mock._config.defaultAgentMode = true;

  console.log('\n# switching session ends the turn');
  const i = new ChatPanel({ extensionPath: path.dirname(SRC), subscriptions: [] });
  i._view = { webview: { postMessage: () => true } };
  const stranded = i._requestApproval({ kind: 'write', title: 'Write q', diff: '+q' });
  i._handle({ type: 'loadSession', name: 't1' });
  ok((await stranded) === false, 'a pending approval is rejected, not stranded');

  console.log('\n# auto-approve setting');
  mock._config.editApproval = 'auto';
  const e = new ChatPanel({ extensionPath: path.dirname(SRC), subscriptions: [] });
  const ePosted = [];
  e._view = { webview: { postMessage: (m) => ePosted.push(m) } };
  ok((await e._requestApproval({ kind: 'edit', title: 'Edit x' })) === true, 'edits auto-approve when configured');
  ok(ePosted.some(m => m.type === 'toolApprovalAuto'), 'the UI is still told what happened');
  const neverAuto = e._requestApproval({ kind: 'delete', title: 'Delete x', neverAuto: true });
  const askedId = ePosted.find(m => m.type === 'toolApproval')?.id;
  ok(!!askedId, 'deletions still ask even on auto');
  e._handle({ type: 'approvalResponse', id: askedId, approved: false });
  ok((await neverAuto) === false, 'and can still be rejected');
  mock._config.editApproval = 'ask';

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
