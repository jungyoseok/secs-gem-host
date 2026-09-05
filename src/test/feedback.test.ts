import test from 'node:test';
import assert from 'node:assert/strict';
import { postFeedback } from '../mcp.js';

test('scadathings_feedback POSTs the note to /api/feedback/<slug>', async () => {
  const calls: { url: string; init: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const r = await postFeedback('secs-gem-s1f13-establish-communications', {
      helped: true, note: 'fixed our COMMACK 1 loop', agent: 'claude-opus-5',
    });
    assert.deepEqual(r, { ok: true });
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/api/feedback/secs-gem-s1f13-establish-communications');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    helped: true, note: 'fixed our COMMACK 1 loop', agent: 'claude-opus-5',
  });
});

test('a non-2xx answer comes back as { ok: false, status }', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    assert.deepEqual(await postFeedback('no-such-article', { helped: false }), { ok: false, status: 404 });
  } finally {
    globalThis.fetch = real;
  }
});
