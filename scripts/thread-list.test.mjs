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

test('project identity and Windows directory spelling share one project group', () => {
  const groups = groupThreads([
    chat('with-project', 1, { projectId: 'pc', cwd: 'D:\\Projects\\pc' }),
    chat('directory-only', 2, { cwd: 'd:/projects/PC/' }),
    chat('second-id', 3, { projectId: 'pc-alias', cwd: 'D:/Projects/pc' }),
  ], [
    { id: 'pc', name: 'pc', path: 'D:\\Projects\\pc' },
    { id: 'pc-alias', name: 'pc', path: 'd:/projects/pc/' },
  ], 'project');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'pc');
  assert.deepEqual(groups[0].threads.map(thread => thread.id), ['second-id', 'directory-only', 'with-project']);
});

test('same directory names in different roots remain distinguishable', () => {
  const groups = groupThreads([
    chat('one', 1, { cwd: 'D:/Projects/pc' }),
    chat('two', 2, { cwd: 'E:/Projects/pc' }),
    chat('linux-upper', 3, { cwd: '/home/PC' }),
    chat('linux-lower', 4, { cwd: '/home/pc' }),
  ], [], 'project');
  assert.equal(groups.length, 4);
  assert.ok(groups.some(group => group.title === 'pc · D:/Projects/pc'));
  assert.ok(groups.some(group => group.title === 'pc · E:/Projects/pc'));
});
