import { showDialog } from './ui';
import type { ReachClient } from './api';
import { uploadFiles, renderUploadTasks } from './uploads';
import { computerImage, displayImage, saveImage, openReader } from './reader';
import './files.css';

export type FileAttachment = { path: string; name: string; directory: boolean; image: boolean; url?: string };
export type MessageAttachment = { path?: string; name: string; directory: boolean; image: boolean; url?: string };
type FileListing = {
  path: string | null;
  parent: string | null;
  entries: { name: string; path: string; directory: boolean; size: number | null }[];
};
type AttachmentOptions = { client?: ReachClient | null; onRemove?: (index: number) => void };
type AttachmentRow = {
  root: HTMLElement;
  attachment: MessageAttachment;
  remove: HTMLButtonElement;
  index: number;
  options: AttachmentOptions;
};

const attachmentRows = new WeakMap<HTMLElement, AttachmentRow[]>();
let pickerDialog: HTMLDialogElement | null = null;
let previewDialog: HTMLDialogElement | null = null;
let nextDialogId = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function button(text: string, className = 'quiet'): HTMLButtonElement {
  const node = element('button', text, className);
  node.type = 'button';
  return node;
}

function createDialog(title: string, className: string): HTMLDialogElement {
  const dialog = element('dialog', '', `task-dialog ${className}`);
  const header = element('div', '', 'dialog-header');
  const close = button('返回');
  close.addEventListener('click', () => dialog.close());
  const heading = element('h2', title);
  heading.id = `files-dialog-title-${++nextDialogId}`;
  dialog.setAttribute('aria-labelledby', heading.id);
  header.append(close, heading);
  dialog.append(header);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  return dialog;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function sizeText(size: number | null): string {
  if (size === null) return '文件';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

export function openFilePicker(client: ReachClient, initialPath: string, onSelect: (files: FileAttachment[]) => void, imagesOnly = false, draftKey = ''): void {
  if (pickerDialog?.open) { pickerDialog.focus(); return; }
  const dialog = createDialog('添加附件', 'files-dialog');
  pickerDialog = dialog;
  dialog.addEventListener('close', () => { if (pickerDialog === dialog) pickerDialog = null; }, { once: true });
  const controls = element('fieldset', '', 'files-controls');
  const pathForm = element('form', '', 'files-path-form');
  const pathLabel = element('label', '电脑路径');
  const pathInput = element('input');
  pathInput.type = 'text';
  pathInput.placeholder = '输入文件或文件夹路径';
  pathInput.autocomplete = 'off';
  pathInput.spellcheck = false;
  pathInput.value = initialPath;
  pathLabel.append(pathInput);
  const pathActions = element('div', '', 'files-path-actions');
  const browseButton = button('打开文件夹');
  browseButton.type = 'submit';
  const selectPath = button('添加路径', 'primary');
  pathActions.append(browseButton, selectPath);
  pathForm.append(pathLabel, pathActions);
  const navigation = element('div', '', 'files-navigation');
  const parent = button('上层');
  const drives = button('盘符');
  const selectFolder = button('选用当前文件夹');
  parent.disabled = true;
  selectFolder.hidden = true;
  navigation.append(parent, drives, selectFolder);
  const entries = element('div', '', 'files-list');
  const uploadLabel = element('label', '从手机上传', 'files-upload');
  const upload = element('input');
  upload.type = 'file';
  upload.multiple = true;
  if (imagesOnly) upload.accept = 'image/*';
  uploadLabel.append(upload);
  uploadLabel.hidden = !draftKey;
  controls.append(pathForm, navigation, entries, uploadLabel);
  const status = element('p', '', 'field-note files-status');
  status.setAttribute('role', 'status');
  const error = element('p', '', 'form-error files-status');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  dialog.append(controls, status, error);
  let listing: FileListing | null = null;
  let busy = false;

  function setBusy(value: boolean, text = ''): void {
    busy = value;
    controls.disabled = value;
    dialog.setAttribute('aria-busy', String(value));
    status.textContent = text;
    status.hidden = !text;
  }

  function showError(text = ''): void { error.textContent = text; error.hidden = !text; }

  async function browse(path: string): Promise<void> {
    if (busy) return;
    setBusy(true, '正在读取文件夹…');
    showError();
    try {
      const result = await client.request<FileListing>(path ? `/files?path=${encodeURIComponent(path)}` : '/files');
      if (!dialog.open) return;
      listing = result;
      pathInput.value = result.path ?? '';
      parent.disabled = result.parent === null;
      drives.disabled = result.path === null;
      selectFolder.hidden = result.path === null;
      entries.replaceChildren();
      for (const entry of result.entries) {
        const row = button('', 'files-entry');
        row.setAttribute('aria-label', `${entry.directory ? '打开文件夹' : '选择文件'} ${entry.name}`);
        row.append(element('span', entry.name, 'files-entry-name'), element('small', entry.directory ? '文件夹' : sizeText(entry.size), 'files-entry-meta'));
        row.addEventListener('click', () => { if (entry.directory) void browse(entry.path); else void select([entry.path]); });
        const item = element('div', '', 'files-entry-row');
        item.append(row);
        if (!entry.directory) {
          const preview = button('阅读', 'quiet');
          preview.setAttribute('aria-label', `阅读 ${entry.name}`);
          preview.addEventListener('click', () => void openReader(entry.path, client, result.path ?? undefined));
          item.append(preview);
        }
        entries.append(item);
      }
      if (!result.entries.length) entries.append(element('p', '此文件夹为空', 'files-empty'));
    } catch (failure) { if (dialog.open) showError(errorText(failure)); }
    finally { if (dialog.open) setBusy(false); }
  }

  async function select(paths: string[]): Promise<void> {
    if (busy) return;
    if (!paths[0]?.trim()) { showError('请输入文件或文件夹路径'); pathInput.focus(); return; }
    setBusy(true, '正在读取附件信息…');
    showError();
    try {
      const result = await client.request<{ attachments: FileAttachment[] }>('/files/resolve', 'POST', { paths });
      if (!dialog.open) return;
      onSelect(result.attachments);
      dialog.close();
    } catch (failure) { if (dialog.open) showError(errorText(failure)); }
    finally { if (dialog.open) setBusy(false); }
  }

  pathForm.addEventListener('submit', event => { event.preventDefault(); void browse(pathInput.value.trim()); });
  selectPath.addEventListener('click', () => void select([pathInput.value.trim()]));
  parent.addEventListener('click', () => { if (listing?.parent !== null && listing?.parent !== undefined) void browse(listing.parent); });
  drives.addEventListener('click', () => void browse(''));
  selectFolder.addEventListener('click', () => { if (listing?.path) void select([listing.path]); });
  upload.addEventListener('change', () => {
    const files = [...upload.files ?? []];
    upload.value = '';
    if (busy || !files.length) return;
    uploadFiles(client, draftKey, files);
    dialog.close();
  });
  showDialog(dialog);
  if (imagesOnly) {
    pathForm.hidden = true;
    navigation.hidden = true;
    entries.hidden = true;
    upload.click();
  } else void browse(initialPath);
}

function safeImageUrl(url: string): string | null {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.href;
  } catch { return null; }
  return null;
}

export async function loadImage(attachment: MessageAttachment, client?: ReachClient | null, refresh = false): Promise<string> {
  const source = attachment.url ? safeImageUrl(attachment.url) : null;
  if (source) return displayImage(source);
  if (attachment.url?.startsWith('sediment://')) throw new Error('此图片仅有桌面媒体标识，当前读取接口尚未支持');
  if (!attachment.path) throw new Error('此图片地址无法预览');
  if (!client) throw new Error('当前未连接电脑');
  return computerImage(client, attachment.path, refresh);
}

export function openPreview(attachment: MessageAttachment, client?: ReachClient | null): void {
  if (attachment.path) { void openReader(attachment.path, client ?? null); return; }
  if (previewDialog?.open) { previewDialog.focus(); return; }
  const dialog = createDialog(attachment.name || '图片预览', 'attachment-preview');
  previewDialog = dialog;
  const status = element('p', '正在读取图片…', 'field-note');
  status.setAttribute('role', 'status');
  const error = element('p', '', 'form-error');
  error.hidden = true;
  const picture = element('img', '', 'attachment-preview-image');
  picture.alt = attachment.name;
  picture.referrerPolicy = 'no-referrer';
  picture.hidden = true;
  const retry = button('重试');
  retry.hidden = true;
  dialog.append(status, error, picture, retry);
  const save = button('保存原图片到手机');
  save.addEventListener('click', async () => {
    save.disabled = true; status.hidden = false; status.textContent = '正在保存…';
    try {
      const address = attachment.url && safeImageUrl(attachment.url);
      if (!address) throw new Error('此图片的原文件地址不可用');
      const name = /\.(?:png|jpe?g|gif|webp|avif)$/i.test(attachment.name) ? attachment.name : 'image.png';
      status.textContent = await saveImage(address, name) ? '已保存到所选位置' : '已取消保存';
    } catch (failure) { status.textContent = errorText(failure); }
    finally { save.disabled = false; }
  });
  dialog.append(save);
  dialog.addEventListener('close', () => {
    picture.removeAttribute('src');
    if (previewDialog === dialog) previewDialog = null;
  }, { once: true });

  function showFailure(text: string): void {
    status.hidden = true;
    picture.hidden = true;
    error.textContent = text;
    error.hidden = false;
    retry.hidden = false;
    retry.disabled = false;
  }

  async function load(): Promise<void> {
    error.hidden = true;
    status.hidden = false;
    picture.hidden = true;
    retry.disabled = true;
    try {
      const source = await loadImage(attachment, client, true);
      if (dialog.open) picture.src = source;
    } catch (failure) { if (dialog.open) showFailure(errorText(failure)); }
  }

  picture.addEventListener('load', () => {
    if (!dialog.open) return;
    status.hidden = true;
    picture.hidden = false;
    retry.hidden = true;
    retry.disabled = false;
  });
  picture.addEventListener('error', () => { if (dialog.open) showFailure('图片无法显示，请重试'); });
  retry.addEventListener('click', () => void load());
  showDialog(dialog);
  void load();
}

async function copyPath(path: string, status: HTMLElement, parent: HTMLElement): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(path);
    else {
      const focused = document.activeElement;
      const input = element('textarea', path, 'attachment-copy-input');
      input.readOnly = true;
      parent.append(input);
      try {
        input.select();
        if (!document.execCommand('copy')) throw new Error('无法写入剪贴板');
      } finally {
        input.remove();
        if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
      }
    }
    status.textContent = '路径已复制';
  } catch { status.textContent = '复制失败，请长按路径复制'; }
  status.hidden = false;
}

