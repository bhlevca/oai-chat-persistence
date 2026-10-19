'use strict';
// Smoke test: does the extension activate, register everything it contributes,
// and build its webview HTML without blowing up?
const Module = require('module');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oai-home-'));
process.env.HOME = HOME;

const mock = require('./mock-vscode');
const orig = Module._load;
Module._load = function (r, ...x) { return r === 'vscode' ? mock : orig.call(this, r, ...x); };

const ROOT = path.join(__dirname, '..');
const pkg  = require(path.join(ROOT, 'package.json'));

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${String(extra).replace(/\n/g, '\n       ')}` : ''}`); }
};

// Capture what activate() registers
const registered = { commands: [], views: [], providers: [] };
mock.commands.registerCommand = (id, fn) => { registered.commands.push({ id, fn }); return { dispose() {} }; };
mock.window.registerWebviewViewProvider = (id, provider) => {
  registered.views.push({ id, provider }); return { dispose() {} };
};
mock.workspace.registerTextDocumentContentProvider = (scheme, p) => {
  registered.providers.push({ scheme, p }); return { dispose() {} };
};

const ext = require(path.join(ROOT, 'src', 'extension.js'));

(async () => {
console.log('\n# activation');
const context = { extensionPath: ROOT, subscriptions: [] };
let activateError = null;
try { ext.activate(context); } catch (e) { activateError = e; }
ok(!activateError, 'activate() runs clean', activateError && activateError.stack);
ok(typeof ext.deactivate === 'function', 'deactivate() is exported');
ok(context.subscriptions.length >= 7, 'everything is pushed to subscriptions for disposal',
   String(context.subscriptions.length));

console.log('\n# contributions line up with package.json');
const declared = pkg.contributes.commands.map((c) => c.command);
const wired    = registered.commands.map((c) => c.id);
for (const id of declared) ok(wired.includes(id), `declared command is registered: ${id}`);
for (const id of wired) ok(declared.includes(id), `registered command is declared: ${id}`);
ok(registered.views[0]?.id === pkg.contributes.views['oai-chat-sidebar'][0].id,
   'the sidebar view id matches package.json', registered.views[0]?.id);
ok(registered.providers.some((p) => p.scheme === 'oai-proposed'), 'diff-preview scheme registered');

console.log('\n# settings used by the code exist in package.json');
const props = Object.keys(pkg.contributes.configuration.properties);
const sources = ['panel.js', 'tools.js', 'workspace.js', 'lm.js']
  .map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
const used = [...sources.matchAll(/\.get\('([A-Za-z]+)'\)/g)].map((m) => `oaiChatPersistence.${m[1]}`);
for (const key of [...new Set(used)]) ok(props.includes(key), `setting declared: ${key}`);

console.log('\n# webview html');
const view = registered.views[0].provider;
const posts = [];
const webviewView = {
  webview: { options: {}, html: '', postMessage: (m) => posts.push(m),
             onDidReceiveMessage: () => ({ dispose() {} }) },
  onDidDispose: () => ({ dispose() {} }),
  onDidChangeVisibility: () => ({ dispose() {} }),
  visible: true,
};
let resolveError = null;
try { view.resolveWebviewView(webviewView, {}, {}); } catch (e) { resolveError = e; }
ok(!resolveError, 'resolveWebviewView runs clean', resolveError && resolveError.stack);
const html = webviewView.webview.html;
ok(html.includes('<!DOCTYPE html>'), 'html was loaded from disk');
ok(!html.includes('{{NONCE}}'), 'the CSP nonce placeholder was replaced');
const nonce = html.match(/nonce-([0-9a-f]+)/)?.[1];
ok(!!nonce && html.includes(`<script nonce="${nonce}">`), 'script tag carries the same nonce', nonce);
ok(webviewView.webview.options.enableScripts === true, 'scripts enabled for the view');
ok(posts.some((m) => m.type === 'editorContext'), 'initial editor context is pushed to the UI');

console.log('\n# command handlers survive a missing editor');
mock._state.activeEditor = null;
for (const { id, fn } of registered.commands) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  ok(!err, `no editor: ${id} degrades gracefully`, err && err.message);
}

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
