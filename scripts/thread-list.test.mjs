import assert from 'node:assert/strict';
import test from 'node:test';
import { groupThreads, threadTitle } from '../src/thread-list.ts';

const chat = (id, updatedAt, extra = {}) => ({ id, title: id, cwd: 'D:/Example', projectId: null, status: 'idle', updatedAt, ...extra });
test('all group modes put pinned chats first and retain descending activity within groups', () => {
  const chats = [chat('older', 1700000000), chat('pinned', 1600000000, { pinned: true }), chat('newer', 1700000100)];
  for (const mode of ['date', 'project', 'status']) {
    const groups = groupThreads(chats, [], mode);
    assert.equal(groups[0].title, '置顶');
    assert.equal(groups[0].threads[0].id, 'pinned');
    assert.deepEqual(groups.slice(1).flatMap(group => group.threads.map(thread => thread.id)), ['newer', 'older']);
  }
});
test('project grouping separates project identity and standalone directory', () => {
  const groups = groupThreads([chat('a', 1, { projectId: 'a' }), chat('b', 2, { projectId: 'b' }), chat('c', 3)],
    [{ id: 'a', name: 'A', path: 'D:/A' }, { id: 'b', name: 'B', path: 'D:/B' }], 'project');
  assert.deepEqual(groups.map(group => group.title), ['A', 'B', 'Example']);
});
test('status grouping uses explicit waiting evidence and hides idle labels', () => {
  const groups = groupThreads([chat('idle', 1), chat('running', 2, { status: 'active' }), chat('waiting', 3, { waitingForUser: true })], [], 'status');
  assert.deepEqual(groups.map(group => group.title), ['待处理', '进行中', '其他对话']);
  assert.equal(threadTitle(chat('a', 0)), '未命名对话');
  assert.equal(threadTitle(chat('a', 0, { title: '已有标题' })), '已有标题');
});
