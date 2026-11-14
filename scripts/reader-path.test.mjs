import assert from 'node:assert/strict';
import test from 'node:test';
import { readerPath } from '../src/reader-path.ts';

test('desktop links separate line and column from decoded local paths', () => {
  assert.deepEqual(readerPath('D:/Projects/docs/%E4%BA%A7%E5%93%81%E8%A7%84%E6%A0%BC.md:144'),
    { path: 'D:/Projects/docs/产品规格.md', line: 144 });
  assert.equal(readerPath('/C:/Users/Example/source.cpp:43:8').path, 'C:/Users/Example/source.cpp');
  assert.equal(readerPath('C:\\Example\\source.cpp#L43-L49').line, 43);
  assert.equal(readerPath('file:///D:/Example/source.cpp#L12C3').line, 12);
});

test('file urls and relative links preserve encoded filename characters', () => {
  assert.equal(readerPath('file://server/share/a%20b.txt').path, '//server/share/a b.txt');
  assert.equal(readerPath('a%23b%25.txt', 'D:/项目').path, 'D:/项目/a#b%.txt');
  assert.equal(readerPath('100%.txt', 'D:/项目').path, 'D:/项目/100%.txt');
  assert.equal(readerPath('D:/Example/10%2520.txt').path, 'D:/Example/10%20.txt');
  assert.deepEqual(readerPath('a#b.txt', 'D:/项目'), { path: 'D:/项目/a#b.txt', line: undefined });
});

test('resolved computer paths preserve literal percent and location-like filename suffixes', () => {
  for (const path of ['D:/Example/a%20b.txt', 'D:/Example/image.png#L12', '//server/share/a%23b.png']) {
    assert.deepEqual(readerPath({ path }), { path, line: undefined });
  }
  assert.deepEqual(readerPath({ path: 'a%20b.txt' }, 'D:/项目'), { path: 'D:/项目/a%20b.txt', line: undefined });
});

test('local image URLs decode reserved filename characters and preserve UNC roots', () => {
  assert.equal(readerPath('D:/Example/a%23b.png').path, 'D:/Example/a#b.png');
  assert.equal(readerPath('file://server/share/a%23b.png').path, '//server/share/a#b.png');
  assert.equal(readerPath('a%2520b.png', 'D:/项目').path, 'D:/项目/a%20b.png');
});
