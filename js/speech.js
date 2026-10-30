// speech.js — "Read aloud": the device's own voices read the book to you.
//
// Think of it as a narrator holding a bookmark: the book is cut into
// sentences, the narrator reads one, moves the bookmark, reads the next,
// and at the end of a chapter turns the page by itself. Pausing just
// remembers where the bookmark is.

const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

export const speechSupported = () => !!(synth && window.SpeechSynthesisUtterance);

/**
 * iPhones and iPads only let a page start speaking straight from a tap.
 * Call this first thing inside the tap so the narrator is allowed to talk later.
 */
export function unlockSpeech() {
  if (!speechSupported() || unlockSpeech.done) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
    unlockSpeech.done = true;
  } catch { /* ignore */ }
}

// Joke and low-quality voices Apple ships alongside the real ones
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Jester|Junior|Organ|Pipe Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Ralph|Kathy|Princess|Bruce|Agnes|Vicki|Victoria|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;

/** How natural a voice is likely to sound: Premium > Enhanced > the rest. */
export function voiceQuality(v) {
  const id = `${v.name} ${v.voiceURI}`.toLowerCase();
  if (id.includes('premium')) return 3;
  if (id.includes('enhanced') || id.includes('neural') || id.includes('natural')) return 2;
  if (id.includes('siri')) return 2;
  return 1;
}

export function voiceLabel(v) {
  const q = voiceQuality(v);
  const name = v.name.replace(/\s*\((Enhanced|Premium)\)\s*/i, '').trim();
  return { name, tag: q === 3 ? 'Premium' : q === 2 ? 'Enhanced' : '' };
}

const langPart = (tag) => (tag || '').toLowerCase().split(/[-_]/)[0];

/** The voices worth offering for a language, best first. */
export function voicesFor(lang) {
  if (!synth) return [];
  const want = langPart(lang);
  const all = synth.getVoices().filter((v) => !NOVELTY.test(v.name));
  const matching = all.filter((v) => langPart(v.lang) === want);
  const list = matching.length ? matching : all;
  const region = (lang || '').toLowerCase().replace('_', '-');
  return list.sort((a, b) => (voiceQuality(b) - voiceQuality(a))
    || ((b.lang.toLowerCase() === region) - (a.lang.toLowerCase() === region))
    || ((b.localService ? 1 : 0) - (a.localService ? 1 : 0))
    || a.name.localeCompare(b.name));
}

/** Voices load a moment after the app starts; wait for them (max ~1.5 s). */
export function voicesReady() {
  if (!synth) return Promise.resolve([]);
  if (synth.getVoices().length) return Promise.resolve(synth.getVoices());
  return new Promise((resolve) => {
    const done = () => { synth.removeEventListener?.('voiceschanged', done); resolve(synth.getVoices()); };
    synth.addEventListener?.('voiceschanged', done);
    setTimeout(done, 1500);
  });
}

/**
 * Cut text into sentence-sized pieces: [[start, end], ...] offsets.
 * Very long sentences are cut again at a comma or space, because iPhones
 * sometimes go silent on one very long utterance.
 */
export function splitSentences(text, lang) {
  const pieces = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
    for (const s of seg.segment(text)) pieces.push([s.index, s.index + s.segment.length]);
  } else {
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(text)) && m[0]) pieces.push([m.index, m.index + m[0].length]);
  }
  const out = [];
  const MAX = 260;
  for (let [a, b] of pieces) {
    while (b - a > MAX) {
      const chunk = text.slice(a, a + MAX);
      let cut = Math.max(chunk.lastIndexOf(', '), chunk.lastIndexOf('; '), chunk.lastIndexOf(': '));
      if (cut < MAX / 3) cut = chunk.lastIndexOf(' ');
      if (cut < MAX / 3) cut = MAX - 1;
      out.push([a, a + cut + 1]);
      a += cut + 1;
    }
    out.push([a, b]);
  }
  // Drop pieces with nothing to say; glue tiny fragments ("I.", "1.") onto the next one
  const spoken = out.filter(([a, b]) => /[\p{L}\p{N}]/u.test(text.slice(a, b)));
  const merged = [];
  for (let i = 0; i < spoken.length; i++) {
    const [a, b] = spoken[i];
    if (text.slice(a, b).trim().length < 4 && i + 1 < spoken.length) { spoken[i + 1][0] = a; continue; }
    merged.push([a, b]);
  }
  return merged;
}

/**
 * The narrator. Works with any reader that offers:
 *   speechSection(fromView) → { units: [{ text }], start }   sentences of the chapter/page on screen
 *   speechNextSection()     → Promise<{ units, start } | null>  turn to the next chapter/page
 *   speechShow(unit)        mark the sentence being read and keep it in view
 *   speechInView(unit)      is that sentence still on screen?
 *   speechClear()           remove the mark
 */
