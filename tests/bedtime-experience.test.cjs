// Unit tests run the real inline application with small device/DOM stand-ins.
// They make no network requests and do not incur narration charges.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const storyCount = JSON.parse(fs.readFileSync(path.join(__dirname, '../content/source.json'), 'utf8')).stories.length;
const script = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(([, attrs]) => !attrs.includes('application/ld+json')).map(([, , code]) => code).join('\n');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (url, ok = true) => ({ ok, json: async () => ({ url }) });

function app({ fetcher = async () => response('https://example.test/story.mp3'), availability = async () => ({ ok: true, json: async () => ({ reviewVersion: 1, ready: true }) }), search = '', stored = {}, voices } = {}) {
  const elements = new Map(), timers = new Map(), events = new Map(), storage = new Map(Object.entries(stored));
  const recordings = [], spoken = [];
  let document, clock = Date.now(), timerId = 0;
  class Element {
    constructor() { this.dataset = {}; this.style = {}; this.innerHTML = ''; this.textContent = ''; this.hidden = false; this.value = ''; this.isConnected = true; this.attrs = {}; this.listeners = new Map();
      const classes = new Set();
      this.classList = { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k), toggle(k, on) { if (on ?? !classes.has(k)) classes.add(k); else classes.delete(k); } };
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.src = ''; }
    appendChild() {}
    addEventListener(k, fn) { this.listeners.set(k, fn); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    querySelectorAll() { return []; }
  }
  class Audio extends Element {
    constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 120; this.src = ''; this.plays = 0; recordings.push(this); }
    async play() { this.paused = false; this.plays++; }
    pause() { this.paused = true; }
    load() { this.currentTime = 0; }
  }
  const paragraphs = ['First sentence. Second sentence.', 'Last paragraph.'].map(text => { const p = new Element(); p.textContent = text; return p; });
  const backgrounds = [new Element(), new Element(), new Element()];
  const get = id => { if (!elements.has(id)) elements.set(id, id === 'bgMusic' ? new Audio() : new Element()); return elements.get(id); };
  document = {
    getElementById: get, createElement: () => new Element(), documentElement: new Element(), body: new Element(),
    querySelectorAll(selector) { if (selector === '.story-body p') return paragraphs; if (selector === '.story-body p.speaking') return paragraphs.filter(p => p.classList.contains('speaking')); if (selector === '.wrap, .account-dock, .music-dock') return backgrounds; return []; },
    querySelector: () => null,
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }
  };
  document.activeElement = new Element();
  get('musicPanel').hidden = true;
  const synth = { getVoices: () => voices || [{ name: 'Natural', lang: 'en-US' }, { name: 'Natural', lang: 'fr-FR' }, { name: 'Natural', lang: 'sw-KE' }, { name: 'Natural', lang: 'sv-SE' }],
    speak: u => { spoken.push(u); synth.speaking = true; }, pause() { this.paused = true; }, resume() { this.paused = false; }, cancel() { this.speaking = false; this.paused = false; } };
  const location = { search, hash: '', pathname: '/', hostname: 'malakaistory.com', origin: 'https://malakaistory.com' };
  const context = vm.createContext({ document, window: { speechSynthesis: synth, matchMedia: () => ({ matches: true }) }, location,
    history: { replaceState: (_, __, url) => { location.hash = url.startsWith('#') ? url : ''; } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    Audio, SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, URLSearchParams, AbortController,
    fetch: (url, options) => url.endsWith('/ask?capabilities=1') ? availability(url, options) : fetcher(url, options), console, Date: class extends Date { static now() { return clock; } },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  const run = code => vm.runInContext(code, context);
  return { get, run, recordings, spoken, synth, backgrounds, location, storage,
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } },
    event(name, target) { for (const fn of events.get(name) || []) fn({ target }); }
  };
}

