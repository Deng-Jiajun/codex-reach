import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../package.json' with { type: 'json' };
import { ReachClient, ReachError } from '../src/api.ts';

const connection = { url: 'http://reach.test', key: 'fixture', serverId: 'test' };
const base = connection.url + '/api/' + manifest.version;

test('restored clients verify the service once before concurrent business requests', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.method]);
    assert.equal(options.headers.Authorization, 'Bearer fixture');
    return Response.json(url.endsWith('/status') ? { version: manifest.version, serverId: 'test' } : {});
  });
  const client = new ReachClient(connection);
  await Promise.all([client.request('/projects'), client.request('/threads', 'POST', {})]);
  assert.deepEqual(calls, [[base + '/status', 'GET'], [base + '/projects', 'GET'], [base + '/threads', 'POST']]);
});

test('old, missing or mismatched service versions prevent writes and allow reconnect after upgrade', async t => {
  let status;
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === base + '/status') return status();
    assert.equal(url, base + '/threads');
    assert.equal(options.method, 'POST');
    writes++;
    return Response.json({});
  });
  const client = new ReachClient(connection);
  for (status of [
    () => new Response(null, { status: 404 }),
    () => Response.json({ serverId: 'test' }),
    () => Response.json({ version: '0.6.8' }),
  ]) {
    await assert.rejects(client.request('/threads', 'POST', {}), error =>
      error instanceof ReachError && error.status === 412 && error.message.includes('同步更新'));
  }
  assert.equal(writes, 0);
  status = () => Response.json({ version: manifest.version, serverId: 'test' });
  await client.request('/threads', 'POST', {});
  assert.equal(writes, 1);
});
