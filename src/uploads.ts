import type { ReachClient } from './api';
import type { FileAttachment } from './files';

type UploadReceipt = { id: string; name: string; size: number; offset: number; attachment: FileAttachment | null };
type UploadTask = { id: string; name: string; size: number; draftKey: string; offset: number; status: string; error?: string };
const active = new Map<string, File>();
const running = new Set<string>();
const chunkBytes = 512 * 1024;

function tasksKey(client: ReachClient): string { return `codex-reach-uploads:${client.connection.serverId}`; }
function tasks(client: ReachClient): UploadTask[] {
  try { return JSON.parse(localStorage.getItem(tasksKey(client)) ?? '[]') as UploadTask[]; }
  catch { return []; }
}
function update(client: ReachClient, task: UploadTask): void {
  const all = tasks(client).filter(item => item.id !== task.id);
  all.push(task);
  localStorage.setItem(tasksKey(client), JSON.stringify(all));
  window.dispatchEvent(new Event('reach-uploads'));
}
function remove(client: ReachClient, id: string): void {
  localStorage.setItem(tasksKey(client), JSON.stringify(tasks(client).filter(item => item.id !== id)));
  active.delete(id);
  window.dispatchEvent(new Event('reach-uploads'));
}
function accept(client: ReachClient, task: UploadTask, receipt: UploadReceipt): boolean {
  if (!receipt.attachment) return false;
  const files = JSON.parse(localStorage.getItem(task.draftKey) ?? '[]') as FileAttachment[];
  if (!files.some(file => file.path === receipt.attachment!.path)) files.push(receipt.attachment);
  localStorage.setItem(task.draftKey, JSON.stringify(files));
  remove(client, task.id);
  return true;
}

async function sendFile(client: ReachClient, task: UploadTask, file: File): Promise<void> {
  if (running.has(task.id)) return;
  running.add(task.id);
  active.set(task.id, file);
  task.status = '正在上传';
  task.error = undefined;
  update(client, task);
  try {
    const receipt = await client.request<UploadReceipt>('/uploads', 'POST', { id: task.id, name: file.name, size: file.size });
    if (accept(client, task, receipt)) return;
    // Replaying chunks verifies an explicitly reselected file against already received bytes.
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const original = await file.slice(offset, offset + chunkBytes).arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', original);
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      let bytes = new Uint8Array(original);
      let gzip = false;
      if (typeof CompressionStream !== 'undefined') {
        const compressed = new Uint8Array(await new Response(new Blob([original]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
        if (compressed.length < bytes.length) { bytes = compressed; gzip = true; }
      }
      let binary = '';
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      const result = await client.request<UploadReceipt>(`/uploads/${task.id}/chunk`, 'POST', { offset, data: btoa(binary), gzip, sha256 });
      task.offset = result.offset;
      update(client, task);
    }
    accept(client, task, await client.request<UploadReceipt>(`/uploads/${task.id}/finish`, 'POST'));
  } catch (error) {
    task.status = '等待核对';
    task.error = error instanceof Error ? error.message : String(error);
    update(client, task);
    try {
      const receipt = await client.request<UploadReceipt>(`/uploads/${task.id}`);
      if (!accept(client, task, receipt)) {
        task.offset = receipt.offset;
        task.status = '上传中断';
        update(client, task);
      }
    } catch { /* Keep the operation identifier until its result can be queried */ }
  } finally { running.delete(task.id); window.dispatchEvent(new Event('reach-uploads')); }
}

export function uploadFiles(client: ReachClient, draftKey: string, files: File[]): void {
  const prepared = files.map(file => {
    const task: UploadTask = { id: crypto.randomUUID(), name: file.name, size: file.size, draftKey, offset: 0, status: '等待上传' };
    active.set(task.id, file);
    update(client, task);
    return { file, task };
  });
  void (async () => {
    for (const { task, file } of prepared) await sendFile(client, task, file);
  })();
}

export async function recoverUploads(client: ReachClient): Promise<void> {
  for (const task of tasks(client)) {
    if (running.has(task.id) || (task.status === '等待上传' && active.has(task.id))) continue;
    try {
      const receipt = await client.request<UploadReceipt>(`/uploads/${task.id}`);
      if (!accept(client, task, receipt)) { task.offset = receipt.offset; task.status = '上传中断'; update(client, task); }
    } catch { task.status = '等待核对'; update(client, task); }
  }
}

export function uploadCount(client: ReachClient, draftKey: string): number {
  return tasks(client).filter(task => task.draftKey === draftKey).length;
}

export function renderUploadTasks(container: HTMLElement, client: ReachClient, draftKey: string): void {
  container.replaceChildren();
  for (const task of tasks(client).filter(item => item.draftKey === draftKey)) {
    const busy = running.has(task.id) || (task.status === '等待上传' && active.has(task.id));
    const row = document.createElement('div');
    row.className = 'upload-task';
    const label = document.createElement('p');
    label.textContent = `${task.name} · ${active.has(task.id) ? task.status : '上传中断'} · ${task.size ? Math.floor(task.offset * 100 / task.size) : 0}%`;
    const error = document.createElement('small');
    error.textContent = task.error ?? '';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'quiet';
    retry.textContent = active.has(task.id) ? '核对并重试' : '重新选择原文件';
    retry.disabled = busy;
    retry.addEventListener('click', () => {
      const file = active.get(task.id);
      if (file) { void sendFile(client, task, file); return; }
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.addEventListener('change', () => {
        const chosen = picker.files?.[0];
        if (!chosen) return;
        if (chosen.name !== task.name || chosen.size !== task.size) { error.textContent = '请选择同名、同大小的原文件'; return; }
        void sendFile(client, task, chosen);
      });
      picker.click();
    });
    const query = document.createElement('button');
    query.type = 'button'; query.className = 'quiet'; query.textContent = '查询结果'; query.disabled = busy;
    query.addEventListener('click', () => void recoverUploads(client));
    const discard = document.createElement('button');
    discard.type = 'button'; discard.className = 'quiet'; discard.textContent = '移除记录'; discard.disabled = busy;
    discard.addEventListener('click', () => remove(client, task.id));
    row.append(label, error, retry, query, discard);
    container.append(row);
  }
}
