import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { renderMarkdown, copyText, sourceText, sourceRange, rangeOffsets } from './message-content';
import { ReachClient, ReachError } from './api';
import { ChatCache } from './cache';
import { mergeHistory, mergeTail, prependHistory } from './sync';
import { groupMessages, groupProcessMessages, type MessageGroup, type ProcessGroup } from './transcript';
import { populateParameters, selectedParameters, updateThinking } from './task-options';
import { renderRequests, renderAsyncQuestions, type PendingRequest } from './requests';
import { openFilePicker, openAttachmentManager, renderAttachments, type FileAttachment } from './files';
import { recoverUploads, uploadCount } from './uploads';
import { groupThreads, threadTitle, type Grouping } from './thread-list';
import { openReader } from './reader';
import { openContextPicker, bindMention } from './context-picker';
import { openQueue, type QueueItem } from './queue';
import { openChanges, openDeletion } from './organization';
import { connectNotifications, initializeNotifications, openNotificationSettings, type TaskEvent } from './notifications';
import { annotationPrompt, createSelectionToolbar, openAnnotation, openAnnotationDetail, renderAnnotations } from './chat-actions';
import type { Connection, EditableTurn, HistoryPage, LiveView, Message, ModelChoice, Project, QuestionReply, Receipt, ResponseAnnotation, Skill, Thread, ThreadReference, Turn, TurnOptions } from './types';
import './style.css';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const views = ['connection', 'inbox', 'chat'] as const;
const notice = element<HTMLParagraphElement>('notice');
const urlInput = element<HTMLInputElement>('server-url');
const keyInput = element<HTMLInputElement>('server-key');
const connectButton = element<HTMLButtonElement>('connect-button');
const refreshButton = element<HTMLButtonElement>('refresh-button');
const projectFilter = element<HTMLSelectElement>('project-filter');
const searchInput = element<HTMLInputElement>('thread-search');
const messageInput = element<HTMLTextAreaElement>('message-input');
const sendButton = element<HTMLButtonElement>('send-button');
const olderButton = element<HTMLButtonElement>('older-button');
const stopButton = element<HTMLButtonElement>('stop-button');
const newDialog = element<HTMLDialogElement>('new-chat-dialog');
const optionsDialog = element<HTMLDialogElement>('options-dialog');
const editDialog = element<HTMLDialogElement>('edit-dialog');
const newModel = element<HTMLSelectElement>('new-chat-model');
const newThinking = element<HTMLSelectElement>('new-chat-thinking');
const optionsModel = element<HTMLSelectElement>('options-model');
const optionsThinking = element<HTMLSelectElement>('options-thinking');
const scroll = element<HTMLDivElement>('messages-scroll');
const cache = new ChatCache();
const renderedMessages = new Map<string, HTMLElement>();
const messageAnnotations = new Map<string, ResponseAnnotation[]>();
let currentView: typeof views[number] = 'connection';
let settingsReturnView: 'inbox' | 'chat' | null = null;
let settingsScrollTop = 0;
let followLatest = true;
let restoringScroll: number | null = null;
let connectionAttempt = 0;
let inboxRetryTimer: ReturnType<typeof setTimeout> | undefined;
let connectionError = '';
let historyError = '';
let streamError = '';
let historyLoaded = false;
let opening = false;
let syncing = false;
let olderLoading = false;
let moreLoading = false;
let historyRequest = 0;
let runtimeStatus: string | null = null;
let activeTurnId: string | null = null;
let turnOptions: TurnOptions = {};
let modelChoices: ModelChoice[] = [];
let selectedPinned: boolean | undefined;
const pinRequests = new Set<string>();
const pinRevisions = new Map<string, number>();
const readAttempts = new Map<string, string>();
const readRevisions = new Map<string, number>();
const readOperations = new Map<string, Promise<void>>();
const pinIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v5"/></svg>';
let dialogRequest = 0;
let newFormLoading = false;
let newFormError = '';
let optionsChatId = '';
let selectedSkills: Skill[] = [];
let selectedThreads: ThreadReference[] = [];
let newSkills: Skill[] = [];
let newThreads: ThreadReference[] = [];
let addingToNew = false;
let selectedFiles: FileAttachment[] = [];
let selectedAnnotations: ResponseAnnotation[] = [];
let liveRequests: PendingRequest[] = [];
let editableTurn: EditableTurn | null = null;
let editing: (EditableTurn & { chatId: string }) | null = null;
type Interaction = { requestId: string; kind: 'respond' | 'edit'; approvalRequestId?: string | number; turnId?: string; prompt?: string; status: string; error?: string };
let interaction: Interaction | null = null;
let questionReplies: QuestionReply[] = [];
let questionDrafts: QuestionReply[] = [];
type NewChatDraft = { projectId?: string; prompt: string } & TurnOptions;
type Creation = NewChatDraft & { requestId: string; status?: string; error?: string };
type StopOperation = { requestId: string; expectedTurnId: string; status?: string; error?: string };
let creation: Creation | null = null;
let creationPolling: { key: string; client: ReachClient } | null = null;
let stopOperation: StopOperation | null = null;
let connection = readStored<Connection>('codex-reach-connection');
let client = connection ? new ReachClient(connection) : null;
let connected = false;
let projects: Project[] = [];
let threads: Thread[] = [];
let nextThreads: string | null = null;
let archivedList = false;
let grouping: Grouping = (['date', 'project', 'status'].includes(localStorage.getItem('codex-reach-grouping') ?? '')
  ? localStorage.getItem('codex-reach-grouping') : 'date') as Grouping;
let selected: HistoryPage | null = null;
let revision: string | null = null;
let generation = 0;
let foreground = true;
let liveWaiting = false;
let liveModel = '';
let liveThinking = '';
let pending: { requestId: string; prompt: string; status?: string; error?: string; options?: TurnOptions; questionReplies?: QuestionReply[]; annotations?: ResponseAnnotation[]; queued?: boolean } | null = null;
let queueItems: QueueItem[] = [];
let notificationTarget: TaskEvent | null = null;
let applicationReady = false;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
let cacheWriting = false;
const pendingCache = new Map<string, { serverId: string; page: HistoryPage; revision: string | null }>();
const selectionToolbar = createSelectionToolbar(element('messages'), (text, messageId, selection) => {
  if (!selected || pending) return;
  const chatId = selected.id;
  openAnnotation(text, messageId, selection, '', annotation => {
    if (selected?.id !== chatId) return;
    selectedAnnotations.push(annotation);
    localStorage.setItem(storageKey('annotations', chatId), JSON.stringify(selectedAnnotations));
    renderChat();
  });
});

