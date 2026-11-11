import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeHistory, mergeTail } from '../src/sync.ts';

const turn = id => ({ id, status: 'completed', messages: [] });
const page = (ids, nextCursor) => ({ id: 'chat', title: 'Chat', cwd: '', status: 'idle', turns: ids.map(turn), nextCursor, hasMore: nextCursor !== null });

test('refreshing the tail preserves the cursor for already loaded older history', () => {
  const current = page(['older', 'anchor', 'latest'], 'before-older');
  const refreshed = page(['anchor', 'latest', 'new'], 'before-anchor');
  const result = mergeHistory(current, refreshed);
  assert.deepEqual(result.turns.map(turn => turn.id), ['older', 'anchor', 'latest', 'new']);
  assert.equal(result.nextCursor, 'before-older');
});

test('a complete replacement removes the edited turn id', () => {
  const result = mergeHistory(page(['old'], null), page(['edited'], null));
  assert.deepEqual(result.turns.map(turn => turn.id), ['edited']);
  assert.equal(result.hasMore, false);
});

test('an unanchored partial stream asks its caller to refresh history', () => {
  assert.equal(mergeTail([turn('old')], [turn('new')], false), null);
});
