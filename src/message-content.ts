import DOMPurify from 'dompurify';
import { marked, Renderer } from 'marked';
import type { ResponseAnnotation } from './types';
import type { ReachClient } from './api';
import { loadImage, openPreview } from './files';
import { openReader } from './reader';

// Source offsets use rendered UTF-16 text, excluding controls injected by Reach
export function sourceText(node: Node, native = true): string {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll?.('[data-selection-ignore]').forEach(item => item.remove());
  if (native) copy.querySelectorAll?.<HTMLElement>('[data-source-text]').forEach(item => item.replaceWith(item.dataset.sourceText!));
  return copy.textContent ?? '';
}

export function sourceRange(container: HTMLElement, start: number, end: number, native = true): Range | null {
  const atoms: { node: Node; text: string }[] = [];
  function visit(node: Node): void {
    if (node instanceof HTMLElement && node.hasAttribute('data-selection-ignore')) return;
    if (node instanceof HTMLElement && node.dataset.sourceText !== undefined) { atoms.push({ node, text: native ? node.dataset.sourceText : node.textContent ?? '' }); return; }
    if (node instanceof Text) { atoms.push({ node, text: node.data }); return; }
    node.childNodes.forEach(visit);
  }
  visit(container);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const atom of atoms) {
    const limit = offset + atom.text.length;
    if (!started && start < limit) {
      if (atom.node instanceof Text) range.setStart(atom.node, Math.max(0, start - offset));
      else range.setStartBefore(atom.node);
      started = true;
    }
    if (started && end <= limit) {
      if (atom.node instanceof Text) range.setEnd(atom.node, Math.max(0, end - offset));
      else range.setEndAfter(atom.node);
      return range;
    }
    offset = limit;
  }
  return null;
}

export function rangeOffsets(content: HTMLElement, range: Range, native = true): { startOffset: number; endOffset: number } {
  const prefix = document.createRange();
  prefix.selectNodeContents(content);
  prefix.setEnd(range.startContainer, range.startOffset);
  const startOffset = sourceText(prefix.cloneContents(), native).length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return { startOffset, endOffset: sourceText(prefix.cloneContents(), native).length };
}

export async function copyText(text: string, button: HTMLButtonElement): Promise<void> {
  const label = button.textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement('textarea');
      input.value = text;
      input.className = 'attachment-copy-input';
      button.parentElement!.append(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('复制失败');
    }
    button.textContent = '已复制';
  } catch { button.textContent = '复制失败'; }
  setTimeout(() => { button.textContent = label; }, 1600);
}

