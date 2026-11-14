const paths = {
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  expand: '<path d="M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7"/>',
  collapse: '<path d="M21 3l-7 7m0-7v7h7M3 21l7-7m-7 0h7v7"/>',
  send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  down: '<path d="M12 4v16m-7-7 7 7 7-7"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  queue: '<path d="M4 5h16M4 11h10M4 17h8m5-3 4 3-4 3Z"/>',
  pin: '<path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v5"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
  unread: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  archive: '<path d="M4 8v13h16V8M9 12h6"/><rect x="2" y="3" width="20" height="5" rx="1"/>',
  file: '<path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  folder: '<path d="M3 7V4h6l2 3h10v13H3Z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
} as const;

export type Icon = keyof typeof paths;
export function icon(name: Icon): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

export function setIcon(button: HTMLElement, name: Icon, label: string): void {
  button.innerHTML = icon(name);
  button.classList.add('icon-button');
  button.setAttribute('aria-label', label);
  button.title = label;
}

export function setAction(button: HTMLButtonElement, name: Icon, label: string): void {
  button.innerHTML = icon(name);
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);
  button.classList.add('menu-action');
}

export function resizeComposer(input: HTMLTextAreaElement, toggle: HTMLElement): void {
  if (!input.clientWidth) return;
  input.style.height = 'auto';
  const overflow = input.scrollHeight > 160;
  const expanded = overflow && toggle.getAttribute('aria-expanded') === 'true';
  toggle.hidden = !overflow;
  toggle.setAttribute('aria-expanded', String(expanded));
  setIcon(toggle, expanded ? 'collapse' : 'expand', expanded ? '收起输入框' : '展开输入框');
  input.closest('.composer')?.classList.toggle('expanded', expanded);
  const limit = expanded ? Math.max(160, (window.visualViewport?.height ?? innerHeight) * .5) : 160;
  input.style.height = `${Math.min(limit, input.scrollHeight)}px`;
}

const prepared = new WeakSet<HTMLDialogElement>();
const openDialogs = new Set<HTMLDialogElement>();

export function closeTopDialog(): boolean {
  const dialog = [...openDialogs].reverse().find(dialog => dialog.open && dialog.isConnected);
  if (!dialog) return false;
  dialog.close();
  return true;
}

export function showDialog(dialog: HTMLDialogElement): void {
  if (!prepared.has(dialog)) {
    prepared.add(dialog);
    const header = dialog.querySelector<HTMLElement>(':scope > .dialog-header');
    const title = header?.querySelector('h2')?.textContent;
    if (title && !dialog.hasAttribute('aria-labelledby')) dialog.setAttribute('aria-label', title);
    const close = header?.querySelector<HTMLButtonElement>('button');
    if (close) {
      setIcon(close, 'close', '关闭');
      close.classList.add('dialog-close');
      header!.append(close);
    }
    let outside = false;
    const isOutside = (event: MouseEvent) => {
      const rect = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom);
    };
    dialog.addEventListener('pointerdown', event => { outside = isOutside(event); });
    dialog.addEventListener('click', event => {
      if (outside && isOutside(event)) {
        event.preventDefault();
        event.stopPropagation();
        dialog.close();
      }
      outside = false;
    });
    dialog.addEventListener('pointercancel', () => { outside = false; });
    dialog.addEventListener('close', () => { if (!dialog.open) openDialogs.delete(dialog); });
  }
  if (!dialog.open) {
    dialog.showModal();
    openDialogs.delete(dialog);
    openDialogs.add(dialog);
  }
}
