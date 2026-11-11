import type { HistoryPage, Turn } from './types';

export function mergeTail(current: Turn[], incoming: Turn[], complete: boolean): Turn[] | null {
  if (complete || !current.length) return incoming;
  if (!incoming.length) return current;
  const boundary = current.findIndex(turn => turn.id === incoming[0].id);
  if (boundary < 0) return null;
  const previous = current[boundary].messages;
  const latest = incoming[0].messages;
  let messages = latest;
  if (previous.length && latest.length) {
    const anchor = previous.findIndex(message => message.id === latest[0].id);
    if (anchor >= 0) messages = [...previous.slice(0, anchor), ...latest];
    else if (!latest.some(message => message.id === previous[0].id)) return null;
  }
  return [...current.slice(0, boundary), { ...incoming[0], messages }, ...incoming.slice(1)];
}

export function mergeHistory(current: HistoryPage, incoming: HistoryPage): HistoryPage {
  const turns = mergeTail(current.turns, incoming.turns, !incoming.hasMore);
  const retainedOlder = turns !== null && (turns.length > incoming.turns.length
    || (turns[0]?.messages.length ?? 0) > (incoming.turns[0]?.messages.length ?? 0));
  return {
    ...incoming,
    title: incoming.title || current.title || '未命名对话',
    turns: turns ?? incoming.turns,
    nextCursor: retainedOlder ? current.nextCursor : incoming.nextCursor,
    hasMore: retainedOlder ? current.hasMore : incoming.hasMore,
  };
}

export function prependHistory(current: HistoryPage, older: HistoryPage): HistoryPage {
  const turns = [...older.turns];
  for (const turn of current.turns) {
    const index = turns.findIndex(item => item.id === turn.id);
    if (index < 0) turns.push(turn);
    else {
      const ids = new Set(turn.messages.map(message => message.id));
      turns[index] = { ...turn, messages: [...turns[index].messages.filter(message => !ids.has(message.id)), ...turn.messages] };
    }
  }
  return { ...current, turns, hasMore: older.hasMore, nextCursor: older.nextCursor };
}
