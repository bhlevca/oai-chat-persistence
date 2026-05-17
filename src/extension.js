'use strict';

const vscode = require('vscode');
const { ChatPanel } = require('./panel');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const provider = new ChatPanel(context);

  // Register the sidebar WebviewView
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'oaiChatPersistence.chatView',
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Keep the command so Ctrl+Shift+O and the palette still work
  context.subscriptions.push(
    vscode.commands.registerCommand('oaiChatPersistence.openChat', () => {
      provider.focus();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };

