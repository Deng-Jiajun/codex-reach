import type { HistoryPage, Turn } from './types';

export function mergeTail(current: Turn[], incoming: Turn[], complete: boolean): Turn[] | null {
  if (complete || !current.length) return incoming;
  if (!incoming.length) return current;
  const boundary = current.findIndex(turn => turn.id === incoming[0].id);
  if (boundary < 0) return null;
  return [...current.slice(0, boundary), ...incoming];
}

export function mergeHistory(current: HistoryPage, incoming: HistoryPage): HistoryPage {
  const turns = mergeTail(current.turns, incoming.turns, !incoming.hasMore);
  const retainedOlder = turns !== null && turns.length > incoming.turns.length;
  return {
    ...incoming,
    title: incoming.title || current.title || '未命名对话',
    turns: turns ?? incoming.turns,
    nextCursor: retainedOlder ? current.nextCursor : incoming.nextCursor,
    hasMore: retainedOlder ? current.hasMore : incoming.hasMore,
  };
}
