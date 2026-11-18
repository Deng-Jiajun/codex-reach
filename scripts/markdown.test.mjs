import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from '../src/markdown.ts';
test('Chinese punctuation next to strong closing markers retains inline code', () => {
  const html = markdown.parse('**停止时固定 `sleep 5` 不合适。**建议修改');
  assert.match(html, /<strong>停止时固定 <code>sleep 5<\/code> 不合适。<\/strong>建议修改/);
});
test('code examples and escaped stars remain literal', () => {
  assert.equal(markdown.parse('`**示例。**后文`').includes('<strong>'), false);
  assert.equal(markdown.parse('```text\n**示例。**后文\n```').includes('<strong>'), false);
  assert.equal(markdown.parse(String.raw`\*\*示例。\*\*后文`).includes('<strong>'), false);
});
