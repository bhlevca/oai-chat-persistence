'use strict';

const vscode = require('vscode');
const { ChatPanel } = require('./panel');
const ws = require('./workspace');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new ChatPanel(context);

  // Virtual documents used for "proposed content" diff views
  ws.registerProposedProvider(context);

  // Register the sidebar WebviewView
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'oaiChatPersistence.chatView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const register = (id, fn) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Keep the command so Ctrl+Shift+O and the palette still work
  register('oaiChatPersistence.openChat', () => provider.focus());

  // ── Editor / explorer entry points ──────────────────────────────────────────

  register('oaiChatPersistence.addActiveFileToChat', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('OAI Chat: no active editor.');
      return;
    }
    await provider.insertIntoInput(`@${ws.label(editor.document.uri)} `);
  });

  register('oaiChatPersistence.addFileToChat', async (uri, uris) => {
    const targets = (uris && uris.length ? uris : [uri]).filter(Boolean);
    if (!targets.length) return;
    await provider.insertIntoInput(targets.map((u) => `@${ws.label(u)}`).join(' ') + ' ');
  });

  register('oaiChatPersistence.sendSelectionToChat', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage('OAI Chat: select some code first.');
      return;
    }
    await provider.insertIntoInput('@selection ');
  });

  register('oaiChatPersistence.explainSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage('OAI Chat: select some code first.');
      return;
    }
    await provider.insertIntoInput('Explain this code:\n@selection', { autoSend: true });
  });

  register('oaiChatPersistence.fixProblems', async () => {
    await provider.insertIntoInput(
      'Fix the problems reported in the workspace:\n@problems',
      { autoSend: true }
    );
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