function readStored<T>(key: string): T | null {
  const value = localStorage.getItem(key);
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function inform(text = ''): void { notice.textContent = text; notice.hidden = !text; }
function storageKey(kind: string, id = ''): string { return `codex-reach-${kind}:${connection?.serverId}:${id}`; }
function stateLabel(status: string): string {
  return ({ active: '进行中', inProgress: '进行中', completed: '已完成', failed: '失败', interrupted: '已停止', systemError: '异常' } as Record<string, string>)[status] ?? '';
}

function clearRuntimeStatus(): void {
  runtimeStatus = null;
  activeTurnId = null;
  liveWaiting = false;
  editableTurn = null;
}

function showView(view: typeof currentView): void {
  if (view !== currentView) selectionToolbar.dismiss();
  currentView = view;
  for (const name of views) element(`${name}-view`).hidden = name !== view;
  document.querySelector<HTMLElement>('.app-header')!.hidden = view === 'chat';
  element('brand').textContent = view === 'connection' ? '连接设置' : 'Codex Reach';
  element('cancel-settings').hidden = view !== 'connection' || !settingsReturnView;
  element('settings-button').hidden = view === 'connection';
  renderConnection();
}

function renderConnection(): void {
  const label = connected ? '已连接' : connection ? '重连中' : '未连接';
  for (const badge of document.querySelectorAll<HTMLElement>('[data-connection-status]')) {
    badge.textContent = label;
    badge.dataset.connected = String(connected);
  }
  element('reconnect-notice').hidden = !connection || connected || currentView === 'connection';
  element('reconnect-text').textContent = `正在重连，当前内容和草稿已保留。${connectionError}`;
  element<HTMLButtonElement>('new-chat-button').disabled = !connected;
}

function stopUpdates(): void {
  generation += 1;
  clearTimeout(inboxRetryTimer);
  inboxRetryTimer = undefined;
  refreshButton.disabled = false;
  refreshButton.setAttribute('aria-label', '刷新');
  refreshButton.removeAttribute('aria-busy');
  opening = false;
  olderLoading = false;
  moreLoading = false;
}

function resumeChat(): void {
  if (!selected || !foreground) return;
  restoringScroll = scroll.scrollTop;
  stopUpdates();
  revision = null;
  clearRuntimeStatus();
  syncing = true;
  renderChat();
  const id = selected.id;
  const token = generation;
  void refreshHistory(id, token).then(() => {
    if (token === generation) void followChat(id, token);
  });
}

function openSettings(): void {
  if (currentView === 'connection') return;
  settingsReturnView = currentView;
  settingsScrollTop = scroll.scrollTop;
  followLatest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2;
  stopUpdates();
  urlInput.value = connection?.url ?? '';
  keyInput.value = connection?.key ?? '';
  showView('connection');
}

function closeSettings(): void {
  if (!settingsReturnView) return;
  connectionAttempt += 1;
  connectButton.disabled = false;
  connectButton.textContent = '连接';
  const destination = settingsReturnView;
  settingsReturnView = null;
  inform();
  showView(destination);
  if (destination === 'chat') {
    scroll.scrollTop = settingsScrollTop;
    resumeChat();
  } else void refreshInbox();
}

function backToInbox(): void {
  stopUpdates();
  showView('inbox');
  void refreshInbox();
}

async function connect(): Promise<void> {
  const attempt = ++connectionAttempt;
  connectButton.disabled = true;
  connectButton.textContent = '连接中…';
  inform('正在连接电脑…');
  try {
    const url = new URL(urlInput.value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/') {
      throw new Error('请填写 http://主机:端口 或 https://主机:端口');
    }
    const candidate: Connection = { url: url.origin, key: keyInput.value.trim(), serverId: '' };
    const nextClient = new ReachClient(candidate);
    const status = await nextClient.request<{ serverId: string; desktopLocale?: string | null }>('/status');
    if (attempt !== connectionAttempt) return;
    candidate.serverId = status.serverId;
    candidate.desktopLocale = status.desktopLocale;
    const sameServer = candidate.serverId === connection?.serverId;
    const returnToChat = settingsReturnView === 'chat' && sameServer;
    stopUpdates();
    pinRequests.clear();
    pinRevisions.clear();
    if (!sameServer) {
      projects = [];
      modelChoices = [];
      selectedPinned = undefined;
      threads = [];
      nextThreads = null;
      selected = null;
      renderInbox();
    }
    connection = candidate;
    client = nextClient;
    void connectNotifications(nextClient).catch(error => inform(`提醒连接未启动。${errorText(error)}`));
    void recoverUploads(nextClient);
    connected = true;
    connectionError = '';
    localStorage.setItem('codex-reach-connection', JSON.stringify(candidate));
    inform();
    if (returnToChat) closeSettings();
    else {
      settingsReturnView = null;
      showView('inbox');
      void refreshInbox();
    }
    void resumeCreation();
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    inform(errorText(error));
  } finally {
    if (attempt === connectionAttempt) {
      connectButton.disabled = false;
      connectButton.textContent = '连接';
    }
  }
}

async function loadInbox(token: number): Promise<void> {
  if (!client) return;
  void client.loadModels().catch(() => {});
  const revisions = new Map(pinRevisions);
  const unreadRevisions = new Map(readRevisions);
  const [projectResult, threadResult] = await Promise.all([
    client.request<{ projects: Project[] }>('/projects'),
    client.request<{ threads: Thread[]; nextCursor: string | null }>(`/threads?archived=${archivedList}`),
  ]);
  if (token !== generation) return;
  projects = projectResult.projects;
  threads = threadResult.threads.map(thread => {
    thread.pinned = Boolean(thread.pinned);
    const current = threads.find(item => item.id === thread.id);
    if (thread.isUnread == null || readOperations.has(thread.id) || unreadRevisions.get(thread.id) !== readRevisions.get(thread.id)) thread.isUnread = current?.isUnread ?? readStored<Record<string, boolean>>(storageKey('unread'))?.[thread.id];
    else rememberUnread(thread.id, thread.isUnread);
    if (current && (pinRequests.has(thread.id) || revisions.get(thread.id) !== pinRevisions.get(thread.id))) {
      thread.pinned = current.pinned;
    }
    return thread;
  });
  nextThreads = threadResult.nextCursor;
  const selectedProject = projectFilter.value;
  projectFilter.replaceChildren(new Option('全部项目', ''), new Option('无项目', '__none__'));
  for (const project of projects) projectFilter.add(new Option(project.name, project.id));
  projectFilter.value = selectedProject;
  renderInbox();
  void refreshThreadStates(token);
  const selectedThread = threads.find(thread => thread.id === selected?.id);
  if (selectedThread) selectedPinned = Boolean(selectedThread.pinned);
  if (selected && selectedThread?.title) {
    selected.title = selectedThread.title;
    if (currentView === 'chat') renderChat();
    scheduleCache();
  }
}

async function refreshInbox(): Promise<void> {
  if (!client || !foreground || currentView !== 'inbox') return;
  stopUpdates();
  const token = generation;
  refreshButton.disabled = true;
  refreshButton.setAttribute('aria-label', '正在刷新');
  refreshButton.setAttribute('aria-busy', 'true');
  element('refresh-status').textContent = '';
  try {
    await loadInbox(token);
    if (token !== generation) return;
    connected = true;
    connectionError = '';
    if (notice.textContent?.startsWith('列表读取失败')) inform();
    element('refresh-status').textContent = `已刷新 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    void resumeCreation();
  } catch (error) {
    if (token !== generation) return;
    await checkConnectionAfterError(error, token);
    if (token !== generation) return;
    element('refresh-status').textContent = '刷新失败';
    if (connected) inform(`列表读取失败。${errorText(error)}`);
    else inboxRetryTimer = setTimeout(() => void refreshInbox(), 2000);
  } finally {
    if (token === generation) {
      refreshButton.disabled = false;
      refreshButton.setAttribute('aria-label', '刷新');
      refreshButton.removeAttribute('aria-busy');
      renderConnection();
    }
  }
}

function renderSelectedPin(): void {
  element('chat-pinned').innerHTML = pinIcon;
  element('chat-pinned').hidden = !selectedPinned;
}

function menuDialog(title: string): { dialog: HTMLDialogElement; body: HTMLElement; error: HTMLElement } {
  const dialog = document.createElement('dialog'); dialog.className = 'task-dialog menu-dialog';
  const heading = document.createElement('div'); heading.className = 'dialog-header';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'quiet'; close.textContent = '返回';
  close.addEventListener('click', () => dialog.close());
  const label = document.createElement('h2'); label.textContent = title;
  heading.append(close, label);
  const body = document.createElement('div'); body.className = 'menu-actions';
  const error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'status');
  dialog.append(heading, body, error);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); dialog.showModal();
  return { dialog, body, error };
}

function openThreadMenu(thread: Thread): void {
  const menu = menuDialog(threadTitle(thread));
  const detail = document.createElement('p'); detail.className = 'field-note thread-detail';
  detail.textContent = [thread.cwd, thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString('zh-CN') : '', thread.waitingTargets?.length ? `正在等待 ${thread.waitingTargets.map(threadTitle).join('、')}` : ''].filter(Boolean).join('\n');
  menu.body.append(detail);
  const action = (name: string, run: () => Promise<void>) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = name;
    button.disabled = !connected;
    button.addEventListener('click', async () => {
      button.disabled = true; menu.error.textContent = '';
      try { await run(); menu.dialog.close(); }
      catch (error) { menu.error.textContent = errorText(error); }
      finally { button.disabled = !connected; }
    });
    menu.body.append(button);
  };
  action(thread.pinned ? '取消置顶' : '置顶', () => togglePin(thread.id));
  const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'quiet'; rename.textContent = '改名'; rename.disabled = !connected;
  rename.addEventListener('click', () => {
    menu.body.replaceChildren();
    const form = document.createElement('form');
    const label = document.createElement('label'); label.textContent = '对话名称';
    const input = document.createElement('input'); input.value = threadTitle(thread); input.maxLength = 60; input.required = true; label.append(input);
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary'; save.textContent = '保存名称';
    form.append(label, save); menu.body.append(form); input.focus(); input.select();
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!client || !input.value.trim()) return;
      save.disabled = true;
      try {
        const result = await client.request<{ title: string }>(`/threads/${encodeURIComponent(thread.id)}/title`, 'POST', { title: input.value.trim() });
        thread.title = result.title;
        if (selected?.id === thread.id) { selected.title = thread.title; renderChat(); scheduleCache(); }
        renderInbox(); menu.dialog.close();
      } catch (error) { menu.error.textContent = errorText(error); }
      finally { save.disabled = false; }
    });
  });
  menu.body.append(rename);
  action(thread.isUnread === false ? '标为未读' : '标为已读', async () => {
    const read = thread.isUnread !== false;
    await setRead(thread.id, read);
    if (selected?.id === thread.id) readAttempts.set(thread.id, revision ?? 'history');
    renderInbox();
  });
  action(archivedList ? '恢复到对话列表' : '归档', async () => {
    await client!.request(`/threads/${encodeURIComponent(thread.id)}/archive`, 'POST', { archived: !archivedList });
    await invalidateChats([thread.id]);
    backToInbox();
  });
  action('改动文件', async () => { openChanges(client!, thread.id, thread.cwd); });
  if (selected?.id === thread.id) action('在对话中查找', async () => { openChatSearch(); });
  action('永久删除', async () => { openDeletion(client!, thread, async ids => { await invalidateChats(ids); backToInbox(); }); });
}

async function invalidateChats(ids: string[]): Promise<void> {
  if (!connection) return;
  if (selected && ids.includes(selected.id)) { stopUpdates(); selected = null; }
  for (const id of ids) pendingCache.delete(`${connection.serverId}:${id}`);
  await cache.remove(connection.serverId, ids);
  threads = threads.filter(thread => !ids.includes(thread.id));
}

async function setRead(id: string, read: boolean): Promise<void> {
  if (!client) return;
  const current = client;
  const version = (readRevisions.get(id) ?? 0) + 1;
  readRevisions.set(id, version);
  const operation = (readOperations.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await current.request(`/threads/${encodeURIComponent(id)}/read`, 'POST', { read });
    if (client === current && readRevisions.get(id) === version) { rememberUnread(id, !read); renderInbox(); }
  });
  readOperations.set(id, operation);
  try { await operation; }
  finally { if (readOperations.get(id) === operation) { readOperations.delete(id); readRevisions.set(id, version + 1); } }
}

async function refreshThreadStates(token: number): Promise<void> {
  const stateClient = client;
  if (!stateClient) return;
  const active = threads.filter(thread => ['active', 'inProgress'].includes(thread.status));
  for (let offset = 0; offset < active.length && token === generation; offset += 3) {
    await Promise.allSettled(active.slice(offset, offset + 3).map(async thread => {
      const summary = await stateClient.request<Pick<Thread, 'status' | 'waitingForUser' | 'waitingForThread' | 'waitingTargets'> & { available: boolean }>(`/threads/${encodeURIComponent(thread.id)}/state`);
      if (token !== generation || !summary.available) return;
      const current = threads.find(item => item.id === thread.id);
      if (current) Object.assign(current, summary);
    }));
    if (token === generation) renderInbox();
  }
}

function rememberUnread(id: string, unread: boolean): void {
  const known = readStored<Record<string, boolean>>(storageKey('unread')) ?? {};
  known[id] = unread;
  localStorage.setItem(storageKey('unread'), JSON.stringify(known));
  const thread = threads.find(item => item.id === id);
  if (thread) thread.isUnread = unread;
}

function markLatestRead(): void {
  if (!selected || !client || !foreground || currentView !== 'chat' || !historyLoaded || syncing || historyError || streamError
    || document.querySelector('dialog[open]') || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 90) return;
  const id = selected.id;
  const unread = threads.find(thread => thread.id === id)?.isUnread ?? readStored<Record<string, boolean>>(storageKey('unread'))?.[id];
  const stamp = revision ?? 'history';
  if (unread !== true || readAttempts.get(id) === stamp) return;
  readAttempts.set(id, stamp);
  void setRead(id, true).catch(() => { /* Preserve unread state until a later sync or an explicit read-state action */ });
}

element('list-menu-button').addEventListener('click', () => {
  const menu = menuDialog('对话列表');
  const legend = document.createElement('h3'); legend.textContent = '分组方式'; menu.body.append(legend);
  for (const [value, name] of [['date', '日期'], ['project', '项目'], ['status', '状态']] as const) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet';
    button.setAttribute('role', 'menuitemradio'); button.setAttribute('aria-checked', String(grouping === value));
    button.textContent = `${grouping === value ? '✓ ' : ''}${name}`;
    button.addEventListener('click', () => { grouping = value; localStorage.setItem('codex-reach-grouping', value); renderInbox(); menu.dialog.close(); });
    menu.body.append(button);
  }
  const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'quiet'; archive.textContent = archivedList ? '查看当前对话' : '查看已归档对话';
  archive.addEventListener('click', () => { archivedList = !archivedList; threads = []; nextThreads = null; menu.dialog.close(); renderInbox(); void refreshInbox(); });
  menu.body.append(archive);
  const notifications = document.createElement('button'); notifications.type = 'button'; notifications.className = 'quiet'; notifications.textContent = '任务提醒';
  notifications.addEventListener('click', () => { menu.dialog.close(); if (client) openNotificationSettings(client); }); menu.body.append(notifications);
});

async function togglePin(id: string): Promise<void> {
  if (!client || !connected || pinRequests.has(id)) return;
  const pinned = threads.find(item => item.id === id)?.pinned ?? (selected?.id === id ? selectedPinned : undefined);
  const pinClient = client;
  pinRequests.add(id);
  pinRevisions.set(id, (pinRevisions.get(id) ?? 0) + 1);
  renderInbox();
  if (selected) renderSelectedPin();
  try {
    const path = `/threads/${encodeURIComponent(id)}/pin`;
    const result = pinned === undefined
      ? await pinClient.request<{ pinned: boolean }>(path)
      : await pinClient.request<{ pinned: boolean }>(path, 'POST', { pinned: !pinned });
    if (client !== pinClient) return;
    const current = threads.find(item => item.id === id);
    if (current) current.pinned = result.pinned;
    if (selected?.id === id) selectedPinned = result.pinned;
  } catch (error) {
    if (client === pinClient) inform(`置顶状态未确认，可重试或刷新列表核对。${errorText(error)}`);
  } finally {
    if (client === pinClient) {
      pinRequests.delete(id);
      pinRevisions.set(id, (pinRevisions.get(id) ?? 0) + 1);
      renderInbox();
      if (selected) renderSelectedPin();
    }
  }
}

function renderInbox(): void {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const projectId = projectFilter.value;
  const visible = threads.filter(thread => (!query || (thread.title || '').toLocaleLowerCase().includes(query))
    && (!projectId || (projectId === '__none__' ? !thread.projectId : thread.projectId === projectId)))
    ;
  const fragment = document.createDocumentFragment();
  element('list-scope').textContent = `${archivedList ? '已归档 · ' : ''}已加载 ${threads.length} 条${query ? ` · 匹配 ${visible.length} 条` : ''}`;
  for (const group of groupThreads(visible, projects, grouping)) {
    const heading = document.createElement('h2');
    heading.className = 'thread-group-title'; heading.textContent = group.title;
    fragment.append(heading);
    for (const thread of group.threads) {
    const row = document.createElement('div');
    row.className = 'thread-entry';
    const button = document.createElement('button');
    button.className = 'thread-row';
    button.type = 'button';
    button.dataset.threadId = thread.id;
    const title = document.createElement('span');
    title.className = 'thread-title';
    title.textContent = threadTitle(thread);
    button.append(title);
    button.title = `${threadTitle(thread)}\n${thread.cwd}\n${new Date(thread.updatedAt * 1000).toLocaleString('zh-CN')}`;
    if (thread.isUnread) { const unread = document.createElement('span'); unread.className = 'unread-dot'; unread.setAttribute('aria-label', '未读'); button.append(unread); }
    if (thread.pinned) { const pin = document.createElement('span'); pin.className = 'static-pin'; pin.innerHTML = pinIcon; pin.setAttribute('aria-label', '已置顶'); button.append(pin); }
    const state = thread.waitingForUser ? '待处理' : thread.waitingForThread ? '等待对话' : stateLabel(thread.status);
    if (state) { const status = document.createElement('span'); status.className = 'thread-status'; status.textContent = state; button.append(status); }
    let press: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    let origin = { x: 0, y: 0 };
    const cancel = () => { clearTimeout(press); press = undefined; };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      held = false; origin = { x: event.clientX, y: event.clientY };
      press = setTimeout(() => { held = true; openThreadMenu(thread); }, 500);
    });
    button.addEventListener('pointermove', event => { if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 12) cancel(); });
    button.addEventListener('pointerup', cancel);
    button.addEventListener('pointercancel', cancel);
    button.addEventListener('contextmenu', event => { event.preventDefault(); cancel(); if (!held) openThreadMenu(thread); held = true; });
    button.addEventListener('click', () => { if (!held) void openChat(thread.id); held = false; });
    row.append(button);
    fragment.append(row);
    }
  }
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = nextThreads ? '当前列表中没有匹配项，可继续加载。' : '暂无匹配的对话';
    fragment.append(empty);
  }
  element('thread-list').replaceChildren(fragment);
  element('more-threads').hidden = !nextThreads;
  element<HTMLButtonElement>('more-threads').disabled = moreLoading || !connected;
}

async function refreshHistory(id: string, token: number): Promise<void> {
  if (!client) return;
  const request = ++historyRequest;
  const revisionAtStart = revision;
  const currentRequest = () => token === generation && selected?.id === id && request === historyRequest && revision === revisionAtStart;
  let page: HistoryPage;
  try { page = await client.request<HistoryPage>(`/threads/${encodeURIComponent(id)}/history`); }
  catch (error) {
    if (currentRequest()) await reportReadError(error, token, 'history', currentRequest);
    return;
  }
  if (!currentRequest() || !selected) return;
  const current = historyLoaded ? selected : { ...selected, turns: [], hasMore: false, nextCursor: null };
  selected = mergeHistory(current, page);
  historyLoaded = true;
  historyError = '';
  connected = true;
  connectionError = '';
  renderChat();
  scheduleCache();
}

async function checkConnectionAfterError(error: unknown, token: number, currentRequest: () => boolean = () => true): Promise<void> {
  let reachable = false;
  let failure = error;
  if (client && error instanceof ReachError && error.status !== 401) {
    try { await client.request('/status'); reachable = true; }
    catch (statusError) { failure = statusError; }
  }
  if (token !== generation || !currentRequest()) return;
  connected = reachable;
  connectionError = reachable ? '' : errorText(failure);
  renderConnection();
}

async function reportReadError(error: unknown, token: number, kind: 'history' | 'stream', currentRequest: () => boolean = () => true): Promise<void> {
  await checkConnectionAfterError(error, token, currentRequest);
  if (token !== generation || !currentRequest()) return;
  if (connected) {
    if (kind === 'history') historyError = `历史读取失败。${errorText(error)}`;
    else streamError = `实时更新失败。${errorText(error)}`;
  }
  syncing = false;
  if (!connected || kind === 'stream') clearRuntimeStatus();
  renderChat();
}

async function openChat(id: string, pinned?: boolean): Promise<void> {
  followLatest = true;
  restoringScroll = null;
  readAttempts.delete(id);
  stopUpdates();
  const token = generation;
  revision = null;
  liveWaiting = false;
  liveRequests = [];
  liveModel = '';
  liveThinking = '';
  historyLoaded = false;
  opening = true;
  syncing = true;
  clearRuntimeStatus();
  historyError = '';
  streamError = '';
  renderedMessages.clear();
  const thread = threads.find(item => item.id === id);
  selectedPinned = pinned ?? (thread ? Boolean(thread.pinned) : undefined);
  selected = { id, title: thread?.title || '未命名对话', cwd: thread?.cwd ?? '', status: thread?.status ?? '', turns: [], hasMore: false, nextCursor: null };
  pending = readStored(storageKey('pending', id));
  stopOperation = readStored(storageKey('stop', id));
  interaction = readStored(storageKey('interaction', id));
  selectedSkills = readStored<Skill[]>(storageKey('skills', id)) ?? [];
  selectedThreads = readStored<ThreadReference[]>(storageKey('thread-refs', id)) ?? [];
  queueItems = [];
  void refreshQueue();
  selectedFiles = readStored<FileAttachment[]>(storageKey('attachments', id)) ?? [];
  selectedAnnotations = readStored<ResponseAnnotation[]>(storageKey('annotations', id)) ?? [];
  questionReplies = readStored<QuestionReply[]>(storageKey('question-replies', id)) ?? [];
  questionDrafts = readStored<QuestionReply[]>(storageKey('question-drafts', id)) ?? pending?.questionReplies ?? [];
  turnOptions = readStored<TurnOptions>(storageKey('options', id)) ?? {};
  messageInput.value = localStorage.getItem(storageKey('draft', id)) ?? '';
  localStorage.setItem(storageKey('last-chat'), id);
  showView('chat');
  renderChat(true);
  if (selectedPinned === undefined && connected) void togglePin(id);
  try {
    const saved = connection ? await cache.load(connection.serverId, id).catch(error => {
      if (token === generation) inform(`本地缓存读取失败。${errorText(error)}`);
      return null;
    }) : null;
    if (token !== generation) return;
    if (saved) { selected = saved; renderChat(true); }
    await refreshHistory(id, token);
    if (token !== generation) return;
    if (connected && !historyError) inform();
    renderChat(true);
    if (pending) void checkReceipt(token).catch(error => { if (token === generation) inform(errorText(error)); });
    if (stopOperation) void checkStopReceipt(token);
    if (interaction) void checkInteractionReceipt(token);
    void followChat(id, token);
  } catch (error) {
    if (token !== generation) return;
    await reportReadError(error, token, 'history');
    if (token !== generation) return;
    void followChat(id, token);
  } finally {
    if (token === generation) { opening = false; renderChat(); }
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
      connectionError = '';
      streamError = '';
      if (wasDisconnected) { syncing = true; void resumeCreation(); }
      if (wasDisconnected && !historyError) {
        await refreshHistory(id, token);
        if (token !== generation || !selected) return;
      }
      if (!view.available) {
        if (!historyError) await refreshHistory(id, token);
        if (token !== generation) return;
        clearRuntimeStatus();
        syncing = false;
        settleStopFromRuntime();
        renderChat();
        if (pending) await checkReceipt(token);
        if (stopOperation) await checkStopReceipt(token);
        if (interaction) await checkInteractionReceipt(token);
        await new Promise(resolve => setTimeout(resolve, 3000));
        continue;
      }
      let merged = mergeTail(selected.turns, view.turns ?? [], Boolean(view.complete));
      if (!merged) {
        if (!historyError) await refreshHistory(id, token);
        if (token !== generation || !selected) return;
        merged = mergeTail(selected.turns, view.turns ?? [], Boolean(view.complete));
      }
      if (!merged) {
        syncing = true;
        revision = null;
        renderChat();
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      selected.turns = merged;
      if (runtimeStatus !== view.status) void refreshQueue();
      if (view.title) selected.title = view.title;
      selected.status = view.status ?? selected.status;
      runtimeStatus = view.status ?? null;
      activeTurnId = view.activeTurnId ?? null;
      revision = view.revision ?? null;
      liveWaiting = Boolean(view.waiting);
      liveRequests = view.requests ?? [];
      editableTurn = view.editableTurn ?? null;
      if (interaction?.kind === 'respond' && !liveRequests.some(request => request.id === interaction?.approvalRequestId)) clearInteraction();
      liveModel = view.model ?? '';
      liveThinking = view.thinking ?? '';
      syncing = false;
      settleStopFromRuntime();
      renderChat();
      scheduleCache();
      if (previousStatus === 'active' && selected.status !== 'active') await refreshHistory(id, token);
      if (token !== generation) return;
      previousStatus = selected.status;
      if (pending) await checkReceipt(token);
      if (stopOperation) await checkStopReceipt(token);
      if (interaction) await checkInteractionReceipt(token);
      await new Promise(resolve => setTimeout(resolve, 120));
    } catch (error) {
      if (token !== generation) return;
      await reportReadError(error, token, 'stream');
      if (token !== generation) return;
      if (!connected) revision = null;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

async function loadAnnotationSource(annotation: ResponseAnnotation): Promise<Message> {
  if (!selected || !annotation.source) throw new Error('来源不可用，摘录已保留');
  const token = generation;
  const find = () => selected?.turns.flatMap(turn => turn.messages).find(message => message.id === annotation.source!.messageId);
  let source = find();
  while (!source && selected.nextCursor && client) {
    const page = await client.request<HistoryPage>(`/threads/${encodeURIComponent(selected.id)}/history?cursor=${encodeURIComponent(selected.nextCursor)}`);
    if (token !== generation) throw new Error('已切换对话');
    selected = prependHistory(selected, page);
    source = find();
  }
  if (!source) throw new Error('来源已不可用，摘录已保留');
  return source;
}

async function showAnnotationSource(annotation: ResponseAnnotation): Promise<void> {
  const source = await loadAnnotationSource(annotation);
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog annotation-detail';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'quiet';
  close.textContent = '返回引用';
  close.addEventListener('click', () => dialog.close());
  const content = document.createElement('div');
  content.className = 'message-content';
  renderMarkdown(content, source.text, source.requestAnnotations ?? [], client, () => {}, selected?.cwd);
  dialog.append(close, content);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  let start = annotation.source!.contentOffsets?.startOffset ?? annotation.source!.startOffset;
  let end = annotation.source!.contentOffsets?.endOffset ?? annotation.source!.endOffset;
  if (!annotation.source!.contentOffsets) {
    const text = sourceText(content);
    const found = text.indexOf(annotation.text);
    if (found >= 0 && text.indexOf(annotation.text, found + 1) < 0) { start = found; end = found + annotation.text.length; }
  }
  const range = sourceRange(content, start, end);
  if (range) {
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const target = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    target?.scrollIntoView({ block: 'center' });
  }
}

function renderMessage(message: Message, key: string, answers: Map<string, string>, process = false): HTMLElement {
  let node = renderedMessages.get(key);
  if (!node) {
    node = document.createElement('article');
    node.className = `message ${message.kind}`;
    node.dataset.messageId = message.id;
    const content = document.createElement('div');
    content.className = 'message-content';
    node.append(content);
    const attachments = document.createElement('div');
    attachments.className = 'message-attachments';
    node.append(attachments);
    const actions = document.createElement('div');
    actions.className = 'message-actions';
    node.append(actions);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'quiet copy-message';
    copy.textContent = '复制';
    copy.addEventListener('click', () => void copyText(node!.dataset.copyText ?? '', copy));
    actions.append(copy);
    const annotations = document.createElement('div');
    annotations.className = 'message-annotations';
    node.prepend(annotations);
    if (message.kind === 'user') {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'quiet edit-message';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => openEdit());
      actions.append(edit);
    }
    renderedMessages.set(key, node);
  }
  node.classList.toggle('process-message', process);
  node.querySelector<HTMLElement>('.message-actions')!.hidden = process;
  const content = node.querySelector<HTMLElement>('.message-content')!;
  const details = node.querySelector<HTMLDetailsElement>(':scope > .message-record');
  if (!process && (message.kind === 'reasoning' || message.kind === 'tool')) {
    if (!details) {
      const wrapper = document.createElement('details');
      wrapper.className = 'message-record';
      const summary = document.createElement('summary');
      summary.textContent = message.kind === 'reasoning' ? '思考摘要' : '工具记录';
      content.replaceWith(wrapper);
      wrapper.append(summary, content);
    }
  } else details?.replaceWith(content);
  const questionText = message.questions?.map(question => [question.title, ...(question.options ?? []).map(option => `- ${option}`)].join('\n')).join('\n\n');
  const body = message.questionReplies?.length ? message.questionReplies.map(reply => `${reply.question}\n${reply.answer}`).join('\n\n')
    : questionText === message.text ? '' : message.text;
  const annotations = messageAnnotations.get(key) ?? [];
  node.dataset.copyText = [...(message.responseAnnotations ?? []).map((annotation, index) =>
    `引用 ${index + 1}\n${annotation.text}${annotation.annotation ? `\n${annotation.annotation}` : ''}`), body].filter(text => text.trim()).join('\n\n');
  const annotationKey = JSON.stringify([annotations, connection?.desktopLocale]);
  if (node.dataset.body !== body || node.dataset.annotationKey !== annotationKey) {
    content.hidden = !body.trim();
    if (message.kind === 'user' || message.kind === 'tool') content.textContent = body;
    else renderMarkdown(content, body, annotations, client, (annotation, index) => openAnnotationDetail(annotation, index, showAnnotationSource), selected?.cwd);
    node.dataset.body = body;
    node.dataset.annotationKey = annotationKey;
  }
  const edit = node.querySelector<HTMLButtonElement>('.edit-message');
  renderAnnotations(node.querySelector<HTMLElement>('.message-annotations')!, message.responseAnnotations ?? [], undefined, undefined, showAnnotationSource);
  renderAttachments(node.querySelector<HTMLElement>('.message-attachments')!, message.attachments ?? [], { client });
  if (edit) {
    edit.hidden = !editableTurn || key !== `${editableTurn.turnId}:${editableTurn.messageId}`;
    edit.disabled = !connected || runtimeStatus === 'active' || Boolean(pending) || Boolean(interaction) || Boolean(stopOperation);
  }
  if (message.questions?.length) {
    let questions = node.querySelector<HTMLDivElement>('.async-questions');
    if (!questions) {
      questions = document.createElement('div');
      questions.className = 'async-questions';
      node.append(questions);
    }
    renderAsyncQuestions(questions, message.questions.map((question, index) => {
      const id = JSON.stringify(['request_user_input_async', message.id, index]);
      return { ...question, id, answer: answers.get(id), draft: questionDrafts.find(reply => reply.questionItemId === id)?.answer };
    }), { disabled: !connected || Boolean(pending) || Boolean(interaction) || Boolean(stopOperation), onSubmit: replies => void submitQuestionReplies(replies) });
  } else node.querySelector('.async-questions')?.remove();
  return node;
}

function renderProcessRecords(group: ProcessGroup, turn: Turn, answers: Map<string, string>, used: Set<HTMLElement>): HTMLElement {
  let node = group.messages.map(message => renderedMessages.get(`${turn.id}:${message.id}`)
    ?.closest<HTMLDetailsElement>('.process-records')).find(node => node && !used.has(node));
  if (!node) {
    node = document.createElement('details');
    node.className = 'process-records';
    node.innerHTML = '<summary></summary><div class="record-messages"></div>';
  }
  used.add(node);
  node.dataset.kind = group.kind!;
  const label = group.kind === 'tool' ? '工具记录' : '思考摘要';
  node.querySelector('summary')!.textContent = label + (group.messages.length > 1 ? `（${group.messages.length}）` : '');
  const messages = node.querySelector<HTMLElement>('.record-messages')!;
  let position = messages.firstElementChild;
  for (const message of group.messages) {
    const item = renderMessage(message, `${turn.id}:${message.id}`, answers, true);
    if (item !== position) messages.insertBefore(item, position);
    position = item.nextElementSibling;
  }
  while (position) { const next = position.nextElementSibling; position.remove(); position = next; }
  return node;
}

function renderProcess(group: MessageGroup, turn: Turn, answers: Map<string, string>, used: Set<HTMLElement>, active: boolean): HTMLElement {
  // Reuse a group through live updates and pages that prepend older process items
  let node = group.messages.map(message => renderedMessages.get(`${turn.id}:${message.id}`)
    ?.closest<HTMLDetailsElement>('.turn-process')).find(node => node && !used.has(node));
  if (!node) {
    node = document.createElement('details');
    node.className = 'turn-process';
    node.innerHTML = '<summary><span class="process-title"></span><span class="process-preview" hidden></span></summary><div class="process-messages"></div>';
  }
  used.add(node);
  node.dataset.turnId = turn.id;
  node.querySelector('.process-title')!.textContent = active ? '执行中…'
    : turn.status === 'failed' ? '执行过程（失败）'
    : turn.status === 'interrupted' ? '执行过程（已停止）' : '执行过程';
  const preview = node.querySelector<HTMLElement>('.process-preview')!;
  const progress = group.messages.slice().reverse().find(message => message.kind === 'assistant');
  preview.textContent = active ? progress?.text.trim().split('\n')[0] ?? '' : '';
  preview.hidden = !preview.textContent;
  const messages = node.querySelector<HTMLElement>('.process-messages')!;
  let position = messages.firstElementChild;
  const usedRecords = new Set<HTMLElement>();
  for (const records of groupProcessMessages(group.messages)) {
    const message = records.messages[0];
    const item = records.kind ? renderProcessRecords(records, turn, answers, usedRecords)
      : renderMessage(message, `${turn.id}:${message.id}`, answers, true);
    if (item !== position) messages.insertBefore(item, position);
    position = item.nextElementSibling;
  }
  while (position) { const next = position.nextElementSibling; position.remove(); position = next; }
  return node;
}

function renderChat(forceBottom = false): void {
  if (!selected) return;
  selectionToolbar.setDisabled(Boolean(pending));
  const previousTop = scroll.scrollTop;
  element('chat-title').textContent = threadTitle(selected);
  element('chat-title').title = threadTitle(selected);
  element('chat-meta').textContent = [selected.cwd, liveModel, liveThinking].filter(Boolean).join(' · ');
  element('chat-state').textContent = stateLabel(runtimeStatus ?? '');
  element('chat-state').dataset.status = runtimeStatus ?? '';
  element('chat-state').hidden = !element('chat-state').textContent;
  if (optionsDialog.open && optionsChatId === selected.id && runtimeStatus !== null && liveModel && liveThinking) {
    element('options-current').textContent = `当前会话使用 ${liveModel} · ${liveThinking}`;
  }
  element('chat-error').hidden = !historyError && !streamError;
  element('chat-error-text').textContent = [historyError, streamError].filter(Boolean).join(' ');
  renderConnection();
  olderButton.hidden = !selected.hasMore;
  olderButton.disabled = !connected || olderLoading || syncing;
  olderButton.setAttribute('aria-busy', String(olderLoading));
  element('older-spinner').hidden = !olderLoading;
  element('older-label').textContent = olderLoading ? '正在读取更早的消息…' : '读取更早的消息';
  const hasMessages = selected.turns.some(turn => turn.messages.length > 0);
  const loadingText = opening && !hasMessages ? '正在读取对话…' : syncing && connected ? '正在同步最新消息…' : '';
  element('history-status').hidden = !loadingText || Boolean(historyError) || Boolean(streamError);
  element('history-status-text').textContent = loadingText;
  element('empty-history').hidden = hasMessages || opening || syncing || !historyLoaded || Boolean(historyError);
  element('empty-history').textContent = selected.hasMore ? '此页没有可显示的消息，可继续读取更早内容' : '暂无消息';
  const messages = element('messages');
  let position = messages.firstElementChild;
  const keys = new Set<string>();
  const answers = new Map<string, string>();
  const acceptedReplies = new Set<string>();
  for (const turn of selected.turns) {
    for (const message of turn.messages) {
      for (const reply of message.questionReplies ?? []) {
        answers.set(reply.questionItemId, reply.answer);
        acceptedReplies.add(JSON.stringify([reply.questionItemId, reply.answer]));
      }
    }
  }
  const repliesAwaitingHistory = questionReplies.filter(reply => !acceptedReplies.has(JSON.stringify([reply.questionItemId, reply.answer])));
  if (repliesAwaitingHistory.length !== questionReplies.length) {
    questionReplies = repliesAwaitingHistory;
    localStorage.setItem(storageKey('question-replies', selected.id), JSON.stringify(questionReplies));
  }
  for (const reply of questionReplies) answers.set(reply.questionItemId, reply.answer);
  const remainingDrafts = questionDrafts.filter(reply => !acceptedReplies.has(JSON.stringify([reply.questionItemId, reply.answer])));
  if (remainingDrafts.length !== questionDrafts.length) {
    questionDrafts = remainingDrafts;
    localStorage.setItem(storageKey('question-drafts', selected.id), JSON.stringify(questionDrafts));
  }
  const usedGroups = new Set<HTMLElement>();
  messageAnnotations.clear();
  for (const turn of selected.turns) {
    const annotations = turn.messages.find(message => message.kind === 'user')?.responseAnnotations ?? [];
    for (const message of turn.messages) {
      messageAnnotations.set(`${turn.id}:${message.id}`, message.requestAnnotations ?? annotations);
    }
  }
  for (const turn of selected.turns) {
    const groups = groupMessages(turn.messages);
    for (const [index, group] of groups.entries()) {
      for (const message of group.messages) keys.add(`${turn.id}:${message.id}`);
      const message = group.messages[0];
      const active = turn.status === 'inProgress' && index === groups.length - 1;
      const node = group.process ? renderProcess(group, turn, answers, usedGroups, active)
        : renderMessage(message, `${turn.id}:${message.id}`, answers);
      if (node !== position) messages.insertBefore(node, position);
      position = node.nextElementSibling;
    }
  }
  while (position) { const next = position.nextElementSibling; position.remove(); position = next; }
  for (const key of renderedMessages.keys()) if (!keys.has(key)) renderedMessages.delete(key);
  const requestPending = interaction?.kind === 'respond' ? { [JSON.stringify(interaction.approvalRequestId)]: interaction } : {};
  renderRequests(element('requests'), liveRequests, {
    disabled: !connected || runtimeStatus === null || Boolean(interaction), pending: requestPending,
    canResolve: connected && runtimeStatus !== null,
    onSubmit: (request, response) => void submitResponse(request, response), onResolve: () => { clearInteraction(); renderChat(); },
  });
  const activity = element('activity');
  activity.textContent = runtimeStatus === null && liveRequests.length ? '等待电脑端重新同步请求…' : liveWaiting ? '等待处理请求' : '正在处理…';
  activity.hidden = !connected || (!liveWaiting && runtimeStatus !== 'active' && !liveRequests.length);
  sendButton.disabled = !connected || Boolean(pending) || Boolean(stopOperation) || Boolean(interaction)
    || (!messageInput.value.trim() && !selectedFiles.length && !selectedSkills.length && !selectedThreads.length && !selectedAnnotations.length) || (Boolean(selectedFiles.length) && runtimeStatus === null);
  const queued = runtimeStatus === 'active' && element<HTMLSelectElement>('send-mode').value === 'queue';
  sendButton.textContent = queued ? '排队' : runtimeStatus === 'active' ? '立即追加' : '发送';
  element('send-mode-label').hidden = runtimeStatus !== 'active';
  element('queue-button').textContent = `队列${queueItems.filter(item => !['accepted', 'cancelled'].includes(item.status)).length ? `（${queueItems.filter(item => !['accepted', 'cancelled'].includes(item.status)).length}）` : ''}`;
  element('queue-button').hidden = runtimeStatus !== 'active' && !queueItems.length;
  element('queue-button').parentElement!.hidden = element('queue-button').hidden && runtimeStatus !== 'active';
  stopButton.hidden = runtimeStatus !== 'active' || !activeTurnId;
  stopButton.disabled = !connected || !activeTurnId || Boolean(stopOperation);
  stopButton.setAttribute('aria-label', stopOperation ? '正在停止' : '停止任务');
  element('stop-note').hidden = !stopOperation;
  element('stop-status').textContent = stopOperation?.error ?? (stopOperation?.status === 'accepted' ? '已请求停止，正在等待轮次结束…' : '正在确认停止结果…');
  element('resolve-stop').hidden = stopOperation?.status !== 'unknown' || !activeTurnId;
  element('parameters-button').textContent = turnOptions.model ? `${turnOptions.model} · ${turnOptions.thinking}` : [liveModel, liveThinking].filter(Boolean).join(' · ') || '沿用会话参数';
  element<HTMLButtonElement>('parameters-button').disabled = !connected || Boolean(pending);
  element<HTMLButtonElement>('skills-button').disabled = !connected || Boolean(pending) || Boolean(interaction);
  element<HTMLButtonElement>('files-button').disabled = !connected || Boolean(pending) || Boolean(interaction);
  renderSelectedPin();
  element('open-attachment-chat').hidden = !selectedFiles.length || runtimeStatus !== null;
  element<HTMLButtonElement>('open-attachment-chat').disabled = !connected || opening;
  renderAttachments(element('selected-files'), selectedFiles, { client, onRemove: pending ? undefined : index => {
    selectedFiles.splice(index, 1);
    localStorage.setItem(storageKey('attachments', selected!.id), JSON.stringify(selectedFiles));
    renderChat();
  } });
  const uploading = client ? uploadCount(client, storageKey('attachments', selected.id)) : 0;
  sendButton.disabled ||= uploading > 0;
  element('manage-files').hidden = !selectedFiles.length && !uploading;
  element('manage-files').textContent = `附件（${selectedFiles.length}）${uploading ? ` · ${uploading} 项上传` : ''}`;
  renderAnnotations(element('selected-annotations'), selectedAnnotations, pending ? undefined : index => {
    selectedAnnotations.splice(index, 1);
    localStorage.setItem(storageKey('annotations', selected!.id), JSON.stringify(selectedAnnotations));
    renderChat();
  }, pending ? undefined : async index => {
    const annotation = selectedAnnotations[index];
    const chatId = selected!.id;
    const save = (replacement: ResponseAnnotation) => {
      if (selected?.id !== chatId) return;
      selectedAnnotations[index] = replacement;
      localStorage.setItem(storageKey('annotations', chatId), JSON.stringify(selectedAnnotations));
      renderChat();
    };
    try {
      const message = await loadAnnotationSource(annotation);
      const content = document.createElement('div');
      renderMarkdown(content, message.text, message.requestAnnotations ?? [], client, () => {}, selected?.cwd);
      const nativeRange = annotation.source!.contentOffsets ?? annotation.source!;
      const range = sourceRange(content, nativeRange.startOffset, nativeRange.endOffset);
      if (!range) throw new Error('来源位置已变化');
      openAnnotation(sourceText(content, false), annotation.source!.messageId,
        { ...rangeOffsets(content, range, false), text: annotation.text }, annotation.annotation, replacement => {
          const range = sourceRange(content, replacement.source!.startOffset, replacement.source!.endOffset, false);
          if (!range) return;
          const offsets = rangeOffsets(content, range);
          save({ ...replacement, text: sourceText(range.cloneContents(), false), source: { messageId: annotation.source!.messageId, ...offsets, contentOffsets: offsets } });
        });
    } catch {
      if (selected?.id !== chatId) return;
      openAnnotation(annotation.text, annotation.source?.messageId ?? '', { startOffset: 0, endOffset: annotation.text.length }, annotation.annotation,
        replacement => save({ ...annotation, annotation: replacement.annotation }), true);
    }
  });
  renderSelectedSkills();
  element('interaction-note').hidden = !interaction || interaction.kind !== 'edit';
  element('interaction-status').textContent = interaction?.error ?? '正在确认编辑结果…';
  element('resolve-interaction').hidden = interaction?.status !== 'unknown';
  element<HTMLButtonElement>('submit-edit').disabled = Boolean(interaction) || !connected || runtimeStatus === 'active' || Boolean(editing?.blockedReason);
  element('delivery-note').hidden = !pending;
  element('delivery-text').textContent = pending?.status === 'unknown' ? pending.error || '投递结果待确认，请先查看聊天记录。草稿已保留。' : '正在确认投递结果…';
  element('resolve-delivery').hidden = pending?.status !== 'unknown';
  if (restoringScroll !== null && !forceBottom) scroll.scrollTop = restoringScroll;
  else if (forceBottom || followLatest) scroll.scrollTop = scroll.scrollHeight;
  else scroll.scrollTop = previousTop;
  if (!syncing) restoringScroll = null;
  updateReadingActions();
  selectionToolbar.refresh();
}

function updateReadingActions(): void {
  const away = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight >= 90;
  element('reading-actions').hidden = !away;
  element('jump-requests').hidden = !liveRequests.length;
  markLatestRead();
  if (notificationTarget && selected && notificationTarget.threadId === selected.id && historyLoaded) {
    const target = notificationTarget!;
    const request = [...document.querySelectorAll<HTMLElement>('[data-request-id]')].find(node => node.dataset.requestId === JSON.stringify(target.requestId));
    const turn = selected?.turns.find(turn => turn.id === target.turnId);
    const message = turn && [...turn.messages].reverse().find(message => message.kind === 'assistant');
    const answer = message && renderedMessages.get(`${turn!.id}:${message.id}`);
    const node = target.requestId != null ? request : answer;
    if (node) {
      notificationTarget = null; node.scrollIntoView({ block: 'center' });
      node.classList.add('search-highlight'); setTimeout(() => node.classList.remove('search-highlight'), 3000);
    }
  }
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
  let receipt: Receipt;
  try {
    if (request.queued) {
      const result = await client.request<{ items: QueueItem[] }>(`/threads/${encodeURIComponent(chatId)}/queue`);
      const exists = result.items.some(item => item.requestId === request.requestId);
      receipt = { requestId: request.requestId, chatId, status: exists ? 'accepted' : 'unknown', error: exists ? null : '电脑队列中尚未找到这条消息，请查询后再处理' };
    } else receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(request.requestId)}`);
  } catch (error) {
    if (!(error instanceof ReachError) || error.status !== 404) throw error;
    if (token !== generation || pending?.requestId !== request.requestId) return;
    pending.status = 'unknown';
    localStorage.setItem(storageKey('pending', chatId), JSON.stringify(pending));
    renderChat();
    return;
  }
  if (token !== generation || pending?.requestId !== request.requestId) return;
  if (receipt.status === 'accepted') {
    if (messageInput.value === request.prompt) {
      messageInput.value = '';
      messageInput.style.height = 'auto';
      localStorage.removeItem(storageKey('draft', chatId));
    }
    if (request.options?.skills?.length) {
      const sent = new Set(request.options.skills.map(skill => skill.path));
      selectedSkills = selectedSkills.filter(skill => !sent.has(skill.path));
      localStorage.setItem(storageKey('skills', chatId), JSON.stringify(selectedSkills));
    }
    if (request.options?.attachments?.length) {
      const sent = new Set(request.options.attachments.map(file => file.path));
      selectedFiles = selectedFiles.filter(file => !sent.has(file.path));
      localStorage.setItem(storageKey('attachments', chatId), JSON.stringify(selectedFiles));
    }
    if (request.options?.threadRefs?.length) {
      const sent = new Set(request.options.threadRefs.map(thread => thread.id));
      selectedThreads = selectedThreads.filter(thread => !sent.has(thread.id));
      localStorage.setItem(storageKey('thread-refs', chatId), JSON.stringify(selectedThreads));
    }
    if (request.annotations?.length) {
      const sent = new Set(request.annotations.map(annotation => JSON.stringify(annotation)));
      selectedAnnotations = selectedAnnotations.filter(annotation => !sent.has(JSON.stringify(annotation)));
      localStorage.setItem(storageKey('annotations', chatId), JSON.stringify(selectedAnnotations));
    }
    if (request.questionReplies?.length) {
      const answered = new Map(questionReplies.map(reply => [reply.questionItemId, reply]));
      for (const reply of request.questionReplies) answered.set(reply.questionItemId, reply);
      questionReplies = [...answered.values()];
      localStorage.setItem(storageKey('question-replies', chatId), JSON.stringify(questionReplies));
      questionDrafts = questionDrafts.filter(draft => !request.questionReplies!.some(reply => reply.questionItemId === draft.questionItemId && reply.answer === draft.answer));
      localStorage.setItem(storageKey('question-drafts', chatId), JSON.stringify(questionDrafts));
    }
    pending = null;
    if (request.queued) { inform('已保存到电脑待发队列'); void refreshQueue(); }
    localStorage.removeItem(storageKey('pending', chatId));
    revision = null;
    syncing = true;
    await refreshHistory(chatId, token);
  } else {
    pending.status = receipt.status;
    pending.error = receipt.error ?? undefined;
    localStorage.setItem(storageKey('pending', chatId), JSON.stringify(pending));
  }
  renderChat();
}

