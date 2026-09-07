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

function app({ fetcher = async () => response('https://example.test/story.mp3'), search = '', stored = {}, voices } = {}) {
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
    fetch: fetcher, console, Date: class extends Date { static now() { return clock; } },
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
