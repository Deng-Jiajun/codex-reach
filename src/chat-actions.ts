import { showDialog } from './ui';
import type { ResponseAnnotation } from './types';
import { sourceText, rangeOffsets } from './message-content';

export type TextSelection = { startOffset: number; endOffset: number; text?: string };

export function selectedMessageText(content: HTMLElement): TextSelection | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0).cloneRange();
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const startMarker = startElement?.closest('[data-source-text]');
  const endMarker = endElement?.closest('[data-source-text]');
  if (startMarker) range.setStartBefore(startMarker);
  if (endMarker) range.setEndAfter(endMarker);
  const visible = range.cloneContents();
  visible.querySelectorAll('[data-selection-ignore]').forEach(item => item.remove());
  return { ...rangeOffsets(content, range), text: visible.textContent ?? '' };
}

export function createSelectionToolbar(root: HTMLElement,
  onAdd: (text: string, messageId: string, selection: TextSelection) => void) {
  const toolbar = document.createElement('div');
  toolbar.id = 'selection-toolbar';
  toolbar.className = 'selection-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '选中文字操作');
  toolbar.hidden = true;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '添加到对话';
  toolbar.append(button);
  document.body.append(toolbar);
  let current: { text: string; messageId: string; selection: TextSelection } | null = null;
  let frame = 0;
  const hide = () => { toolbar.hidden = true; current = null; };
  const dismiss = () => {
    const selection = window.getSelection();
    const inside = Boolean(selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer));
    const visible = !toolbar.hidden;
    hide();
    if (inside) selection!.removeAllRanges();
    return inside || visible;
  };
  const update = () => {
    frame = 0;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || document.querySelector('dialog[open]')) { hide(); return; }
    const range = selection.getRangeAt(0);
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const content = start?.closest<HTMLElement>('.message.assistant .message-content');
    const offsets = content && root.contains(content) ? selectedMessageText(content) : undefined;
    if (!content || !offsets || !selection.toString().trim()) { hide(); return; }
    const viewport = window.visualViewport;
    const scroll = root.closest<HTMLElement>('.messages-scroll')!.getBoundingClientRect();
    const leftBound = Math.max(viewport?.offsetLeft ?? 0, scroll.left) + 8;
    const rightBound = Math.min((viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth), scroll.right) - 8;
    const topBound = Math.max(viewport?.offsetTop ?? 0, scroll.top) + 8;
    const viewportBottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight);
    const readingBottom = Math.min(viewportBottom, scroll.bottom) - 8;
    const bottomInset = parseFloat(getComputedStyle(document.body).paddingBottom);
    const bottomBound = Math.min(viewportBottom, innerHeight - bottomInset) - 8;
    const anchor = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0
      && rect.bottom > topBound - 8 && rect.top < readingBottom + 8 && rect.right > leftBound && rect.left < rightBound);
    if (!anchor || rightBound <= leftBound || bottomBound <= topBound) { hide(); return; }
    toolbar.style.maxWidth = `${rightBound - leftBound}px`;
    toolbar.hidden = false;
    const { width, height } = toolbar.getBoundingClientRect();
    if (height > bottomBound - topBound) { hide(); return; }
    const above = anchor.top - height - 8;
    const below = anchor.bottom + 8;
    // Leave room above the selection for the native touch selection actions
    const preferBelow = matchMedia('(pointer: coarse)').matches;
    const positions = preferBelow ? [below, above] : [above, below];
    const top = positions.find(top => top >= topBound && top + height <= readingBottom)
      ?? positions.find(top => top >= topBound && top + height <= bottomBound) ?? positions[0];
    toolbar.style.left = `${Math.max(leftBound, Math.min(rightBound - width, (anchor.left + anchor.right - width) / 2))}px`;
    toolbar.style.top = `${Math.max(topBound, Math.min(bottomBound - height, top))}px`;
    current = { text: sourceText(content), messageId: content.closest<HTMLElement>('.message')!.dataset.messageId!, selection: offsets };
  };
  const refresh = () => { if (!frame) frame = requestAnimationFrame(update); };
  toolbar.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!current) return;
    const source = current;
    dismiss();
    onAdd(source.text, source.messageId, source.selection);
  });
  document.addEventListener('selectionchange', refresh);
  document.addEventListener('pointerdown', event => {
    if (event.target instanceof Node && !root.contains(event.target) && !toolbar.contains(event.target)) dismiss();
  });
  document.addEventListener('focusin', event => {
    if (event.target instanceof Node && !root.contains(event.target) && !toolbar.contains(event.target)) dismiss();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !toolbar.hidden) { dismiss(); event.preventDefault(); }
  });
  root.closest('.messages-scroll')!.addEventListener('scroll', refresh, { passive: true, capture: true });
  root.addEventListener('toggle', refresh, true);
  window.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('resize', refresh);
  window.visualViewport?.addEventListener('scroll', refresh);
  return { dismiss, refresh, setDisabled: (disabled: boolean) => { button.disabled = disabled; } };
}

export function annotationPrompt(prompt: string, annotations: ResponseAnnotation[]): string {
  if (!annotations.length) return prompt;
  return `\n# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment.\n<response-annotations>\n${JSON.stringify(annotations)}\n</response-annotations>\n\n## My request:\n${prompt}`;
}

export function openAnnotationDetail(annotation: ResponseAnnotation, index: number,
  onSource: (annotation: ResponseAnnotation) => Promise<void>): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog annotation-detail';
  const header = document.createElement('div');
  header.className = 'dialog-header';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'quiet';
  close.textContent = '返回';
  close.addEventListener('click', () => dialog.close());
  const title = document.createElement('h2');
  title.textContent = `引用 ${index + 1}`;
  header.append(close, title);
  const body = document.createElement('div');
  renderAnnotations(body, [annotation], undefined, undefined, onSource, index);
  body.querySelector('details')!.open = true;
  dialog.append(header, body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  showDialog(dialog);
}

