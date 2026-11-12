import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { ReachClient, ReachError } from './api';
import { ChatCache } from './cache';
import { mergeHistory, mergeTail, prependHistory } from './sync';
import { groupMessages, groupProcessMessages, type MessageGroup, type ProcessGroup } from './transcript';
import { populateParameters, selectedParameters, updateThinking } from './task-options';
import { renderRequests, renderAsyncQuestions, type PendingRequest } from './requests';
import { openFilePicker, renderAttachments, type FileAttachment } from './files';
import { annotationPrompt, createSelectionToolbar, openAnnotation, renderAnnotations } from './chat-actions';
import type { Connection, EditableTurn, HistoryPage, LiveView, Message, ModelChoice, Project, QuestionReply, Receipt, ResponseAnnotation, Skill, Thread, Turn, TurnOptions } from './types';
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
const skillsDialog = element<HTMLDialogElement>('skills-dialog');
const editDialog = element<HTMLDialogElement>('edit-dialog');
const newModel = element<HTMLSelectElement>('new-chat-model');
const newThinking = element<HTMLSelectElement>('new-chat-thinking');
const optionsModel = element<HTMLSelectElement>('options-model');
const optionsThinking = element<HTMLSelectElement>('options-thinking');
const scroll = element<HTMLDivElement>('messages-scroll');
const cache = new ChatCache();
const renderedMessages = new Map<string, HTMLElement>();
let currentView: typeof views[number] = 'connection';
let settingsReturnView: 'inbox' | 'chat' | null = null;
let settingsScrollTop = 0;
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
const pinIcon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v5"/></svg>';
let dialogRequest = 0;
let newFormLoading = false;
let newFormError = '';
let optionsChatId = '';
let skillsChatId = '';
let skillChoices: Skill[] = [];
let selectedSkills: Skill[] = [];
let selectedFiles: FileAttachment[] = [];
let selectedAnnotations: ResponseAnnotation[] = [];
let skillDraft = new Set<string>();
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
let selected: HistoryPage | null = null;
let revision: string | null = null;
let generation = 0;
let foreground = true;
let liveWaiting = false;
let liveModel = '';
let liveThinking = '';
let pending: { requestId: string; prompt: string; status?: string; error?: string; options?: TurnOptions; questionReplies?: QuestionReply[]; annotations?: ResponseAnnotation[] } | null = null;
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
    const status = await nextClient.request<{ serverId: string }>('/status');
    if (attempt !== connectionAttempt) return;
    candidate.serverId = status.serverId;
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
  const [projectResult, threadResult] = await Promise.all([
    client.request<{ projects: Project[] }>('/projects'),
    client.request<{ threads: Thread[]; nextCursor: string | null }>('/threads'),
  ]);
  if (token !== generation) return;
  projects = projectResult.projects;
  threads = threadResult.threads.map(thread => {
    thread.pinned = Boolean(thread.pinned);
    const current = threads.find(item => item.id === thread.id);
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

function renderPin(button: HTMLButtonElement, id: string): void {
  const pinned = threads.find(item => item.id === id)?.pinned ?? (selected?.id === id ? selectedPinned : undefined);
  const label = pinned === undefined ? '读取置顶状态' : pinned ? '取消置顶' : '置顶对话';
  button.innerHTML = pinIcon;
  button.setAttribute('aria-pressed', String(Boolean(pinned)));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.setAttribute('aria-busy', String(pinRequests.has(id)));
  button.disabled = !connected || pinRequests.has(id);
}

async function togglePin(id: string): Promise<void> {
  if (!client || !connected || pinRequests.has(id)) return;
  const pinned = threads.find(item => item.id === id)?.pinned ?? (selected?.id === id ? selectedPinned : undefined);
  const pinClient = client;
  pinRequests.add(id);
  pinRevisions.set(id, (pinRevisions.get(id) ?? 0) + 1);
  renderInbox();
  if (selected) renderPin(element<HTMLButtonElement>('chat-pin-button'), selected.id);
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
      if (selected) renderPin(element<HTMLButtonElement>('chat-pin-button'), selected.id);
    }
  }
}