async function refreshQueue(): Promise<void> {
  if (!selected || !client) return;
  const id = selected.id; const token = generation;
  try {
    const result = await client.request<{ items: QueueItem[] }>(`/threads/${encodeURIComponent(id)}/queue`);
    if (token !== generation || selected?.id !== id) return;
    queueItems = result.items; renderChat();
  } catch { /* The queue panel provides its own actionable connection feedback. */ }
}

element('queue-button').addEventListener('click', () => { if (client && selected) openQueue(client, selected.id, selected.cwd, () => void refreshQueue()); });
element('send-mode').addEventListener('change', () => renderChat());

async function sendMessage(): Promise<void> {
  if ((selectedFiles.length && runtimeStatus === null) || (client && selected && uploadCount(client, storageKey('attachments', selected.id)))) return;
  await sendPrompt(messageInput.value, { ...turnOptions, skills: selectedSkills.map(({ name, path }) => ({ name, path })), attachments: selectedFiles, threadRefs: selectedThreads }, undefined, selectedAnnotations, runtimeStatus === 'active' && element<HTMLSelectElement>('send-mode').value === 'queue');
}

async function submitQuestionReplies(replies: QuestionReply[]): Promise<void> {
  if (!selected || pending || interaction || stopOperation || !connected) return;
  const drafts = new Map(questionDrafts.map(reply => [reply.questionItemId, reply]));
  for (const reply of replies) drafts.set(reply.questionItemId, reply);
  questionDrafts = [...drafts.values()];
  localStorage.setItem(storageKey('question-drafts', selected.id), JSON.stringify(questionDrafts));
  const prompt = `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
  await sendPrompt(prompt, turnOptions, replies);
}

async function sendPrompt(prompt: string, options: TurnOptions, replies?: QuestionReply[], annotations: ResponseAnnotation[] = [], queued = false): Promise<void> {
  if (!selected || !client || !connected || pending || stopOperation || interaction || (!prompt.trim() && !options.attachments?.length && !options.skills?.length && !options.threadRefs?.length && !annotations.length)) return;
  const id = selected.id;
  const token = generation;
  const request = { requestId: crypto.randomUUID(), prompt, options, questionReplies: replies, annotations: [...annotations], queued };
  inform();
  pending = request;
  localStorage.setItem(storageKey('pending', id), JSON.stringify(request));
  renderChat();
  try {
    await client.request(`/threads/${encodeURIComponent(id)}/${queued ? 'queue' : 'messages'}`, 'POST', { requestId: request.requestId, prompt: annotationPrompt(request.prompt, request.annotations), ...request.options });
    while (token === generation && pending?.requestId === request.requestId && pending.status !== 'unknown') {
      await checkReceipt(token);
      if (pending) await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (error) {
    if (token !== generation) return;
    if (pending) { pending.status = 'unknown'; pending.error = `投递结果待确认。${errorText(error)}`; }
    localStorage.setItem(storageKey('pending', id), JSON.stringify(pending));
    renderChat();
  }
}

function showFormError(id: string, text = ''): void {
  const node = element(id);
  node.textContent = text;
  node.hidden = !text;
}

function newChatDraft(): NewChatDraft {
  return {
    projectId: element<HTMLSelectElement>('new-chat-project').value || undefined,
    prompt: element<HTMLTextAreaElement>('new-chat-prompt').value,
    ...selectedParameters(newModel, newThinking),
    attachments: readStored<FileAttachment[]>(storageKey('attachments', '__new__')) ?? [],
    skills: newSkills, threadRefs: newThreads,
  };
}

function saveNewChatDraft(): void {
  if (!creation && connection) localStorage.setItem(storageKey('new-chat-draft'), JSON.stringify(newChatDraft()));
  const project = projects.find(item => item.id === element<HTMLSelectElement>('new-chat-project').value);
  element('new-chat-path').textContent = project?.path ?? '由 Codex 创建独立目录';
  renderNewContext();
}

function renderCreation(): void {
  renderNewContext();
  element<HTMLFieldSetElement>('new-chat-fields').disabled = Boolean(creation);
  const awaitingFirstCatalog = newFormLoading && !modelChoices.length;
  newModel.disabled = awaitingFirstCatalog;
  newThinking.disabled = awaitingFirstCatalog || !newModel.value;
  const button = element<HTMLButtonElement>('create-chat-button');
  button.disabled = awaitingFirstCatalog || Boolean(creation) || Boolean(client && uploadCount(client, storageKey('attachments', '__new__')));
  button.textContent = creation?.status === 'unknown' ? '结果待确认' : creation ? '正在创建…' : '创建并发送';
  const catalogStatus = modelChoices.length ? '正在更新模型选项…' : '正在读取模型选项…';
  element('new-chat-status').textContent = newFormLoading ? catalogStatus
    : creation?.status === 'unknown' ? '请先检查会话列表，确认是否已创建。首条消息已保留。'
    : creation ? '正在确认创建结果，返回列表后仍会保留本次请求。' : '';
  element('new-chat-status').hidden = !newFormLoading && !creation;
  element('resolve-create').hidden = creation?.status !== 'unknown';
  showFormError('new-chat-error', creation?.error ?? newFormError);
}

async function openNewChat(): Promise<void> {
  if (!client || !connection) return;
  const serverId = connection.serverId;
  const request = ++dialogRequest;
  creation = readStored<Creation>(storageKey('creation'));
  const draft = creation ?? readStored<NewChatDraft>(storageKey('new-chat-draft')) ?? {
    prompt: '', projectId: projectFilter.value && projectFilter.value !== '__none__' ? projectFilter.value : undefined,
  };
  const projectSelect = element<HTMLSelectElement>('new-chat-project');
  projectSelect.replaceChildren(new Option('无项目', ''));
  projectSelect.setCustomValidity('');
  for (const project of projects) projectSelect.add(new Option(project.name, project.id));
  if (draft.projectId && !projects.some(project => project.id === draft.projectId)) {
    const unavailable = new Option('原项目已不可用', draft.projectId);
    unavailable.disabled = true;
    projectSelect.add(unavailable);
    projectSelect.setCustomValidity('请重新选择可用项目');
  }
  projectSelect.value = draft.projectId ?? '';
  element<HTMLTextAreaElement>('new-chat-prompt').value = draft.prompt;
  newSkills = draft.skills ?? []; newThreads = draft.threadRefs ?? [];
  renderNewContext();
  modelChoices = client.cachedModels();
  newFormLoading = true;
  newFormError = '';
  populateParameters(newModel, newThinking, modelChoices, draft, '使用默认设置');
  const project = projects.find(item => item.id === draft.projectId);
  element('new-chat-path').textContent = project?.path ?? '由 Codex 创建独立目录';
  renderCreation();
  newDialog.showModal();
  try {
    const models = await client.loadModels();
    if (request !== dialogRequest || connection?.serverId !== serverId) return;
    const options = modelChoices.length ? selectedParameters(newModel, newThinking) : draft;
    modelChoices = models;
    populateParameters(newModel, newThinking, modelChoices, options, '使用默认设置');
  } catch (error) {
    if (request === dialogRequest) newFormError = `模型选项读取失败。${errorText(error)}`;
  } finally {
    if (request === dialogRequest) { newFormLoading = false; renderCreation(); }
  }
  if (creation) void pollCreation();
}

async function createChat(): Promise<void> {
  if (!client || !connection || creation || (newFormLoading && !modelChoices.length)) return;
  const draft = newChatDraft();
  if ((!draft.prompt.trim() && !draft.attachments?.length && !draft.skills?.length && !draft.threadRefs?.length) || (client && uploadCount(client, storageKey('attachments', '__new__')))) return;
  const serverId = connection.serverId;
  const request: Creation = { ...draft, requestId: crypto.randomUUID(), status: 'sending' };
  creation = request;
  newFormError = '';
  localStorage.setItem(storageKey('creation'), JSON.stringify(request));
  renderCreation();
  try {
    await client.request<Receipt>('/threads', 'POST', { ...draft, requestId: request.requestId });
  } catch (error) {
    if (connection?.serverId !== serverId || creation?.requestId !== request.requestId) return;
    creation.error = `创建结果待确认。${errorText(error)}`;
    localStorage.setItem(storageKey('creation'), JSON.stringify(creation));
    renderCreation();
  }
  if (connection?.serverId === serverId) void pollCreation();
}

async function resumeCreation(): Promise<void> {
  if (!client || !connection || !foreground) return;
  creation = readStored<Creation>(storageKey('creation'));
  if (creation) await pollCreation();
}

async function pollCreation(): Promise<void> {
  if (!client || !connection || !creation || !foreground) return;
  const requestId = creation.requestId;
  const serverId = connection.serverId;
  const key = `${serverId}:${requestId}`;
  const actionClient = client;
  if (creationPolling?.key === key && creationPolling.client === actionClient) return;
  const owner = { key, client: actionClient };
  creationPolling = owner;
  try {
    while (foreground && client === actionClient && connection?.serverId === serverId && creation?.requestId === requestId) {
      let receipt: Receipt;
      try { receipt = await actionClient.request<Receipt>(`/requests/${encodeURIComponent(requestId)}`); }
      catch (error) {
        if (client !== actionClient || connection?.serverId !== serverId || creation?.requestId !== requestId) return;
        creation.error = errorText(error);
        const missing = error instanceof ReachError && error.status === 404;
        if (missing) creation.status = 'unknown';
        localStorage.setItem(storageKey('creation'), JSON.stringify(creation));
        renderCreation();
        if (missing) return;
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      if (client !== actionClient || connection?.serverId !== serverId || creation?.requestId !== requestId) return;
      if (receipt.status === 'accepted' && receipt.result?.threadId) {
        const threadId = receipt.result.threadId;
        creation = null;
        localStorage.removeItem(storageKey('creation'));
        localStorage.removeItem(storageKey('new-chat-draft'));
        localStorage.removeItem(storageKey('attachments', '__new__'));
        newSkills = []; newThreads = [];
        if (newDialog.open) {
          newDialog.close();
          await openChat(threadId, false);
        } else {
          inform('新会话已创建，可在会话列表中查看。');
          if (currentView === 'inbox') await refreshInbox();
        }
        return;
      }
      creation.status = receipt.status;
      creation.error = receipt.error ?? undefined;
      localStorage.setItem(storageKey('creation'), JSON.stringify(creation));
      renderCreation();
      if (receipt.status === 'unknown') return;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  } finally {
    if (creationPolling === owner) creationPolling = null;
  }
}

async function openParameters(draft = turnOptions): Promise<void> {
  if (!client || !connection || !selected) return;
  const request = ++dialogRequest;
  const optionsClient = client;
  optionsChatId = selected.id;
  const id = optionsChatId;
  const current = () => request === dialogRequest && client === optionsClient && selected?.id === id;
  modelChoices = client.cachedModels();
  const hasLiveSettings = runtimeStatus !== null && liveModel && liveThinking;
  element('options-current').textContent = hasLiveSettings ? `当前会话使用 ${liveModel} · ${liveThinking}` : '正在读取会话参数…';
  showFormError('options-error');
  populateParameters(optionsModel, optionsThinking, modelChoices, draft, '沿用会话设置');
  optionsModel.disabled = !modelChoices.length;
  element<HTMLButtonElement>('save-options').disabled = !modelChoices.length;
  element('options-catalog-status').hidden = false;
  element('options-catalog-status').textContent = modelChoices.length ? '正在更新模型选项…' : '正在读取模型选项…';
  optionsDialog.showModal();
  element('approval-policy-label').hidden = true;
  element('open-approval-chat').hidden = true;
  element('approval-policy-status').textContent = '正在读取审批策略…';
  const policy = element<HTMLSelectElement>('approval-policy');
  policy.dataset.original = ''; policy.replaceChildren();
  void optionsClient.request<{ available: boolean; approvalPolicy: unknown; allowed: unknown[] | null }>(`/threads/${encodeURIComponent(id)}/approval`).then(settings => {
    if (!current()) return;
    if (!settings.available) { element('approval-policy-status').textContent = '桌面加载该对话后可设置审批策略'; element('open-approval-chat').hidden = false; return; }
    const original = typeof settings.approvalPolicy === 'string' ? settings.approvalPolicy : '__custom__';
    const labels: Record<string, string> = { untrusted: '仅信任操作自动执行', 'on-request': '由模型请求审批', never: '不请求审批' };
    for (const [value, label] of Object.entries(labels)) if (!settings.allowed || settings.allowed.includes(value) || value === original) {
      const option = new Option(label, value); option.disabled = Boolean(settings.allowed && !settings.allowed.includes(value)); policy.add(option);
    }
    if (original === '__custom__') policy.add(new Option('当前自定义策略', original));
    policy.value = original; policy.dataset.original = original;
    element('approval-policy-label').hidden = false;
    element('approval-policy-status').textContent = '保存后用于后续轮次，当前轮次与已有审批继续按原设置处理。';
  }).catch(error => { if (current()) element('approval-policy-status').textContent = `审批策略读取失败。${errorText(error)}`; });
  // Loaded sessions already provide these settings in their live snapshot
  if (!hasLiveSettings) void optionsClient.request<TurnOptions>(`/threads/${encodeURIComponent(id)}/settings`).then(settings => {
    if (!current() || (runtimeStatus !== null && liveModel && liveThinking)) return;
    element('options-current').textContent = settings.model ? `当前会话使用 ${settings.model}${settings.thinking ? ` · ${settings.thinking}` : ''}` : '当前会话沿用 Codex 默认设置';
  }).catch(error => {
    if (current() && !(runtimeStatus !== null && liveModel && liveThinking)) element('options-current').textContent = `当前会话参数读取失败。${errorText(error)}`;
  });
  try {
    const models = await optionsClient.loadModels();
    if (!current()) return;
    const options = modelChoices.length ? selectedParameters(optionsModel, optionsThinking) : draft;
    modelChoices = models;
    populateParameters(optionsModel, optionsThinking, modelChoices, options, '沿用会话设置');
    optionsModel.disabled = false;
    element<HTMLButtonElement>('save-options').disabled = false;
  } catch (error) {
    if (current()) showFormError('options-error', errorText(error));
  } finally {
    if (current()) element('options-catalog-status').hidden = true;
  }
}

function clearStopOperation(): void {
  if (selected) localStorage.removeItem(storageKey('stop', selected.id));
  stopOperation = null;
}

function settleStopFromRuntime(): void {
  if (runtimeStatus !== null && stopOperation?.status === 'accepted' && activeTurnId !== stopOperation.expectedTurnId) clearStopOperation();
}

async function checkStopReceipt(token: number): Promise<void> {
  if (!client || !selected || !stopOperation) return;
  const requestId = stopOperation.requestId;
  let receipt: Receipt;
  try { receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(requestId)}`); }
  catch (error) {
    if (token !== generation || stopOperation?.requestId !== requestId) return;
    stopOperation.status = 'unknown';
    stopOperation.error = `停止结果待确认。${errorText(error)}`;
    localStorage.setItem(storageKey('stop', selected.id), JSON.stringify(stopOperation));
    renderChat();
    return;
  }
  if (token !== generation || stopOperation?.requestId !== requestId) return;
  if (receipt.status === 'accepted' && receipt.result?.interruptedTurnId == null) {
    clearStopOperation();
    inform('目标轮次已结束或已切换，请根据当前任务状态操作。');
    revision = null;
    clearRuntimeStatus();
    syncing = true;
  } else {
    stopOperation.status = receipt.status;
    stopOperation.error = receipt.error ?? undefined;
    localStorage.setItem(storageKey('stop', selected.id), JSON.stringify(stopOperation));
    if (receipt.result?.goalPauseError) inform(`轮次已中断，暂停目标时出现问题。${receipt.result.goalPauseError}`);
    settleStopFromRuntime();
  }
  renderChat();
}

