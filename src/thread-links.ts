export type ThreadNavigation = { open: (id: string) => void; title: (id: string) => Promise<string> };

export function createdThreadMarkers(text: string): { index: number; text: string; id: string; pending: boolean }[] {
  const pattern = /::created-thread\{(threadId|clientThreadId)="([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})"\}/gi;
  return [...text.matchAll(pattern)].map(match => ({ index: match.index!, text: match[0], id: match[2], pending: match[1].toLowerCase() === 'clientthreadid' }));
}

export function renderThreadMarkers(root: DocumentFragment, navigation: ThreadNavigation): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    if (text.parentElement?.closest('code, pre, a, button')) continue;
    const matches = createdThreadMarkers(text.data);
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let end = 0;
    for (const match of matches) {
      fragment.append(text.data.slice(end, match.index));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'thread-link';
      link.dataset.sourceText = match.text;
      if (match.pending) {
        link.disabled = true;
        link.textContent = '对话准备请求 · 完成后可从列表打开';
      } else {
        link.dataset.threadId = match.id;
        link.textContent = '打开新对话 ›';
        link.addEventListener('click', () => navigation.open(match.id));
        void navigation.title(match.id).then(title => {
          link.textContent = `新对话：${title} ›`;
          link.title = title;
        }).catch(() => { link.title = '名称暂时无法读取，点击尝试打开对话'; });
      }
      fragment.append(link);
      end = match.index + match.text.length;
    }
    fragment.append(text.data.slice(end));
    text.replaceWith(fragment);
  }
}
