import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { renderMarkdown } from './message-content';
import type { ReachClient } from './api';

const nativeReader = registerPlugin<{
  open(options: { url: string; name: string; kind: string; savable: boolean }): Promise<void>;
  image(options: { url: string }): Promise<{ path: string }>;
  save(options: { url: string; name: string }): Promise<{ saved: boolean }>;
}>('ReachReader');
type DocumentInfo = { name: string; size: number; kind: string; prefix: string; relative: string };
const imageCache = new WeakMap<ReachClient, Map<string, Promise<string>>>();

export async function documentInfo(client: ReachClient, path: string, root?: string): Promise<DocumentInfo & { url: string }> {
  const info = await client.request<DocumentInfo>('/files/read', 'POST', { path, root });
  return { ...info, url: `${client.connection.url}${info.prefix}${info.relative.split('/').map(encodeURIComponent).join('/')}` };
}

export async function displayImage(address: string): Promise<string> {
  if (Capacitor.getPlatform() !== 'android' || address.startsWith('data:')) return address;
  const file = await nativeReader.image({ url: address });
  return Capacitor.convertFileSrc(file.path);
}

export async function saveImage(address: string, name: string): Promise<boolean> {
  if (Capacitor.getPlatform() === 'android') return (await nativeReader.save({ url: address, name })).saved;
  const response = await fetch(address, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`图片读取失败，HTTP ${response.status}`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

export function computerImage(client: ReachClient, path: string, refresh = false): Promise<string> {
  let cache = imageCache.get(client);
  if (!cache) { cache = new Map(); imageCache.set(client, cache); }
  if (refresh) cache.delete(path);
  let result = cache.get(path);
  if (!result) {
    result = documentInfo(client, path).then(info => displayImage(info.url)).catch(error => { cache!.delete(path); throw error; });
    cache.set(path, result);
  }
  return result;
}

export function wireReaderLinks(container: ParentNode, client: ReachClient | null, root?: string): void {
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a')) {
    const address = link.getAttribute('href');
    if (!address || address.startsWith('#')) continue;
    link.addEventListener('click', event => { event.preventDefault(); void openReader(address, client, root); });
  }
}

function localPath(address: string, root?: string): string {
  let path = address;
  if (/^file:/i.test(address)) {
    const uri = new URL(address);
    path = uri.hostname ? `//${uri.hostname}${uri.pathname}` : uri.pathname.replace(/^\/([a-z]:)/i, '$1');
  }
  try { path = decodeURI(path); } catch { /* A literal percent can appear in filenames */ }
  if (/^[a-z]:[/\\]/i.test(path) || path.startsWith('/') || path.startsWith('\\\\')) return path;
  return root ? `${root.replace(/[/\\]$/, '')}/${path}` : path;
}

async function textRange(url: string, start: number, end: number): Promise<Uint8Array> {
  const headers = { Range: `bytes=${start}-${end}` };
  if (Capacitor.getPlatform() === 'android') {
    const response = await CapacitorHttp.request({ url, method: 'GET', headers, responseType: 'arraybuffer', disableRedirects: true });
    if (response.status !== 200 && response.status !== 206) throw new Error(`读取失败，HTTP ${response.status}`);
    return Uint8Array.from(atob(response.data as string), value => value.charCodeAt(0));
  }
  const response = await fetch(url, { headers, redirect: 'error', credentials: 'omit' });
  if (!response.ok) throw new Error(`读取失败，HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function openReader(address: string, client: ReachClient | null, root?: string): Promise<void> {
  const web = /^https?:\/\//i.test(address);
  if (web && Capacitor.getPlatform() === 'android') {
    await nativeReader.open({ url: address, name: new URL(address).hostname, kind: 'html', savable: false });
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog reader-dialog';
  const header = document.createElement('div');
  header.className = 'dialog-header';
  const title = document.createElement('h2');
  title.textContent = web ? new URL(address).hostname : address.split(/[/\\]/).at(-1) ?? '阅读文件';
  const button = (text: string, action: () => void) => {
    const result = document.createElement('button');
    result.type = 'button'; result.className = 'quiet'; result.textContent = text;
    result.addEventListener('click', action);
    return result;
  };
  const expand = button('展开', () => { dialog.classList.toggle('reader-full'); expand.textContent = dialog.classList.contains('reader-full') ? '收起' : '展开'; });
  header.append(button('关闭', () => dialog.close()), title, expand);
  let startY = 0;
  header.addEventListener('touchstart', event => { startY = event.touches[0].clientY; }, { passive: true });
  header.addEventListener('touchend', event => {
    const distance = event.changedTouches[0].clientY - startY;
    if (Math.abs(distance) > 40) { dialog.classList.toggle('reader-full', distance < 0); expand.textContent = distance < 0 ? '收起' : '展开'; }
  });
  const status = document.createElement('p');
  status.className = 'field-note'; status.textContent = '正在读取…'; status.setAttribute('role', 'status');
  const body = document.createElement('div');
  body.className = 'reader-body';
  const controls = document.createElement('div'); controls.className = 'reader-controls';
  dialog.append(header, status, controls, body);
  const focused = document.activeElement;
  dialog.addEventListener('close', () => { dialog.remove(); if (focused instanceof HTMLElement) focused.focus({ preventScroll: true }); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();

  async function load(): Promise<void> {
    body.replaceChildren(); controls.replaceChildren(); status.textContent = '正在读取…';
    try {
      if (!web && /^[a-z][a-z\d+.-]*:/i.test(address) && !/^(?:file:|[a-z]:[/\\])/i.test(address)) throw new Error('此链接协议暂不支持应用内阅读');
      if (!web && !client) throw new Error('当前未连接电脑');
      const info = web ? { url: address, name: title.textContent!, size: 0, kind: 'html' }
        : await documentInfo(client!, localPath(address, root), root);
      if (!dialog.open) return;
      title.textContent = info.name;
      if (!web && Capacitor.getPlatform() === 'android' && ['html', 'pdf'].includes(info.kind)) {
        dialog.close();
        await nativeReader.open({ url: info.url, name: info.name, kind: info.kind, savable: true });
        return;
      }
      status.textContent = web ? '' : `${(info.size / 1024).toFixed(1)} KiB`;
      if (!web) controls.append(button('保存到手机', () => {
        if (Capacitor.getPlatform() === 'android') {
          status.textContent = '请选择保存位置…';
          void nativeReader.save({ url: info.url, name: info.name }).then(result => { status.textContent = result.saved ? '已保存到所选位置' : '已取消保存'; })
            .catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
        } else {
          const link = document.createElement('a'); link.href = `${info.url}?download=1`; link.download = info.name; link.click();
        }
      }));
      if (info.kind === 'image') {
        const image = document.createElement('img'); image.className = 'reader-image'; image.alt = info.name;
        image.src = await computerImage(client!, localPath(address, root), true);
        image.addEventListener('error', () => { status.textContent = '图片读取失败'; controls.append(button('重试', () => void load())); });
        body.append(image);
      } else if (info.kind === 'text' || info.kind === 'markdown') {
        const encoding = document.createElement('select'); encoding.setAttribute('aria-label', '文本编码');
        for (const name of ['utf-8', 'gb18030', 'utf-16le']) encoding.add(new Option(name.toUpperCase(), name));
        const positions = [0];
        let page = 0;
        let nextOffset = 0;
        const previous = button('上一段', () => { page--; void read(); });
        const next = button('下一段', () => { positions[++page] = nextOffset; void read(); });
        controls.append(encoding, previous, next);
        encoding.addEventListener('change', () => { page = 0; positions.splice(1); void read(); });
        async function read(): Promise<void> {
          previous.disabled = true; next.disabled = true; status.textContent = '正在读取文本…';
          try {
            let bytes = info.size ? await textRange(info.url, positions[page], Math.min(info.size - 1, positions[page] + 256 * 1024 - 1)) : new Uint8Array();
            if (encoding.value === 'utf-8' && positions[page] + bytes.length < info.size) {
              let boundary = bytes.length - 1;
              while (boundary > 0 && (bytes[boundary] & 0xc0) === 0x80) boundary--;
              const lead = bytes[boundary];
              const length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
              if (bytes.length - boundary < length) bytes = bytes.subarray(0, boundary);
            }
            if (encoding.value === 'gb18030' && positions[page] + bytes.length < info.size) {
              let boundary = 0;
              while (boundary < bytes.length) {
                const length = bytes[boundary] < 0x80 ? 1 : bytes[boundary + 1] >= 0x30 && bytes[boundary + 1] <= 0x39 ? 4 : 2;
                if (boundary + length > bytes.length) { bytes = bytes.subarray(0, boundary); break; }
                boundary += length;
              }
            }
            if (encoding.value === 'utf-16le' && positions[page] + bytes.length < info.size) {
              const last = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
              if (last >= 0xd800 && last <= 0xdbff) bytes = bytes.subarray(0, bytes.length - 2);
            }
            nextOffset = positions[page] + bytes.length;
            const text = new TextDecoder(encoding.value, { fatal: true }).decode(bytes);
            if (info.kind === 'markdown') {
              renderMarkdown(body, text, [], client, () => {}, localPath(address, root).replace(/[/\\][^/\\]+$/, ''));
            } else { const pre = document.createElement('pre'); pre.textContent = text; body.replaceChildren(pre); }
            body.scrollTop = 0;
            status.textContent = info.size > bytes.length ? `第 ${page + 1} 段 · ${positions[page]}–${nextOffset} / ${info.size} 字节` : `${(info.size / 1024).toFixed(1)} KiB`;
            previous.disabled = page === 0; next.disabled = nextOffset >= info.size;
          } catch (error) { status.textContent = `${error instanceof Error ? error.message : error}，可选择其他文本编码或保存文件`; previous.disabled = page === 0; }
        }
        await read();
      } else if (info.kind === 'html' || info.kind === 'pdf') {
        const frame = document.createElement('iframe');
        frame.title = info.name;
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads');
        frame.referrerPolicy = 'no-referrer'; frame.src = info.url;
        body.append(frame);
        if (web) { const external = document.createElement('a'); external.href = address; external.target = '_blank'; external.rel = 'noopener noreferrer'; external.dataset.systemBrowser = ''; external.textContent = '在浏览器打开'; controls.append(external); }
      } else status.textContent = '此格式可保存到手机后打开';
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      controls.append(button('重试', () => void load()));
    }
  }
  await load();
}
