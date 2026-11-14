import { showDialog } from './ui';
import type { ReachClient } from './api';
import type { ModelChoice, ResponseAnnotation, TurnOptions } from './types';
import { openContextPicker, bindMention } from './context-picker';
import { openFilePicker, openAttachmentManager, type FileAttachment } from './files';
import { annotationPrompt, openAnnotation, renderAnnotations } from './chat-actions';
import { populateParameters, selectedParameters, updateThinking } from './task-options';
import { uploadCount } from './uploads';

export type QueueItem = { requestId: string; chatId: string; prompt: string; options: TurnOptions; status: string; error?: string; version: number };
const labels: Record<string, string> = { queued: '等待投递', sending: '投递中', accepted: '已接收', unknown: '结果待确认', failed: '投递失败', cancelled: '已取消' };

export function queuePrompt(prompt: string): { text: string; annotations: ResponseAnnotation[] } {
  const match = /^\s*# Response annotations:[\s\S]*?<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>\s*## My request:\n([\s\S]*)$/.exec(prompt);
  if (match) {
    try { const annotations = JSON.parse(match[1]); if (Array.isArray(annotations)) return { text: match[2], annotations }; } catch { /* Keep unrecognized source text intact. */ }
  }
  return { text: prompt, annotations: [] };
}

export function openQueue(client: ReachClient, chatId: string, cwd: string, changed: () => void): void {
  const dialog = document.createElement('dialog'); dialog.className = 'task-dialog';
  dialog.innerHTML = '<div class="dialog-header"><button type="button" class="quiet">返回</button><h2>待发队列</h2></div><p class="field-note" role="status"></p><div class="queue-items"></div>';
  const status = dialog.querySelector('p')!;
  const list = dialog.querySelector<HTMLElement>('.queue-items')!;
  let signature = '';
  let timer: ReturnType<typeof setTimeout>;
  dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
  async function action(item: QueueItem, action: string): Promise<void> {
    try {
      await client.request(`/threads/${encodeURIComponent(chatId)}/queue/${encodeURIComponent(item.requestId)}`, 'POST', { action, version: item.version });
      signature = ''; await refresh(); changed();
    } catch (error) { status.textContent = String(error); }
  }
  async function refresh(): Promise<void> {
    clearTimeout(timer);
    try {
      const result = await client.request<{ items: QueueItem[] }>(`/threads/${encodeURIComponent(chatId)}/queue`);
      if (!dialog.open) return;
      const next = JSON.stringify(result.items);
      if (next !== signature) {
        signature = next; list.replaceChildren();
        const visible = result.items.filter(item => item.status !== 'cancelled');
        status.textContent = visible.length ? '' : '队列为空';
        for (const item of visible) {
          const row = document.createElement('section'); row.className = 'queue-item';
          const label = document.createElement('strong'); label.textContent = labels[item.status] ?? item.status;
          const text = document.createElement('p'); text.textContent = queuePrompt(item.prompt).text || '附件或选段引用';
          text.className = 'queue-excerpt';
          const detail = document.createElement('p'); detail.className = 'field-note';
          detail.textContent = [item.options.model, item.options.thinking, item.error].filter(Boolean).join(' · ');
          const controls = document.createElement('div'); controls.className = 'queue-actions';
          function button(label: string, callback: () => void): void {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = label;
            button.addEventListener('click', callback); controls.append(button);
          }
          button(['queued', 'failed'].includes(item.status) ? '查看／编辑' : '查看内容', () => openQueueEditor(client, item, cwd, () => { signature = ''; void refresh(); changed(); }));
          if (['queued', 'failed'].includes(item.status)) button('取消', () => void action(item, 'cancel'));
          if (item.status === 'unknown') {
            button('查询原操作', () => void action(item, 'check'));
            button('已在历史确认收到', () => {
              if (confirm('确认这条消息已经出现在目标对话中？确认后会继续投递后续队列。')) void action(item, 'confirmAccepted');
            });
          }
          row.append(label, text, detail, controls); list.append(row);
        }
      }
    } catch (error) { if (dialog.open) status.textContent = String(error); }
    if (dialog.open) timer = setTimeout(() => void refresh(), 2000);
  }
  dialog.addEventListener('close', () => { clearTimeout(timer); dialog.remove(); }, { once: true });
  document.body.append(dialog); showDialog(dialog); void refresh();
}