export class ReadAloud {
  constructor({ reader, lang, getVoiceURI, rate = 1, onState }) {
    this.reader = reader;
    this.lang = lang || navigator.language || 'en';
    this.getVoiceURI = getVoiceURI;
    this.rate = rate;
    this.onState = onState || (() => {});
    this.playing = false;
    this.units = null;
    this.index = 0;
    this.token = 0;
    this.turning = false;
    this.wakeLock = null;
    this.onVisibility = () => {
      // Coming back to the app: iOS may have silenced the voice meanwhile
      if (document.visibilityState === 'visible' && this.playing && !synth.speaking) this.speak();
      if (document.visibilityState === 'visible' && this.playing) this.keepAwake();
    };
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get voice() {
    const uri = this.getVoiceURI?.();
    const all = synth.getVoices();
    return all.find((v) => v.voiceURI === uri) || voicesFor(this.lang)[0] || null;
  }

  async play() {
    if (!speechSupported()) return;
    await voicesReady();
    // Start where the reader is looking: if they scrolled away since pausing, follow them
    if (!this.units || !this.units.length || !this.reader.speechInView(this.units[this.index])) {
      const section = await this.reader.speechSection(true);
      this.units = section.units;
      this.index = section.start;
    }
    if (!this.units.length) {
      const next = await this.turn();
      if (!next) return;
    }
    this.playing = true;
    this.keepAwake();
    this.onState(this.state());
    this.speak();
  }

  pause() {
    this.playing = false;
    this.token++;
    synth?.cancel();
    this.releaseWake();
    this.onState(this.state());
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  /** Jump a sentence forward (+1) or back (-1). */
  async skip(delta) {
    if (!this.units) {
      const section = await this.reader.speechSection(true);
      this.units = section.units;
      this.index = section.start;
    }
    const target = this.index + delta;
    if (target >= this.units.length) {
      if (!(await this.turn())) return;
    } else {
      this.index = Math.max(0, target);
    }
    if (this.playing) { this.token++; synth.cancel(); this.speak(); }
    else if (this.units[this.index]) this.reader.speechShow(this.units[this.index]);
    this.onState(this.state());
  }

  setRate(rate) {
    this.rate = rate;
    if (this.playing) { this.token++; synth.cancel(); this.speak(); }
  }

  /** The voice changed: carry on in the new voice from the same sentence. */
  restartSentence() {
    if (this.playing) { this.token++; synth.cancel(); this.speak(); }
  }

  /** The book moved without us (contents, links, next-chapter button): start over from the view. */
  invalidate() {
    if (this.turning) return;
    const was = this.playing;
    this.token++;
    synth?.cancel();
    this.units = null;
    this.index = 0;
    this.reader.speechClear?.();
    if (was) { this.playing = false; this.releaseWake(); this.onState(this.state()); }
  }

  /** Text changed underneath (e.g. a new highlight split a sentence): re-read the sentence map. */
  async refresh() {
    if (!this.units) return;
    const keep = this.index;
    const section = await this.reader.speechSection(false);
    this.units = section.units;
    this.index = Math.min(keep, Math.max(0, this.units.length - 1));
    if (this.playing && this.units[this.index]) this.reader.speechShow(this.units[this.index]);
  }

  async turn() {
    this.turning = true;
    try {
      const next = await this.reader.speechNextSection();
      if (!next) {
        this.playing = false;
        this.units = null;
        this.reader.speechClear();
        this.releaseWake();
        this.onState({ ...this.state(), finished: true });
        return false;
      }
      this.units = next.units;
      this.index = next.start;
      if (!this.units.length) return this.turn();
      return true;
    } finally {
      this.turning = false;
    }
  }

  speak() {
    const unit = this.units?.[this.index];
    if (!unit) return;
    const token = ++this.token;
    this.reader.speechShow(unit);
    const u = new SpeechSynthesisUtterance(unit.text);
    const voice = this.voice;
    if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = this.lang;
    u.rate = this.rate;
    u.onend = async () => {
      if (token !== this.token || !this.playing) return;
      if (this.index + 1 < this.units.length) this.index++;
      else if (!(await this.turn())) return;
      if (token !== this.token || !this.playing) return;
      this.onState(this.state());
      this.speak();
    };
    u.onerror = (e) => {
      if (token !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
      u.onend();
    };
    // A short breath after cancel(): Safari sometimes drops an utterance queued at the same instant
    synth.cancel();
    setTimeout(() => { if (token === this.token && this.playing) synth.speak(u); }, 60);
  }

  state() {
    return { playing: this.playing, index: this.index, count: this.units?.length || 0 };
  }

  // Keep the screen on while listening: when an iPhone/iPad locks, it stops the voice
  async keepAwake() {
    try {
      if (navigator.wakeLock && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
      }
    } catch { /* not allowed here; fine */ }
  }

  releaseWake() {
    try { this.wakeLock?.release(); } catch { /* already gone */ }
    this.wakeLock = null;
  }

  destroy() {
    this.token++;
    this.playing = false;
    synth?.cancel();
    this.releaseWake();
    this.reader.speechClear?.();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}
