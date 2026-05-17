'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_DIR = path.join(os.homedir(), '.vscode', 'oai-chat-persistence');

function ensureBaseDir() {
  if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  }
}

/** Sanitise display name to a safe filename (max 64 chars). */
function safeFileName(name) {
  return (name || 'session')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64) || 'session';
}

function sessionPath(name) {
  return path.join(BASE_DIR, `${safeFileName(name)}.json`);
}

/**
 * Load a session from disk.
 * @param {string} name  display name of the session
 * @returns {{ name: string, model: string, created: string, updated: string, messages: object[] } | null}
 */
function loadSession(name) {
  ensureBaseDir();
  const filePath = sessionPath(name);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Create a new session. Returns existing if the name already exists.
 * @param {string} name
 * @param {string} [model]
 * @returns {{ name: string, model: string, created: string, updated: string, messages: object[] }}
 */
function createSession(name, model) {
  const existing = loadSession(name);
  if (existing) return existing;
  const now = new Date().toISOString();
  const session = { name, model: model || '', created: now, updated: now, messages: [] };
  _write(name, session);
  return session;
}

/**
 * Persist a full session object to disk.
 * @param {{ name: string, messages: object[] }} session
 */
function saveSession(session) {
  session.updated = new Date().toISOString();
  _write(session.name, session);
}

/**
 * Append a single message and persist.
 * @returns {object} updated session
 */
function appendMessage(name, role, content) {
  let session = loadSession(name);
  if (!session) {
    const now = new Date().toISOString();
    session = { name, model: '', created: now, updated: now, messages: [] };
  }
  session.messages.push({ role, content, timestamp: new Date().toISOString() });
  saveSession(session);
  return session;
}

/** Delete session file. */
function deleteSession(name) {
  const filePath = sessionPath(name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/**
 * List all sessions sorted by most-recently updated.
 * @returns {{ name: string, model: string, messageCount: number, updated: string }[]}
 */
function listSessions() {
  ensureBaseDir();
  return fs
    .readdirSync(BASE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(BASE_DIR, f), 'utf8'));
        return {
          name: s.name || f.replace(/\.json$/, ''),
          model: s.model || '',
          messageCount: (s.messages || []).length,
          updated: s.updated || '',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

/**
 * Export messages in OpenAI-compatible format (role + content only).
 * @returns {{ role: string, content: string }[] | null}
 */
function exportSession(name) {
  const session = loadSession(name);
  if (!session) return null;
  return session.messages.map(({ role, content }) => ({ role, content }));
}

function _write(name, session) {
  ensureBaseDir();
  fs.writeFileSync(sessionPath(name), JSON.stringify(session, null, 2), 'utf8');
}

module.exports = {
  BASE_DIR,
  ensureBaseDir,
  loadSession,
  createSession,
  saveSession,
  appendMessage,
  deleteSession,
  listSessions,
  exportSession,
};
