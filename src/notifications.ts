import { showDialog } from './ui';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ReachClient } from './api';

export type TaskEvent = { id: string; serverId?: string; threadId: string; turnId: string; kind: string; title: string; body: string; requestId?: string | number };
type Settings = { enabled: boolean; completed: boolean; failed: boolean; approval: boolean; question: boolean };
type NativeStatus = { enabled: boolean; permitted: boolean; running: boolean; lastConnectedAt: number; error: string };
const native = registerPlugin<{
  configure(settings: Settings & { url: string; key: string; serverId: string }): Promise<{ enabled: boolean }>;
  status(): Promise<NativeStatus>;
  openSettings(): Promise<void>;
  addListener(event: 'open', callback: (event: TaskEvent) => void): Promise<PluginListenerHandle>;
}>('ReachNotifications');
let generation = 0;
let activeClient: ReachClient | null = null;
let openEvent: (event: TaskEvent) => void = () => {};
const key = (client: ReachClient) => `codex-reach-notifications:${client.connection.serverId}`;
function settings(client: ReachClient): Settings {
  try { return { enabled: false, completed: true, failed: true, approval: true, question: true, ...JSON.parse(localStorage.getItem(key(client)) ?? '{}') }; }
  catch { return { enabled: false, completed: true, failed: true, approval: true, question: true }; }
}

export async function initializeNotifications(open: (event: TaskEvent) => void): Promise<void> {
  openEvent = open;
  if (Capacitor.isNativePlatform()) await native.addListener('open', open);
  else document.addEventListener('visibilitychange', () => {
    generation++;
    if (!document.hidden && activeClient) void connectNotifications(activeClient);
  });
}

export async function connectNotifications(client: ReachClient): Promise<void> {
  activeClient = client;
  const token = ++generation;
  const configuration = settings(client);
  if (Capacitor.isNativePlatform()) {
    const status = await native.status();
    await native.configure({ ...client.connection, ...configuration, enabled: configuration.enabled && status.permitted });
    return;
  }
  if (!configuration.enabled || document.hidden) return;
  const cursorKey = `${key(client)}:cursor`;
  let cursor = Number(localStorage.getItem(cursorKey) ?? '-1');
  while (token === generation && !document.hidden) {
    try {
      const page = await client.request<{ events: TaskEvent[]; cursor: number }>('/events?wait=true&after=' + cursor);
      if (token !== generation || document.hidden) return;
      for (const event of page.events) if (configuration[event.kind as keyof Settings]) showEvent({ ...event, serverId: client.connection.serverId });
      cursor = page.cursor; localStorage.setItem(cursorKey, String(cursor));
    } catch { await new Promise(resolve => setTimeout(resolve, 3000)); }
  }
}

function showEvent(event: TaskEvent): void {
  const container = document.getElementById('task-notices')!;
  if ([...container.children].some(node => (node as HTMLElement).dataset.event === event.id)) return;
  const item = document.createElement('div'); item.className = 'task-notice'; item.dataset.event = event.id;
  const open = document.createElement('button'); open.type = 'button'; open.className = 'quiet'; open.textContent = `${event.title || '未命名对话'} · ${event.body}`;
  open.addEventListener('click', () => { item.remove(); container.hidden = !container.children.length; openEvent(event); });
  const close = document.createElement('button'); close.type = 'button'; close.className = 'quiet'; close.textContent = '×'; close.setAttribute('aria-label', '关闭提醒');
  close.addEventListener('click', () => { item.remove(); container.hidden = !container.children.length; });
  item.append(open, close); container.append(item); container.hidden = false;
}

export function openNotificationSettings(client: ReachClient): void {
  const dialog = document.createElement('dialog'); dialog.className = 'task-dialog';
  dialog.innerHTML = '<div class="dialog-header"><button type="button" class="quiet">返回</button><h2>任务提醒</h2></div><form class="notification-options"><label><input type="checkbox" name="enabled">开启任务提醒</label><label><input type="checkbox" name="completed">任务完成</label><label><input type="checkbox" name="failed">任务失败</label><label><input type="checkbox" name="approval">等待审批</label><label><input type="checkbox" name="question">等待回答</label><p class="field-note notification-scope"></p><p class="field-note notification-status" role="status"></p><button type="button" class="quiet notification-system">系统通知设置</button><p class="form-error" role="alert"></p><button type="submit" class="primary">保存</button></form>';
  const original = settings(client);
  for (const input of dialog.querySelectorAll<HTMLInputElement>('input')) input.checked = original[input.name as keyof Settings];
  const status = dialog.querySelector<HTMLElement>('.notification-status')!;
  const error = dialog.querySelector<HTMLElement>('.form-error')!;
  dialog.querySelector('.notification-scope')!.textContent = Capacitor.isNativePlatform()
    ? '开启后通过常驻通知维持电脑连接。断线期间的提醒在重连后补收。系统省电或主动停止应用期间可能延迟，重新打开后恢复。'
    : '此浏览器页面在前台时接收提醒。Android 应用提供后台接收。';
  const system = dialog.querySelector<HTMLButtonElement>('.notification-system')!;
  system.hidden = !Capacitor.isNativePlatform(); system.addEventListener('click', () => void native.openSettings());
  if (Capacitor.isNativePlatform()) void native.status().then(value => {
    if (!dialog.open) return;
    status.textContent = `${value.permitted ? '通知权限已开启' : '通知权限未开启'} · ${value.running ? '接收服务运行中' : '接收服务已停止'}${value.error ? ` · ${value.error}` : ''}`;
  }).catch(failure => { status.textContent = String(failure); });
  dialog.querySelector('button')!.addEventListener('click', () => dialog.close());
  dialog.querySelector('form')!.addEventListener('submit', async event => {
    event.preventDefault();
    const configuration = Object.fromEntries([...dialog.querySelectorAll<HTMLInputElement>('input')].map(input => [input.name, input.checked])) as Settings;
    const save = dialog.querySelector<HTMLButtonElement>('[type=submit]')!;
    save.disabled = true; error.textContent = '';
    try {
      if (Capacitor.isNativePlatform()) await native.configure({ ...client.connection, ...configuration });
      localStorage.setItem(key(client), JSON.stringify(configuration));
      if (!Capacitor.isNativePlatform()) void connectNotifications(client);
      dialog.close();
    } catch (failure) { error.textContent = failure instanceof Error ? failure.message : String(failure); }
    finally { save.disabled = false; }
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog); showDialog(dialog);
}
