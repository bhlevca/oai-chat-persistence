'use strict';
const Module = require('module');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const mock = require('./mock-vscode');
const orig = Module._load;
Module._load = function (r, ...x) { return r === 'vscode' ? mock : orig.call(this, r, ...x); };

const SRC = path.join(__dirname, '..', 'src');
const lm = require(path.join(SRC, 'lm.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-lm-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
mock._state.folders = [{ name: path.basename(root), uri: mock.Uri.file(root) }];

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${String(extra).replace(/\n/g, '\n       ')}` : ''}`); }
};

/** Build a scripted model: rounds[] of parts, recording what it was sent. */
function scriptModel(rounds, { throwOnTools = false } = {}) {
  const seen = [];
  mock.lm = {
    selectChatModels: async () => [{
      id: 'test', name: 'Test', vendor: 'mock', family: 'mock',
      sendRequest: async (messages, options) => {
        seen.push({ messages, options });
        if (throwOnTools && options.tools) {
          const e = new Error('The requested model does not support tools.');
          throw e;
        }
        const parts = rounds.shift() || [];
        return { stream: (async function* () { for (const p of parts) yield p; })() };
      },
    }],
  };
  return seen;
}

const noCancel = { isCancellationRequested: false };

(async () => {
  console.log('\n# agentic loop');
  const T = mock.LanguageModelTextPart, C = mock.LanguageModelToolCallPart;
  let seen = scriptModel([
    [new T('Let me look.'), new C('c1', 'read_file', { path: 'a.txt' })],
    [new T(' Done: two lines.')],
  ]);

  const events = [];
  let res = await lm.streamChat('test', [{ role: 'user', content: 'how many lines in a.txt?' }], {
    onChunk: (t) => events.push(['chunk', t]),
    onToolStart: (i) => events.push(['start', i.name, i.label]),
    onToolEnd: (i) => events.push(['end', i.name, i.ok]),
    requestApproval: async () => true,
  }, noCancel);

  ok(res.text === 'Let me look. Done: two lines.', 'text from both rounds is concatenated', res.text);
  ok(res.toolCalls.length === 1 && res.toolCalls[0].name === 'read_file', 'tool call recorded');
  ok(events.some(e => e[0] === 'start' && e[2] === 'read a.txt'), 'onToolStart carries a human label', JSON.stringify(events));
  ok(events.some(e => e[0] === 'end' && e[2] === true), 'onToolEnd reports success');
  ok(seen.length === 2, 'two model round-trips', String(seen.length));
  const second = seen[1].messages;
  ok(second.length === 3, 'tool result is fed back as a third message', String(second.length));
  ok(second[2].content[0] instanceof mock.LanguageModelToolResultPart, 'result arrives as a tool-result part');
  ok(String(seen[0].messages[0].content).includes('You are working inside'), 'agent preamble is prepended');
  ok(seen[0].options.tools.some(t => t.name === 'write_file'), 'write tools offered in agent mode');

  console.log('\n# approval wiring');
  scriptModel([
    [new C('c2', 'write_file', { path: 'b.txt', content: 'hello\n' })],
    [new T('Rejected, stopping.')],
  ]);
  const reqs = [];
  res = await lm.streamChat('test', [{ role: 'user', content: 'write b.txt' }], {
    onChunk: () => {},
    requestApproval: async (q) => { reqs.push(q); return false; },
  }, noCancel);
  ok(reqs.length === 1 && reqs[0].kind === 'create', 'write_file asked for approval', JSON.stringify(reqs[0]?.kind));
  ok(!fs.existsSync(path.join(root, 'b.txt')), 'rejected write created nothing');
  ok(res.toolCalls[0].result.includes('User rejected'), 'model is told the user rejected it', res.toolCalls[0].result);

  console.log('\n# read-only mode');
  seen = scriptModel([[new T('ok')]]);
  await lm.streamChat('test', [{ role: 'user', content: 'hi' }], { onChunk: () => {} }, noCancel, { agent: false });
  ok(!seen[0].options.tools.some(t => t.name === 'write_file'), 'no write tools in read-only mode');
  ok(seen[0].options.tools.some(t => t.name === 'read_file'), 'read tools still offered');
  ok(String(seen[0].messages[0].content).includes('read-only tools'), 'read-only preamble used');

  console.log('\n# models without tool support');
  seen = scriptModel([[new T('plain answer')]], { throwOnTools: true });
  const notices = [];
  res = await lm.streamChat('test', [{ role: 'user', content: 'hi' }], {
    onChunk: () => {}, onNotice: (t) => notices.push(t),
  }, noCancel);
  ok(res.text === 'plain answer', 'falls back to a tool-free request', res.text);
  ok(notices.length === 1 && /does not support tool calling/.test(notices[0]), 'user is told why', notices[0]);
  ok(!seen.at(-1).options.tools, 'retry carried no tools payload');

  console.log('\n# tools disabled (compaction path)');
  seen = scriptModel([[new T('summary text')]]);
  res = await lm.streamChat('test', [{ role: 'user', content: 'summarise' }], { onChunk: () => {} },
    noCancel, { agent: false, toolsEnabled: false });
  ok(!seen[0].options.tools, 'no tools when toolsEnabled is false');
  ok(!String(seen[0].messages[0].content).includes('You are working inside'), 'no preamble for summarisation');

  console.log('\n# history replay');
  seen = scriptModel([[new T('ok')]]);
  await lm.streamChat('test', [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'first' },
    { role: 'tool', _tool: true, name: 'read_file', label: 'read a.txt', ok: true, content: 'File: a.txt\none\ntwo' },
    { role: 'assistant', content: 'two lines' },
    { role: 'user', content: 'and now?' },
  ], { onChunk: () => {} }, noCancel);
  const msgs = seen[0].messages;
  ok(String(msgs[0].content).includes('Be terse.'), 'session system prompt folded into the first turn');
  ok(msgs.some(m => String(m.content).startsWith('[tool read a.txt: ok]')), 'tool history replays as a one-liner',
     JSON.stringify(msgs.map(m => String(m.content).slice(0, 40))));
  ok(!msgs.some(m => String(m.content).includes('one\ntwo')), 'full tool output is not replayed');

  console.log('\n# VS Code without the tool API (pre-1.95)');
  const savedCall = mock.LanguageModelToolCallPart;
  const savedRes  = mock.LanguageModelToolResultPart;
  delete mock.LanguageModelToolCallPart;
  delete mock.LanguageModelToolResultPart;
  seen = scriptModel([[new T('plain reply')]]);
  const oldNotices = [];
  res = await lm.streamChat('test', [{ role: 'user', content: 'hi' }], {
    onChunk: () => {}, onNotice: (t) => oldNotices.push(t),
  }, noCancel);
  ok(res.text === 'plain reply', 'still answers without the tool API', res.text);
  ok(!seen[0].options.tools, 'no tools payload sent');
  ok(oldNotices.some(n => /1\.95/.test(n)), 'the user is told which version is needed', oldNotices[0]);
  mock.LanguageModelToolCallPart = savedCall;
  mock.LanguageModelToolResultPart = savedRes;

  console.log('\n# fallback text tool calls (Qwen / local LLM format)');
  scriptModel([
    [new T('```json\n{\n  "name": "write_file",\n  "arguments": {\n    "content": "hello",\n    "path": "c.txt"\n  }\n}\n```')],
    [new T('File c.txt created.')],
  ]);
  const textEvents = [];
  res = await lm.streamChat('test', [{ role: 'user', content: 'create c.txt' }], {
    onChunk: (t) => textEvents.push(['chunk', t]),
    onResetStream: (t) => textEvents.push(['reset', t]),
    onToolStart: (i) => textEvents.push(['start', i.name]),
    onToolEnd: (i) => textEvents.push(['end', i.name, i.ok]),
    requestApproval: async () => true,
  }, noCancel);
  ok(res.toolCalls.length === 1 && res.toolCalls[0].name === 'write_file', 'text JSON tool call parsed and executed');
  ok(fs.existsSync(path.join(root, 'c.txt')), 'c.txt written to disk by fallback tool call');
  ok(textEvents.some(e => e[0] === 'reset'), 'resetStream fired to clear raw tool JSON from bubble');
  ok(res.text.includes('File c.txt created.'), 'clean assistant answer preserved without raw tool JSON');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