test('guest homepage includes a story, collections, real counts and keyboard story links', () => {
  const a = app();
  assert.match(a.get('featuredPick').innerHTML, /Tonight&#39;s story|Tonight's story/);
  assert.match(a.get('featuredPick').innerHTML, /data-listen/);
  assert.match(a.get('collections').innerHTML, /Curious minds/);
  assert.equal(a.get('countLine').textContent, `${storyCount} stories`);
  assert.equal((a.get('grid').innerHTML.match(/<a class="card/g) || []).length, storyCount);
  assert.match(a.get('voiceOffer').innerHTML, /your-voice.html/);
  a.run('collectionFilter = "africa"; render()');
  assert.equal(a.get('countLine').textContent, `${a.run('STORIES.filter(s => s.region === "africa").length')} stories`);
  a.run('searchQuery = "<img src=x onerror=alert(1)>"; render()');
  assert.ok(!a.get('grid').innerHTML.includes('<img'));
});

test('available language and length options follow actual translations', () => {
  const a = app();
  for (const language of ['en', 'fr', 'sw', 'ki', 'sv']) {
    a.run(`setLang("${language}"); render()`);
    const count = a.run('inLang().length');
    assert.equal((a.get('grid').innerHTML.match(/<a class="card/g) || []).length, count);
    assert.ok(count > 0);
  }
  assert.equal(a.run('lengthsFor(STORIES.find(s => s.id === "newton")).includes("m")'), false);
});

test('old narration responses cannot play after switching stories or closing', async () => {
  const first = deferred(), second = deferred();
  let count = 0;
  const a = app({ fetcher: () => (++count === 1 ? first.promise : second.promise) });
  a.run('openReader("maathai")');
  const old = a.run('startNarration()');
  a.run('openReader("ngugi")');
  const current = a.run('startNarration()');
  first.resolve(response('https://example.test/old.mp3'));
  await old;
  assert.equal(a.recordings.at(-1).plays, 0);
  second.resolve(response('https://example.test/new.mp3'));
  await current;
  assert.equal(a.recordings.at(-1).src, 'https://example.test/new.mp3');
  a.run('closeReader()');
  assert.equal(a.recordings.at(-1).paused, true);
  assert.equal(a.run('narrationState'), 'idle');
  assert.ok(a.backgrounds.every(el => !el.inert));
});

test('cancel while preparing prevents later playback', async () => {
  const pending = deferred();
  const a = app({ fetcher: () => pending.promise });
  a.run('openReader("maathai")');
  const playing = a.run('startNarration()');
  await a.run('toggleNarration()');
  pending.resolve(response('https://example.test/cancelled.mp3'));
  await playing;
  assert.equal(a.recordings.at(-1).plays, 0);
  assert.equal(a.run('narrationState'), 'idle');
});

test('recorded audio pauses, resumes, seeks and stops both sounds at the sleep deadline', async () => {
  const a = app();
  a.run('openReader("maathai")');
  await a.run('startNarration()');
  const audio = a.recordings.at(-1);
  audio.currentTime = 37;
  await a.run('toggleNarration()');
  assert.equal(audio.paused, true);
  assert.equal(a.run('narrationState'), 'paused');
  await a.run('toggleNarration()');
  assert.equal(audio.currentTime, 37);
  assert.equal(audio.paused, false);
  a.event('change', { id: 'audioSeek', value: 76 });
  assert.equal(audio.currentTime, 76);
  a.get('bgMusic').play();
  a.run('setSleepTimer(5)');
  a.advance(5 * 60000);
  assert.equal(audio.paused, true);
  assert.equal(a.get('bgMusic').paused, true);
  assert.equal(a.run('sleepDeadline'), 0);
});

test('device voice fallback resumes between sentences and keeps the selected narrator', async () => {
  const a = app({ fetcher: async () => response(null, false) });
  a.run('openReader("maathai")');
  await a.run('startNarration()');
  assert.equal(a.run('narrator'), 'sarah');
  assert.equal(a.spoken.length, 1);
  a.spoken[0].onend();
  await a.run('toggleNarration()');
  a.advance(1000);
  assert.equal(a.spoken.length, 1);
  await a.run('toggleNarration()');
  assert.equal(a.spoken.length, 2);
  assert.equal(a.spoken[1].text, 'Second sentence.');
  a.run('closeReader()');
  a.spoken[1].onend();
  a.advance(1000);
  assert.equal(a.spoken.length, 2);
});

test('voice packs use the language on screen, not the interface fallback language', async () => {
  const requested = [];
  const a = app({ search: '?voice=test-family', stored: { lang: 'sv' }, fetcher: async (url, opts) => {
    requested.push([url, opts?.method]);
    return response(null, opts?.method === 'HEAD');
  } });
  a.run('openReader("newton")');
  await a.run('startNarration()');
  assert.ok(requested.some(([url, method]) => method === 'HEAD' && url.endsWith('/newton-sv.mp3')));
  assert.match(a.recordings.at(-1).src, /newton-sv.mp3$/);
});

test('missing device-language voice is explained without reading a different language', async () => {
  const a = app({ fetcher: async () => response(null, false), voices: [{ name: 'English', lang: 'en-US' }], stored: { lang: 'sw' } });
  a.run('openReader("maathai")');
  await a.run('startNarration()');
  assert.equal(a.spoken.length, 0);
  assert.equal(a.run('narrationState'), 'idle');
  assert.match(a.get('audioStatus').textContent, /haipatikani/);
});

test('generated biography and marketing counts match the content source', () => {
  const a = app();
  assert.equal(a.run('STORIES.find(s => s.id === "ngugi").years'), '1938–2025');
  assert.ok(html.includes(`name="description" content="${storyCount} true bedtime stories`));
  a.run('openReader("ngugi")');
  assert.match(a.get('reader').innerHTML, /One little question/);
  assert.match(a.get('reader').innerHTML, /news.uci.edu/);
});

const ratingToken = '3a5d7eb1-690b-4d23-b764-a0b40f6e3a25';
const askReply = (body = {}, status = 200) => ({ ok: status < 400, status, json: async () => ({ id: 7, reviewVersion: 1, suitable: true, answer: 'Trees need water to grow. What can you notice about a leaf?', remaining: 1, ratingToken, ...body }) });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function beginAsk(a, story = 'maathai') {
  await a.run(`openReader("${story}"); startAsk()`);
  // The DOM stand-in does not parse select/option markup.
  a.get('askAge').value = '5-7';
}

test('Ask why requires a parent and age choice, then hides the AI draft until parent preview', async () => {
  const calls = [];
  const a = app({ stored: { childName: 'Malakai', lang: 'sw' }, fetcher: async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), signal: opts.signal });
    return askReply({ answer: 'Miti inahitaji <b>maji</b>. Unaona nini kwenye jani?' });
  } });
  a.run('openReader("maathai")');
  assert.match(a.get('reader').innerHTML, /id="askForm" hidden/);
  assert.match(a.get('reader').innerHTML, /AI inaweza kukosea/);
  a.get('askInput').value = 'Kwa nini miti ilikufa?';
  await a.run('submitAsk()');
  assert.equal(calls.length, 0);
  await a.run('startAsk()');
  await a.run('submitAsk()');
  assert.equal(calls.length, 0);
  a.get('askAge').value = '5-7';
  await a.run('submitAsk()');
  assert.deepEqual(calls[0].body, { story: 'maathai', lang: 'sw', length: 'short', question: 'Kwa nini miti ilikufa?', age: '5-7', parentPresent: true });
  assert.equal(calls[0].signal.aborted, true); // controller is released after completion
  assert.ok(!a.get('askAnswers').innerHTML.includes('Miti inahitaji'));
  a.run('reviewAsk(0, "approve")');
  assert.equal(a.run('askThread.items[0].approved'), false);
  a.run('reviewAsk(0, "preview")');
  assert.match(a.get('askAnswers').innerHTML, /&lt;b&gt;maji&lt;\/b&gt;/);
  assert.ok(!a.get('askAnswers').innerHTML.includes('<b>'));
  a.run('reviewAsk(0, "approve")');
  assert.equal(a.run('askThread.items[0].approved'), true);
  assert.match(a.get('askAnswers').innerHTML, /tayari kusoma pamoja/);
  assert.equal(a.spoken.length, 0);
  assert.equal(a.get('askInput').value, '');
  assert.ok([...a.storage.values()].every(v => !String(v).includes('Kwa nini miti')));
});

test('feedback is saved only after server confirmation and uses the private answer token', async () => {
  const calls = []; let failRating = true;
  const a = app({ fetcher: async (_, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    if (body.rate) return { ok: !failRating, status: failRating ? 503 : 200, json: async () => ({ ok: !failRating }) };
    return askReply();
  } });
  await beginAsk(a); a.get('askInput').value = 'Why do trees grow?';
  await a.run('submitAsk()'); a.run('reviewAsk(0, "preview")');
  await a.run('rateAsk(0, true)');
  assert.equal(a.run('askThread.items[0].rating'), 0);
  assert.match(a.get('askNote').textContent, /wasn't saved/);
  failRating = false;
  await a.run('rateAsk(0, false)');
  assert.deepEqual(calls.at(-1), { rate: 7, ratingToken, good: false });
  assert.equal(a.run('askThread.items[0].rating'), -1);
  assert.match(a.get('askAnswers').innerHTML, /Feedback saved/);
});

test('parent notes cannot be approved for reading; malformed drafts preserve the question', async () => {
  let reply = askReply({ suitable: false, answer: 'A conversation with you will help.' });
  const a = app({ fetcher: async () => reply });
  await beginAsk(a, 'ngugi'); a.get('askInput').value = 'A difficult question';
  await a.run('submitAsk()'); a.run('reviewAsk(0, "preview"); reviewAsk(0, "approve")');
  assert.match(a.get('askAnswers').innerHTML, /A note for the parent/);
  assert.equal(a.run('askThread.items[0].approved'), false);
  assert.ok(!a.get('askAnswers').innerHTML.includes('data-ask-approve'));
  for (const bad of [{ reviewVersion: undefined }, { suitable: undefined }, { suitable: 'true' }, { answer: '' }, { answer: 'a'.repeat(1601) }]) {
    reply = askReply(bad); a.get('askInput').value = 'Why is that?';
    await a.run('submitAsk()');
    assert.equal(a.run('askThread.items.length'), 1);
    assert.equal(a.get('askInput').value, 'Why is that?');
    assert.match(a.get('askNote').textContent, /couldn't prepare/);
    assert.equal(a.get('askBtn').disabled, false);
  }
});

test('the allowance encourages curiosity, honours retry timing, and leaves offline prompts available', async () => {
  let calls = 0;
  const a = app({ fetcher: async () => { calls++; return askReply({ error: 'limit', remaining: 0, retryAfter: 3600 }, 429); } });
  await beginAsk(a); a.get('askInput').value = 'Why do trees grow?';
  await a.run('submitAsk()');
  assert.match(a.get('askNote').textContent, /Keep wondering together/);
  assert.match(a.get('askNote').textContent, /about 1 hour/);
  await a.run('submitAsk()'); assert.equal(calls, 1);
  a.run('useAskStarter()');
  assert.equal(a.get('askInput').value, a.run('STORIES.find(s => s.id === "maathai").question.en'));
  a.advance(3600001); await a.run('submitAsk()'); assert.equal(calls, 2);
});

test('old replies cannot cross story, language, close/reopen, clear or account changes', async () => {
  for (const change of ['openReader("ngugi")', 'setLang("fr")', 'closeReader(); openReader("maathai")', 'clearAsk()', 'saveSession({user_id: "another-parent", access_token: "example"})']) {
    const pending = deferred(); let signal;
    const a = app({ fetcher: (_, opts) => { signal = opts.signal; return pending.promise; } });
    await beginAsk(a); a.get('askInput').value = 'Why do trees grow?';
    const old = a.run('submitAsk()'); await tick();
    a.run(change);
    assert.equal(signal.aborted, true, change);
    pending.resolve(askReply({ answer: 'Old reply' })); await old;
    assert.equal(a.run('askThread.items.length'), 0, change);
    assert.ok(!a.get('askAnswers').innerHTML.includes('Old reply'), change);
  }
});

test('timeout releases controls and a late response cannot interfere with the next question', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const a = app({ fetcher: () => ++calls === 1 ? first.promise : second.promise });
  await beginAsk(a); a.get('askInput').value = 'First question';
  const old = a.run('submitAsk()'); await tick();
  a.advance(55000);
  assert.match(a.get('askNote').textContent, /taking too long/);
  assert.equal(a.get('askBtn').disabled, false);
  a.get('askInput').value = 'New question';
  const current = a.run('submitAsk()'); await tick();
  first.resolve(askReply({ answer: 'Old answer' })); await old;
  assert.equal(a.get('askBtn').disabled, true);
  assert.equal(a.run('askThread.items.length'), 0);
  second.resolve(askReply({ answer: 'Current answer' })); await current;
  assert.equal(a.run('askThread.items[0].answer'), 'Current answer');
  a.run('closeReader()');
  assert.equal(a.run('askThread.items.length'), 0);
  assert.equal(a.get('askBox').innerHTML, '');
});

test('Ask why uses the selected story length and never silently changes an unsupported language', async () => {
  const calls = [];
  const a = app({ fetcher: async (_, opts) => { calls.push(JSON.parse(opts.body)); return askReply(); } });
  await beginAsk(a); a.run('storyLen = "m"'); a.get('askInput').value = 'Why did she start planting?';
  await a.run('submitAsk()'); assert.equal(calls[0].length, 'm');
  a.run('setLang("sv"); openReader("newton"); startAsk()');
  assert.match(a.get('reader').innerHTML, /currently supports English, Kiswahili and French/);
  assert.ok(!a.get('reader').innerHTML.includes('id="askInput"'));
  await a.run('submitAsk()'); assert.equal(calls.length, 1);
});

test('a timed-out feedback request cannot overwrite a subsequent rating', async () => {
  const late = deferred(); let ratings = 0;
  const a = app({ fetcher: async (_, opts) => {
    const body = JSON.parse(opts.body);
    if (!body.rate) return askReply();
    if (++ratings === 1) return late.promise;
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  await beginAsk(a); a.get('askInput').value = 'Why do trees grow?';
  await a.run('submitAsk()'); a.run('reviewAsk(0, "preview")');
  const first = a.run('rateAsk(0, true)'); await tick();
  a.advance(12000);
  assert.equal(a.run('askThread.items[0].ratingBusy'), false);
  assert.match(a.get('askNote').textContent, /wasn't saved/);
  await a.run('rateAsk(0, false)');
  assert.equal(a.run('askThread.items[0].rating'), -1);
  late.resolve({ ok: true, json: async () => ({ ok: true }) }); await first;
  assert.equal(a.run('askThread.items[0].rating'), -1);
});

test('an old or unavailable answer service cannot receive a question; offline exploration remains usable', async () => {
  for (const availability of [
    async () => ({ ok: false, json: async () => ({ error: 'POST only' }) }),
    async () => ({ ok: true, json: async () => ({ reviewVersion: 1, ready: false }) }),
    async () => ({ ok: true, json: async () => ({ ready: true }) }),
    async () => { throw new Error('network unavailable'); },
  ]) {
    let sent = 0;
    const a = app({ availability, fetcher: async () => { sent++; return askReply(); } });
    await beginAsk(a);
    a.get('askInput').value = 'Why do trees need water?';
    await a.run('submitAsk()');
    assert.equal(sent, 0);
    assert.equal(a.get('askForm').hidden, true);
    assert.equal(a.get('askOffline').open, true);
    assert.equal(a.get('askStart').disabled, false);
    assert.match(a.get('askNote').textContent, /No question has been sent/);
    assert.match(a.get('reader').innerHTML, /Explore together without AI/);
    assert.equal(a.run('askThread.serviceReady'), false);
  }
});

test('availability timeout and closing a story invalidate late checks and permit a fresh retry', async () => {
  for (const change of ['closeReader(); openReader("ngugi")', 'timeout']) {
    const pending = deferred(); let calls = 0, signal;
    const a = app({ availability: (_, options) => {
      signal = options.signal;
      return ++calls === 1 ? pending.promise : Promise.resolve({ ok: true, json: async () => ({ reviewVersion: 1, ready: true }) });
    } });
    const first = a.run('openReader("maathai"); startAsk()');
    if (change === 'timeout') a.advance(8000); else a.run(change);
    assert.equal(signal.aborted, true);
    assert.equal(a.run('askThread.serviceReady'), false);
    await a.run('startAsk()');
    assert.equal(a.run('askThread.serviceReady'), true);
    pending.resolve({ ok: false, json: async () => ({ ready: false }) });
    await first;
    assert.equal(a.run('askThread.serviceReady'), true);
    assert.equal(a.get('askForm').hidden, false);
  }
});

test('Wonder together pauses a playing story and offers age-appropriate offline prompts', async () => {
  const a = app({ stored: { childAge: 'u2' } });
  a.run('openReader("maathai")');
  await a.run('startNarration()');
  a.run('jumpToAsk()');
  assert.equal(a.run('narrationState'), 'paused');
  assert.equal(a.run('askThread.parentReady'), false);
  assert.match(a.run('offlineAskSteps()'), /No questions to answer/);
  a.event('change', { id: 'askAge', value: '2-4' });
  assert.match(a.get('askOfflineSteps').innerHTML, /Which part of the story/);
  a.run('setLang("fr")');
  assert.match(a.run('offlineAskSteps("u2")'), /Aucune question/);
  a.run('setLang("sw")');
  assert.match(a.run('offlineAskSteps("u2")'), /Hakuna maswali/);
});