function openQueueEditor(client: ReachClient, item: QueueItem, cwd: string, saved: () => void): void {
  const editable = ['queued', 'failed'].includes(item.status);
  const dialog = document.createElement('dialog'); dialog.className = 'task-dialog';
  dialog.innerHTML = '<div class="dialog-header"><button class="quiet" type="button">返回</button><h2>队列内容</h2></div><form><div class="composer-tools"><button class="quiet queue-files" type="button">＋</button></div><div class="field-pair"><label>模型<select class="queue-model"></select></label><label>思考深度<select class="queue-thinking"></select></label></div><div class="queue-contexts"></div><button class="quiet queue-manage" type="button">附件</button><div class="queue-annotations"></div><label>消息<textarea rows="5"></textarea></label><p class="form-error" role="status"></p><button class="primary queue-save" type="submit">保存队列</button></form>';
  const input = dialog.querySelector('textarea')!;
  const model = dialog.querySelector<HTMLSelectElement>('.queue-model')!;
  const thinking = dialog.querySelector<HTMLSelectElement>('.queue-thinking')!;
  const error = dialog.querySelector<HTMLElement>('.form-error')!;
  const save = dialog.querySelector<HTMLButtonElement>('.queue-save')!;
  const options = structuredClone(item.options);
  const attachments = options.attachments ??= [];
  const parsed = queuePrompt(item.prompt);
  let annotations = parsed.annotations;
  input.value = parsed.text;
  const key = `codex-reach-queue-files:${client.connection.serverId}:${item.requestId}:${item.version}`;
  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(options.attachments ?? []));
  let models: ModelChoice[] = client.cachedModels();
  populateParameters(model, thinking, models, options, '沿用会话设置');
  model.addEventListener('change', () => { model.setCustomValidity(''); updateThinking(model, thinking, models); });
  thinking.addEventListener('change', () => thinking.setCustomValidity(''));
  function render(): void {
    attachments.splice(0, attachments.length, ...JSON.parse(localStorage.getItem(key) ?? '[]') as FileAttachment[]);
    dialog.querySelector('.queue-manage')!.textContent = `附件（${attachments.length}）${uploadCount(client, key) ? ' · 上传待处理' : ''}`;
    save.disabled = !editable || uploadCount(client, key) > 0;
    const refs = dialog.querySelector('.queue-contexts')!; refs.replaceChildren();
    for (const [kind, entries] of [['skills', options.skills ?? []], ['threadRefs', options.threadRefs ?? []]] as const) {
      for (const entry of entries) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet';
        button.textContent = `${'name' in entry ? entry.name : entry.title}${editable ? ' ×' : ''}`; button.disabled = !editable;
        button.addEventListener('click', () => { if (kind === 'skills') options.skills = options.skills?.filter(value => value !== entry); else options.threadRefs = options.threadRefs?.filter(value => value !== entry); render(); }); refs.append(button);
      }
    }
    renderAnnotations(dialog.querySelector<HTMLElement>('.queue-annotations')!, annotations,
      editable ? index => { annotations.splice(index, 1); render(); } : undefined,
      editable ? index => { const original = annotations[index]; openAnnotation(original.text, original.source?.messageId ?? '', { startOffset: 0, endOffset: original.text.length, text: original.text }, original.annotation, replacement => { annotations[index] = { ...replacement, source: original.source }; render(); }, true); } : undefined);
  }
  function context(picked: () => void = () => {}): void {
    openContextPicker(client, { chatId: item.chatId }, selection => {
      if (selection.kind === 'file') {
        const files = JSON.parse(localStorage.getItem(key) ?? '[]') as FileAttachment[];
        if (!files.some(file => file.path === selection.value.path)) files.push(selection.value);
        localStorage.setItem(key, JSON.stringify(files));
      } else if (selection.kind === 'skill') {
        options.skills ??= []; if (!options.skills.some(skill => skill.path === selection.value.path)) options.skills.push(selection.value);
      } else {
        options.threadRefs ??= []; if (!options.threadRefs.some(thread => thread.id === selection.value.id)) options.threadRefs.push(selection.value);
      }
      picked(); render();
    });
  }
  if (editable) bindMention(input, context);
  dialog.querySelector('.queue-files')!.addEventListener('click', () => openFilePicker(client, cwd, files => {
    const current = JSON.parse(localStorage.getItem(key) ?? '[]') as FileAttachment[];
    current.push(...files.filter(file => !current.some(existing => existing.path === file.path)));
    localStorage.setItem(key, JSON.stringify(current)); render();
  }, false, key));
  dialog.querySelector('.queue-manage')!.addEventListener('click', () => openAttachmentManager(attachments, client, editable ? index => {
    attachments.splice(index, 1); localStorage.setItem(key, JSON.stringify(attachments)); render();
  } : undefined, key));
  dialog.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault(); if (!editable || uploadCount(client, key)) return;
    save.disabled = true; error.textContent = '';
    try {
      delete options.model; delete options.thinking;
      await client.request(`/threads/${encodeURIComponent(item.chatId)}/queue/${encodeURIComponent(item.requestId)}`, 'POST', {
        action: 'edit', version: item.version, prompt: annotationPrompt(input.value, annotations), options: { ...options, ...selectedParameters(model, thinking) },
      });
      localStorage.removeItem(key); saved(); dialog.close();
    } catch (failure) { error.textContent = String(failure); save.disabled = false; }
  });
  dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
  if (!editable) for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,select,textarea,.queue-context,.queue-files,.queue-save')) control.disabled = true;
  render();
  window.addEventListener('reach-uploads', render);
  dialog.addEventListener('close', () => { window.removeEventListener('reach-uploads', render); dialog.remove(); }, { once: true });
  document.body.append(dialog); showDialog(dialog);
  void client.loadModels().then(result => {
    if (!dialog.open) return;
    const current = models.length ? selectedParameters(model, thinking) : options;
    models = result; populateParameters(model, thinking, models, current, '沿用会话设置');
  }).catch(failure => { error.textContent = String(failure); });
}