async function stopTask(): Promise<void> {
  if (!client || !selected || !activeTurnId || runtimeStatus !== 'active' || stopOperation) return;
  const token = generation;
  const id = selected.id;
  inform();
  stopOperation = { requestId: crypto.randomUUID(), expectedTurnId: activeTurnId, status: 'sending' };
  localStorage.setItem(storageKey('stop', id), JSON.stringify(stopOperation));
  renderChat();
  try { await client.request(`/threads/${encodeURIComponent(id)}/stop`, 'POST', stopOperation); }
  catch (error) {
    if (token !== generation || !stopOperation) return;
    stopOperation.error = `停止结果待确认。${errorText(error)}`;
    localStorage.setItem(storageKey('stop', id), JSON.stringify(stopOperation));
  }
  if (token === generation) await checkStopReceipt(token);
}

function renderReferences(container: HTMLElement, skills: Skill[], refs: ThreadReference[], remove: (kind: 'skill' | 'thread', id: string) => void, disabled = false): void {
  container.hidden = !skills.length && !refs.length;
  container.replaceChildren();
  for (const item of [...skills.map(skill => ({ kind: 'skill' as const, id: skill.path, title: skill.name })),
    ...refs.map(thread => ({ kind: 'thread' as const, id: thread.id, title: thread.title }))]) {
    const group = document.createElement('span'); group.className = 'reference-chip';
    const detail = document.createElement('button'); detail.type = 'button'; detail.className = 'quiet'; detail.textContent = item.title;
    detail.addEventListener('click', () => {
      if (item.kind === 'skill' && client) void openReader(item.id, client);
      else {
        const dialog = document.createElement('dialog'); dialog.className = 'task-dialog';
        const title = document.createElement('h2'); title.textContent = item.title;
        const id = document.createElement('p'); id.textContent = item.id;
        const view = document.createElement('button'); view.className = 'quiet'; view.textContent = '查看引用对话';
        view.addEventListener('click', () => { dialog.close(); newDialog.close(); void openChat(item.id); });
        const close = document.createElement('button'); close.className = 'quiet'; close.textContent = '关闭'; close.addEventListener('click', () => dialog.close());
        dialog.append(title, id, view, close); dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
      }
    });
    const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet'; button.textContent = '×';
    button.setAttribute('aria-label', `移除 ${item.title}`); button.disabled = disabled;
    button.addEventListener('click', () => remove(item.kind, item.id)); group.append(detail, button); container.append(group);
  }
}

