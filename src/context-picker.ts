import { showDialog } from './ui';
import type { ReachClient } from './api';
import type { FileAttachment } from './files';
import type { Skill, Thread, ThreadReference } from './types';
import { threadTitle } from './thread-list';

type Selection = { kind: 'skill'; value: Skill } | { kind: 'file'; value: FileAttachment } | { kind: 'thread'; value: ThreadReference };

export function openContextPicker(client: ReachClient, scope: { chatId?: string; projectId?: string }, onSelect: (selection: Selection) => void): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog context-picker';
  dialog.innerHTML = '<div class="dialog-header"><button type="button" class="quiet context-close" aria-label="返回">‹</button><h2>添加引用</h2></div><div class="context-tabs"><button type="button" class="quiet" data-kind="skills">Skill</button><button type="button" class="quiet" data-kind="files">项目文件</button><button type="button" class="quiet" data-kind="threads">对话</button></div><input type="search" aria-label="筛选引用" placeholder="输入关键词"><p class="field-note context-status" role="status"></p><div class="context-results"></div><button type="button" class="quiet context-more" hidden>继续读取对话</button>';
  const search = dialog.querySelector<HTMLInputElement>('input')!;
  const status = dialog.querySelector<HTMLElement>('.context-status')!;
  const results = dialog.querySelector<HTMLElement>('.context-results')!;
  const more = dialog.querySelector<HTMLButtonElement>('.context-more')!;
  let kind = 'skills';
  let request = 0;
  let timer: ReturnType<typeof setTimeout>;
  let cursor: string | null = null;
  let threads: Thread[] = [];
  function row(title: string, detail: string, select: () => Promise<void> | void): void {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'quiet context-result';
    const name = document.createElement('strong'); name.textContent = title;
    const description = document.createElement('span'); description.textContent = detail;
    button.append(name, description);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await select(); dialog.close(); }
      catch (error) { status.textContent = error instanceof Error ? error.message : String(error); button.disabled = false; }
    });
    results.append(button);
  }
  function renderThreads(): void {
    results.replaceChildren();
    const query = search.value.toLocaleLowerCase();
    for (const thread of threads.filter(thread => `${thread.title} ${thread.cwd}`.toLocaleLowerCase().includes(query))) {
      row(threadTitle(thread), thread.cwd, () => onSelect({ kind: 'thread', value: { id: thread.id, title: thread.title } }));
    }
    status.textContent = `搜索已读取的 ${threads.length} 个对话${cursor ? '，可继续读取' : ''}`;
    more.hidden = !cursor;
  }
  async function load(append = false): Promise<void> {
    const token = ++request;
    more.hidden = true; status.textContent = '正在读取…';
    if (!append) results.replaceChildren();
    for (const tab of dialog.querySelectorAll<HTMLButtonElement>('[data-kind]')) tab.setAttribute('aria-pressed', String(tab.dataset.kind === kind));
    try {
      if (kind === 'threads') {
        const page = await client.request<{ threads: Thread[]; nextCursor: string | null }>(`/threads${append && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (token !== request || !dialog.open) return;
        threads = append ? [...new Map([...threads, ...page.threads].map(thread => [thread.id, thread])).values()] : page.threads;
        cursor = page.nextCursor; renderThreads(); return;
      }
      const query = new URLSearchParams({ ...scope, kind, query: search.value });
      if (kind === 'skills') {
        const catalog = await client.request<{ skills: Skill[]; errors: { message: string }[] }>(`/context?${query}`);
        if (token !== request || !dialog.open) return;
        const filter = search.value.toLocaleLowerCase();
        for (const skill of catalog.skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(filter))) {
          row(skill.name, skill.shortDescription ?? skill.description ?? '', () => onSelect({ kind: 'skill', value: skill }));
        }
        status.textContent = catalog.errors.map(error => error.message).join('\n') || (scope.chatId || scope.projectId ? '当前工作目录可用 Skill' : '全局可用 Skill');
      } else {
        const found = await client.request<{ files: { file_name: string; path: string; root: string }[]; needsProject?: boolean }>(`/context?${query}`);
        if (token !== request || !dialog.open) return;
        for (const file of found.files) {
          const path = /^(?:[A-Za-z]:|[\\/])/.test(file.path) ? file.path : `${file.root}/${file.path}`;
          row(file.file_name, file.path, async () => {
            const resolved = await client.request<{ attachments: FileAttachment[] }>('/files/resolve', 'POST', { paths: [path] });
            onSelect({ kind: 'file', value: resolved.attachments[0] });
          });
        }
        status.textContent = found.needsProject ? '选择项目后可查找项目文件，也可从「＋」浏览电脑文件。' : `找到 ${found.files.length} 项`;
      }
    } catch (error) { if (token === request) status.textContent = error instanceof Error ? error.message : String(error); }
  }
  dialog.querySelector('.context-close')!.addEventListener('click', () => dialog.close());
  for (const tab of dialog.querySelectorAll<HTMLButtonElement>('[data-kind]')) tab.addEventListener('click', () => { kind = tab.dataset.kind!; void load(); });
  search.addEventListener('input', () => {
    if (kind === 'threads') { renderThreads(); return; }
    clearTimeout(timer); timer = setTimeout(() => void load(), 180);
  });
  more.addEventListener('click', () => void load(true));
  dialog.addEventListener('close', () => { request++; clearTimeout(timer); dialog.remove(); }, { once: true });
  document.body.append(dialog); showDialog(dialog); void load();
}

export function bindMention(input: HTMLTextAreaElement, open: (picked: () => void) => void): void {
  input.addEventListener('input', event => {
    if ((event as InputEvent).data !== '@') return;
    const end = input.selectionStart;
    if (!/(?:^|\s)@$/.test(input.value.slice(0, end))) return;
    const original = input.value;
    open(() => {
      if (input.value === original) {
        input.value = original.slice(0, end - 1) + original.slice(end);
        input.setSelectionRange(end - 1, end - 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  });
}
