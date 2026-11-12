import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMessages, groupProcessMessages } from '../src/transcript.ts';

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

test('adjacent records share a disclosure while progress and other record types preserve order', () => {
  const input = [message('tool-1', 'tool'), message('tool-2', 'tool'),
    message('thought-1', 'reasoning'), message('thought-2', 'reasoning'),
    message('progress', 'assistant', 'commentary'), message('tool-3', 'tool')];
  const groups = groupProcessMessages(input);
  assert.deepEqual(groups.map(group => [group.kind, group.messages.length]), [['tool', 2], ['reasoning', 2], [null, 1], ['tool', 1]]);
  assert.deepEqual(groups.flatMap(group => group.messages), input);
});

test('record runs extend across partial pages without joining separated runs', () => {
  const tail = [message('tool-2', 'tool'), message('thought', 'reasoning'), message('tool-3', 'tool')];
  assert.deepEqual(groupProcessMessages(tail).map(group => group.messages.length), [1, 1, 1]);
  assert.deepEqual(groupProcessMessages([message('tool-1', 'tool'), ...tail]).map(group => group.messages.length), [2, 1, 1]);
});