function renderSelectedSkills(): void {
  renderReferences(element('selected-skills'), selectedSkills, selectedThreads, (kind, id) => {
    selectedSkills = kind === 'skill' ? selectedSkills.filter(skill => skill.path !== id) : selectedSkills;
    selectedThreads = kind === 'thread' ? selectedThreads.filter(thread => thread.id !== id) : selectedThreads;
    localStorage.setItem(storageKey('skills', selected!.id), JSON.stringify(selectedSkills));
    localStorage.setItem(storageKey('thread-refs', selected!.id), JSON.stringify(selectedThreads));
    renderChat();
  }, Boolean(pending));
}

function renderNewContext(): void {
  renderReferences(element('new-references'), newSkills, newThreads, (kind, id) => {
    newSkills = kind === 'skill' ? newSkills.filter(skill => skill.path !== id) : newSkills;
    newThreads = kind === 'thread' ? newThreads.filter(thread => thread.id !== id) : newThreads;
    saveNewChatDraft();
  }, Boolean(creation));
  const files = readStored<FileAttachment[]>(storageKey('attachments', '__new__')) ?? [];
  renderAttachments(element('new-selected-files'), files, { client, onRemove: creation ? undefined : index => {
    files.splice(index, 1); localStorage.setItem(storageKey('attachments', '__new__'), JSON.stringify(files)); saveNewChatDraft();
  } });
  const uploading = client ? uploadCount(client, storageKey('attachments', '__new__')) : 0;
  element('new-manage-files').hidden = !files.length && !uploading;
  element('new-manage-files').textContent = `附件（${files.length}）${uploading ? ` · ${uploading} 项上传待处理` : ''}`;
  element('new-parameters-button').textContent = newModel.value ? `${newModel.value} · ${newThinking.value}` : '使用默认设置';
}