function createAttachmentRow(attachment: MessageAttachment, options: AttachmentOptions): AttachmentRow {
  const root = element('div', '', 'attachment-chip');
  const name = button(attachment.name || attachment.path || '附件', attachment.image ? 'attachment-image-button' : 'attachment-name');
  const remove = button('×', 'attachment-remove');
  remove.setAttribute('aria-label', `移除附件 ${attachment.name}`);
  const row: AttachmentRow = { root, attachment, remove, index: 0, options };
  if (attachment.image) {
    name.setAttribute('aria-label', `预览图片 ${attachment.name}`);
    name.addEventListener('click', () => openPreview(row.attachment, row.options.client));
    const thumbnail = element('img', '', 'attachment-thumbnail');
    thumbnail.alt = '';
    thumbnail.loading = 'lazy';
    name.prepend(thumbnail);
    void loadImage(attachment, options.client).then(source => { thumbnail.src = source; }).catch(() => { thumbnail.remove(); });
  } else if (attachment.path && !attachment.directory) name.addEventListener('click', () => void openReader(row.attachment.path!, row.options.client ?? null));
  else name.disabled = true;
  root.append(name);
  if (attachment.path) {
    const path = element('span', attachment.path, 'attachment-path');
    const copy = button('复制路径', 'attachment-copy');
    const status = element('span', '', 'attachment-feedback');
    status.hidden = true;
    status.setAttribute('role', 'status');
    copy.addEventListener('click', () => void copyPath(row.attachment.path!, status, root));
    root.append(path, copy, status);
  }
  remove.addEventListener('click', () => row.options.onRemove?.(row.index));
  root.append(remove);
  return row;
}