export function renderMarkdown(container: HTMLElement, body: string, annotations: ResponseAnnotation[],
  client: ReachClient | null, onAnnotation: (annotation: ResponseAnnotation, index: number) => void, root?: string): void {
  const template = document.createElement('template');
  const renderer = new Renderer();
  renderer.code = token => {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = token.text;
    if (token.lang) code.className = `language-${token.lang.split(/\s/)[0]}`;
    pre.append(code);
    return pre.outerHTML;
  };
  template.innerHTML = marked.parse(body, { async: false, renderer });
  // The desktop renderer concatenates block elements without HTML formatting whitespace.
  const blockSpaces = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const formatting: Text[] = [];
  while (blockSpaces.nextNode()) {
    const text = blockSpaces.currentNode as Text;
    if (/^\s+$/.test(text.data) && (text.parentNode === template.content || text.parentElement?.matches('ul,ol,li,blockquote,table,thead,tbody,tfoot,tr'))) formatting.push(text);
  }
  for (const text of formatting) text.remove();
  const imageSources: string[] = [];
  const linkTargets: string[] = [];
  for (const link of template.content.querySelectorAll('a')) {
    linkTargets.push(link.getAttribute('href') ?? '');
    link.setAttribute('href', `https://reach.invalid/link/${linkTargets.length - 1}`);
  }
  for (const picture of template.content.querySelectorAll('img')) {
    imageSources.push(picture.getAttribute('src') ?? '');
    picture.setAttribute('src', `https://reach.invalid/image/${imageSources.length - 1}`);
  }
  template.innerHTML = DOMPurify.sanitize(template.innerHTML, {
    FORBID_TAGS: ['iframe', 'form', 'button', 'input', 'style'], FORBID_ATTR: ['style', 'srcset'], ALLOW_DATA_ATTR: false,
  });
  for (const link of template.content.querySelectorAll('a')) {
    const address = linkTargets[Number(link.getAttribute('href')?.split('/').at(-1))] ?? '';
    link.href = '#';
    link.addEventListener('click', event => { event.preventDefault(); void openReader(address, client, root); });
  }
  // Remove image sources while detached so local paths never become unauthenticated requests
  for (const picture of template.content.querySelectorAll('img')) {
    const index = Number(picture.getAttribute('src')?.split('/').at(-1));
    let address = imageSources[index] ?? '';
    try { address = decodeURI(address); } catch { /* A literal percent is valid in a local filename */ }
    if (root && !/^(?:[a-z]+:|[/\\])/i.test(address)) address = `${root}/${address}`;
    picture.removeAttribute('src');
    picture.referrerPolicy = 'no-referrer';
    picture.loading = 'lazy';
    picture.className = 'answer-image';
    const attachment = /^(?:https?:|data:)/i.test(address)
      ? { name: picture.alt, image: true, directory: false, url: address }
      : { name: picture.alt, image: true, directory: false, path: address.replace(/^file:\/\/\/?/i, '') };
    const wrapper = document.createElement('span');
    wrapper.className = 'answer-image-frame';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'quiet image-retry';
    retry.dataset.selectionIgnore = '';
    retry.textContent = '正在读取图片…';
    retry.disabled = true;
    picture.replaceWith(wrapper);
    wrapper.append(picture, retry);
    const load = async (refresh = false) => {
      retry.hidden = false;
      retry.disabled = true;
      retry.textContent = '正在读取图片…';
      try { picture.src = await loadImage(attachment, client, refresh); }
      catch (error) {
        retry.textContent = `${picture.alt || '图片'} · ${error instanceof Error ? error.message : '读取失败'} · 重试`;
        retry.disabled = false;
      }
    };
    picture.addEventListener('load', () => { retry.hidden = true; });
    picture.addEventListener('error', () => { retry.textContent = `${picture.alt || '图片'}加载失败 · 重试`; retry.disabled = false; retry.hidden = false; });
    picture.tabIndex = 0;
    picture.setAttribute('role', 'button');
    picture.setAttribute('aria-label', `放大 ${picture.alt || '图片'}`);
    picture.addEventListener('click', () => openPreview(attachment, client));
    picture.addEventListener('keydown', event => { if (event.key === 'Enter') openPreview(attachment, client); });
    retry.addEventListener('click', () => void load(true));
    void load();
  }
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    if (text.parentElement?.closest('code, pre, a, button')) continue;
    const pattern = /:codex-annotation\{index="([1-9]\d*)"\}/g;
    const fragment = document.createDocumentFragment();
    let end = 0;
    for (const match of text.data.matchAll(pattern)) {
      const index = Number(match[1]) - 1;
      if (!annotations[index]) continue;
      fragment.append(text.data.slice(end, match.index));
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'annotation-marker';
      marker.textContent = `引用 ${index + 1}`;
      const nativeLabel = ['zh-CN', 'zh-Hans'].includes(client?.connection.desktopLocale ?? '') ? '注释' : 'Annotation';
      marker.dataset.sourceText = `${nativeLabel} ${index + 1}`;
      marker.addEventListener('click', () => onAnnotation(annotations[index], index));
      fragment.append(marker);
      end = match.index! + match[0].length;
    }
    if (end) { fragment.append(text.data.slice(end)); text.replaceWith(fragment); }
  }
  for (const pre of template.content.querySelectorAll('pre')) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'quiet copy-code';
    copy.dataset.selectionIgnore = '';
    copy.textContent = '复制代码';
    const code = pre.textContent ?? '';
    copy.addEventListener('click', () => void copyText(code, copy));
    pre.after(copy);
  }
  container.replaceChildren(template.content);
}
