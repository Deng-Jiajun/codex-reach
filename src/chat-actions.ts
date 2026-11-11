import { ReachClient, ReachError } from './api';
import type { HistoryPage, Receipt } from './types';

type ForkOperation = { requestId: string; status: string; error?: string; result?: Receipt['result'] };

export function openChatActions(client: ReachClient, chat: HistoryPage, storageKey: string, callbacks: {
  onOpen: (threadId: string) => void;
  onPinned: (pinned: boolean) => void;
}): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog';
  dialog.id = 'chat-actions-dialog';
  dialog.innerHTML = `<div class="dialog-header"><button class="quiet" type="button" data-back>返回</button><h2>对话操作</h2></div>
    <button class="quiet" type="button" data-pin disabled>正在读取置顶状态…</button>
    <hr><p class="field-note">分支会复制当前完整历史，使用相同工作目录。原对话正在执行时，也会包含当前轮次已有内容。</p>
    <button class="primary" type="button" data-fork>创建完整历史分支</button>
    <p class="field-note" role="status" data-status hidden></p>
    <button class="quiet" type="button" data-query hidden>重新查询结果</button>
    <button class="quiet" type="button" data-open hidden>打开已创建的分支</button>
    <button class="quiet" type="button" data-reset hidden>已核对会话列表，恢复操作</button>`;
  const pin = dialog.querySelector<HTMLButtonElement>('[data-pin]')!;
  const fork = dialog.querySelector<HTMLButtonElement>('[data-fork]')!;
  const status = dialog.querySelector<HTMLParagraphElement>('[data-status]')!;
  const query = dialog.querySelector<HTMLButtonElement>('[data-query]')!;
  const open = dialog.querySelector<HTMLButtonElement>('[data-open]')!;
  const reset = dialog.querySelector<HTMLButtonElement>('[data-reset]')!;
  let operation: ForkOperation | null = null;
  try { operation = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as ForkOperation | null; } catch { /* Ignore an unreadable local record. */ }
  let pinned = false;
  let polling = false;

  function render(): void {
    fork.disabled = Boolean(operation);
    fork.textContent = operation?.status === 'sending' ? '正在创建分支…' : '创建完整历史分支';
    const childId = operation?.result?.threadId;
    const synchronization = operation?.result?.synchronization;
    status.hidden = !operation;
    status.textContent = childId ? synchronization?.status === 'failed'
      ? `分支已创建，历史同步失败。${synchronization.message ?? ''} 请打开分支核对。`
      : '完整历史分支已创建。'
      : operation?.error ?? '正在确认创建结果…';
    query.hidden = !operation || operation.status !== 'sending' || !operation.error || polling;
    open.hidden = !childId;
    reset.hidden = operation?.status !== 'unknown';
  }

  function save(): void {
    if (operation) localStorage.setItem(storageKey, JSON.stringify(operation));
    else localStorage.removeItem(storageKey);
    render();
  }

  async function poll(): Promise<void> {
    if (polling || !operation || operation.status !== 'sending') return;
    polling = true;
    try {
      while (dialog.open && operation?.status === 'sending') {
        try {
          const receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(operation.requestId)}`);
          operation.status = receipt.status;
          operation.error = receipt.error ?? undefined;
          operation.result = receipt.result;
          save();
          if (receipt.status !== 'sending') return;
        } catch (error) {
          operation.error = `创建结果待确认。${error instanceof Error ? error.message : String(error)}`;
          if (error instanceof ReachError && error.status === 404) operation.status = 'unknown';
          save();
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally { polling = false; render(); }
  }

  dialog.querySelector('[data-back]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  pin.addEventListener('click', async () => {
    pin.disabled = true;
    try {
      const result = await client.request<{ pinned: boolean }>(`/threads/${encodeURIComponent(chat.id)}/pin`, 'POST', { pinned: !pinned });
      pinned = result.pinned;
      callbacks.onPinned(pinned);
      pin.textContent = pinned ? '取消置顶' : '置顶对话';
    } catch (error) {
      pin.textContent = `置顶状态未确认，点击重试。${error instanceof Error ? error.message : String(error)}`;
    } finally { pin.disabled = false; }
  });
  fork.addEventListener('click', async () => {
    if (operation) return;
    operation = { requestId: crypto.randomUUID(), status: 'sending' };
    save();
    try { await client.request(`/threads/${encodeURIComponent(chat.id)}/fork`, 'POST', { requestId: operation.requestId }); }
    catch (error) { operation.error = error instanceof Error ? error.message : String(error); save(); }
    await poll();
  });
  query.addEventListener('click', () => void poll());
  reset.addEventListener('click', () => { operation = null; save(); });
  open.addEventListener('click', () => {
    if (!operation?.result?.threadId) return;
    const threadId = operation.result.threadId;
    operation = null;
    save();
    dialog.close();
    callbacks.onOpen(threadId);
  });
  document.body.append(dialog);
  dialog.showModal();
  render();
  void client.request<{ pinned: boolean }>(`/threads/${encodeURIComponent(chat.id)}/pin`).then(result => {
    pinned = result.pinned;
    pin.textContent = pinned ? '取消置顶' : '置顶对话';
    pin.disabled = false;
  }).catch(error => { pin.textContent = `置顶状态读取失败。${error instanceof Error ? error.message : String(error)}`; });
  void poll();
}

export function openQuote(text: string, chat: HistoryPage, messageId: string, onAdd: (quote: string) => void): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog';
  dialog.id = 'quote-dialog';
  dialog.innerHTML = `<div class="dialog-header"><button class="quiet" type="button" data-back>返回</button><h2>引用消息</h2></div>
    <label>引用内容<textarea rows="8" data-quote></textarea></label>
    <p class="field-note" data-source></p><button class="primary" type="button" data-add>加入当前输入框</button>`;
  const input = dialog.querySelector<HTMLTextAreaElement>('[data-quote]')!;
  input.value = text;
  dialog.querySelector('[data-source]')!.textContent = `来源对话「${chat.title || '未命名对话'}」`;
  dialog.querySelector('[data-back]')!.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-add]')!.addEventListener('click', () => {
    if (!input.value.trim()) return;
    const quote = `引用自对话「${chat.title || '未命名对话'}」\n对话 ID ${chat.id}，消息 ID ${messageId}\n\n${input.value.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    onAdd(quote);
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
}
