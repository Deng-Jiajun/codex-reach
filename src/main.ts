import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ReachClient } from './api';
import { ChatCache } from './cache';
import type { Connection, HistoryPage, LiveView, Message, Project, Receipt, Thread, Turn } from './types';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const views = ['connection', 'inbox', 'chat'] as const;
const notice = element<HTMLParagraphElement>('notice');
const urlInput = element<HTMLInputElement>('server-url');
const keyInput = element<HTMLInputElement>('server-key');
const connectButton = element<HTMLButtonElement>('connect-button');
const projectFilter = element<HTMLSelectElement>('project-filter');
const searchInput = element<HTMLInputElement>('thread-search');
const messageInput = element<HTMLTextAreaElement>('message-input');
const sendButton = element<HTMLButtonElement>('send-button');
const olderButton = element<HTMLButtonElement>('older-button');
const scroll = element<HTMLDivElement>('messages-scroll');
const cache = new ChatCache();
const renderedMessages = new Map<string, HTMLElement>();
let currentView: typeof views[number] = 'connection';
let connection = readStored<Connection>('codex-reach-connection');
let client = connection ? new ReachClient(connection) : null;
let connected = false;
let projects: Project[] = [];
let threads: Thread[] = [];
let nextThreads: string | null = null;
let selected: HistoryPage | null = null;
let revision: string | null = null;
let generation = 0;
let foreground = true;
let liveWaiting = false;
let liveModel = '';
let pending: { requestId: string; prompt: string; status?: string } | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
let cacheWriting = false;
const pendingCache = new Map<string, { serverId: string; page: HistoryPage; revision: string | null }>();

