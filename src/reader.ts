import { showDialog, setIcon } from './ui';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { renderMarkdown } from './message-content';
import type { ReachClient } from './api';
import { readerPath, type ReaderReference } from './reader-path';

const nativeReader = registerPlugin<{
  open(options: { url: string; name: string; kind: string; savable: boolean }): Promise<void>;
  image(options: { url: string }): Promise<{ path: string }>;
  save(options: { url: string; name: string }): Promise<{ saved: boolean }>;
}>('ReachReader');
type DocumentInfo = { name: string; size: number; kind: string; prefix: string; relative: string };
const imageCache = new WeakMap<ReachClient, Map<string, Promise<string>>>();
const remoteImageCache = new Map<string, Promise<string>>();

export async function documentInfo(client: ReachClient, path: string, root?: string): Promise<DocumentInfo & { url: string }> {
  const info = await client.request<DocumentInfo>('/files/read', 'POST', { path, root });
  return { ...info, url: `${client.connection.url}${info.prefix}${info.relative.split('/').map(encodeURIComponent).join('/')}` };
}

export async function displayImage(address: string, refresh = false): Promise<string> {
  if (Capacitor.getPlatform() !== 'android' || address.startsWith('data:')) return address;
  if (refresh) remoteImageCache.delete(address);
  let image = remoteImageCache.get(address);
  if (!image) {
    image = nativeReader.image({ url: address }).then(file => Capacitor.convertFileSrc(file.path))
      .catch(error => { remoteImageCache.delete(address); throw error; });
    remoteImageCache.set(address, image);
  }
  return image;
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
    result = documentInfo(client, path).then(info => displayImage(info.url, refresh)).catch(error => { cache!.delete(path); throw error; });
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

export async function openReader(reference: ReaderReference, client: ReachClient | null, root?: string): Promise<void> {
  const address = typeof reference === 'string' ? reference : reference.path;
  const web = typeof reference === 'string' && /^https?:\/\//i.test(address);
  const target = web ? null : readerPath(reference, root);
  if (web && Capacitor.getPlatform() === 'android') {
    await nativeReader.open({ url: address, name: new URL(address).hostname, kind: 'html', savable: false });
    return;
  }
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog reader-dialog';
  const header = document.createElement('div');
  header.className = 'dialog-header';
  const title = document.createElement('h2');
  title.textContent = web ? new URL(address).hostname : target!.path.split(/[/\\]/).at(-1) ?? '阅读文件';
  const button = (text: string, action: () => void) => {
    const result = document.createElement('button');
    result.type = 'button'; result.className = 'quiet'; result.textContent = text;
    result.addEventListener('click', action);
    return result;
  };
  const expand = button('展开', () => {
    const expanded = dialog.classList.toggle('reader-full');
    setIcon(expand, expanded ? 'collapse' : 'expand', expanded ? '收起阅读面板' : '展开阅读面板');
  });
  setIcon(expand, 'expand', '展开阅读面板');
  const more = button('阅读操作', () => showControls(Boolean(controls.hidden)));
  setIcon(more, 'more', '阅读操作');
  more.setAttribute('aria-expanded', 'false');
  header.append(button('关闭', () => dialog.close()), title, more, expand);
  let startY = 0;
  header.addEventListener('touchstart', event => { startY = event.touches[0].clientY; }, { passive: true });
  header.addEventListener('touchend', event => {
    const distance = event.changedTouches[0].clientY - startY;
    if (Math.abs(distance) > 40) {
      dialog.classList.toggle('reader-full', distance < 0);
      setIcon(expand, distance < 0 ? 'collapse' : 'expand', distance < 0 ? '收起阅读面板' : '展开阅读面板');
    }
  });
  const status = document.createElement('p');
  status.className = 'field-note'; status.textContent = '正在读取…'; status.setAttribute('role', 'status');
  const body = document.createElement('div');
  body.className = 'reader-body';
  const controls = document.createElement('div'); controls.className = 'reader-controls'; controls.hidden = true;
  function showControls(visible = true): void {
    controls.hidden = !visible;
    more.setAttribute('aria-expanded', String(visible));
  }
  const navigation = document.createElement('div'); navigation.className = 'reader-navigation'; navigation.hidden = true;
  dialog.append(header, controls, status, body, navigation);
  const focused = document.activeElement;
  dialog.addEventListener('close', () => { dialog.remove(); if (focused instanceof HTMLElement) focused.focus({ preventScroll: true }); }, { once: true });
  document.body.append(dialog);
  showDialog(dialog);

  let loadVersion = 0;
  async function load(refresh = false): Promise<void> {
    const version = ++loadVersion;
    const current = () => dialog.open && version === loadVersion;
    body.replaceChildren(); controls.replaceChildren(); navigation.replaceChildren(); navigation.hidden = true;
    status.hidden = false; status.textContent = '正在读取…';
    try {
      if (!web && /^[a-z][a-z\d+.-]*:/i.test(address) && !/^(?:file:|[a-z]:[/\\])/i.test(address)) throw new Error('此链接协议暂不支持应用内阅读');
      if (!web && !client) throw new Error('当前未连接电脑');
      const cached = !refresh && client && target ? imageCache.get(client)?.get(target.path) : undefined;
      const info = web ? { url: address, name: title.textContent!, size: 0, kind: 'html' }
        : cached ? { url: '', name: title.textContent!, size: 0, kind: 'image' }
          : await documentInfo(client!, target!.path, root);
      if (!current()) return;
      title.textContent = info.name;
      if (!web && Capacitor.getPlatform() === 'android' && ['html', 'pdf'].includes(info.kind)) {
        dialog.close();
        await nativeReader.open({ url: info.url, name: info.name, kind: info.kind, savable: true });
        return;
      }
      status.hidden = true;
      controls.append(button('重新读取', () => void load(true)));
      if (target) {
        const path = document.createElement('p'); path.className = 'reader-path'; path.textContent = target.path; controls.append(path);
        controls.append(button('复制路径', async () => {
          status.hidden = false;
          try { await navigator.clipboard.writeText(target.path); status.textContent = '路径已复制'; }
          catch { status.textContent = '复制失败，可长按路径复制'; }
        }));
      }
      if (!web) controls.append(button('保存到手机', () => {
        status.hidden = false; status.textContent = '请选择保存位置…';
        void (async () => {
          const url = info.url || (await documentInfo(client!, target!.path, root)).url;
          if (Capacitor.getPlatform() === 'android') {
            const result = await nativeReader.save({ url, name: info.name });
            status.textContent = result.saved ? '已保存到所选位置' : '已取消保存';
          } else {
            const link = document.createElement('a'); link.href = `${url}?download=1`; link.download = info.name; link.click();
            status.hidden = true;
          }
        })().catch(error => { status.textContent = error instanceof Error ? error.message : String(error); });
      }));
      if (info.kind === 'image') {
        const image = document.createElement('img'); image.className = 'reader-image'; image.alt = info.name;
        image.src = await (cached || computerImage(client!, target!.path, refresh));
        if (!current()) return;
        image.addEventListener('error', () => { if (current()) { status.hidden = false; status.textContent = '图片读取失败'; showControls(); } });
        body.append(image);
      } else if (info.kind === 'text' || info.kind === 'markdown') {
        const encoding = document.createElement('select'); encoding.setAttribute('aria-label', '文本编码');
        for (const name of ['utf-8', 'gb18030', 'utf-16le']) encoding.add(new Option(name.toUpperCase(), name));
        const positions = [0];
        const lineStarts = [1];
        let page = 0;
        let nextOffset = 0;
        let readVersion = 0;
        const previous = button('上一段', () => { page--; void read(); });
        const next = button('下一段', () => { positions[++page] = nextOffset; void read(); });
        controls.append(encoding);
        navigation.append(previous, next);
        encoding.addEventListener('change', () => { page = 0; positions.splice(1); lineStarts.splice(1); void read(true); });
        async function read(locate = false): Promise<void> {
          const reading = ++readVersion;
          const offset = positions[page];
          const textEncoding = encoding.value;
          const currentRead = () => current() && reading === readVersion;
          previous.disabled = true; next.disabled = true; status.hidden = false; status.textContent = '正在读取文本…';
          try {
            let bytes = info.size ? await textRange(info.url, offset, Math.min(info.size - 1, offset + 256 * 1024 - 1)) : new Uint8Array();
            if (!currentRead()) return;
            if (textEncoding === 'utf-8' && offset + bytes.length < info.size) {
              let boundary = bytes.length - 1;
              while (boundary > 0 && (bytes[boundary] & 0xc0) === 0x80) boundary--;
              const lead = bytes[boundary];
              const length = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
              if (bytes.length - boundary < length) bytes = bytes.subarray(0, boundary);
            }
            if (textEncoding === 'gb18030' && offset + bytes.length < info.size) {
              let boundary = 0;
              while (boundary < bytes.length) {
                const length = bytes[boundary] < 0x80 ? 1 : bytes[boundary + 1] >= 0x30 && bytes[boundary + 1] <= 0x39 ? 4 : 2;
                if (boundary + length > bytes.length) { bytes = bytes.subarray(0, boundary); break; }
                boundary += length;
              }
            }
            if (textEncoding === 'utf-16le' && offset + bytes.length < info.size) {
              const last = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8);
              if (last >= 0xd800 && last <= 0xdbff) bytes = bytes.subarray(0, bytes.length - 2);
            }
            if (offset + bytes.length < info.size) {
              // Keep page boundaries at a complete line when the chunk contains one
              const unit = textEncoding === 'utf-16le' ? 2 : 1;
              for (let index = bytes.length - unit; index >= 0; index -= unit) {
                if (bytes[index] === 10 && (unit === 1 || bytes[index + 1] === 0)) { bytes = bytes.subarray(0, index + unit); break; }
              }
            }
            nextOffset = offset + bytes.length;
            const text = new TextDecoder(textEncoding, { fatal: true }).decode(bytes);
            const lines = text.split('\n');
            lineStarts[page + 1] = lineStarts[page] + lines.length - 1;
            if (locate && target?.line && nextOffset < info.size
              && (target.line > lineStarts[page + 1] || (target.line === lineStarts[page + 1] && text.endsWith('\n')))) {
              positions[++page] = nextOffset; await read(true); return;
            }
            if (text.endsWith('\n') && nextOffset < info.size) lines.pop();
            if (info.kind === 'markdown' && !target?.line) {
              renderMarkdown(body, text, [], client, () => {}, target!.path.replace(/[/\\][^/\\]+$/, ''));
            } else {
              const pre = document.createElement('pre'); pre.className = 'reader-source';
              lines.forEach((line, index) => {
                const row = document.createElement('span'); row.dataset.line = String(lineStarts[page] + index);
                row.className = 'reader-line'; row.textContent = line || ' ';
                row.classList.toggle('reader-line-selected', Number(row.dataset.line) === target?.line);
                pre.append(row);
              });
              body.replaceChildren(pre);
            }
            body.scrollTop = 0;
            status.textContent = info.size > bytes.length ? `第 ${page + 1} 段 · ${positions[page]}–${nextOffset} / ${info.size} 字节` : `${(info.size / 1024).toFixed(1)} KiB`;
            status.hidden = info.size <= bytes.length;
            navigation.hidden = page === 0 && nextOffset >= info.size;
            const selectedLine = body.querySelector<HTMLElement>('.reader-line-selected');
            if (selectedLine) body.scrollTop = selectedLine.offsetTop - body.offsetTop - 32;
            if (target?.line && (locate || selectedLine)) { status.hidden = false; status.textContent = selectedLine ? `第 ${target.line} 行` : `文件只有 ${lineStarts[page + 1]} 行，无法定位第 ${target.line} 行`; }
            previous.disabled = page === 0; next.disabled = nextOffset >= info.size;
          } catch (error) {
            if (!currentRead()) return;
            status.hidden = false; showControls(); status.textContent = `${error instanceof Error ? error.message : error}，可选择其他文本编码或保存文件`; previous.disabled = page === 0;
          }
        }
        await read(true);
      } else if (info.kind === 'html' || info.kind === 'pdf') {
        const frame = document.createElement('iframe');
        frame.title = info.name;
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads');
        frame.referrerPolicy = 'no-referrer'; frame.src = info.url;
        body.append(frame);
        if (web) { const external = document.createElement('a'); external.href = address; external.target = '_blank'; external.rel = 'noopener noreferrer'; external.dataset.systemBrowser = ''; external.textContent = '在浏览器打开'; controls.append(external); }
      } else { status.hidden = false; showControls(); status.textContent = '此格式可保存到手机后打开'; }
    } catch (error) {
      if (!current()) return;
      status.hidden = false; showControls();
      status.textContent = error instanceof Error ? error.message : String(error);
      controls.append(button('重试', () => void load(true)));
    }
  }
  await load();
}
