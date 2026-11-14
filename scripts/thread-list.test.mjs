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
test('project grouping separates saved projects from chats without a project', () => {
  const groups = groupThreads([chat('a', 1, { projectId: 'a' }), chat('b', 2, { projectId: 'b' }), chat('c', 3)],
    [{ id: 'a', name: 'A', path: 'D:/A' }, { id: 'b', name: 'B', path: 'D:/B' }], 'project');
  assert.deepEqual(groups.map(group => group.title).sort(), ['A', 'B', '无项目'].sort());
});
test('status grouping uses explicit waiting evidence and hides idle labels', () => {
  const groups = groupThreads([chat('idle', 1), chat('running', 2, { status: 'active' }), chat('waiting', 3, { waitingForUser: true })], [], 'status');
  assert.deepEqual(groups.map(group => group.title), ['待处理', '进行中', '其他对话']);
  assert.equal(threadTitle(chat('a', 0)), '未命名对话');
  assert.equal(threadTitle(chat('a', 0, { title: '已有标题' })), '已有标题');
});

test('preview titles stay bounded without changing stored names or splitting Unicode characters', () => {
  const thread = chat('long', 0, { title: '😀'.repeat(80) + '\n完整首条消息' });
  assert.equal(threadTitle(thread), '😀'.repeat(60) + '…');
  assert.ok(thread.title.endsWith('\n完整首条消息'));
  assert.equal(threadTitle(chat('a', 0, { title: '  原有标题\n第二行  ' })), '原有标题 第二行');
  assert.equal(threadTitle(chat('a', 0, { title: ' \n ' })), '未命名对话');
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

test('saved projects with the same name in different roots remain distinguishable', () => {
  const groups = groupThreads([
    chat('one', 1, { cwd: 'D:/Projects/pc' }),
    chat('two', 2, { cwd: 'E:/Projects/pc' }),
    chat('linux-upper', 3, { cwd: '/home/PC' }),
    chat('linux-lower', 4, { cwd: '/home/pc' }),
  ], [
    { id: 'one', name: 'pc', path: 'D:/Projects/pc' },
    { id: 'two', name: 'pc', path: 'E:/Projects/pc' },
    { id: 'linux-upper', name: 'PC', path: '/home/PC' },
    { id: 'linux-lower', name: 'pc', path: '/home/pc' },
  ], 'project');
  assert.equal(groups.length, 4);
  assert.ok(groups.some(group => group.title === 'pc · D:/Projects/pc'));
  assert.ok(groups.some(group => group.title === 'pc · E:/Projects/pc'));
});

test('unassigned chats share one group without exposing generated folder names', () => {
  const groups = groupThreads([
    chat('test', 1, { cwd: 'C:/Example/files-mentioned-by-the-user-first' }),
    chat('other', 3, { cwd: 'D:/Another/directory', projectId: 'removed-project' }),
    chat('empty', 2, { cwd: '' }),
  ], [], 'project');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, '无项目');
  assert.deepEqual(groups[0].threads.map(thread => thread.id), ['other', 'empty', 'test']);
});