function openContext(isNew = false, picked: () => void = () => {}): void {
  if (!client || (isNew ? creation : !selected || pending)) return;
  const pickerClient = client;
  const chatId = isNew ? '__new__' : selected!.id;
  const keys = { files: storageKey('attachments', chatId), skills: storageKey('skills', chatId), threads: storageKey('thread-refs', chatId) };
  const projectId = isNew ? element<HTMLSelectElement>('new-chat-project').value || undefined : undefined;
  openContextPicker(client, isNew ? { projectId } : { chatId }, selection => {
    if (selection.kind === 'file') {
      const files = readStored<FileAttachment[]>(keys.files) ?? [];
      if (!files.some(file => file.path === selection.value.path)) files.push(selection.value);
      localStorage.setItem(keys.files, JSON.stringify(files));
    } else if (selection.kind === 'skill') {
      const skills = isNew ? newSkills : readStored<Skill[]>(keys.skills) ?? [];
      if (!skills.some(skill => skill.path === selection.value.path)) skills.push(selection.value);
      if (isNew) newSkills = skills; else localStorage.setItem(keys.skills, JSON.stringify(skills));
    } else {
      const refs = isNew ? newThreads : readStored<ThreadReference[]>(keys.threads) ?? [];
      if (!refs.some(thread => thread.id === selection.value.id)) refs.push(selection.value);
      if (isNew) newThreads = refs; else localStorage.setItem(keys.threads, JSON.stringify(refs));
    }
    if (client !== pickerClient) return;
    picked();
    if (isNew) saveNewChatDraft();
    else if (selected?.id === chatId) {
      selectedFiles = readStored<FileAttachment[]>(keys.files) ?? [];
      selectedSkills = readStored<Skill[]>(keys.skills) ?? [];
      selectedThreads = readStored<ThreadReference[]>(keys.threads) ?? [];
      renderChat();
    }
  });
}

