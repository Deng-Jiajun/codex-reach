import { showDialog } from './ui';
import { ReachClient, ReachError } from './api';
import { openReader } from './reader';
import { threadTitle } from './thread-list';
import type { Receipt, Thread } from './types';

function dialog(title: string): { root: HTMLDialogElement; body: HTMLElement; status: HTMLElement } {
  const root = document.createElement('dialog'); root.className = 'task-dialog';
  root.innerHTML = '<div class="dialog-header"><button type="button" class="quiet">返回</button><h2></h2></div><div class="organization-content"></div><p class="field-note" role="status"></p>';
  root.querySelector('h2')!.textContent = title;
  root.querySelector('button')!.addEventListener('click', () => root.close());
  root.addEventListener('close', () => root.remove(), { once: true });
  document.body.append(root); showDialog(root);
  return { root, body: root.querySelector('.organization-content')!, status: root.querySelector('p')! };
}

export function openDeletion(client: ReachClient, thread: Thread, removed: (ids: string[]) => Promise<void>): void {
  const view = dialog('永久删除对话');
  const key = `codex-reach-delete:${client.connection.serverId}:${thread.id}`;
  type Preview = { threads: { id: string; title: string; cwd: string }[]; fingerprint: string; requestId?: string };
  let preview: Preview | null = null;
  const stored = localStorage.getItem(key);
  if (stored) { try { preview = JSON.parse(stored) as Preview; } catch { localStorage.removeItem(key); } }
  const button = document.createElement('button'); button.type = 'button'; button.className = 'primary danger'; button.disabled = true;
  view.root.append(button);
  function render(): void {
    view.body.replaceChildren();
    const label = document.createElement('p'); label.textContent = `将永久删除「${threadTitle(thread)}」及以下范围内的对话。`;
    const list = document.createElement('ul');
    for (const affected of preview?.threads ?? []) {
      const item = document.createElement('li'); item.textContent = `${threadTitle(affected)} · ${affected.cwd}`; list.append(item);
    }
    const scope = document.createElement('p'); scope.className = 'field-note';
    scope.textContent = '范围包含已发现的子对话和附属对话。桌面删除会级联处理执行时的关联对话。';
    view.body.append(label, list, scope);
    button.textContent = preview?.requestId ? '查询删除结果' : `确认永久删除 ${preview?.threads.length ?? 0} 个对话`;
    button.disabled = !preview;
  }
  async function result(): Promise<void> {
    if (!preview?.requestId) return;
    let receipt: Receipt;
    try { receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(preview.requestId)}`); }
    catch (error) {
      if (!(error instanceof ReachError) || error.status !== 404) throw error;
      receipt = await client.request<Receipt>(`/threads/${encodeURIComponent(thread.id)}/delete`, 'POST', { requestId: preview.requestId, fingerprint: preview.fingerprint });
    }
    if (receipt.status === 'accepted') {
      await removed(preview.threads.map(item => item.id)); localStorage.removeItem(key); view.root.close(); return;
    }
    view.status.textContent = receipt.status === 'sending' ? '桌面正在处理删除，可稍后查询结果。' : receipt.error ?? '删除结果待确认，请核对对话列表。';
  }
  button.addEventListener('click', async () => {
    if (!preview) return;
    button.disabled = true;
    try {
      if (!preview.requestId) {
        preview.requestId = crypto.randomUUID(); localStorage.setItem(key, JSON.stringify(preview));
        await client.request(`/threads/${encodeURIComponent(thread.id)}/delete`, 'POST', { requestId: preview.requestId, fingerprint: preview.fingerprint });
      }
      await result();
    } catch (error) {
      view.status.textContent = error instanceof Error ? error.message : String(error);
      if (error instanceof ReachError && error.status === 409) { localStorage.removeItem(key); preview = null; await load(); }
    } finally { if (view.root.open) render(); }
  });
  async function load(): Promise<void> {
    view.status.textContent = '正在核对删除范围…';
    try {
      preview = await client.request<Preview>(`/threads/${encodeURIComponent(thread.id)}/delete-preview`);
      if (view.root.open) { view.status.textContent = ''; render(); }
    } catch (error) { if (view.root.open) view.status.textContent = String(error); }
  }
  if (preview) { render(); void result().catch(error => { view.status.textContent = String(error); }); }
  else void load();
}

export function openChanges(client: ReachClient, threadId: string, cwd: string): void {
  const view = dialog('改动文件');
  const scope = document.createElement('p'); scope.className = 'field-note';
  scope.textContent = '显示该对话工具记录中的文件变更。每条差异保留所属轮次和执行结果。';
  view.body.append(scope);
  const rows = document.createElement('div'); view.body.append(rows);
  const more = document.createElement('button'); more.type = 'button'; more.className = 'quiet'; more.textContent = '继续读取更早记录'; view.root.append(more);
  let cursor: string | null = null;
  let count = 0;
  let changesCount = 0;
  const known = new Set<string>();
  type ChangePage = { changes: { turnId: string; itemId: string; status: string; changes: { path: string; kind: { type: string; move_path?: string }; diff: string }[] }[]; nextCursor: string | null; readCount: number };
  async function load(): Promise<void> {
    more.disabled = true; view.status.textContent = `正在读取文件变更，已检查 ${count} 条记录…`;
    try {
      const page = await client.request<ChangePage>(`/threads/${encodeURIComponent(threadId)}/changes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!view.root.open) return;
      count += page.readCount; cursor = page.nextCursor;
      for (const group of page.changes) {
        if (known.has(group.itemId)) continue; known.add(group.itemId);
        for (const change of group.changes ?? []) {
          changesCount++;
          const entry = document.createElement('details'); entry.className = 'change-entry';
          const title = document.createElement('summary');
          title.textContent = `${({ add: '新增', delete: '删除', update: '修改' } as Record<string, string>)[change.kind.type] ?? change.kind.type} · ${change.path}`;
          const detail = document.createElement('p'); detail.className = 'field-note';
          detail.textContent = `轮次 ${group.turnId} · ${{ completed: '已执行', failed: '执行失败', declined: '未批准', inProgress: '执行中' }[group.status] ?? group.status}${change.kind.move_path ? ` · 移动到 ${change.kind.move_path}` : ''}`;
          const open = document.createElement('button'); open.type = 'button'; open.className = 'quiet'; open.textContent = '打开当前文件';
          open.addEventListener('click', () => void openReader(change.kind.move_path ?? change.path, client, cwd));
          const diff = document.createElement('pre'); diff.className = 'change-diff';
          if (change.diff) for (const line of change.diff.split('\n')) {
            const span = document.createElement('span'); span.textContent = line + '\n';
            span.className = line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-removed' : line.startsWith('@@') ? 'diff-range' : '';
            diff.append(span);
          } else diff.textContent = '此文件没有可用的文本差异，可能是二进制文件或记录未包含差异。';
          entry.append(title, detail, open, diff); rows.append(entry);
        }
      }
      view.status.textContent = `已检查 ${count} 条对话记录，找到 ${changesCount} 项文件变更${cursor ? '，可继续读取' : ''}`;
      more.hidden = !cursor;
    } catch (error) { if (view.root.open) view.status.textContent = String(error); }
    finally { more.disabled = false; }
  }
  more.addEventListener('click', () => void load()); void load();
}