export function openAttachmentManager(attachments: FileAttachment[], client: ReachClient | null,
  onRemove?: (index: number) => void, draftKey = ''): void {
  const dialog = createDialog(`附件（${attachments.length}）`, 'attachment-manager');
  const list = element('div');
  const render = () => renderAttachments(list, attachments, { client, onRemove: onRemove ? index => {
    onRemove(index);
    render();
    dialog.querySelector('h2')!.textContent = `附件（${attachments.length}）`;
  } : undefined });
  render();
  dialog.append(list);
  if (client && draftKey) {
    const uploads = element('div');
    const refresh = () => {
      attachments.splice(0, attachments.length, ...JSON.parse(localStorage.getItem(draftKey) ?? '[]') as FileAttachment[]);
      render();
      dialog.querySelector('h2')!.textContent = `附件（${attachments.length}）`;
      renderUploadTasks(uploads, client, draftKey);
    };
    refresh();
    window.addEventListener('reach-uploads', refresh);
    dialog.addEventListener('close', () => window.removeEventListener('reach-uploads', refresh), { once: true });
    dialog.append(uploads);
  }
  showDialog(dialog);
}

export function renderAttachments(container: HTMLElement, attachments: MessageAttachment[], options: AttachmentOptions): void {
  const previous = attachmentRows.get(container) ?? [];
  const rows: AttachmentRow[] = [];
  let position = container.firstElementChild;
  for (const [index, attachment] of attachments.entries()) {
    const existing = previous.find(row => !rows.includes(row) && row.attachment.path === attachment.path
      && row.attachment.url === attachment.url && row.attachment.name === attachment.name
      && row.attachment.image === attachment.image && row.attachment.directory === attachment.directory);
    const row = existing ?? createAttachmentRow(attachment, options);
    row.attachment = attachment;
    row.options = options;
    row.index = index;
    row.remove.hidden = !options.onRemove;
    rows.push(row);
    if (position !== row.root) container.insertBefore(row.root, position);
    position = row.root.nextElementSibling;
  }
  while (position) { const next = position.nextElementSibling; position.remove(); position = next; }
  attachmentRows.set(container, rows);
  container.classList.add('attachments');
  container.hidden = !attachments.length;
}