export function openAnnotation(text: string, messageId: string, selection: TextSelection | undefined,
  comment: string, onAdd: (annotation: ResponseAnnotation) => void, selectionLocked = false): void {
  const dialog = document.createElement('dialog');
  dialog.className = 'task-dialog annotation-dialog';
  dialog.id = 'annotation-dialog';
  dialog.innerHTML = `<div class="dialog-header"><button class="quiet" type="button" data-back>返回</button><h2>添加到对话</h2></div>
    <details class="annotation-source"><summary>选择回答片段</summary><label>选中要讨论的文字<textarea rows="6" readonly data-source-text></textarea></label></details>
    <blockquote class="annotation-excerpt" data-excerpt hidden></blockquote>
    <label>你的意见<textarea rows="3" data-comment placeholder="对这段话有什么意见？（可选）"></textarea></label>
    <button class="primary" type="button" data-add disabled>添加到对话</button>`;
  const input = dialog.querySelector<HTMLTextAreaElement>('[data-source-text]')!;
  const opinion = dialog.querySelector<HTMLTextAreaElement>('[data-comment]')!;
  const excerpt = dialog.querySelector<HTMLElement>('[data-excerpt]')!;
  const add = dialog.querySelector<HTMLButtonElement>('[data-add]')!;
  const source = dialog.querySelector<HTMLDetailsElement>('.annotation-source')!;
  input.value = text;
  opinion.value = comment;
  source.open = !selection;
  source.hidden = selectionLocked;
  if (selectionLocked) {
    const status = document.createElement('p');
    status.className = 'field-note'; status.textContent = '来源暂不可读，已有摘录保留，可修改意见';
    source.after(status);
  }
  let chosen = selection;
  const update = () => {
    const selectedText = chosen ? chosen.text ?? text.slice(chosen.startOffset, chosen.endOffset) : '';
    excerpt.textContent = selectedText;
    excerpt.hidden = !selectedText || source.open;
    add.disabled = !selectedText.trim();
  };
  input.addEventListener('select', () => {
    if (chosen?.startOffset === input.selectionStart && chosen?.endOffset === input.selectionEnd) return;
    chosen = { startOffset: input.selectionStart, endOffset: input.selectionEnd };
    update();
  });
  source.addEventListener('toggle', update);
  dialog.querySelector('[data-back]')!.addEventListener('click', () => dialog.close());
  add.addEventListener('click', () => {
    if (!chosen || add.disabled) return;
    onAdd({ text: chosen.text ?? text.slice(chosen.startOffset, chosen.endOffset), annotation: opinion.value.trim(),
      source: { messageId, startOffset: chosen.startOffset, endOffset: chosen.endOffset,
        contentOffsets: { startOffset: chosen.startOffset, endOffset: chosen.endOffset } } });
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  showDialog(dialog);
  if (source.open) input.focus();
  else opinion.focus();
  input.setSelectionRange(selection?.startOffset ?? 0, selection?.endOffset ?? 0);
  update();
}

export function renderAnnotations(container: HTMLElement, annotations: ResponseAnnotation[],
  onRemove?: (index: number) => void, onEdit?: (index: number) => void,
  onSource?: (annotation: ResponseAnnotation) => Promise<void>, firstIndex = 0): void {
  const signature = JSON.stringify(annotations);
  if (!onRemove && !onEdit && container.dataset.annotations === signature) return;
  container.dataset.annotations = signature;
  container.replaceChildren();
  container.hidden = !annotations.length;
  for (const [index, annotation] of annotations.entries()) {
    const card = document.createElement('div');
    card.className = 'annotation-card';
    const body = document.createElement(onEdit ? 'button' : 'div');
    if (onEdit) {
      (body as HTMLButtonElement).type = 'button';
      body.className = 'annotation-edit';
      body.setAttribute('aria-label', `编辑选段 ${index + 1} 的意见`);
      body.addEventListener('click', () => onEdit(index));
    }
    const excerpt = document.createElement('blockquote');
    excerpt.className = 'annotation-excerpt';
    excerpt.textContent = annotation.text;
    if (onEdit) {
      const label = document.createElement('span');
      label.textContent = `引用 ${index + 1}`;
      body.append(label, excerpt);
    } else {
      const details = document.createElement('details');
      details.className = 'sent-annotation';
      const summary = document.createElement('summary');
      summary.textContent = `引用 ${firstIndex + index + 1} · ${annotation.text.replace(/\s+/g, ' ').slice(0, 72)}`;
      details.append(summary, excerpt);
      if (onSource && annotation.source) {
        const source = document.createElement('button');
        source.type = 'button';
        source.className = 'quiet';
        source.textContent = '查看来源';
        source.addEventListener('click', async () => {
          source.disabled = true;
          try { await onSource(annotation); }
          catch (error) { source.textContent = error instanceof Error ? error.message : '来源不可用'; }
          finally { source.disabled = false; }
        });
        details.append(source);
      }
      body.append(details);
    }
    if (annotation.annotation) {
      const comment = document.createElement('p');
      comment.className = 'annotation-comment';
      comment.textContent = annotation.annotation;
      body.append(comment);
    }
    card.append(body);
    if (onRemove) {
      const remove = document.createElement('button');
      remove.className = 'quiet';
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除选段 ${index + 1}`);
      remove.textContent = '×';
      remove.addEventListener('click', () => onRemove(index));
      card.append(remove);
    }
    container.append(card);
  }
}
