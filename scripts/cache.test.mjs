import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

test('an existing SQLite cache migrates and retains origin when reopening a chat', async () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE cached_chats (
    server_id TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL,
    status TEXT NOT NULL, revision TEXT, next_cursor TEXT, has_more INTEGER NOT NULL,
    PRIMARY KEY (server_id, chat_id));
    INSERT INTO cached_chats VALUES ('server', 'old', '旧缓存', '', 'idle', NULL, NULL, 0);`);
  const connection = {
    open: async () => {},
    execute: async sql => database.exec(sql),
    query: async (sql, values = []) => ({ values: database.prepare(sql).all(...values) }),
    executeSet: async entries => {
      database.exec('BEGIN');
      try { for (const entry of entries) database.prepare(entry.statement).run(...entry.values); database.exec('COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  const source = readFileSync(new URL('../src/cache.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class ChatCache', 'class ChatCache');
  const ChatCache = new Function('Capacitor', 'CapacitorSQLite', 'SQLiteConnection', stripTypeScriptTypes(source) + '\nreturn ChatCache;')(
    { getPlatform: () => 'android' }, {}, class { async checkConnectionsConsistency() {} async createConnection() { return connection; } });
  try {
    const cache = new ChatCache(); await cache.open();
    assert.equal((await cache.load('server', 'old')).title, '旧缓存');
    const page = { id: 'child', title: '新对话', cwd: '', status: 'idle', turns: [], nextCursor: null, hasMore: false,
      origin: { id: 'source', title: '来源对话' } };
    await cache.save('server', page, null);
    const reopened = new ChatCache(); await reopened.open();
    assert.deepEqual((await reopened.load('server', 'child')).origin, page.origin);
    await reopened.save('another-server', { ...page, origin: null }, null);
    assert.deepEqual((await reopened.load('server', 'child')).origin, page.origin);
    assert.equal((await reopened.load('another-server', 'child')).origin, null);
  } finally { database.close(); }
});
