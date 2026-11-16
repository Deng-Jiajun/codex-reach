import assert from 'node:assert/strict';
import test from 'node:test';
import { createdThreadMarkers } from '../src/thread-links.ts';

const id = '11111111-1111-4111-8111-111111111111';
test('ready and queued creation results retain their distinct target identifiers', () => {
  const ready = `::created-thread{threadId="${id}"}`;
  const queued = `::created-thread{clientThreadId="${id}"}`;
  assert.deepEqual(createdThreadMarkers(`已创建\n${ready}\n${queued}`).map(({ id, pending }) => ({ id, pending })),
    [{ id, pending: false }, { id, pending: true }]);
});
test('partial streamed or malformed directives cannot become navigation targets', () => {
  assert.equal(createdThreadMarkers(`::created-thread{threadId="${id}"`).length, 0);
  assert.equal(createdThreadMarkers('::created-thread{threadId="../../etc"}').length, 0);
  assert.equal(createdThreadMarkers(`::created-thread{threadId="${id}" hostId="remote"}`).length, 0);
});
