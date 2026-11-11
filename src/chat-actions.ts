import type { ResponseAnnotation } from './types';

export type TextSelection = { startOffset: number; endOffset: number };

export function selectedMessageText(content: HTMLElement): TextSelection | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return;
  const prefix = document.createRange();
  prefix.selectNodeContents(content);
  prefix.setEnd(range.startContainer, range.startOffset);
  const startOffset = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return { startOffset, endOffset: prefix.toString().length };
}

export function annotationPrompt(prompt: string, annotations: ResponseAnnotation[]): string {
  if (!annotations.length) return prompt;
  return `\n# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment.\n<response-annotations>\n${JSON.stringify(annotations)}\n</response-annotations>\n\n## My request:\n${prompt}`;
}

export function openAnnotation(text: string, messageId: string, selection: TextSelection | undefined,
  comment: string, onAdd: (annotation: ResponseAnnotation) => void): void {
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
  let chosen = selection;
  const update = () => {
    const selectedText = chosen ? text.slice(chosen.startOffset, chosen.endOffset) : '';
    excerpt.textContent = selectedText;
    excerpt.hidden = !selectedText || source.open;
    add.disabled = !selectedText.trim();
  };
  input.addEventListener('select', () => {
    chosen = { startOffset: input.selectionStart, endOffset: input.selectionEnd };
    update();
  });
  source.addEventListener('toggle', update);
  dialog.querySelector('[data-back]')!.addEventListener('click', () => dialog.close());
  add.addEventListener('click', () => {
    if (!chosen || add.disabled) return;
    onAdd({ text: text.slice(chosen.startOffset, chosen.endOffset), annotation: opinion.value.trim(),
      source: { messageId, ...chosen } });
    dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  if (source.open) input.focus();
  else opinion.focus();
  input.setSelectionRange(selection?.startOffset ?? 0, selection?.endOffset ?? 0);
  update();
}

export function renderAnnotations(container: HTMLElement, annotations: ResponseAnnotation[],
  onRemove?: (index: number) => void, onEdit?: (index: number) => void): void {
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
    body.append(excerpt);
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
