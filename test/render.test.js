'use strict';
// Runs the webview's pure rendering helpers in a VM (no DOM needed).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'webview.html'), 'utf8');
const script = html.match(/<script nonce="\{\{NONCE\}\}">([\s\S]*?)<\/script>/)[1];

/** Grab a top-level `function name(...) {...}` block (closing brace at column 0). */
function grab(name) {
  const lines = script.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`missing function ${name}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end < 0) throw new Error(`unbalanced ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

const ctx = vm.createContext({ console, state: { capabilities: { hasWorkspace: true } } });
vm.runInContext(
  'let cbSeq = 0; const codeBlocks = new Map();\n' +
  ['esc', 'inlineMd', 'plainText', 'parseFenceInfo', 'renderCodeBlock', 'renderMarkdown', 'renderDiffHtml']
    .map(grab).join('\n'),
  ctx
);
const { renderMarkdown, parseFenceInfo, renderDiffHtml, esc, codeBlocks } =
  vm.runInContext('({ renderMarkdown, parseFenceInfo, renderDiffHtml, esc, codeBlocks })', ctx);

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? `\n       ${String(extra).replace(/\n/g, '\n       ')}` : ''}`); }
};
const blockOf = (md) => { const h = renderMarkdown(md); const id = h.match(/data-cb="(cb\d+)"/)?.[1]; return { html: h, entry: codeBlocks.get(id) }; };

console.log('\n# fence info parsing');
ok(parseFenceInfo('js').path === '' && parseFenceInfo('js').lang === 'js', 'plain language fence');
let p = parseFenceInfo('js src/panel.js');
ok(p.lang === 'js' && p.path === 'src/panel.js', 'language + path fence', JSON.stringify(p));
p = parseFenceInfo('src/panel.js');
ok(p.path === 'src/panel.js' && p.lang === 'js', 'path-only fence infers the language', JSON.stringify(p));
p = parseFenceInfo('python path=scripts/run.py');
ok(p.lang === 'python' && p.path === 'scripts/run.py', 'path= prefix is stripped', JSON.stringify(p));
p = parseFenceInfo('ts (src/x.ts)');
ok(p.path === 'src/x.ts', 'parenthesised path', JSON.stringify(p));

console.log('\n# code block extraction');
let r = blockOf('text\n```js src/app.js\nconst a = 1;\n```\nafter');
ok(r.entry.code === 'const a = 1;', 'block code captured exactly', JSON.stringify(r.entry?.code));
ok(r.entry.path === 'src/app.js', 'target path captured');
ok(r.html.includes('class="code-wrap"') && r.html.includes('code-path">src/app.js'), 'wrapper and path header rendered');
ok(r.html.includes('text') && r.html.includes('after'), 'surrounding prose preserved');

r = blockOf('```\n# File: src/storage.js\nmodule.exports = {};\n```');
ok(r.entry.path === 'src/storage.js', '"# File:" header becomes the target', JSON.stringify(r.entry?.path));
ok(r.entry.code === 'module.exports = {};', '"# File:" line stripped from the payload', JSON.stringify(r.entry?.code));

r = blockOf('```\n// File: a.ts\nlet x;\n```');
ok(r.entry.path === 'a.ts' && r.entry.code === 'let x;', '// File: header variant', JSON.stringify(r.entry));

r = blockOf('```\nplain snippet\n```');
ok(r.entry.code === 'plain snippet' && r.entry.path === '', 'untargeted block still actionable');

console.log('\n# escaping / safety');
r = blockOf('```html\n<script>alert(1)</script>\n```');
ok(!r.html.includes('<script>') && r.html.includes('&lt;script&gt;'), 'html in code is escaped', r.html);
ok(r.entry.code === '<script>alert(1)</script>', 'but the payload keeps the original text');
const injected = renderMarkdown('<img src=x onerror=alert(1)>');
ok(!injected.includes('<img'), 'inline html is escaped', injected);
r = blockOf('```js\nconst price = "$& $1 $`";\n```');
ok(r.entry.code === 'const price = "$& $1 $`";', 'dollar patterns survive rendering', JSON.stringify(r.entry?.code));

console.log('\n# misc rendering');
ok(renderMarkdown('a **b** `c`').includes('<strong>b</strong>'), 'bold still renders');
ok(renderMarkdown('x\n```js\n1\n```\ny\n```js\n2\n```').match(/data-cb/g).length === 2, 'multiple blocks each get actions');
ok(renderMarkdown('```js\nx\n```', { withActions: false }).indexOf('code-wrap') === -1, 'streaming render omits actions');

console.log('\n# diff colouring');
const d = renderDiffHtml('--- f\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new');
ok(d.includes('class="diff-del">-old') && d.includes('class="diff-add">+new'), 'added/removed lines are classed', d);
ok(d.includes('class="diff-meta">@@'), 'hunk header is classed');
ok(renderDiffHtml('-<b>x</b>').includes('&lt;b&gt;'), 'diff content is escaped');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
