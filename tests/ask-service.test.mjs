import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAskHandler, prepareDraft, readLimit, subjectKey, SYSTEM, REVIEW_SYSTEM } from '../supabase/functions/ask/core.mjs';

const token = '3a5d7eb1-690b-4d23-b764-a0b40f6e3a25';
const question = { story: 'maathai', lang: 'en', age: '5-7', length: 'short', question: 'Why do trees need water?', parentPresent: true };
const model = (value, stop = 'end_turn') => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(value) }] });
const draft = model({ kind: 'answer', answer: 'Water helps trees grow. What do you notice about a leaf?' });
const approved = model({ approved: true, urgent: false });
function request(body = question, headers = {}) {
  return new Request('https://example.test/ask', { method: 'POST', headers: {
    'content-type': 'application/json', origin: 'https://malakaistory.com', 'x-forwarded-for': '192.0.2.10', ...headers,
  }, body: JSON.stringify(body) });
}
function service(overrides = {}) {
  const calls = { model: [], reserve: [], finish: [], rate: [] };
  const deps = {
    ready: true, identitySecret: 'offline-test-secret', origins: ['https://malakaistory.com'], limitGuest: 2, limitSignedIn: 5,
    getUser: async () => 'cd0971b7-7552-4eb6-af51-eb7c320a71ca',
    loadStories: async () => [{ id: 'maathai', langs: {
      en: { title: 'Wangari', text: ['She planted trees.'], textM: ['She helped people care for forests.'] },
      sw: { title: 'Wangari', text: ['Alipanda miti.'] },
    } }],
    reserve: async values => { calls.reserve.push(values); return { allowed: true, id: 1, rating_token: token, remaining: 1, retry_after: 86400 }; },
    finish: async (...values) => { calls.finish.push(values); },
    rate: async (...values) => { calls.rate.push(values); return true; },
    complete: async (...values) => { calls.model.push(values); return values[0] === SYSTEM ? draft : approved; },
    ...overrides,
  };
  return { handler: createAskHandler(deps), calls };
}

test('a parent question reserves before generation, reviews the draft, and persists metadata only', async () => {
  const s = service();
  const r = await s.handler(request()); const body = await r.json();
  assert.equal(r.status, 200); assert.equal(body.suitable, true); assert.equal(body.ratingToken, token);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://malakaistory.com');
  assert.equal(s.calls.model.length, 2); assert.equal(s.calls.model[1][0], REVIEW_SYSTEM);
  assert.deepEqual(JSON.parse(s.calls.model[0][1]), {
    lang: 'en', language: 'English', age: 'five to seven: a simple cause and effect, with one optional question',
    story: 'Wangari\n\nShe planted trees.', question: question.question,
  });
  assert.match(s.calls.reserve[0].p_subject_key, /^g:[0-9a-f]{64}$/);
  assert.equal(s.calls.reserve[0].p_limit, 2);
  const persisted = JSON.stringify([s.calls.reserve, s.calls.finish]);
  assert.ok(!persisted.includes(question.question)); assert.ok(!persisted.includes('192.0.2.10'));
  assert.equal(s.calls.finish[0][2], true);
});