function openEdit(): void {
  if (!selected || !editableTurn || runtimeStatus === 'active' || interaction || pending) return;
  editing = { ...editableTurn, chatId: selected.id };
  element<HTMLTextAreaElement>('edit-prompt').value = localStorage.getItem(storageKey('edit-draft', `${selected.id}:${editableTurn.turnId}`)) ?? editableTurn.prompt;
  showFormError('edit-error', editing.blockedReason);
  element<HTMLButtonElement>('submit-edit').disabled = Boolean(editing.blockedReason);
  editDialog.showModal();
}

function clearInteraction(): void {
  interaction = null;
  if (selected) localStorage.removeItem(storageKey('interaction', selected.id));
}

async function checkInteractionReceipt(token: number): Promise<void> {
  const operation = interaction;
  const id = selected?.id;
  if (!operation || !id || !client) return;
  let receipt: Receipt;
  try { receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(operation.requestId)}`); }
  catch (error) {
    if (token !== generation || interaction?.requestId !== operation.requestId) return;
    if (error instanceof ReachError && error.status === 404) operation.status = 'unknown';
    operation.error = `操作结果待确认。${errorText(error)}`;
    localStorage.setItem(storageKey('interaction', id), JSON.stringify(operation));
    renderChat();
    return;
  }
  if (token !== generation || interaction?.requestId !== operation.requestId) return;
  operation.status = receipt.status;
  operation.error = receipt.error ?? undefined;
  localStorage.setItem(storageKey('interaction', id), JSON.stringify(operation));
  if (receipt.status === 'accepted' && operation.kind === 'edit') {
    clearInteraction();
    localStorage.removeItem(storageKey('edit-draft', `${id}:${operation.turnId}`));
    historyLoaded = false;
    revision = null;
    syncing = true;
    await refreshHistory(id, token);
  }
  renderChat();
}

async function performInteraction(operation: Interaction, body: Record<string, unknown>): Promise<void> {
  if (!selected || !client || interaction || !connected) return;
  const id = selected.id;
  const token = generation;
  interaction = operation;
  inform();
  localStorage.setItem(storageKey('interaction', id), JSON.stringify(operation));
  renderChat();
  try { await client.request(`/threads/${encodeURIComponent(id)}/${operation.kind}`, 'POST', { ...body, requestId: operation.requestId }); }
  catch (error) {
    if (token !== generation || interaction?.requestId !== operation.requestId) return;
    operation.error = `操作结果待确认。${errorText(error)}`;
    localStorage.setItem(storageKey('interaction', id), JSON.stringify(operation));
  }
  while (token === generation && interaction?.requestId === operation.requestId && operation.status === 'sending') {
    await checkInteractionReceipt(token);
    if (interaction?.status === 'sending') await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function submitResponse(request: PendingRequest, response: unknown): Promise<void> {
  if (!liveRequests.some(item => item.id === request.id)) return;
  await performInteraction({ requestId: crypto.randomUUID(), kind: 'respond', approvalRequestId: request.id, status: 'sending' }, { approvalRequestId: request.id, response });
}

async function submitEdit(): Promise<void> {
  const prompt = element<HTMLTextAreaElement>('edit-prompt').value;
  if (!editing || !selected || selected.id !== editing.chatId || !prompt.trim() || interaction || editing.blockedReason) return;
  if (editableTurn?.turnId !== editing.turnId || runtimeStatus === 'active') {
    showFormError('edit-error', '当前轮次已变化，请关闭后重新选择可编辑的消息。');
    return;
  }
  const operation: Interaction = { requestId: crypto.randomUUID(), kind: 'edit', turnId: editing.turnId, prompt, status: 'sending' };
  editDialog.close();
  await performInteraction(operation, { turnId: operation.turnId, prompt });
}

element('connection-form').addEventListener('submit', event => { event.preventDefault(); void connect(); });
element('new-chat-button').addEventListener('click', () => void openNewChat());
element('new-chat-form').addEventListener('submit', event => { event.preventDefault(); void createChat(); });
element('new-chat-project').addEventListener('change', () => {
  element<HTMLSelectElement>('new-chat-project').setCustomValidity('');
  saveNewChatDraft();
});
element('new-chat-prompt').addEventListener('input', () => { saveNewChatDraft(); resizeNewInput(); });
element('new-expand-input').addEventListener('click', () => {
  const button = element('new-expand-input'); const expanded = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(expanded)); button.textContent = expanded ? '收起' : '展开';
  resizeNewInput(); element<HTMLTextAreaElement>('new-chat-prompt').focus({ preventScroll: true });
});
function resizeNewInput(): void {
  const input = element<HTMLTextAreaElement>('new-chat-prompt'); input.style.height = 'auto';
  const limit = element('new-expand-input').getAttribute('aria-expanded') === 'true' ? Math.max(160, (window.visualViewport?.height ?? innerHeight) * .5) : 160;
  input.style.height = `${Math.min(limit, input.scrollHeight)}px`;
}
window.visualViewport?.addEventListener('resize', resizeNewInput);
newModel.addEventListener('change', () => {
  newModel.setCustomValidity('');
  updateThinking(newModel, newThinking, modelChoices);
  saveNewChatDraft();
});
newThinking.addEventListener('change', () => { newThinking.setCustomValidity(''); saveNewChatDraft(); });
element('resolve-create').addEventListener('click', () => {
  creation = null;
  localStorage.removeItem(storageKey('creation'));
  newFormError = '';
  renderCreation();
  saveNewChatDraft();
});
element('parameters-button').addEventListener('click', () => void openParameters());
element('open-approval-chat').addEventListener('click', async () => {
  if (!client || !selected) return;
  const id = selected.id;
  const draft = selectedParameters(optionsModel, optionsThinking);
  const button = element<HTMLButtonElement>('open-approval-chat'); button.disabled = true;
  try {
    await client.request(`/threads/${encodeURIComponent(id)}/open`, 'POST', {});
    if (selected?.id === id && optionsDialog.open) await openParameters(draft);
  } catch (error) { showFormError('options-error', errorText(error)); }
  finally { button.disabled = false; }
});
element('skills-button').addEventListener('click', () => openContext());
element('new-context-button').addEventListener('click', () => openContext(true));
bindMention(messageInput, picked => openContext(false, picked));
bindMention(element<HTMLTextAreaElement>('new-chat-prompt'), picked => openContext(true, picked));
element('new-parameters-button').addEventListener('click', () => element<HTMLDialogElement>('new-parameters-dialog').showModal());
element('chat-menu-button').addEventListener('click', () => {
  if (selected) openThreadMenu(threads.find(thread => thread.id === selected!.id) ?? { ...selected, projectId: null, updatedAt: 0, pinned: selectedPinned });
});
function addFiles(imagesOnly = false): void {
  if (!client || (addingToNew ? creation : !selected || pending)) return;
  const isNew = addingToNew;
  const id = isNew ? '__new__' : selected!.id;
  const key = storageKey('attachments', id);
  const fileClient = client;
  const cwd = isNew ? projects.find(project => project.id === element<HTMLSelectElement>('new-chat-project').value)?.path ?? '' : selected!.cwd;
  openFilePicker(fileClient, cwd, files => {
    const draft = readStored<FileAttachment[]>(key) ?? [];
    const paths = new Set(draft.map(file => file.path));
    draft.push(...files.filter(file => !paths.has(file.path)));
    localStorage.setItem(key, JSON.stringify(draft));
    if (client !== fileClient) return;
    if (isNew) saveNewChatDraft();
    else if (selected?.id === id) { selectedFiles = draft; renderChat(); }
  }, imagesOnly, key);
}
element('files-button').addEventListener('click', () => { addingToNew = false; element<HTMLDialogElement>('add-content-dialog').showModal(); });
element('new-files-button').addEventListener('click', () => { addingToNew = true; element<HTMLDialogElement>('add-content-dialog').showModal(); });
element('add-images').addEventListener('click', () => {
  element<HTMLDialogElement>('add-content-dialog').close();
  addFiles(true);
});
element('add-files').addEventListener('click', () => {
  element<HTMLDialogElement>('add-content-dialog').close();
  addFiles();
});
element('new-manage-files').addEventListener('click', () => {
  const key = storageKey('attachments', '__new__');
  const files = readStored<FileAttachment[]>(key) ?? [];
  openAttachmentManager(files, client, creation ? undefined : index => {
    const latest = (readStored<FileAttachment[]>(key) ?? []).filter(file => file.path !== files[index].path);
    files.splice(index, 1); localStorage.setItem(key, JSON.stringify(latest)); saveNewChatDraft();
  }, key);
});
element('manage-files').addEventListener('click', () => {
  if (!selected) return;
  const id = selected.id;
  const key = storageKey('attachments', id);
  const files = selectedFiles;
  openAttachmentManager(files, client, pending ? undefined : index => {
    const removedPath = files[index].path;
    files.splice(index, 1);
    const latest = (readStored<FileAttachment[]>(key) ?? []).filter(file => file.path !== removedPath);
    localStorage.setItem(key, JSON.stringify(latest));
    if (selected?.id === id) { selectedFiles = latest; renderChat(); }
  }, key);
});
window.addEventListener('reach-uploads', () => {
  if (newDialog.open) { saveNewChatDraft(); renderCreation(); }
  if (!selected) return;
  selectedFiles = readStored<FileAttachment[]>(storageKey('attachments', selected.id)) ?? [];
  renderChat();
});
element('open-attachment-chat').addEventListener('click', async () => {
  if (!client || !selected) return;
  const id = selected.id;
  const token = generation;
  const button = element<HTMLButtonElement>('open-attachment-chat');
  button.disabled = true;
  try {
    await client.request(`/threads/${encodeURIComponent(id)}/open`, 'POST', {});
    if (token === generation) resumeChat();
  } catch (error) { if (token === generation) inform(errorText(error)); }
  finally { if (selected?.id === id) button.disabled = false; }
});
element('edit-form').addEventListener('submit', event => { event.preventDefault(); void submitEdit(); });
element('edit-prompt').addEventListener('input', () => {
  if (editing) localStorage.setItem(storageKey('edit-draft', `${editing.chatId}:${editing.turnId}`), element<HTMLTextAreaElement>('edit-prompt').value);
});
element('resolve-interaction').addEventListener('click', () => { clearInteraction(); renderChat(); });
optionsModel.addEventListener('change', () => {
  optionsModel.setCustomValidity('');
  updateThinking(optionsModel, optionsThinking, modelChoices);
});
optionsThinking.addEventListener('change', () => optionsThinking.setCustomValidity(''));
element('options-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selected || selected.id !== optionsChatId) return;
  const id = selected.id;
  const policy = element<HTMLSelectElement>('approval-policy');
  if (policy.dataset.original && policy.value !== policy.dataset.original && client) {
    const button = element<HTMLButtonElement>('save-options'); button.disabled = true;
    try { await client.request(`/threads/${encodeURIComponent(id)}/approval`, 'POST', { policy: policy.value }); }
    catch (error) { showFormError('options-error', errorText(error)); return; }
    finally { button.disabled = false; }
    if (selected?.id !== id) return;
  }
  turnOptions = selectedParameters(optionsModel, optionsThinking);
  localStorage.setItem(storageKey('options', selected.id), JSON.stringify(turnOptions));
  optionsDialog.close();
  renderChat();
});
stopButton.addEventListener('click', () => void stopTask());
element('resolve-stop').addEventListener('click', () => { clearStopOperation(); void stopTask(); });
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close-dialog]')) {
  button.addEventListener('click', () => element<HTMLDialogElement>(button.dataset.closeDialog!).close());
}
for (const dialog of [newDialog, optionsDialog]) dialog.addEventListener('close', () => { dialogRequest += 1; });
element('settings-button').addEventListener('click', openSettings);
element('notification-settings').addEventListener('click', () => { if (client) openNotificationSettings(client); else inform('连接电脑后可设置任务提醒'); });
document.addEventListener('click', event => {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.dataset.systemBrowser !== undefined || !/^https?:/i.test(link.getAttribute('href') ?? '')) return;
  event.preventDefault();
  void openReader(link.href, client, selected?.cwd).catch(error => inform(errorText(error)));
});
element('chat-settings-button').addEventListener('click', openSettings);
element('cancel-settings').addEventListener('click', closeSettings);
element('back-button').addEventListener('click', backToInbox);
element('reconnect-button').addEventListener('click', () => {
  if (currentView === 'chat') resumeChat();
  else void refreshInbox();
});
element('retry-history').addEventListener('click', () => {
  historyError = '';
  streamError = '';
  historyLoaded = false;
  renderChat();
  resumeChat();
});
projectFilter.addEventListener('change', renderInbox);
searchInput.addEventListener('input', renderInbox);
refreshButton.addEventListener('click', () => void refreshInbox());
let refreshGesture: number | null = null;
element('inbox-view').addEventListener('touchstart', event => {
  refreshGesture = element('inbox-view').scrollTop <= 0 ? event.touches[0].clientY : null;
}, { passive: true });
element('inbox-view').addEventListener('touchend', event => {
  if (refreshGesture !== null && event.changedTouches[0].clientY - refreshGesture > 80 && !refreshButton.disabled) void refreshInbox();
  refreshGesture = null;
}, { passive: true });
element('more-threads').addEventListener('click', async () => {
  if (!client || !nextThreads || moreLoading) return;
  const token = generation;
  const button = element<HTMLButtonElement>('more-threads');
  moreLoading = true;
  button.disabled = true;
  try {
    const page = await client.request<{ threads: Thread[]; nextCursor: string | null }>(`/threads?archived=${archivedList}&cursor=${encodeURIComponent(nextThreads)}`);
    if (token !== generation) return;
    const existing = new Set(threads.map(thread => thread.id));
    threads.push(...page.threads.filter(thread => !existing.has(thread.id)).map(thread => ({ ...thread, pinned: Boolean(thread.pinned) })));
    nextThreads = page.nextCursor;
    renderInbox();
  } catch (error) { if (token === generation) inform(errorText(error)); }
  finally { if (token === generation) { moreLoading = false; button.disabled = !connected; } }
});
async function loadOlderHistory(): Promise<void> {
  if (!client || !selected?.nextCursor || olderLoading || !historyLoaded) return;
  const token = generation;
  const oldHeight = scroll.scrollHeight;
  const oldTop = scroll.scrollTop;
  olderLoading = true;
  renderChat();
  try {
    const page = await client.request<HistoryPage>(`/threads/${encodeURIComponent(selected.id)}/history?cursor=${encodeURIComponent(selected.nextCursor)}`);
    if (token !== generation || !selected) return;
    selected = prependHistory(selected, page);
    historyError = '';
    renderChat();
    scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
    scheduleCache();
  } catch (error) { await reportReadError(error, token, 'history'); }
  finally { if (token === generation) { olderLoading = false; renderChat(); } }
}
olderButton.addEventListener('click', () => void loadOlderHistory());

function openChatSearch(): void {
  if (!selected) return;
  const chatId = selected.id;
  const menu = menuDialog('在对话中查找');
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = '搜索已加载的消息'; input.setAttribute('aria-label', '查找消息');
  const scope = document.createElement('p'); scope.className = 'field-note';
  const results = document.createElement('div');
  const more = document.createElement('button'); more.className = 'quiet'; more.type = 'button'; more.textContent = '继续读取更早消息';
  menu.body.append(input, scope, results, more);
  function search(): void {
    if (selected?.id !== chatId) { menu.dialog.close(); return; }
    results.replaceChildren();
    const query = input.value.trim().toLocaleLowerCase();
    let total = 0; let matches = 0;
    for (const turn of selected.turns) for (const message of turn.messages) {
      total++;
      const text = [message.text, ...(message.responseAnnotations ?? []).flatMap(item => [item.text, item.annotation])].join('\n');
      const position = text.toLocaleLowerCase().indexOf(query);
      if (!query || position < 0) continue;
      matches++;
      const result = document.createElement('button'); result.type = 'button'; result.className = 'quiet search-result';
      result.textContent = `${message.kind === 'user' ? '用户' : message.kind === 'assistant' ? '助手' : '执行过程'} · ${turn.id}\n${text.slice(Math.max(0, position - 35), position + query.length + 100)}`;
      result.addEventListener('click', () => {
        menu.dialog.close();
        const target = renderedMessages.get(`${turn.id}:${message.id}`);
        if (!target) { inform('来源消息已更新，请重新查找'); return; }
        let ancestor: HTMLElement | null = target;
        while (ancestor) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; ancestor = ancestor.parentElement; }
        target.scrollIntoView({ block: 'center' }); target.classList.add('search-highlight');
        setTimeout(() => target.classList.remove('search-highlight'), 3000);
      });
      results.append(result);
    }
    scope.textContent = `已加载 ${selected.turns.length} 轮、${total} 条记录${query ? `，匹配 ${matches} 条` : ''}${selected.hasMore ? '，更早内容尚未搜索' : ''}`;
    more.hidden = !selected.hasMore;
  }
  input.addEventListener('input', search);
  more.addEventListener('click', async () => {
    more.disabled = true; scope.textContent = '正在读取更早内容…';
    await loadOlderHistory();
    if (menu.dialog.open) { search(); more.disabled = false; if (historyError) menu.error.textContent = historyError; }
  });
  search(); input.focus();
}
element('message-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
element('expand-input').addEventListener('click', () => {
  const expanded = element('message-form').classList.toggle('expanded');
  element('expand-input').textContent = expanded ? '收起' : '展开';
  element('expand-input').setAttribute('aria-expanded', String(expanded));
  resizeInput();
  messageInput.focus({ preventScroll: true });
});
function resizeInput(): void {
  messageInput.style.height = 'auto';
  const limit = element('message-form').classList.contains('expanded') ? Math.max(160, (window.visualViewport?.height ?? innerHeight) * .5) : 160;
  messageInput.style.height = `${Math.min(limit, messageInput.scrollHeight)}px`;
}
window.visualViewport?.addEventListener('resize', resizeInput);
scroll.addEventListener('scroll', () => {
  if (currentView === 'chat') {
    followLatest = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 2;
    if (restoringScroll !== null) restoringScroll = scroll.scrollTop;
  }
  updateReadingActions();
}, { passive: true });
new ResizeObserver(updateReadingActions).observe(element('messages'));
element('jump-latest').addEventListener('click', () => { restoringScroll = null; followLatest = true; scroll.scrollTop = scroll.scrollHeight; updateReadingActions(); });
element('jump-requests').addEventListener('click', () => element('requests').scrollIntoView({ block: 'start' }));
messageInput.addEventListener('input', () => {
  if (selected) localStorage.setItem(storageKey('draft', selected.id), messageInput.value);
  resizeInput();
  sendButton.disabled = !connected || Boolean(pending) || Boolean(stopOperation) || Boolean(interaction)
    || (!messageInput.value.trim() && !selectedFiles.length && !selectedSkills.length && !selectedThreads.length && !selectedAnnotations.length) || (Boolean(selectedFiles.length) && runtimeStatus === null)
    || Boolean(client && selected && uploadCount(client, storageKey('attachments', selected.id)));
});
element('resolve-delivery').addEventListener('click', () => {
  if (selected) localStorage.removeItem(storageKey('pending', selected.id));
  pending = null;
  inform();
  renderChat();
});

if (Capacitor.getPlatform() === 'android') {
  void App.addListener('backButton', () => {
    const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
    if (dialog) dialog.close();
    else if (selectionToolbar.dismiss()) return;
    else if (currentView === 'chat') backToInbox();
    else if (currentView === 'connection' && settingsReturnView) closeSettings();
    else void App.minimizeApp();
  });
  void App.addListener('appStateChange', ({ isActive }) => {
    foreground = isActive;
    if (!isActive) selectionToolbar.dismiss();
    stopUpdates();
    if (isActive && currentView === 'chat') resumeChat();
    else if (isActive && currentView === 'inbox') void refreshInbox();
    else if (!isActive) void flushCache();
    if (isActive) void resumeCreation();
  });
}

await cache.open().catch(error => inform(`本地缓存不可用。${errorText(error)}`));
async function openNotification(event: TaskEvent): Promise<void> {
  if (event.serverId && event.serverId !== connection?.serverId) { inform('这条提醒来自另一台电脑，请先连接对应服务'); return; }
  notificationTarget = event;
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  await openChat(event.threadId);
  while (notificationTarget && selected?.id === event.threadId && !selected.turns.some(turn => turn.id === event.turnId) && selected.hasMore && !historyError) {
    const cursor = selected.nextCursor;
    await loadOlderHistory();
    if (cursor === selected.nextCursor) break;
  }
  updateReadingActions();
}
async function refreshDesktopLocale(): Promise<void> {
  const current = client;
  if (!current || !connection) return;
  try {
    const status = await current.request<{ serverId: string; desktopLocale?: string | null }>('/status');
    if (client !== current || status.serverId !== connection.serverId) return;
    connection.desktopLocale = status.desktopLocale;
    localStorage.setItem('codex-reach-connection', JSON.stringify(connection));
    if (selected) renderChat();
  } catch { /* Cached reading remains available while connection recovery runs. */ }
}
await initializeNotifications(event => {
  notificationTarget = event;
  if (applicationReady) void openNotification(event);
}).catch(error => inform(`提醒入口不可用。${errorText(error)}`));
applicationReady = true;
connectButton.disabled = false;
urlInput.value = connection?.url ?? '';
keyInput.value = connection?.key ?? '';
showView('connection');
if (connection) {
  void refreshDesktopLocale();
  if (client) void recoverUploads(client);
  if (client) void connectNotifications(client).catch(error => inform(`提醒连接未启动。${errorText(error)}`));
  const lastChat = localStorage.getItem(storageKey('last-chat'));
  if (notificationTarget) {
    await openNotification(notificationTarget);
    void loadInbox(generation).catch(() => {});
  } else if (lastChat) {
    await openChat(lastChat);
    void loadInbox(generation).catch(() => {});
  } else {
    showView('inbox');
    void refreshInbox();
  }
  void resumeCreation();
}
