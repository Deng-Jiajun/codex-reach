import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import type { HistoryPage, Message, Turn } from './types';

export class ChatCache {
  private database?: SQLiteDBConnection;

  async open(): Promise<void> {
    if (Capacitor.getPlatform() !== 'android') return;
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    await sqlite.checkConnectionsConsistency();
    this.database = await sqlite.createConnection('codex_reach', false, 'no-encryption', 1, false);
    await this.database.open();
    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS cached_chats (
        server_id TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT NOT NULL, cwd TEXT NOT NULL,
        status TEXT NOT NULL, revision TEXT, next_cursor TEXT, has_more INTEGER NOT NULL,
        PRIMARY KEY (server_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS cached_turns (
        server_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        position INTEGER NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY (server_id, chat_id, turn_id)
      );
      CREATE TABLE IF NOT EXISTS cached_messages (
        server_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
        position INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, phase TEXT,
        PRIMARY KEY (server_id, chat_id, turn_id, item_id)
      );
    `);
  }

  async load(serverId: string, chatId: string): Promise<HistoryPage | null> {
    if (!this.database) return null;
    const key = [serverId, chatId];
    const chat = (await this.database.query('SELECT * FROM cached_chats WHERE server_id=? AND chat_id=?', key)).values?.[0];
    if (!chat) return null;
    const rows = (await this.database.query('SELECT * FROM cached_turns WHERE server_id=? AND chat_id=? ORDER BY position', key)).values ?? [];
    const messages = (await this.database.query('SELECT * FROM cached_messages WHERE server_id=? AND chat_id=? ORDER BY position', key)).values ?? [];
    const turns: Turn[] = rows.map(row => ({
      id: row.turn_id, status: row.status,
      messages: messages.filter(message => message.turn_id === row.turn_id).map((message): Message => ({
        id: message.item_id, kind: message.kind, text: message.text, phase: message.phase,
      })),
    }));
    return { id: chatId, title: chat.title, cwd: chat.cwd, status: chat.status, turns, nextCursor: chat.next_cursor, hasMore: Boolean(chat.has_more) };
  }

  async save(serverId: string, page: HistoryPage, revision: string | null): Promise<void> {
    if (!this.database) return;
    const key = [serverId, page.id];
    const entries = [
      { statement: 'DELETE FROM cached_messages WHERE server_id=? AND chat_id=?', values: key },
      { statement: 'DELETE FROM cached_turns WHERE server_id=? AND chat_id=?', values: key },
      {
        statement: `INSERT OR REPLACE INTO cached_chats
          (server_id, chat_id, title, cwd, status, revision, next_cursor, has_more) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [...key, page.title, page.cwd, page.status, revision, page.nextCursor, page.hasMore ? 1 : 0],
      },
    ];
    page.turns.slice(-10).forEach((turn, position) => {
      entries.push({
        statement: 'INSERT INTO cached_turns (server_id, chat_id, turn_id, position, status) VALUES (?, ?, ?, ?, ?)',
        values: [...key, turn.id, position, turn.status],
      });
      turn.messages.forEach((message, itemPosition) => entries.push({
        statement: `INSERT INTO cached_messages
          (server_id, chat_id, turn_id, item_id, position, kind, text, phase) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [...key, turn.id, message.id, itemPosition, message.kind, message.text, message.phase],
      }));
    });
    await this.database.executeSet(entries, true);
  }
}