test('rejects missing parent acknowledgement, invalid ages, prototype keys and oversized requests before AI', async () => {
  const s = service();
  for (const patch of [{ parentPresent: false }, { age: null }, { age: 'constructor' }, { lang: '__proto__' }, { story: '../private' }, { question: 'x' }, { question: 'a'.repeat(201) }, { length: 'l' }]) {
    assert.equal((await s.handler(request({ ...question, ...patch }))).status, 400);
  }
  assert.equal((await s.handler(request(null))).status, 400);
  assert.equal((await s.handler(request({ ...question, extra: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await s.handler(request(question, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal(s.calls.reserve.length, 0); assert.equal(s.calls.model.length, 0);
});

test('unsupported origins, methods, missing guest identity and invalid sessions cannot reach generation', async () => {
  const s = service({ getUser: async () => null });
  const blocked = await s.handler(request(question, { origin: 'https://unrelated.example' }));
  assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  assert.equal((await s.handler(new Request('https://example.test/ask'))).status, 405);
  assert.equal((await s.handler(request(question, { authorization: 'Bearer expired' }))).status, 401);
  assert.equal((await s.handler(request(question, { authorization: 'Basic invalid' }))).status, 401);
  assert.equal((await s.handler(request(question, { 'x-forwarded-for': '' }))).status, 503);
  assert.equal(s.calls.model.length, 0);
  const preflight = await s.handler(new Request('https://example.test/ask', { method: 'OPTIONS', headers: { origin: 'https://malakaistory.com' } }));
  assert.equal(preflight.status, 204);
});

test('uses verified family identity and the actual selected story version', async () => {
  const s = service();
  const r = await s.handler(request({ ...question, length: 'm' }, { authorization: 'Bearer family-token' }));
  assert.equal(r.status, 200);
  assert.match(s.calls.reserve[0].p_subject_key, /^u:/); assert.equal(s.calls.reserve[0].p_limit, 5);
  assert.equal(s.calls.reserve[0].p_user_id, 'cd0971b7-7552-4eb6-af51-eb7c320a71ca');
  assert.match(JSON.parse(s.calls.model[0][1]).story, /care for forests/);
  const missing = service();
  assert.equal((await missing.handler(request({ ...question, lang: 'sw', length: 'm' }))).status, 404);
  assert.equal(missing.calls.reserve.length, 0);
});

test('allowance failures and exhaustion fail closed without a paid model call or leaked error', async () => {
  for (const reserve of [async () => { throw new Error('database secret and child text'); }, async () => null, async () => ({ allowed: true, remaining: 1, retry_after: 2, id: 1 })]) {
    const s = service({ reserve }); const r = await s.handler(request());
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'temporarily_unavailable' });
    assert.equal(s.calls.model.length, 0);
  }
  const s = service({ reserve: async () => ({ allowed: false, remaining: 0, retry_after: 60 }) });
  const r = await s.handler(request()); assert.equal(r.status, 429); assert.equal(r.headers.get('retry-after'), '60');
  assert.equal((await r.json()).retryAfter, 60); assert.equal(s.calls.model.length, 0);
});

test('a declined review or provider refusal never returns the draft as a child answer', async () => {
  for (const second of [model({ approved: false, urgent: false }), model({}, 'refusal')]) {
    let calls = 0;
    const result = await prepareDraft(async () => ++calls === 1 ? draft : second, { lang: 'en', question: question.question }, new AbortController().signal);
    assert.equal(result.suitable, false); assert.ok(!result.answer.includes('Water helps trees'));
  }
  const result = await prepareDraft(async () => model({}, 'refusal'), { lang: 'fr' }, new AbortController().signal);
  assert.equal(result.suitable, false); assert.match(result.answer, /conversation avec vous/);
});

test('urgent results use fixed immediate-support wording in each supported language', async () => {
  for (const [lang, expected] of [['en', /now/], ['sw', /sasa/], ['fr', /maintenant/]]) {
    for (const reviewerFlagsUrgency of [false, true]) {
      let n = 0;
      const result = await prepareDraft(async () => {
        n++;
        if (reviewerFlagsUrgency) return n === 1 ? draft : model({ approved: true, urgent: true });
        return model({ kind: 'urgent_support', answer: 'Untrusted text must not be displayed' });
      }, { lang }, new AbortController().signal);
      assert.equal(result.suitable, false); assert.match(result.answer, expected);
      assert.ok(!result.answer.includes('Untrusted')); assert.ok(!result.answer.includes('daytime'));
    }
  }
});

test('malformed, truncated, failed or unfinished model work cannot release a draft', async () => {
  for (const bad of [model({ kind: 'answer', answer: '' }), model({ kind: 'answer', answer: 'a'.repeat(1201) }), model({ kind: 'answer', answer: 'incomplete' }, 'max_tokens'), model({ kind: 'answer', answer: 42 }), model({ kind: 'other', answer: 'anything' })]) {
    const s = service({ complete: async () => bad }); const r = await s.handler(request());
    assert.equal(r.status, 503); assert.equal(s.calls.finish.length, 0);
    assert.deepEqual(await r.json(), { error: 'temporarily_unavailable' });
  }
  const s = service({ finish: async () => { throw new Error('private database detail'); } });
  const r = await s.handler(request()); assert.equal(r.status, 503); assert.ok(!(await r.text()).includes('private'));
  let n = 0;
  await assert.rejects(prepareDraft(async () => ++n === 1 ? draft : model({ approved: 'true', urgent: false }), { lang: 'en' }, new AbortController().signal));
});

test('ratings require a private token plus subject ownership and acknowledge only a matching saved row', async () => {
  const body = { rate: 1, ratingToken: token, good: false };
  const s = service();
  assert.equal((await s.handler(request({ rate: 1, good: true }))).status, 400);
  assert.equal((await s.handler(request({ ...body, rate: '1' }))).status, 400);
  assert.equal((await s.handler(request(body))).status, 200);
  assert.deepEqual(s.calls.rate[0], [1, token, await subjectKey(null, '192.0.2.10', 'offline-test-secret'), false]);
  assert.equal(s.calls.model.length, 0);
  assert.equal((await service({ rate: async () => false }).handler(request(body))).status, 404);
  assert.equal((await service({ rate: async () => { throw new Error('failed write'); } }).handler(request(body))).status, 503);
});

test('identity hashes are secret-bound and configuration cannot accidentally remove the cap', async () => {
  const first = await subjectKey(null, '192.0.2.10', 'one-secret');
  assert.notEqual(first, await subjectKey(null, '192.0.2.10', 'another-secret'));
  assert.notEqual(first, await subjectKey('family', '192.0.2.10', 'one-secret'));
  assert.equal(readLimit(undefined, 2), 2);
  for (const value of ['NaN', 'Infinity', '-1', '2.5', '101']) assert.equal(readLimit(value, 5), 0);
  const s = service({ limitGuest: 'invalid' });
  assert.equal((await s.handler(request())).status, 429); assert.equal(s.calls.model.length, 0);
});
