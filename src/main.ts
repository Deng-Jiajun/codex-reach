import { Capacitor } from '@capacitor/core';
import {
  CapacitorSQLite,
  SQLiteConnection,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite';
import './style.css';

type Stage = 'write' | 'persist';
type Check = { name: string; milliseconds: number };
type VerificationResult = {
  ok: boolean;
  stage: Stage;
  checks: Check[];
  token?: string;
  error?: string;
};

declare global {
  interface Window {
    codexReachVerification: {
      result: VerificationResult | null;
      run: (stage: Stage) => Promise<void>;
    };
  }
}

const databaseName = 'codex_reach_verification';
const messageCount = 1000;
const sqlite = new SQLiteConnection(CapacitorSQLite);
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const results = document.querySelector<HTMLOListElement>('#results')!;
const summary = document.querySelector<HTMLParagraphElement>('#summary')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const persistButton = document.querySelector<HTMLButtonElement>('#persist')!;
const insertMessage = `
  INSERT INTO messages (conversation_id, turn_id, ordinal, content)
  VALUES (?, ?, ?, ?)
`;
let running = false;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyStoredData(database: SQLiteDBConnection): Promise<string> {
  const count = await database.query(
    'SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?', ['main'],
  );
  requireCondition(count.values?.[0]?.total === messageCount, '保存的消息数量不一致');

  const latest = await database.query(
    'SELECT turn_id, content FROM messages WHERE conversation_id = ? ORDER BY ordinal DESC LIMIT 1',
    ['main'],
  );
  requireCondition(latest.values?.[0]?.turn_id === 'edited-turn', '最新轮次 ID 未保存');
  requireCondition(latest.values?.[0]?.content === '编辑后的合成消息', '最新消息内容未保存');

  const sync = await database.query(
    'SELECT revision, token FROM sync_state WHERE conversation_id = ?', ['main'],
  );
  requireCondition(sync.values?.[0]?.revision === 2, '同步位置与消息内容不一致');
  requireCondition(typeof sync.values?.[0]?.token === 'string', '缺少持久化验证标记');

  const other = await database.query(
    'SELECT content FROM messages WHERE conversation_id = ?', ['other'],
  );
  requireCondition(other.values?.length === 1 && other.values[0].content === '其他会话', '其他会话数据发生变化');
  return sync.values[0].token;
}

async function runVerification(stage: Stage): Promise<void> {
  if (running) return;
  running = true;
  runButton.disabled = true;
  persistButton.disabled = true;
  results.replaceChildren();
  summary.textContent = '';
  status.textContent = '正在检查…';
  status.dataset.state = 'running';
  window.codexReachVerification.result = null;

  const checks: Check[] = [];
  const result: VerificationResult = { ok: false, stage, checks };
  let database: SQLiteDBConnection | undefined;

  async function check(name: string, action: () => Promise<void>): Promise<void> {
    const started = performance.now();
    await action();
    const milliseconds = Math.round(performance.now() - started);
    checks.push({ name, milliseconds });
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = name;
    const timing = document.createElement('span');
    timing.className = 'timing';
    timing.textContent = `${milliseconds} ms`;
    item.append(label, timing);
    results.append(item);
  }

  try {
    requireCondition(Capacitor.getPlatform() === 'android', '原生 SQLite 检查需要在 Android APK 中运行');
    database = await sqlite.createConnection(databaseName, false, 'no-encryption', 1, false);
    const connection = database;
    await check('打开原生 SQLite 数据库', () => connection.open());

    if (stage === 'write') {
      await check('创建验证表', async () => {
        await connection.execute(`
          CREATE TABLE IF NOT EXISTS messages (
            conversation_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            content TEXT NOT NULL,
            PRIMARY KEY (conversation_id, turn_id)
          );
          CREATE INDEX IF NOT EXISTS message_order ON messages (conversation_id, ordinal);
          CREATE TABLE IF NOT EXISTS sync_state (
            conversation_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            token TEXT NOT NULL
          );
          DELETE FROM messages;
          DELETE FROM sync_state;
        `);
      });

      await check(`批量写入 ${messageCount} 条消息`, async () => {
        const entries = Array.from({ length: messageCount }, (_, index) => ({
          statement: insertMessage,
          values: ['main', `turn-${index}`, index, `合成消息 ${index}，用于检查聊天缓存。`],
        }));
        await connection.executeSet([
          ...entries,
          { statement: insertMessage, values: ['other', 'other-turn', 0, '其他会话'] },
          {
            statement: 'INSERT INTO sync_state (conversation_id, revision, token) VALUES (?, ?, ?)',
            values: ['main', 1, crypto.randomUUID()],
          },
        ], true);
      });

      await check('按会话连续读取两页历史', async () => {
        const query = 'SELECT ordinal FROM messages WHERE conversation_id = ? ORDER BY ordinal DESC LIMIT ? OFFSET ?';
        const first = await connection.query(query, ['main', 50, 0]);
        const second = await connection.query(query, ['main', 50, 50]);
        requireCondition(first.values?.length === 50 && second.values?.length === 50, '历史分页数量错误');
        requireCondition(first.values.every((row, index) => row.ordinal === messageCount - 1 - index), '第一页排序错误');
        requireCondition(second.values.every((row, index) => row.ordinal === messageCount - 51 - index), '第二页排序错误');
      });

      await check('同一事务替换最新轮次并保存同步位置', async () => {
        await connection.executeSet([
          { statement: 'DELETE FROM messages WHERE conversation_id = ? AND turn_id = ?', values: ['main', `turn-${messageCount - 1}`] },
          { statement: insertMessage, values: ['main', 'edited-turn', messageCount - 1, '编辑后的合成消息'] },
          { statement: 'UPDATE sync_state SET revision = ? WHERE conversation_id = ?', values: [2, 'main'] },
        ], true);
        result.token = await verifyStoredData(connection);
      });

      await check('写入中途失败后回滚消息与同步位置', async () => {
        let rejected = false;
        try {
          await connection.executeSet([
            { statement: insertMessage, values: ['main', 'rollback-turn', messageCount, '应回滚的数据'] },
            { statement: 'UPDATE sync_state SET revision = ? WHERE conversation_id = ?', values: [3, 'main'] },
            {
              statement: 'INSERT INTO sync_state (conversation_id, revision, token) VALUES (?, ?, ?)',
              values: ['main', 4, 'duplicate-primary-key'],
            },
          ], true);
        } catch (error) {
          requireCondition(String(error).includes('UNIQUE constraint failed'), `预期主键冲突，实际错误为 ${String(error)}`);
          rejected = true;
        }
        requireCondition(rejected, '重复主键未触发失败');
        await verifyStoredData(connection);
      });

      await check('关闭并重新打开连接后读取数据', async () => {
        await connection.close();
        await connection.open();
        result.token = await verifyStoredData(connection);
      });
    } else {
      await check('读取上次运行保存的消息与同步位置', async () => {
        result.token = await verifyStoredData(connection);
      });
    }
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (database) {
      try {
        await sqlite.closeConnection(databaseName, false);
      } catch (error) {
        result.ok = false;
        result.error = `${result.error ? `${result.error}；` : ''}关闭连接失败 ${String(error)}`;
      }
    }
    running = false;
    runButton.disabled = false;
    persistButton.disabled = false;
    status.dataset.state = result.ok ? 'passed' : 'failed';
    status.textContent = result.ok ? `${checks.length} 项检查通过` : '检查失败';
    summary.textContent = result.ok ? `数据标记 ${result.token}` : result.error ?? '未知错误';
    window.codexReachVerification.result = result;
  }
}

window.codexReachVerification = { result: null, run: runVerification };
runButton.addEventListener('click', () => void runVerification('write'));
persistButton.addEventListener('click', () => void runVerification('persist'));
document.querySelector('#platform')!.textContent = Capacitor.getPlatform() === 'android'
  ? 'Capacitor 8.6.0 · SQLite 8.1.1'
  : '浏览器预览 · 原生检查请在 APK 中运行';