function renderInbox(): void {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const projectId = projectFilter.value;
  const visible = threads.filter(thread => (!query || (thread.title || '').toLocaleLowerCase().includes(query))
    && (!projectId || (projectId === '__none__' ? !thread.projectId : thread.projectId === projectId)))
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
  const fragment = document.createDocumentFragment();
  for (const thread of visible) {
    const row = document.createElement('div');
    row.className = 'thread-entry';
    const pin = document.createElement('button');
    pin.className = 'quiet icon-button pin-button';
    pin.type = 'button';
    pin.dataset.pinId = thread.id;
    renderPin(pin, thread.id);
    pin.addEventListener('click', () => void togglePin(thread.id));
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
    const date = new Date(thread.updatedAt * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
    metadata.textContent = [project?.name ?? '无项目', date, stateLabel(thread.status)].filter(Boolean).join(' · ');
    button.append(title, metadata);
    button.addEventListener('click', () => void openChat(thread.id));
    row.append(pin, button);
    fragment.append(row);
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
  if (node.dataset.body !== body) {
    content.hidden = !body;
    if (message.kind === 'user' || message.kind === 'tool') content.textContent = body;
    else content.innerHTML = DOMPurify.sanitize(marked.parse(body, { async: false }), { FORBID_TAGS: ['img', 'iframe', 'form'], FORBID_ATTR: ['style'] });
    node.dataset.body = body;
  }
  const edit = node.querySelector<HTMLButtonElement>('.edit-message');
  renderAnnotations(node.querySelector<HTMLElement>('.message-annotations')!, message.responseAnnotations ?? []);
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
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
  element('chat-title').textContent = selected.title || '未命名对话';
  element('chat-title').title = selected.title || '未命名对话';
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
    || (!messageInput.value.trim() && !selectedFiles.length && !selectedAnnotations.length) || (Boolean(selectedFiles.length) && runtimeStatus === null);
  sendButton.textContent = runtimeStatus === 'active' ? '追加' : '发送';
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
  renderPin(element<HTMLButtonElement>('chat-pin-button'), selected.id);
  element('open-attachment-chat').hidden = !selectedFiles.length || runtimeStatus !== null;
  element<HTMLButtonElement>('open-attachment-chat').disabled = !connected || opening;
  renderAttachments(element('selected-files'), selectedFiles, { client, onRemove: pending ? undefined : index => {
    selectedFiles.splice(index, 1);
    localStorage.setItem(storageKey('attachments', selected!.id), JSON.stringify(selectedFiles));
    renderChat();
  } });
  renderAnnotations(element('selected-annotations'), selectedAnnotations, pending ? undefined : index => {
    selectedAnnotations.splice(index, 1);
    localStorage.setItem(storageKey('annotations', selected!.id), JSON.stringify(selectedAnnotations));
    renderChat();
  }, pending ? undefined : index => {
    const annotation = selectedAnnotations[index];
    const chatId = selected!.id;
    const source = annotation.source!;
    openAnnotation(annotation.text, source.messageId, { startOffset: 0, endOffset: annotation.text.length }, annotation.annotation, replacement => {
      if (selected?.id !== chatId) return;
      replacement.source!.startOffset += source.startOffset;
      replacement.source!.endOffset += source.startOffset;
      selectedAnnotations[index] = replacement;
      localStorage.setItem(storageKey('annotations', chatId), JSON.stringify(selectedAnnotations));
      renderChat();
    });
  });
  renderSelectedSkills();
  element('interaction-note').hidden = !interaction || interaction.kind !== 'edit';
  element('interaction-status').textContent = interaction?.error ?? '正在确认编辑结果…';
  element('resolve-interaction').hidden = interaction?.status !== 'unknown';
  element<HTMLButtonElement>('submit-edit').disabled = Boolean(interaction) || !connected || runtimeStatus === 'active' || Boolean(editing?.blockedReason);
  element('delivery-note').hidden = !pending;
  element('delivery-text').textContent = pending?.status === 'unknown' ? pending.error || '投递结果待确认，请先查看聊天记录。草稿已保留。' : '正在确认投递结果…';
  element('resolve-delivery').hidden = pending?.status !== 'unknown';
  if (forceBottom || atBottom) scroll.scrollTop = scroll.scrollHeight;
  selectionToolbar.refresh();
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
    receipt = await client.request<Receipt>(`/requests/${encodeURIComponent(request.requestId)}`);
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

async function sendMessage(): Promise<void> {
  if (selectedFiles.length && runtimeStatus === null) return;
  await sendPrompt(messageInput.value, { ...turnOptions, skills: selectedSkills.map(({ name, path }) => ({ name, path })), attachments: selectedFiles }, undefined, selectedAnnotations);
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

async function sendPrompt(prompt: string, options: TurnOptions, replies?: QuestionReply[], annotations: ResponseAnnotation[] = []): Promise<void> {
  if (!selected || !client || !connected || pending || stopOperation || interaction || (!prompt.trim() && !options.attachments?.length && !annotations.length)) return;
  const id = selected.id;
  const token = generation;
  const request = { requestId: crypto.randomUUID(), prompt, options, questionReplies: replies, annotations: [...annotations] };
  inform();
  pending = request;
  localStorage.setItem(storageKey('pending', id), JSON.stringify(request));
  renderChat();
  try {
    await client.request(`/threads/${encodeURIComponent(id)}/messages`, 'POST', { requestId: request.requestId, prompt: annotationPrompt(request.prompt, request.annotations), ...request.options });
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
  };
}

function saveNewChatDraft(): void {
  if (!creation && connection) localStorage.setItem(storageKey('new-chat-draft'), JSON.stringify(newChatDraft()));
  const project = projects.find(item => item.id === element<HTMLSelectElement>('new-chat-project').value);
  element('new-chat-path').textContent = project?.path ?? '由 Codex 创建独立目录';
}

function renderCreation(): void {
  element<HTMLFieldSetElement>('new-chat-fields').disabled = Boolean(creation);
  const awaitingFirstCatalog = newFormLoading && !modelChoices.length;
  newModel.disabled = awaitingFirstCatalog;
  newThinking.disabled = awaitingFirstCatalog || !newModel.value;
  const button = element<HTMLButtonElement>('create-chat-button');
  button.disabled = awaitingFirstCatalog || Boolean(creation);
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
  if (!draft.prompt.trim()) return;
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

async function openParameters(): Promise<void> {
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
  populateParameters(optionsModel, optionsThinking, modelChoices, turnOptions, '沿用会话设置');
  optionsModel.disabled = !modelChoices.length;
  element<HTMLButtonElement>('save-options').disabled = !modelChoices.length;
  element('options-catalog-status').hidden = false;
  element('options-catalog-status').textContent = modelChoices.length ? '正在更新模型选项…' : '正在读取模型选项…';
  optionsDialog.showModal();
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
    const options = modelChoices.length ? selectedParameters(optionsModel, optionsThinking) : turnOptions;
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

function renderSelectedSkills(): void {
  const container = element('selected-skills');
  container.hidden = !selectedSkills.length;
  const signature = JSON.stringify([selectedSkills, Boolean(pending)]);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.replaceChildren();
  for (const skill of selectedSkills) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'skill-chip';
    button.textContent = `${skill.name} ×`;
    button.setAttribute('aria-label', `移除 Skill ${skill.name}`);
    button.disabled = Boolean(pending);
    button.addEventListener('click', () => {
      selectedSkills = selectedSkills.filter(item => item.path !== skill.path);
      localStorage.setItem(storageKey('skills', selected!.id), JSON.stringify(selectedSkills));
      renderSelectedSkills();
    });
    container.append(button);
  }
}

function renderSkillChoices(): void {
  const query = element<HTMLInputElement>('skills-search').value.trim().toLocaleLowerCase();
  const list = element('skills-list');
  list.replaceChildren();
  for (const skill of skillChoices.filter(item => `${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(query))) {
    const label = document.createElement('label');
    label.className = 'skill-choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = skill.path;
    checkbox.checked = skillDraft.has(skill.path);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) skillDraft.add(skill.path);
      else skillDraft.delete(skill.path);
    });
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = skill.name;
    const description = document.createElement('span');
    description.className = 'field-note';
    description.textContent = skill.shortDescription || skill.description || skill.path;
    text.append(name, description);
    label.append(checkbox, text);
    list.append(label);
  }
  if (!list.childElementCount) {
    const empty = document.createElement('p');
    empty.className = 'field-note';
    empty.textContent = '没有匹配的 Skill';
    list.append(empty);
  }
}

async function openSkills(): Promise<void> {
  if (!selected || !client || pending) return;
  skillsChatId = selected.id;
  const id = skillsChatId;
  const token = generation;
  skillChoices = [];
  skillDraft = new Set(selectedSkills.map(skill => skill.path));
  element<HTMLInputElement>('skills-search').value = '';
  element('skills-list').replaceChildren();
  element('skills-status').textContent = '正在读取当前项目可用 Skill…';
  element('open-skill-chat').hidden = true;
  element<HTMLButtonElement>('save-skills').disabled = true;
  showFormError('skills-error');
  skillsDialog.showModal();
  try {
    const result = await client.request<{ skills: Skill[]; errors: { message: string }[]; sendingSupported?: boolean }>(`/threads/${encodeURIComponent(id)}/skills`);
    if (token !== generation || selected?.id !== id || !skillsDialog.open) return;
    skillChoices = result.skills;
    renderSkillChoices();
    element('skills-status').textContent = result.sendingSupported === false ? '此对话尚未在电脑端加载，请在电脑上打开后再发送 Skill。' : '所选 Skill 用于下一次发送。';
    element('open-skill-chat').hidden = result.sendingSupported !== false;
    showFormError('skills-error', result.errors.map(error => error.message).join('\n'));
    element<HTMLButtonElement>('save-skills').disabled = false;
  } catch (error) {
    if (token === generation && skillsDialog.open) {
      element('skills-status').textContent = '';
      showFormError('skills-error', errorText(error));
    }
  }
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
element('new-chat-prompt').addEventListener('input', saveNewChatDraft);
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
element('skills-button').addEventListener('click', () => void openSkills());
element('chat-pin-button').addEventListener('click', () => { if (selected) void togglePin(selected.id); });
element('files-button').addEventListener('click', () => {
  if (!client || !selected || pending) return;
  const id = selected.id;
  const fileClient = client;
  openFilePicker(fileClient, selected.cwd, files => {
    if (client !== fileClient || selected?.id !== id || pending) return;
    const paths = new Set(selectedFiles.map(file => file.path));
    selectedFiles.push(...files.filter(file => !paths.has(file.path)));
    localStorage.setItem(storageKey('attachments', id), JSON.stringify(selectedFiles));
    renderChat();
  });
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
element('open-skill-chat').addEventListener('click', async () => {
  if (!selected || !client || selected.id !== skillsChatId) return;
  const id = selected.id;
  const token = generation;
  const button = element<HTMLButtonElement>('open-skill-chat');
  button.disabled = true;
  try {
    await client.request(`/threads/${encodeURIComponent(id)}/open`, 'POST', {});
    if (token !== generation || !skillsDialog.open) return;
    element('skills-status').textContent = '已在电脑端打开，所选 Skill 用于下一次发送。';
    button.hidden = true;
    resumeChat();
  } catch (error) { if (token === generation) showFormError('skills-error', errorText(error)); }
  finally { button.disabled = false; }
});
element('skills-search').addEventListener('input', renderSkillChoices);
element('skills-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!selected || selected.id !== skillsChatId || pending) return;
  selectedSkills = skillChoices.filter(skill => skillDraft.has(skill.path));
  localStorage.setItem(storageKey('skills', selected.id), JSON.stringify(selectedSkills));
  skillsDialog.close();
  renderChat();
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
element('options-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!selected || selected.id !== optionsChatId) return;
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
element('more-threads').addEventListener('click', async () => {
  if (!client || !nextThreads || moreLoading) return;
  const token = generation;
  const button = element<HTMLButtonElement>('more-threads');
  moreLoading = true;
  button.disabled = true;
  try {
    const page = await client.request<{ threads: Thread[]; nextCursor: string | null }>(`/threads?cursor=${encodeURIComponent(nextThreads)}`);
    if (token !== generation) return;
    const existing = new Set(threads.map(thread => thread.id));
    threads.push(...page.threads.filter(thread => !existing.has(thread.id)).map(thread => ({ ...thread, pinned: Boolean(thread.pinned) })));
    nextThreads = page.nextCursor;
    renderInbox();
  } catch (error) { if (token === generation) inform(errorText(error)); }
  finally { if (token === generation) { moreLoading = false; button.disabled = !connected; } }
});
olderButton.addEventListener('click', async () => {
  if (!client || !selected?.nextCursor || olderLoading || syncing) return;
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
  } catch (error) { await reportReadError(error, token, 'history'); }
  finally { if (token === generation) { olderLoading = false; renderChat(); } }
});
element('message-form').addEventListener('submit', event => { event.preventDefault(); void sendMessage(); });
messageInput.addEventListener('input', () => {
  if (selected) localStorage.setItem(storageKey('draft', selected.id), messageInput.value);
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(160, messageInput.scrollHeight)}px`;
  sendButton.disabled = !connected || Boolean(pending) || Boolean(stopOperation) || Boolean(interaction)
    || (!messageInput.value.trim() && !selectedFiles.length && !selectedAnnotations.length) || (Boolean(selectedFiles.length) && runtimeStatus === null);
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
connectButton.disabled = false;
urlInput.value = connection?.url ?? '';
keyInput.value = connection?.key ?? '';
showView('connection');
if (connection) {
  const lastChat = localStorage.getItem(storageKey('last-chat'));
  if (lastChat) {
    await openChat(lastChat);
    void loadInbox(generation).catch(() => {});
  } else {
    showView('inbox');
    void refreshInbox();
  }
  void resumeCreation();
}
