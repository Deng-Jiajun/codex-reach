import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMessages } from '../src/transcript.ts';

const message = (id, kind, phase = null) => ({ id, kind, phase, text: id });
const processMessages = [
  message('progress', 'assistant', 'commentary'),
  message('command', 'tool'),
  message('thought', 'reasoning'),
  message('another-command', 'tool'),
];

test('completed turns group progress while keeping the prompt and final answer visible', () => {
  const input = [message('prompt', 'user'), ...processMessages, message('answer', 'assistant', 'final_answer')];
  const groups = groupMessages(input);
  assert.deepEqual(groups.map(group => group.process), [false, true, false]);
  assert.deepEqual(groups[1].messages.map(item => item.id), processMessages.map(item => item.id));
  assert.deepEqual(groups.flatMap(group => group.messages), input);
});

test('partial live and history pages use the same grouping without needing a final answer', () => {
  assert.deepEqual(groupMessages(processMessages).map(group => group.messages.length), [4]);
  assert.deepEqual(groupMessages(processMessages.slice(1)).map(group => group.messages.length), [3]);
});

test('steering input and legacy assistant messages preserve their place in the transcript', () => {
  const input = [...processMessages, message('steer', 'user'), ...processMessages, message('legacy-answer', 'assistant')];
  assert.deepEqual(groupMessages(input).map(group => group.process), [true, false, true, false]);
});

test('questions and attachments stay outside collapsed process groups', () => {
  const question = { ...message('question', 'assistant', 'commentary'), questions: [{ title: 'Which project?' }] };
  const attachment = { ...message('image', 'assistant', 'commentary'), attachments: [{ name: 'preview.png', image: true }] };
  const groups = groupMessages([...processMessages, question, attachment]);
  assert.deepEqual(groups.map(group => group.process), [true, false, false]);
});