function readStored<T>(key: string): T | null {
  const value = localStorage.getItem(key);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function inform(text = ''): void { notice.textContent = text; notice.hidden = !text; }
function storageKey(kind: string, id = ''): string { return `codex-reach-${kind}:${connection?.serverId}:${id}`; }
function stateLabel(status: string): string {
  return ({ active: '进行中', inProgress: '进行中', idle: '空闲', notLoaded: '未加载', completed: '已完成', failed: '失败', interrupted: '已停止', systemError: '异常' } as Record<string, string>)[status] ?? status;
}

function showView(view: typeof currentView): void {
  currentView = view;
  for (const name of views) element(`${name}-view`).hidden = name !== view;
}

function openSettings(): void {
  generation += 1;
  urlInput.value = connection?.url ?? '';
  keyInput.value = connection?.key ?? '';
  showView('connection');
}

async function connect(): Promise<void> {
  connectButton.disabled = true;
  inform('正在连接电脑…');
  try {
    const url = new URL(urlInput.value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
      throw new Error('请填写 http://主机:端口 或 https://主机:端口');
    }
    const candidate: Connection = { url: url.origin, key: keyInput.value.trim(), serverId: '' };
    const nextClient = new ReachClient(candidate);
    const status = await nextClient.request<{ serverId: string }>('/status');
    candidate.serverId = status.serverId;
    generation += 1;
    connection = candidate;
    client = nextClient;
    connected = true;
    localStorage.setItem('codex-reach-connection', JSON.stringify(candidate));
    await loadInbox();
    showView('inbox');
    inform();
  } catch (error) {
    connected = false;
    inform(errorText(error));
  } finally { connectButton.disabled = false; }
}

async function loadInbox(): Promise<void> {
  if (!client) return;
  const [projectResult, threadResult] = await Promise.all([
    client.request<{ projects: Project[] }>('/projects'),
    client.request<{ threads: Thread[]; nextCursor: string | null }>('/threads'),
  ]);
  projects = projectResult.projects;
  threads = threadResult.threads;
  nextThreads = threadResult.nextCursor;
  const selectedProject = projectFilter.value;
  projectFilter.replaceChildren(new Option('全部项目', ''), new Option('无项目', '__none__'));
  for (const project of projects) projectFilter.add(new Option(project.name, project.id));
  projectFilter.value = selectedProject;
  renderInbox();
}

function renderInbox(): void {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const projectId = projectFilter.value;
  const visible = threads.filter(thread => (!query || thread.title.toLocaleLowerCase().includes(query))
    && (!projectId || (projectId === '__none__' ? !thread.projectId : thread.projectId === projectId)));
  const fragment = document.createDocumentFragment();
  for (const thread of visible) {
    const button = document.createElement('button');
    button.className = 'thread-row';
    button.type = 'button';
    button.dataset.threadId = thread.id;
    const title = document.createElement('span');
    title.className = 'thread-title';
    title.textContent = thread.title || '未命名对话';
    const metadata = document.createElement('span');
    metadata.className = 'thread-meta';
    const project = projects.find(item => item.id === thread.projectId);
    const date = new Date(thread.updatedAt * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    metadata.textContent = `${project?.name ?? '无项目'} · ${date} · ${stateLabel(thread.status)}`;
    button.append(title, metadata);
    button.addEventListener('click', () => void openChat(thread.id));
    fragment.append(button);
  }
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = nextThreads ? '当前列表中没有匹配项，可继续加载。' : '暂无匹配的对话';
    fragment.append(empty);
  }
  element('thread-list').replaceChildren(fragment);
  element('more-threads').hidden = !nextThreads;
}

function mergeTail(current: Turn[], incoming: Turn[], complete: boolean): Turn[] | null {
  if (complete || !current.length) return incoming;
  if (!incoming.length) return current;
  const boundary = current.findIndex(turn => turn.id === incoming[0].id);
  if (boundary < 0) return null;
  return [...current.slice(0, boundary), ...incoming];
}

async function refreshHistory(id: string, token: number): Promise<void> {
  if (!client) return;
  const page = await client.request<HistoryPage>(`/threads/${encodeURIComponent(id)}/history`);
  if (token !== generation || selected?.id !== id) return;
  page.turns = mergeTail(selected.turns, page.turns, !page.hasMore) ?? page.turns;
  selected = page;
  renderChat();
  scheduleCache();
}

async function openChat(id: string): Promise<void> {
  const token = ++generation;
  revision = null;
  liveWaiting = false;
  liveModel = '';
  renderedMessages.clear();
  const thread = threads.find(item => item.id === id);
  selected = { id, title: thread?.title ?? '读取对话', cwd: thread?.cwd ?? '', status: thread?.status ?? '', turns: [], hasMore: false, nextCursor: null };
  pending = readStored(storageKey('pending', id));
  messageInput.value = localStorage.getItem(storageKey('draft', id)) ?? '';
  localStorage.setItem(storageKey('last-chat'), id);
  showView('chat');
  renderChat(true);
  try {
    const saved = connection ? await cache.load(connection.serverId, id) : null;
    if (token !== generation) return;
    if (saved) { selected = saved; renderChat(true); }
    await refreshHistory(id, token);
    if (token !== generation) return;
    connected = true;
    inform();
    renderChat(true);
    if (pending) void checkReceipt(token).catch(error => inform(errorText(error)));
    void followChat(id, token);
  } catch (error) {
    if (token !== generation) return;
    connected = false;
    inform(`连接中断，已保留当前内容和草稿。${errorText(error)}`);
    renderChat();
    void followChat(id, token);
  }
}

async function followChat(id: string, token: number): Promise<void> {
  let previousStatus = selected?.status;
  while (token === generation && foreground && currentView === 'chat') {
    try {
      const query = revision ? `?after=${encodeURIComponent(revision)}` : '';
      const view = await client!.request<LiveView>(`/threads/${encodeURIComponent(id)}/live${query}`);
      if (token !== generation || !selected) return;
      const wasDisconnected = !connected;
      connected = true;
      if (wasDisconnected) { inform(); await refreshHistory(id, token); }
      if (!view.available) {
        await refreshHistory(id, token);
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      let merged = mergeTail(selected.turns, view.turns ?? [], Boolean(view.complete));
      if (!merged) {
        await refreshHistory(id, token);
        if (token !== generation || !selected) return;
        merged = mergeTail(selected.turns, view.turns ?? [], Boolean(view.complete));
      }
      if (merged) selected.turns = merged;
      selected.status = view.status ?? selected.status;
      revision = view.revision ?? null;
      liveWaiting = Boolean(view.waiting);
      liveModel = view.model ?? '';
      renderChat();
      scheduleCache();
      if (previousStatus === 'active' && selected.status !== 'active') await refreshHistory(id, token);
      previousStatus = selected.status;
      if (pending) await checkReceipt(token);
      await new Promise(resolve => setTimeout(resolve, 120));
    } catch (error) {
      if (token !== generation) return;
      connected = false;
      revision = null;
      inform(`连接中断，已保留当前内容和草稿。${errorText(error)}`);
      renderChat();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

function renderMessage(message: Message, key: string): HTMLElement {
  let node = renderedMessages.get(key);
  if (!node) {
    node = document.createElement('article');
    node.className = `message ${message.kind}`;
    node.dataset.messageId = message.id;
    const content = document.createElement('div');
    content.className = 'message-content';
    if (message.kind === 'reasoning' || message.kind === 'tool') {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = message.kind === 'reasoning' ? '思考摘要' : '工具记录';
      details.append(summary, content);
      node.append(details);
    } else node.append(content);
    renderedMessages.set(key, node);
  }
  if (node.dataset.body !== message.text) {
    const content = node.querySelector<HTMLElement>('.message-content')!;
    if (message.kind === 'user' || message.kind === 'tool') content.textContent = message.text;
    else content.innerHTML = DOMPurify.sanitize(marked.parse(message.text, { async: false }), { FORBID_TAGS: ['img', 'iframe', 'form'], FORBID_ATTR: ['style'] });
    node.dataset.body = message.text;
  }
  return node;
}

function renderChat(forceBottom = false): void {
  if (!selected) return;
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  element('chat-title').textContent = selected.title;
  element('chat-meta').textContent = [selected.cwd, liveModel].filter(Boolean).join(' · ');
  element('chat-state').textContent = connected ? stateLabel(selected.status) : '离线';
  olderButton.hidden = !selected.hasMore;
  olderButton.disabled = !connected;
  const fragment = document.createDocumentFragment();
  const keys = new Set<string>();
  for (const turn of selected.turns) {
    for (const message of turn.messages) {
      const key = `${turn.id}:${message.id}`;
      keys.add(key);
      fragment.append(renderMessage(message, key));
    }
  }
  for (const key of renderedMessages.keys()) if (!keys.has(key)) renderedMessages.delete(key);
  element('messages').replaceChildren(fragment);
  const activity = element('activity');
  activity.textContent = liveWaiting ? '等待你在电脑上处理确认' : '正在处理…';
  activity.hidden = !connected || (!liveWaiting && selected.status !== 'active');
  sendButton.disabled = !connected || Boolean(pending) || !messageInput.value.trim();
  sendButton.textContent = selected.status === 'active' ? '追加' : '发送';
  element('delivery-note').hidden = !pending;
  element('delivery-text').textContent = pending?.status === 'unknown' ? '投递结果待确认，请先查看聊天记录。草稿已保留。' : '正在确认投递结果…';
  element('resolve-delivery').hidden = pending?.status !== 'unknown';
  if (forceBottom || atBottom) scroll.scrollTop = scroll.scrollHeight;
}

function scheduleCache(): void {
  if (!selected || !connection) return;
  pendingCache.set(`${connection.serverId}:${selected.id}`, { serverId: connection.serverId, page: structuredClone(selected), revision });
  if (!cacheTimer) cacheTimer = setTimeout(() => { cacheTimer = undefined; void flushCache(); }, 500);
}

async function flushCache(): Promise<void> {
  if (cacheWriting) return;
  cacheWriting = true;
  try {
    while (pendingCache.size) {
      const [key, pending] = pendingCache.entries().next().value!;
      pendingCache.delete(key);
      await cache.save(pending.serverId, pending.page, pending.revision);
    }
  } catch (error) { inform(`本地缓存保存失败。${errorText(error)}`); }
  finally { cacheWriting = false; }
}

async function checkReceipt(token: number): Promise<void> {
  const request = pending;
  const chatId = selected?.id;
  if (!request || !chatId || !client) return;
  const receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(request.requestId)}`);
  if (token !== generation || pending?.requestId !== request.requestId) return;
  if (receipt.status === 'accepted') {
    if (messageInput.value === request.prompt) {
      messageInput.value = '';
      localStorage.removeItem(storageKey('draft', chatId));
    }
    pending = null;
    localStorage.removeItem(storageKey('pending', chatId));
    revision = null;
    await refreshHistory(chatId, token);
  } else {
    pending.status = receipt.status;
    localStorage.setItem(storageKey('pending', chatId), JSON.stringify(pending));
  }
  renderChat();
}

async function sendMessage(): Promise<void> {
  if (!selected || !client || !connected || pending || !messageInput.value.trim()) return;
  const id = selected.id;
  const token = generation;
  const request = { requestId: crypto.randomUUID(), prompt: messageInput.value };
  pending = request;
  localStorage.setItem(storageKey('pending', id), JSON.stringify(request));
  renderChat();
  try {
    await client.request(`/threads/${encodeURIComponent(id)}/messages`, 'POST', request);
    while (token === generation && pending?.requestId === request.requestId && pending.status !== 'unknown') {
      await checkReceipt(token);
      if (pending) await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    if (token !== generation) return;
    if (pending) pending.status = 'unknown';
    localStorage.setItem(storageKey('pending', id), JSON.stringify(pending));
    inform(`投递结果待确认。${errorText(error)}`);
    renderChat();
  }
}

element('connection-form').addEventListener('submit', event => { event.preventDefault(); void connect(); });
element('settings-button').addEventListener('click', openSettings);
element('back-button').addEventListener('click', () => { generation += 1; showView('inbox'); void loadInbox().catch(error => inform(errorText(error))); });
projectFilter.addEventListener('change', renderInbox);
searchInput.addEventListener('input', renderInbox);
element('refresh-button').addEventListener('click', () => void loadInbox().then(() => inform()).catch(error => inform(errorText(error))));
element('more-threads').addEventListener('click', async () => {
  if (!client || !nextThreads) return;
  const button = element<HTMLButtonElement>('more-threads');
  button.disabled = true;
  try {
    const page = await client.request<{ threads: Thread[]; nextCursor: string | null }>(`/threads?cursor=${encodeURIComponent(nextThreads)}`);
    const existing = new Set(threads.map(thread => thread.id));
    threads.push(...page.threads.filter(thread => !existing.has(thread.id)));
    nextThreads = page.nextCursor;
    renderInbox();
  } catch (error) { inform(errorText(error)); }
  finally { button.disabled = false; }
});
olderButton.addEventListener('click', async () => {
  if (!client || !selected?.nextCursor) return;
  const token = generation;
  const oldHeight = scroll.scrollHeight;
  const oldTop = scroll.scrollTop;
  olderButton.disabled = true;
  try {
    const page = await client.request<HistoryPage>(`/threads/${encodeURIComponent(selected.id)}/history?cursor=${encodeURIComponent(selected.nextCursor)}`);
    if (token !== generation || !selected) return;
    const existing = new Set(selected.turns.map(turn => turn.id));
    selected.turns = [...page.turns.filter(turn => !existing.has(turn.id)), ...selected.turns];
    selected.hasMore = page.hasMore;
    selected.nextCursor = page.nextCursor;
    renderChat();
    scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
  } catch (error) { inform(errorText(error)); }
  finally { olderButton.disabled = !connected; }
});
element('message-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
messageInput.addEventListener('input', () => {
  if (selected) localStorage.setItem(storageKey('draft', selected.id), messageInput.value);
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(160, messageInput.scrollHeight)}px`;
  sendButton.disabled = !connected || Boolean(pending) || !messageInput.value.trim();
});
element('resolve-delivery').addEventListener('click', () => {
  if (selected) localStorage.removeItem(storageKey('pending', selected.id));
  pending = null;
  inform();
  renderChat();
});

if (Capacitor.getPlatform() === 'android') {
  void App.addListener('backButton', () => {
    if (currentView === 'chat') { generation += 1; showView('inbox'); }
    else if (currentView === 'connection' && connected) showView('inbox');
    else void App.minimizeApp();
  });
  void App.addListener('appStateChange', ({ isActive }) => {
    foreground = isActive;
    generation += 1;
    if (isActive && currentView === 'chat' && selected) void openChat(selected.id);
    else if (!isActive) void flushCache();
  });
}

await cache.open().catch(error => inform(`本地缓存不可用。${errorText(error)}`));
connectButton.disabled = false;
urlInput.value = connection?.url ?? '';
keyInput.value = connection?.key ?? '';
if (connection) {
  const lastChat = localStorage.getItem(storageKey('last-chat'));
  if (lastChat) {
    await openChat(lastChat);
    void loadInbox().catch(error => inform(errorText(error)));
  } else await connect();
}
