const DEFAULT_CONFIG_PATH = "src/data/game-config.json";

const RUNTIME = Object.freeze({
  STANDALONE: "standalone"
});

const GAME_STATES = Object.freeze({
  INTRO: "intro",
  PLAY: "play",
  FEEDBACK: "feedback",
  END: "end"
});

const PROGRESS_STORAGE_KEY = "impuro-progress-v1";

const ACTIVE_GAMES = new WeakMap();
let CURRENT_ROOT = null;

function cloneData(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function toParagraphs(items) {
  return ensureArray(items)
    .map((item) => `<p>${escapeHtml(item)}</p>`)
    .join("");
}

function resolveRank(rankings, score) {
  return ensureArray(rankings)
    .slice()
    .sort((left, right) => Number(right.minScore || 0) - Number(left.minScore || 0))
    .find((ranking) => score >= Number(ranking.minScore || 0));
}

class StateMachine {
  constructor(initialState, transitions) {
    this.initialState = initialState;
    this.current = initialState;
    this.transitions = transitions || {};
  }

  canTransition(nextState) {
    return ensureArray(this.transitions[this.current]).includes(nextState);
  }

  transition(nextState) {
    if (nextState === this.current) {
      return true;
    }

    if (!this.canTransition(nextState)) {
      return false;
    }

    this.current = nextState;
    return true;
  }

  reset() {
    this.current = this.initialState;
    return this.current;
  }
}

class AudioManager {
  static activeBackgroundAudios = new Set();

  constructor(config = {}) {
    this.enabled = Boolean(config.enabled);
    this.basePath = String(config.basePath || "").replace(/\/+$/, "");
    this.volume = Number.isFinite(Number(config.volume)) ? Number(config.volume) : 0.8;
    this.musicVolume = Number.isFinite(Number(config.musicVolume)) ? Number(config.musicVolume) : 0.55;
    this.background = config.background || {};
    this.events = config.events || {};
    this.currentBackgroundName = null;
    this.currentBackgroundSource = null;
    this.backgroundAudio = null;
    this.backgroundPaused = false;
  }

  resolveSource(name) {
    const event = this.events?.[name];
    const sourceName = event?.file || this.background?.[name] || name;
    if (!sourceName) {
      return null;
    }

    if (/^https?:\/\//i.test(sourceName) || sourceName.startsWith("data:") || sourceName.startsWith("blob:")) {
      return sourceName;
    }

    if (!this.basePath) {
      return sourceName;
    }

    return `${this.basePath}/${sourceName}`;
  }

  play(name) {
    if (!this.enabled) {
      return;
    }

    const source = this.resolveSource(name);
    if (!source) {
      return;
    }

    const audio = new Audio(source);
    audio.volume = this.volume;
    audio.play().catch(() => {});
  }

  playBackground(name) {
    if (!this.enabled) {
      return;
    }

    const source = this.resolveSource(name);
    if (!source || this.currentBackgroundSource === source) {
      if (this.backgroundAudio && this.backgroundPaused) {
        this.backgroundAudio.play().catch(() => {});
        this.backgroundPaused = false;
      }
      return;
    }

    this.stopBackground();

    // Prevent duplicated music loops across retries or accidental multiple instances.
    AudioManager.activeBackgroundAudios.forEach((track) => {
      try {
        track.pause();
        track.currentTime = 0;
      } catch (_error) {
        // Ignore media cleanup errors.
      }
    });
    AudioManager.activeBackgroundAudios.clear();

    const audio = new Audio(source);
    audio.loop = true;
    audio.volume = this.musicVolume;
    AudioManager.activeBackgroundAudios.add(audio);
    this.backgroundAudio = audio;
    this.currentBackgroundName = name;
    this.currentBackgroundSource = source;
    this.backgroundPaused = false;
    audio.play().catch(() => {
      if (this.backgroundAudio === audio) {
        this.stopBackground();
      }
    });
  }

  pauseBackground() {
    if (this.backgroundAudio && !this.backgroundPaused) {
      this.backgroundAudio.pause();
      this.backgroundPaused = true;
    }
  }

  resumeBackground() {
    if (!this.enabled) {
      return;
    }

    if (this.backgroundAudio && this.backgroundPaused) {
      this.backgroundAudio.play().catch(() => {});
      this.backgroundPaused = false;
      return;
    }

    if (this.currentBackgroundName) {
      this.playBackground(this.currentBackgroundName);
    }
  }

  stopBackground() {
    if (this.backgroundAudio) {
      this.backgroundAudio.pause();
      this.backgroundAudio.currentTime = 0;
      AudioManager.activeBackgroundAudios.delete(this.backgroundAudio);
      this.backgroundAudio = null;
    }

    this.currentBackgroundName = null;
    this.currentBackgroundSource = null;
    this.backgroundPaused = false;
  }
}

// ---------------------------------------------------------------------------
// SynthAudioManager — Web Audio API synthesizer, no external files required.
// Extends AudioManager keeping the exact same public interface so the rest of
// the game code never needs to change.
// ---------------------------------------------------------------------------
class SynthAudioManager extends AudioManager {
  constructor(config = {}) {
    super(config);
    this._ctx = null;           // AudioContext — created on first user gesture
    this._bgNodes = null;       // { oscillators, gainNode } for the current loop
    this._bgName = null;        // logical name of the running background track
    this._bgPaused = false;
    this._bgGainTarget = 0;
  }

  // ------------------------------------------------------------------
  // AudioContext — lazy init; browsers block audio before a user gesture
  // ------------------------------------------------------------------
  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._ctx.state === "suspended") {
      this._ctx.resume().catch(() => {});
    }
    return this._ctx;
  }

  // ------------------------------------------------------------------
  // Low-level helpers
  // ------------------------------------------------------------------

  /** Schedule a gain ramp from current value to `value` over `duration` seconds. */
  _ramp(gainNode, value, duration, ctx) {
    const t = ctx.currentTime;
    gainNode.gain.cancelScheduledValues(t);
    gainNode.gain.setValueAtTime(gainNode.gain.value, t);
    gainNode.gain.linearRampToValueAtTime(value, t + duration);
  }

  /**
   * Create a chain: oscillator(s) → gain → masterGain → destination.
   * Returns { oscillators, gainNode, masterGain } so callers can clean up.
   */
  _createOscChain(ctx, specs, gainValue, masterVolume) {
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, ctx.currentTime);
    masterGain.connect(ctx.destination);

    const oscillators = specs.map(({ type, freq, detuneValue }) => {
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      if (detuneValue) {
        osc.detune.setValueAtTime(detuneValue, ctx.currentTime);
      }
      oscGain.gain.setValueAtTime(gainValue, ctx.currentTime);
      osc.connect(oscGain);
      oscGain.connect(masterGain);
      osc.start();
      return osc;
    });

    // Fade in
    masterGain.gain.linearRampToValueAtTime(masterVolume, ctx.currentTime + 0.04);

    return { oscillators, masterGain };
  }

  /** Play a one-shot envelope: attack → sustain → release. */
  _oneShot(specs, { attack = 0.01, sustain = 0.12, release = 0.18, volume = 0.18 } = {}) {
    if (!this.enabled) {
      return;
    }
    const ctx = this._getCtx();
    const master = ctx.createGain();
    master.gain.setValueAtTime(0, ctx.currentTime);
    master.connect(ctx.destination);

    const oscs = specs.map(({ type, freq, freqEnd, detuneValue, gainScale = 1 }) => {
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      if (freqEnd !== undefined) {
        osc.frequency.linearRampToValueAtTime(freqEnd, ctx.currentTime + attack + sustain + release);
      }
      if (detuneValue) {
        osc.detune.setValueAtTime(detuneValue, ctx.currentTime);
      }
      oscGain.gain.setValueAtTime(gainScale, ctx.currentTime);
      osc.connect(oscGain);
      oscGain.connect(master);
      osc.start();
      return osc;
    });

    const t = ctx.currentTime;
    master.gain.linearRampToValueAtTime(volume, t + attack);
    master.gain.setValueAtTime(volume, t + attack + sustain);
    master.gain.linearRampToValueAtTime(0, t + attack + sustain + release);

    const total = attack + sustain + release + 0.05;
    oscs.forEach((osc) => osc.stop(ctx.currentTime + total));
  }

  /** Sequence of one-shots played with offsets (simple arpeggio / melody). */
  _sequence(notes, globalOpts = {}) {
    if (!this.enabled) {
      return;
    }
    const ctx = this._getCtx();
    const { volume = 0.18, attack = 0.01, sustain = 0.1, release = 0.12, type = "sine" } = globalOpts;

    notes.forEach(({ freq, offset = 0, dur = sustain, vol = volume, oscType = type }) => {
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.connect(ctx.destination);

      const osc = ctx.createOscillator();
      osc.type = oscType;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(master);
      osc.start(ctx.currentTime + offset);

      const t0 = ctx.currentTime + offset;
      master.gain.setValueAtTime(0, t0);
      master.gain.linearRampToValueAtTime(vol, t0 + attack);
      master.gain.setValueAtTime(vol, t0 + attack + dur);
      master.gain.linearRampToValueAtTime(0, t0 + attack + dur + release);
      osc.stop(t0 + attack + dur + release + 0.05);
    });
  }

  // ------------------------------------------------------------------
  // Sound event synthesizers
  // ------------------------------------------------------------------

  _sfxStart() {
    // Ascending heroic hit: two-tone percussive chord + sweep
    this._oneShot(
      [
        { type: "triangle", freq: 220, freqEnd: 440 },
        { type: "sine",     freq: 330, freqEnd: 660, gainScale: 0.6 },
      ],
      { attack: 0.02, sustain: 0.18, release: 0.35, volume: 0.22 }
    );
    // Metallic strike
    this._oneShot(
      [{ type: "square", freq: 880, freqEnd: 440, gainScale: 0.3 }],
      { attack: 0.001, sustain: 0.04, release: 0.12, volume: 0.12 }
    );
  }

  _sfxMenuOpen() {
    // Soft metallic tonk
    this._oneShot(
      [
        { type: "triangle", freq: 660 },
        { type: "sine",     freq: 990, gainScale: 0.4 },
      ],
      { attack: 0.005, sustain: 0.04, release: 0.22, volume: 0.14 }
    );
  }

  _sfxMenuClose() {
    // Inverse tonk (descending)
    this._oneShot(
      [{ type: "triangle", freq: 550, freqEnd: 330 }],
      { attack: 0.005, sustain: 0.04, release: 0.18, volume: 0.13 }
    );
  }

  _sfxStoryOpen() {
    // "Parchment unfurl": low rumble + high shimmer
    this._sequence(
      [
        { freq: 196, offset: 0,    dur: 0.08, vol: 0.1,  oscType: "triangle" },
        { freq: 392, offset: 0.06, dur: 0.08, vol: 0.12, oscType: "triangle" },
        { freq: 784, offset: 0.12, dur: 0.1,  vol: 0.1,  oscType: "sine"     },
      ],
      { attack: 0.01, release: 0.2 }
    );
  }

  _sfxStoryClose() {
    // Reverse shimmer
    this._sequence(
      [
        { freq: 784, offset: 0,    dur: 0.06, vol: 0.08, oscType: "sine"     },
        { freq: 392, offset: 0.05, dur: 0.07, vol: 0.09, oscType: "triangle" },
        { freq: 196, offset: 0.1,  dur: 0.08, vol: 0.07, oscType: "triangle" },
      ],
      { attack: 0.01, release: 0.18 }
    );
  }

  _sfxPageTurn() {
    // White noise burst shaped like a page whoosh
    if (!this.enabled) {
      return;
    }
    const ctx = this._getCtx();
    const bufferSize = ctx.sampleRate * 0.12;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i += 1) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(2200, ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.12);
    filter.Q.value = 0.8;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start();
    noise.stop(ctx.currentTime + 0.15);
  }

  _sfxCorrect() {
    // Fanfare: major triad arpeggio ascending, warm and resolving
    this._sequence(
      [
        { freq: 261.63, offset: 0,    dur: 0.1,  vol: 0.18, oscType: "triangle" }, // C4
        { freq: 329.63, offset: 0.1,  dur: 0.1,  vol: 0.18, oscType: "triangle" }, // E4
        { freq: 392.00, offset: 0.2,  dur: 0.1,  vol: 0.18, oscType: "triangle" }, // G4
        { freq: 523.25, offset: 0.3,  dur: 0.22, vol: 0.22, oscType: "sine"     }, // C5
      ],
      { attack: 0.01, release: 0.25 }
    );
    // Shimmer on top
    this._oneShot(
      [{ type: "sine", freq: 1046.5, freqEnd: 1046.5 }],
      { attack: 0.3, sustain: 0.15, release: 0.3, volume: 0.08 }
    );
  }

  _sfxIncorrect() {
    // Dissonant descending minor: low and grave
    this._sequence(
      [
        { freq: 311.13, offset: 0,    dur: 0.12, vol: 0.16, oscType: "sawtooth" }, // Eb4
        { freq: 207.65, offset: 0.12, dur: 0.18, vol: 0.16, oscType: "sawtooth" }, // Ab3
      ],
      { attack: 0.02, release: 0.28 }
    );
    // Rumble
    this._oneShot(
      [{ type: "sine", freq: 80, freqEnd: 55 }],
      { attack: 0.02, sustain: 0.12, release: 0.22, volume: 0.14 }
    );
  }

  _sfxSceneAdvance() {
    // Purposeful step forward: low strike + mid tone
    this._sequence(
      [
        { freq: 146.83, offset: 0,    dur: 0.08, vol: 0.14, oscType: "triangle" }, // D3
        { freq: 220.00, offset: 0.08, dur: 0.14, vol: 0.16, oscType: "sine"     }, // A3
        { freq: 293.66, offset: 0.2,  dur: 0.18, vol: 0.14, oscType: "triangle" }, // D4
      ],
      { attack: 0.01, release: 0.2 }
    );
  }

  _sfxEndingReveal() {
    // Full resolution: major chord swell with shimmer cascade
    this._sequence(
      [
        { freq: 130.81, offset: 0,    dur: 0.4,  vol: 0.16, oscType: "triangle" }, // C3
        { freq: 196.00, offset: 0.1,  dur: 0.35, vol: 0.14, oscType: "triangle" }, // G3
        { freq: 261.63, offset: 0.2,  dur: 0.35, vol: 0.16, oscType: "sine"     }, // C4
        { freq: 329.63, offset: 0.3,  dur: 0.35, vol: 0.16, oscType: "sine"     }, // E4
        { freq: 392.00, offset: 0.4,  dur: 0.35, vol: 0.14, oscType: "sine"     }, // G4
        { freq: 523.25, offset: 0.5,  dur: 0.5,  vol: 0.2,  oscType: "sine"     }, // C5
        { freq: 1046.5, offset: 0.65, dur: 0.4,  vol: 0.1,  oscType: "sine"     }, // C6
      ],
      { attack: 0.02, release: 0.5 }
    );
  }

  // ------------------------------------------------------------------
  // Background music synthesizer
  // Each track is a drone/ostinato loop built from oscillators.
  // We re-create the nodes on each track change and let them loop via
  // a ScriptProcessor-free approach: we schedule notes far ahead and
  // rely on the Web Audio clock. For simplicity we build a ~4-bar
  // pattern and repeat with setInterval.
  // ------------------------------------------------------------------

  _stopBgNodes() {
    if (!this._bgNodes) {
      return;
    }
    const { oscillators, masterGain } = this._bgNodes;
    const ctx = this._ctx;
    if (ctx) {
      const t = ctx.currentTime;
      masterGain.gain.cancelScheduledValues(t);
      masterGain.gain.setValueAtTime(masterGain.gain.value, t);
      masterGain.gain.linearRampToValueAtTime(0, t + 0.8);
      oscillators.forEach((osc) => {
        try { osc.stop(t + 0.9); } catch (_e) { /* already stopped */ }
      });
    }
    if (this._bgInterval) {
      clearInterval(this._bgInterval);
      this._bgInterval = null;
    }
    this._bgNodes = null;
  }

  /**
   * Build a generative ambient loop.
   * `profile` has: { rootFreqs, type, detune, vol, speed }
   */
  _startBgLoop(profile) {
    const ctx = this._getCtx();
    const { rootFreqs, type = "sine", vol = 0.08, speed = 4000 } = profile;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, ctx.currentTime);
    masterGain.connect(ctx.destination);

    // Subtle reverb via delay
    const delay = ctx.createDelay(0.6);
    delay.delayTime.setValueAtTime(0.38, ctx.currentTime);
    const delayGain = ctx.createGain();
    delayGain.gain.setValueAtTime(0.22, ctx.currentTime);
    masterGain.connect(delay);
    delay.connect(delayGain);
    delayGain.connect(masterGain);

    // One oscillator per root frequency, slightly detuned for width
    const oscillators = rootFreqs.flatMap((freq, i) => {
      const oscs = [];
      [-6, 0, 5].forEach((cents) => {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        osc.detune.setValueAtTime(cents, ctx.currentTime);
        oscGain.gain.setValueAtTime(i === 0 ? 1 : 0.6, ctx.currentTime);
        osc.connect(oscGain);
        oscGain.connect(masterGain);
        osc.start();
        oscs.push(osc);
      });
      return oscs;
    });

    // Fade in
    masterGain.gain.linearRampToValueAtTime(vol, ctx.currentTime + 2.0);

    // Slow tremolo via LFO on master gain
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.setValueAtTime(0.18, ctx.currentTime);
    lfoGain.gain.setValueAtTime(vol * 0.18, ctx.currentTime);
    lfo.connect(lfoGain);
    lfoGain.connect(masterGain.gain);
    lfo.start();
    oscillators.push(lfo);

    // Slow chord shift: every `speed` ms pick the next root as the "melody"
    let step = 0;
    const melody = rootFreqs;
    this._bgInterval = setInterval(() => {
      if (!this._bgNodes || !this._ctx || this._bgPaused) {
        return;
      }
      step = (step + 1) % melody.length;
      // Gently bump the first oscillator to the next frequency in the set
      try {
        const target = oscillators[0];
        const t = this._ctx.currentTime;
        target.frequency.cancelScheduledValues(t);
        target.frequency.setValueAtTime(target.frequency.value, t);
        target.frequency.linearRampToValueAtTime(melody[step], t + (speed / 1000) * 0.8);
      } catch (_e) { /* context may have been closed */ }
    }, speed);

    this._bgNodes = { oscillators, masterGain };
  }

  /** Map a track name to an oscillator profile. */
  _resolveTrackProfile(name) {
    // Normalize: strip extension, lowercase
    const key = String(name || "").replace(/\.[^.]+$/, "").toLowerCase();

    // Menu — mysterious, minor, low drone
    if (key.includes("menu")) {
      return { rootFreqs: [55, 82.41, 110, 164.81], type: "sine", vol: 0.07, speed: 5500 };
    }

    // Ending — majestic, major, brighter
    if (key.includes("end")) {
      return { rootFreqs: [130.81, 196, 261.63, 329.63], type: "triangle", vol: 0.08, speed: 4800 };
    }

    // Allende — martial, tense, mid-range sawtooth
    if (key.includes("allende")) {
      return { rootFreqs: [73.42, 110, 146.83, 196], type: "sawtooth", vol: 0.055, speed: 3800 };
    }

    // Hidalgo — noble, earnest, triangle
    if (key.includes("hidalgo")) {
      return { rootFreqs: [65.41, 98, 130.81, 196], type: "triangle", vol: 0.065, speed: 4200 };
    }

    // Morelos — spiritual, reflective, sine
    if (key.includes("morelos")) {
      return { rootFreqs: [87.31, 130.81, 174.61, 261.63], type: "sine", vol: 0.07, speed: 5000 };
    }

    // Generic fallback
    return { rootFreqs: [55, 82.41, 110], type: "sine", vol: 0.06, speed: 5000 };
  }

  // ------------------------------------------------------------------
  // Event dispatcher: overrides AudioManager.play()
  // ------------------------------------------------------------------
  play(name) {
    if (!this.enabled) {
      return;
    }

    switch (name) {
      case "ui.start":          this._sfxStart();         break;
      case "ui.menu.open":      this._sfxMenuOpen();      break;
      case "ui.menu.close":     this._sfxMenuClose();     break;
      case "ui.story.open":     this._sfxStoryOpen();     break;
      case "ui.story.close":    this._sfxStoryClose();    break;
      case "ui.page.turn":      this._sfxPageTurn();      break;
      case "ui.choice.correct": this._sfxCorrect();       break;
      case "ui.choice.incorrect":this._sfxIncorrect();    break;
      case "scene.advance":     this._sfxSceneAdvance();  break;
      case "ending.reveal":     this._sfxEndingReveal();  break;
      default:
        // Unknown event — silently ignore (no broken Audio() calls)
        break;
    }
  }

  // ------------------------------------------------------------------
  // Background music: overrides AudioManager background methods
  // ------------------------------------------------------------------
  playBackground(name) {
    if (!this.enabled) {
      return;
    }

    if (this._bgName === name && this._bgNodes) {
      if (this._bgPaused) {
        this._resumeBg();
      }
      return;
    }

    this._stopBgNodes();
    this._bgName = name;
    this._bgPaused = false;

    const profile = this._resolveTrackProfile(name);
    this._startBgLoop(profile);
  }

  pauseBackground() {
    if (!this._bgNodes || this._bgPaused) {
      return;
    }
    const ctx = this._ctx;
    if (ctx) {
      const { masterGain } = this._bgNodes;
      this._ramp(masterGain, 0, 0.5, ctx);
    }
    this._bgPaused = true;
  }

  _resumeBg() {
    if (!this._bgNodes || !this._bgPaused) {
      return;
    }
    const ctx = this._ctx;
    if (ctx) {
      const { masterGain } = this._bgNodes;
      const profile = this._resolveTrackProfile(this._bgName || "");
      this._ramp(masterGain, profile.vol, 1.0, ctx);
    }
    this._bgPaused = false;
  }

  resumeBackground() {
    if (!this.enabled) {
      return;
    }

    if (this._bgNodes && this._bgPaused) {
      this._resumeBg();
      return;
    }

    if (this._bgName) {
      this.playBackground(this._bgName);
    }
  }

  stopBackground() {
    this._stopBgNodes();
    this._bgName = null;
    this._bgPaused = false;
    // Also clear parent-class state for consistency
    this.currentBackgroundName = null;
    this.currentBackgroundSource = null;
    this.backgroundPaused = false;
  }
}

class ImpuroStoryGame {
  constructor(root, options = {}) {
    this.root = root;
    this.config = cloneData(options.config || {});
    this.runtime = options.runtime || RUNTIME.STANDALONE;
    this.onFinish = typeof options.onFinish === "function" ? options.onFinish : null;
    this.abortController = new AbortController();
    this.audio = new SynthAudioManager(this.config.sounds || {});
    // Start muted by default; user must explicitly enable audio via the toggle.
    this.audio.enabled = false;
    this.characterProfiles = new Map(ensureArray(this.config.characterProfiles).map((profile) => [profile.id, profile]));
    this.stateMachine = new StateMachine(GAME_STATES.INTRO, {
      [GAME_STATES.INTRO]: [GAME_STATES.PLAY],
      [GAME_STATES.PLAY]: [GAME_STATES.FEEDBACK],
      [GAME_STATES.FEEDBACK]: [GAME_STATES.PLAY, GAME_STATES.END],
      [GAME_STATES.END]: [GAME_STATES.INTRO]
    });
    this.state = this.createInitialState();
    this.refs = {};
    this.lastRenderedEntryId = null;
  }

  init() {
    this.renderShell();
    this.refs = this.getRefs();
    this.updateContinueAvailability();
    this.applyTheme();
    this.bindEvents();
    this.bindAudioUnlock();
    this.render();
  }

  get currentScreen() {
    return this.stateMachine.current;
  }

  createInitialState() {
    return {
      screen: GAME_STATES.INTRO,
      sceneIndex: 0,
      finaleIndex: 0,
      playPanelIndex: 0,
      endPanelIndex: 0,
      reviewIndex: 0,
      questionFocusIndex: 0,
      finalArchiveTab: "hidalgo",
      score: 0,
      streak: 0,           // racha de respuestas correctas consecutivas
      answers: [],
      journal: [],
      optionOrderByEntry: {},
      wrongOptionsByEntry: {},
      openCardByPanel: {
        0: "character",
        1: "question-journal"
      },
      alert: null,
      storyModalOpen: false,
      exitModalOpen: false,
      hasSavedProgress: false,
      inFinale: false
    };
  }

  setScreen(nextScreen) {
    return this.stateMachine.transition(nextScreen);
  }

  renderShell() {
    this.root.innerHTML = `
      <div class="impuro-app impuro-app--${escapeHtml(this.runtime)}" data-ref="app">
        <button type="button" class="impuro-sound-toggle" data-ref="sound-toggle-btn" aria-pressed="true"></button>
        <section class="impuro-screen impuro-screen--intro" data-ref="screen-intro">
          <div class="impuro-intro-backdrop"></div>
          <div class="impuro-intro-book">
            <article class="impuro-book-face impuro-book-face--cover">
              <p class="impuro-overline">${escapeHtml(this.config.meta?.subtitle || "")}</p>
              <h1 class="impuro-title">${escapeHtml(this.config.meta?.title || "")}</h1>
              <p class="impuro-kicker">${escapeHtml(this.config.meta?.storyLabel || "")}${this.config.meta?.referenceLabel ? ` | ${escapeHtml(this.config.meta.referenceLabel)}` : ""}</p>
            </article>
            <article class="impuro-book-face impuro-book-face--content">
              <h2 class="impuro-intro-title">${escapeHtml(this.config.meta?.introTitle || "")}</h2>
              <p class="impuro-intro-body">${escapeHtml(this.config.meta?.introBody || "")}</p>
              <p class="impuro-intro-goal">${escapeHtml(this.config.meta?.learningGoal || "")}</p>
              <div class="impuro-intro-actions">
                <button type="button" class="impuro-primary-btn" data-ref="start-btn">${escapeHtml(this.config.meta?.startLabel || "Comenzar")}</button>
                <button type="button" class="impuro-secondary-btn" data-ref="continue-menu-btn" hidden>Continuar</button>
                <p class="impuro-intro-note">La lectura avanza por paneles laterales. No necesitas hacer scroll vertical.</p>
              </div>
            </article>
          </div>
        </section>

        <section class="impuro-screen impuro-screen--play" data-ref="screen-play" hidden>
          <div class="impuro-scene-background" data-ref="scene-background"></div>
          <div class="impuro-scene-veil"></div>
          <div class="impuro-particles" aria-hidden="true"></div>
          <header class="impuro-hud">
            <div class="impuro-hud-chip"><span class="impuro-hud-label">Tramo</span><strong data-ref="hud-act"></strong></div>
            <div class="impuro-hud-chip"><span class="impuro-hud-label">Puntaje</span><strong data-ref="hud-score"></strong></div>
            <div class="impuro-hud-chip"><span class="impuro-hud-label">Progreso</span><strong data-ref="hud-progress"></strong><div class="impuro-hud-progress-bar" aria-hidden="true"><div class="impuro-hud-progress-fill" data-ref="hud-progress-fill"></div></div></div>
            <div class="impuro-hud-chip"><span class="impuro-hud-label">Pagina</span><strong data-ref="hud-page"></strong></div>
            <div class="impuro-hud-streak" data-ref="hud-streak" hidden aria-live="polite" aria-label="Racha de respuestas correctas"></div>
            <button type="button" class="impuro-hud-chip impuro-hud-chip--action" data-ref="menu-btn"><span class="impuro-hud-label">Sesion</span><strong>Menu</strong></button>
            <button type="button" class="impuro-hud-chip impuro-hud-chip--action impuro-hud-story-btn" data-ref="story-btn"><span class="impuro-hud-label">Historia</span><strong>${escapeHtml(this.config.meta?.historyButtonLabel || "Ver historia")}</strong></button>
          </header>
          <div class="impuro-book-shell">
            <button type="button" class="impuro-nav-btn impuro-nav-btn--left" data-ref="play-prev-btn" aria-label="Panel anterior">‹</button>
            <div class="impuro-book-window">
              <div class="impuro-book-track" data-ref="play-track">
                <article class="impuro-book-page">
                  <div class="impuro-page-spread">
                    <section class="impuro-page-card impuro-page-card--portrait is-revealing" data-ref="character-card" data-card-id="character">
                      <button type="button" class="impuro-card-toggle" data-card-toggle="character">Personaje</button>
                      <div class="impuro-card-body" data-card-body="character">
                        <div class="impuro-character-frame" data-ref="character-frame"><img data-ref="character-image" alt=""></div>
                        <p class="impuro-character-role" data-ref="character-role"></p>
                        <h2 class="impuro-character-name" data-ref="character-name"></h2>
                        <p class="impuro-character-summary" data-ref="character-summary"></p>
                      </div>
                    </section>
                    <section class="impuro-page-card impuro-page-card--story is-revealing" data-ref="story-card" data-card-id="story">
                      <button type="button" class="impuro-card-toggle" data-card-toggle="story">Historia</button>
                      <div class="impuro-card-body" data-card-body="story">
                        <div class="impuro-story-meta"><p class="impuro-overline" data-ref="story-sequence"></p><p class="impuro-story-route" data-ref="story-route"></p></div>
                        <h2 class="impuro-story-title" data-ref="story-title"></h2>
                        <div class="impuro-narration" data-ref="story-narration"></div>
                        <div class="impuro-context-grid"><article class="impuro-context-card"><h3>Contexto historico</h3><p data-ref="story-context"></p></article><article class="impuro-context-card"><h3>Vinculo entre personajes</h3><p data-ref="story-link"></p></article></div>
                      </div>
                    </section>
                  </div>
                </article>
                <article class="impuro-book-page">
                  <div class="impuro-page-spread">
                    <section class="impuro-page-card impuro-page-card--question-journal is-revealing" data-ref="question-journal-card" data-card-id="question-journal">
                      <button type="button" class="impuro-card-toggle" data-card-toggle="question-journal">Pregunta y bitacora</button>
                      <div class="impuro-card-body" data-card-body="question-journal">
                        <div class="impuro-page-heading"><p class="impuro-kicker">${escapeHtml(this.config.meta?.questionLabel || "Pregunta")}</p><h3>Decision y bitacora</h3></div>
                        <p class="impuro-question-text" data-ref="question-prompt"></p>
                        <div class="impuro-options" data-ref="question-options"></div>
                        <div class="impuro-journal-divider"></div>
                        <h2>${escapeHtml(this.config.meta?.journalTitle || "Bitacora")}</h2>
                        <ol class="impuro-journal-list" data-ref="journal-list"></ol>
                      </div>
                    </section>
                  </div>
                </article>
              </div>
            </div>
            <button type="button" class="impuro-nav-btn impuro-nav-btn--right" data-ref="play-next-btn" aria-label="Panel siguiente">›</button>
          </div>
          <div class="impuro-panel-dots" data-ref="play-dots"></div>
          <section class="impuro-alert" data-ref="alert-panel" hidden><div class="impuro-alert-card" data-ref="alert-card"><p class="impuro-alert-tag" data-ref="alert-tag"></p><h2 class="impuro-alert-title" data-ref="alert-title"></h2><p class="impuro-alert-message" data-ref="alert-message"></p><div class="impuro-alert-whatif" data-ref="alert-whatif" hidden><img class="impuro-alert-image" data-ref="alert-image" alt="Escenario alternativo"><div class="impuro-alert-whatif-copy"><h3 data-ref="alert-whatif-title"></h3><p data-ref="alert-whatif-text"></p></div></div><p class="impuro-alert-note" data-ref="alert-note"></p><button type="button" class="impuro-primary-btn" data-ref="continue-btn"></button></div></section>
          <section class="impuro-modal" data-ref="story-modal" hidden aria-hidden="true"><div class="impuro-modal-backdrop" data-ref="story-modal-backdrop"></div><div class="impuro-modal-card" role="dialog" aria-modal="true" aria-labelledby="story-modal-title"><div class="impuro-page-heading"><p class="impuro-kicker">${escapeHtml(this.config.meta?.referenceLabel || "")}</p><h2 id="story-modal-title" data-ref="story-modal-title"></h2></div><p class="impuro-modal-meta" data-ref="story-modal-meta"></p><div class="impuro-modal-body" data-ref="story-modal-body"></div><p class="impuro-modal-note" data-ref="story-modal-note"></p><a class="impuro-secondary-link" data-ref="story-modal-link" href="#" target="_blank" rel="noopener noreferrer">Abrir referencia historica</a><button type="button" class="impuro-primary-btn" data-ref="story-modal-close">Cerrar historia</button></div></section>
        </section>

        <section class="impuro-screen impuro-screen--end" data-ref="screen-end" hidden>
          <div class="impuro-end-shell">
            <div class="impuro-book-shell impuro-book-shell--end">
              <button type="button" class="impuro-nav-btn impuro-nav-btn--left" data-ref="end-prev-btn" aria-label="Panel anterior">‹</button>
              <div class="impuro-book-window">
                <div class="impuro-book-track" data-ref="end-track">
                  <article class="impuro-book-page">
                    <div class="impuro-page-spread">
                      <section class="impuro-page-card impuro-page-card--ending-combined">
                        <p class="impuro-overline">${escapeHtml(this.config.meta?.resultLabel || "Resultado")}</p>
                        <h2 class="impuro-end-title" data-ref="ending-rank"></h2>
                        <p class="impuro-end-score" data-ref="ending-score"></p>
                        <p class="impuro-end-copy" data-ref="ending-description"></p>

                        <div class="impuro-ending-review-block">
                          <p class="impuro-kicker">${escapeHtml(this.config.meta?.answersLabel || "Respuestas")}</p>
                          <p class="impuro-review-progress" data-ref="review-position"></p>
                          <h3 class="impuro-review-title" data-ref="review-event-title"></h3>
                          <p class="impuro-review-prompt" data-ref="review-prompt"></p>
                          <div class="impuro-review-grid">
                            <div class="impuro-review-answer"><span>Tu respuesta</span><strong data-ref="review-selected"></strong></div>
                            <div class="impuro-review-answer"><span>Respuesta correcta</span><strong data-ref="review-correct"></strong></div>
                          </div>
                          <p class="impuro-review-status" data-ref="review-status"></p>
                          <div class="impuro-inline-nav">
                            <button type="button" class="impuro-secondary-btn" data-ref="review-prev-btn">Anterior</button>
                            <button type="button" class="impuro-secondary-btn" data-ref="review-next-btn">Siguiente</button>
                          </div>
                        </div>

                        <div class="impuro-ending-actions-row">
                          <button type="button" class="impuro-primary-btn" data-ref="restart-btn">${escapeHtml(this.config.meta?.restartLabel || "Reiniciar")}</button>
                          <button type="button" class="impuro-secondary-btn" data-ref="open-archive-btn">Ver archivo final</button>
                        </div>
                      </section>
                    </div>
                  </article>

                  <article class="impuro-book-page">
                    <div class="impuro-page-spread">
                      <section class="impuro-page-card impuro-page-card--archive impuro-page-card--archive-wide">
                        <div class="impuro-archive-stack">
                          <section class="impuro-archive-panel">
                            <div class="impuro-page-heading">
                              <p class="impuro-kicker">${escapeHtml(this.config.meta?.timelineLabel || "Linea del tiempo")}</p>
                              <h3>Orden completo de la historia</h3>
                            </div>
                            <iframe class="impuro-reader-frame" data-ref="timeline-iframe" title="Orden historico completo" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>
                            <p class="impuro-frame-caption">Este panel resume la secuencia historica narrada por el juego.</p>
                          </section>

                          <section class="impuro-archive-panel">
                            <div class="impuro-page-heading">
                              <p class="impuro-kicker">Personajes</p>
                              <h3>Archivo final de protagonistas</h3>
                            </div>
                            <div class="impuro-tab-row" data-ref="final-archive-tabs"></div>
                            <article class="impuro-final-profile-card">
                              <div class="impuro-final-profile-media">
                                <img data-ref="final-character-image" alt="Personaje historico">
                              </div>
                              <div class="impuro-final-profile-copy">
                                <p class="impuro-final-profile-role" data-ref="final-character-role"></p>
                                <h4 class="impuro-final-profile-name" data-ref="final-character-name"></h4>
                                <p class="impuro-final-profile-summary" data-ref="final-character-summary"></p>
                                <ul class="impuro-final-profile-highlights" data-ref="final-character-highlights"></ul>
                              </div>
                            </article>
                            <p class="impuro-frame-caption" data-ref="final-character-caption"></p>
                            <a class="impuro-secondary-link" data-ref="final-character-link" href="#" target="_blank" rel="noopener noreferrer">Abrir perfil historico</a>
                          </section>
                        </div>
                      </section>
                    </div>
                  </article>
                </div>
              </div>
              <button type="button" class="impuro-nav-btn impuro-nav-btn--right" data-ref="end-next-btn" aria-label="Panel siguiente">›</button>
            </div>
            <div class="impuro-panel-dots" data-ref="end-dots"></div>
          </div>
        </section>

        <section class="impuro-modal" data-ref="exit-modal" hidden aria-hidden="true">
          <div class="impuro-modal-backdrop" data-ref="exit-modal-backdrop"></div>
          <div class="impuro-modal-card impuro-modal-card--compact" role="dialog" aria-modal="true" aria-labelledby="exit-modal-title">
            <div class="impuro-page-heading">
              <p class="impuro-kicker">Sesion</p>
              <h2 id="exit-modal-title">Salir de la partida</h2>
            </div>
            <p class="impuro-modal-meta">Elige si quieres volver al menu conservando el progreso o reiniciar desde cero.</p>
            <div class="impuro-exit-actions">
              <button type="button" class="impuro-secondary-btn" data-ref="exit-restart-btn">Reiniciar</button>
              <button type="button" class="impuro-primary-btn" data-ref="exit-menu-btn">Salir</button>
              <button type="button" class="impuro-secondary-btn" data-ref="exit-cancel-btn">Cancelar</button>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  getRefs() {
    return {
      app: this.root.querySelector('[data-ref="app"]'),
      intro: this.root.querySelector('[data-ref="screen-intro"]'),
      play: this.root.querySelector('[data-ref="screen-play"]'),
      end: this.root.querySelector('[data-ref="screen-end"]'),
      startBtn: this.root.querySelector('[data-ref="start-btn"]'),
      continueMenuBtn: this.root.querySelector('[data-ref="continue-menu-btn"]'),
      restartBtn: this.root.querySelector('[data-ref="restart-btn"]'),
      continueBtn: this.root.querySelector('[data-ref="continue-btn"]'),
      soundToggleBtn: this.root.querySelector('[data-ref="sound-toggle-btn"]'),
      background: this.root.querySelector('[data-ref="scene-background"]'),
      hudAct: this.root.querySelector('[data-ref="hud-act"]'),
      hudScore: this.root.querySelector('[data-ref="hud-score"]'),
      hudProgress: this.root.querySelector('[data-ref="hud-progress"]'),
      hudProgressFill: this.root.querySelector('[data-ref="hud-progress-fill"]'),
      hudStreak: this.root.querySelector('[data-ref="hud-streak"]'),
      hudPage: this.root.querySelector('[data-ref="hud-page"]'),
      menuBtn: this.root.querySelector('[data-ref="menu-btn"]'),
      storyBtn: this.root.querySelector('[data-ref="story-btn"]'),
      playTrack: this.root.querySelector('[data-ref="play-track"]'),
      playPrevBtn: this.root.querySelector('[data-ref="play-prev-btn"]'),
      playNextBtn: this.root.querySelector('[data-ref="play-next-btn"]'),
      playDots: this.root.querySelector('[data-ref="play-dots"]'),
      characterCard: this.root.querySelector('[data-ref="character-card"]'),
      characterFrame: this.root.querySelector('[data-ref="character-frame"]'),
      characterImage: this.root.querySelector('[data-ref="character-image"]'),
      characterRole: this.root.querySelector('[data-ref="character-role"]'),
      characterName: this.root.querySelector('[data-ref="character-name"]'),
      characterSummary: this.root.querySelector('[data-ref="character-summary"]'),
      storyCard: this.root.querySelector('[data-ref="story-card"]'),
      storySequence: this.root.querySelector('[data-ref="story-sequence"]'),
      storyRoute: this.root.querySelector('[data-ref="story-route"]'),
      storyTitle: this.root.querySelector('[data-ref="story-title"]'),
      storyNarration: this.root.querySelector('[data-ref="story-narration"]'),
      storyContext: this.root.querySelector('[data-ref="story-context"]'),
      storyLink: this.root.querySelector('[data-ref="story-link"]'),
      questionPrompt: this.root.querySelector('[data-ref="question-prompt"]'),
      questionOptions: this.root.querySelector('[data-ref="question-options"]'),
      questionJournalCard: this.root.querySelector('[data-ref="question-journal-card"]'),
      journalList: this.root.querySelector('[data-ref="journal-list"]'),
      storyModal: this.root.querySelector('[data-ref="story-modal"]'),
      storyModalBackdrop: this.root.querySelector('[data-ref="story-modal-backdrop"]'),
      storyModalTitle: this.root.querySelector('[data-ref="story-modal-title"]'),
      storyModalMeta: this.root.querySelector('[data-ref="story-modal-meta"]'),
      storyModalBody: this.root.querySelector('[data-ref="story-modal-body"]'),
      storyModalNote: this.root.querySelector('[data-ref="story-modal-note"]'),
      storyModalLink: this.root.querySelector('[data-ref="story-modal-link"]'),
      storyModalClose: this.root.querySelector('[data-ref="story-modal-close"]'),
      exitModal: this.root.querySelector('[data-ref="exit-modal"]'),
      exitModalBackdrop: this.root.querySelector('[data-ref="exit-modal-backdrop"]'),
      exitRestartBtn: this.root.querySelector('[data-ref="exit-restart-btn"]'),
      exitMenuBtn: this.root.querySelector('[data-ref="exit-menu-btn"]'),
      exitCancelBtn: this.root.querySelector('[data-ref="exit-cancel-btn"]'),
      alertPanel: this.root.querySelector('[data-ref="alert-panel"]'),
      alertCard: this.root.querySelector('[data-ref="alert-card"]'),
      alertTag: this.root.querySelector('[data-ref="alert-tag"]'),
      alertTitle: this.root.querySelector('[data-ref="alert-title"]'),
      alertMessage: this.root.querySelector('[data-ref="alert-message"]'),
      alertWhatIf: this.root.querySelector('[data-ref="alert-whatif"]'),
      alertImage: this.root.querySelector('[data-ref="alert-image"]'),
      alertWhatIfTitle: this.root.querySelector('[data-ref="alert-whatif-title"]'),
      alertWhatIfText: this.root.querySelector('[data-ref="alert-whatif-text"]'),
      alertNote: this.root.querySelector('[data-ref="alert-note"]'),
      endTrack: this.root.querySelector('[data-ref="end-track"]'),
      endPrevBtn: this.root.querySelector('[data-ref="end-prev-btn"]'),
      endNextBtn: this.root.querySelector('[data-ref="end-next-btn"]'),
      endDots: this.root.querySelector('[data-ref="end-dots"]'),
      endingRank: this.root.querySelector('[data-ref="ending-rank"]'),
      endingScore: this.root.querySelector('[data-ref="ending-score"]'),
      endingDescription: this.root.querySelector('[data-ref="ending-description"]'),
      reviewPosition: this.root.querySelector('[data-ref="review-position"]'),
      reviewEventTitle: this.root.querySelector('[data-ref="review-event-title"]'),
      reviewPrompt: this.root.querySelector('[data-ref="review-prompt"]'),
      reviewSelected: this.root.querySelector('[data-ref="review-selected"]'),
      reviewCorrect: this.root.querySelector('[data-ref="review-correct"]'),
      reviewStatus: this.root.querySelector('[data-ref="review-status"]'),
      reviewPrevBtn: this.root.querySelector('[data-ref="review-prev-btn"]'),
      reviewNextBtn: this.root.querySelector('[data-ref="review-next-btn"]'),
      openArchiveBtn: this.root.querySelector('[data-ref="open-archive-btn"]'),
      timelineIframe: this.root.querySelector('[data-ref="timeline-iframe"]'),
      finalArchiveTabs: this.root.querySelector('[data-ref="final-archive-tabs"]'),
      finalCharacterImage: this.root.querySelector('[data-ref="final-character-image"]'),
      finalCharacterRole: this.root.querySelector('[data-ref="final-character-role"]'),
      finalCharacterName: this.root.querySelector('[data-ref="final-character-name"]'),
      finalCharacterSummary: this.root.querySelector('[data-ref="final-character-summary"]'),
      finalCharacterHighlights: this.root.querySelector('[data-ref="final-character-highlights"]'),
      finalCharacterLink: this.root.querySelector('[data-ref="final-character-link"]'),
      finalCharacterCaption: this.root.querySelector('[data-ref="final-character-caption"]')
    };
  }

  bindEvents() {
    const signal = this.abortController.signal;

    this.refs.startBtn?.addEventListener("click", () => this.startGame(), { signal });
    this.refs.continueMenuBtn?.addEventListener("click", () => this.continueFromMenu(), { signal });
    this.refs.restartBtn?.addEventListener("click", () => this.restart(), { signal });
    this.refs.continueBtn?.addEventListener("click", () => this.advanceFromAlert(), { signal });
    this.refs.soundToggleBtn?.addEventListener("click", () => this.toggleSound(), { signal });
    this.refs.menuBtn?.addEventListener("click", () => this.openExitModal(), { signal });
    this.refs.storyBtn?.addEventListener("click", () => this.openStoryModal(), { signal });
    this.refs.storyModalBackdrop?.addEventListener("click", () => this.closeStoryModal(), { signal });
    this.refs.storyModalClose?.addEventListener("click", () => this.closeStoryModal(), { signal });
    this.refs.exitModalBackdrop?.addEventListener("click", () => this.closeExitModal(), { signal });
    this.refs.exitRestartBtn?.addEventListener("click", () => this.leaveToMenu(false), { signal });
    this.refs.exitMenuBtn?.addEventListener("click", () => this.leaveToMenu(true), { signal });
    this.refs.exitCancelBtn?.addEventListener("click", () => this.closeExitModal(), { signal });
    this.refs.playPrevBtn?.addEventListener("click", () => this.movePlayPanel(-1), { signal });
    this.refs.playNextBtn?.addEventListener("click", () => this.movePlayPanel(1), { signal });
    this.refs.endPrevBtn?.addEventListener("click", () => this.moveEndPanel(-1), { signal });
    this.refs.endNextBtn?.addEventListener("click", () => this.moveEndPanel(1), { signal });
    this.refs.reviewPrevBtn?.addEventListener("click", () => this.moveReview(-1), { signal });
    this.refs.reviewNextBtn?.addEventListener("click", () => this.moveReview(1), { signal });
    this.refs.openArchiveBtn?.addEventListener(
      "click",
      () => {
        this.audio.play("ui.page.turn");
        this.setEndPanel(1);
        this.render();
      },
      { signal }
    );

    this.refs.questionOptions?.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("[data-option-index]");
        if (!button) {
          return;
        }
        this.handleAnswer(Number(button.dataset.optionIndex));
      },
      { signal }
    );

    this.refs.play?.addEventListener(
      "click",
      (event) => {
        const toggle = event.target.closest("[data-card-toggle]");
        if (!toggle) {
          return;
        }

        this.setOpenCard(toggle.dataset.cardToggle);
        this.renderMobileAccordion();
      },
      { signal }
    );

    this.refs.playDots?.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("[data-play-panel]");
        if (!button) {
          return;
        }
        this.setPlayPanel(Number(button.dataset.playPanel));
        this.render();
      },
      { signal }
    );

    this.refs.endDots?.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("[data-end-panel]");
        if (!button) {
          return;
        }
        this.setEndPanel(Number(button.dataset.endPanel));
        this.render();
      },
      { signal }
    );

    this.refs.finalArchiveTabs?.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest("[data-final-archive-tab]");
        if (!button) {
          return;
        }
        this.audio.play("ui.page.turn");
        this.state.finalArchiveTab = button.dataset.finalArchiveTab;
        this.renderEndingArchive();
      },
      { signal }
    );

    document.addEventListener(
      "keydown",
      (event) => this.handleKeyboard(event),
      { signal }
    );

    window.addEventListener(
      "resize",
      () => this.renderMobileAccordion(),
      { signal }
    );
  }

  bindAudioUnlock() {
    if (typeof window === "undefined") {
      return;
    }

    // Register the unlock gesture regardless of current enabled state so that
    // SynthAudioManager can warm up its AudioContext on the first user gesture.
    // When audio is off this is a no-op beyond the context resume.
    const unlock = () => {
      if (this.audio instanceof SynthAudioManager) {
        // Warm up the AudioContext so it's ready the moment the user enables sound.
        try { this.audio._getCtx(); } catch (_e) { /* ignore */ }
      }
      if (this.audio?.enabled && this.currentScreen === GAME_STATES.INTRO) {
        this.syncBackgroundTrack();
      }
    };

    window.addEventListener("pointerdown", unlock, { once: true, passive: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  applyTheme() {
    const theme = this.config.theme || {};
    const colors = theme.colors || {};
    this.refs.app?.style.setProperty("--impuro-font-title", theme.fontFamily || "'Cinzel', serif");
    this.refs.app?.style.setProperty("--impuro-ink", colors.ink || "#f7ead3");
    this.refs.app?.style.setProperty("--impuro-paper", colors.paper || "#1a120f");
    this.refs.app?.style.setProperty("--impuro-paper-soft", colors.paperSoft || "rgba(35, 24, 19, 0.86)");
    this.refs.app?.style.setProperty("--impuro-line", colors.line || "rgba(248, 225, 186, 0.24)");
    this.refs.app?.style.setProperty("--impuro-gold", colors.gold || "#c79c5c");
    this.refs.app?.style.setProperty("--impuro-danger", colors.danger || "#b6483a");
    this.refs.app?.style.setProperty("--impuro-success", colors.success || "#3f8a61");
    this.refs.app?.style.setProperty("--impuro-warning", colors.warning || "#d39c41");
    this.refs.app?.style.setProperty("--impuro-shadow", colors.shadow || "rgba(0, 0, 0, 0.48)");
  }

  updateSoundToggle() {
    if (!this.refs.soundToggleBtn) {
      return;
    }

    const enabled = Boolean(this.audio?.enabled);
    this.refs.soundToggleBtn.textContent = enabled ? "Sonido: activado" : "Sonido: desactivado";
    this.refs.soundToggleBtn.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  toggleSound() {
    if (!this.audio) {
      return;
    }

    this.audio.enabled = !this.audio.enabled;
    if (this.audio.enabled) {
      this.syncBackgroundTrack();
    } else {
      this.audio.stopBackground();
    }
    this.updateSoundToggle();
  }

  getTotalQuestions() {
    return ensureArray(this.config.scenes).length + ensureArray(this.config.finale?.questions).length;
  }

  getPlayPanelCount() {
    return 2;
  }

  getEndPanelCount() {
    return 2;
  }

  setPlayPanel(index) {
    this.state.playPanelIndex = Math.max(0, Math.min(this.getPlayPanelCount() - 1, index));
    if (!this.state.openCardByPanel[this.state.playPanelIndex]) {
      this.state.openCardByPanel[this.state.playPanelIndex] = this.state.playPanelIndex === 0 ? "character" : "question-journal";
    }
  }

  setOpenCard(cardId) {
    if (!cardId) {
      return;
    }
    this.state.openCardByPanel[this.state.playPanelIndex] = cardId;
  }

  renderMobileAccordion() {
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches;
    const cards = Array.from(this.refs.play?.querySelectorAll("[data-card-id]") || []);

    if (!isMobile) {
      cards.forEach((card) => {
        const body = card.querySelector("[data-card-body]");
        const toggle = card.querySelector("[data-card-toggle]");
        card.classList.remove("is-collapsed");
        if (body) {
          body.hidden = false;
        }
        if (toggle) {
          toggle.setAttribute("aria-expanded", "true");
        }
      });
      return;
    }

    const openCardId = this.state.openCardByPanel[this.state.playPanelIndex] || (this.state.playPanelIndex === 0 ? "character" : "question-journal");
    cards.forEach((card) => {
      const cardId = card.dataset.cardId;
      const body = card.querySelector("[data-card-body]");
      const toggle = card.querySelector("[data-card-toggle]");
      const isOpen = cardId === openCardId;
      card.classList.toggle("is-collapsed", !isOpen);
      if (body) {
        body.hidden = !isOpen;
      }
      if (toggle) {
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      }
    });
  }

  movePlayPanel(step) {
    const previousIndex = this.state.playPanelIndex;
    // Si el usuario avanza de panel, completar el typewriter de golpe
    this.cancelTypewriter();
    if (this.refs.storyNarration) {
      const entry = this.getCurrentEntry();
      if (entry) {
        this.refs.storyNarration.innerHTML = toParagraphs(entry.narration);
      }
    }
    this.setPlayPanel(this.state.playPanelIndex + step);
    if (this.state.playPanelIndex !== previousIndex) {
      this.audio.play("ui.page.turn");
    }
    const maxIndex = Math.max(0, this.getCurrentQuestionOptionCount() - 1);
    this.state.questionFocusIndex = Math.max(0, Math.min(maxIndex, this.state.questionFocusIndex));
    this.render();
  }

  setEndPanel(index) {
    this.state.endPanelIndex = Math.max(0, Math.min(this.getEndPanelCount() - 1, index));
  }

  moveEndPanel(step) {
    const previousIndex = this.state.endPanelIndex;
    this.setEndPanel(this.state.endPanelIndex + step);
    if (this.state.endPanelIndex !== previousIndex) {
      this.audio.play("ui.page.turn");
    }
    this.render();
  }

  setReviewIndex(index) {
    const maxIndex = Math.max(0, this.state.answers.length - 1);
    this.state.reviewIndex = Math.max(0, Math.min(maxIndex, index));
  }

  moveReview(step) {
    const previousIndex = this.state.reviewIndex;
    this.setReviewIndex(this.state.reviewIndex + step);
    if (this.state.reviewIndex !== previousIndex) {
      this.audio.play("ui.page.turn");
    }
    this.renderEndingReview();
  }

  getCurrentQuestionOptionCount() {
    const entry = this.getCurrentEntry();
    return this.getDisplayedOptions(entry).length;
  }

  moveQuestionOption(step) {
    const optionCount = this.getCurrentQuestionOptionCount();
    if (!optionCount || this.currentScreen !== GAME_STATES.PLAY || this.state.playPanelIndex !== 1) {
      return;
    }

    this.state.questionFocusIndex = Math.max(0, Math.min(optionCount - 1, this.state.questionFocusIndex + step));
    this.renderQuestionFocus();
  }

  selectFocusedQuestionOption() {
    if (this.currentScreen !== GAME_STATES.PLAY || this.state.alert || this.state.storyModalOpen || this.state.playPanelIndex !== 1) {
      return;
    }

    const entry = this.getCurrentEntry();
    const displayed = this.getDisplayedOptions(entry);
    const current = displayed[this.state.questionFocusIndex];
    if (!current) {
      return;
    }

    const wrongOptions = this.getWrongOptionsSet(entry);
    if (wrongOptions.has(current.originalIndex)) {
      return;
    }

    this.handleAnswer(current.originalIndex);
  }

  handleKeyboard(event) {
    const key = event.key;

    if (this.state.exitModalOpen) {
      if (key === "Escape") {
        event.preventDefault();
        this.closeExitModal();
      }
      return;
    }

    if (this.state.storyModalOpen) {
      if (key === "Escape" || key === "Enter" || key === " ") {
        event.preventDefault();
        this.closeStoryModal();
      }
      return;
    }

    if (this.currentScreen === GAME_STATES.INTRO) {
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        this.startGame();
      }
      return;
    }

    if (this.currentScreen === GAME_STATES.PLAY) {
      if (key === "ArrowLeft") {
        event.preventDefault();
        this.movePlayPanel(-1);
        return;
      }

      if (key === "ArrowRight") {
        event.preventDefault();
        this.movePlayPanel(1);
        return;
      }

      if (key === "ArrowUp") {
        event.preventDefault();
        this.moveQuestionOption(-1);
        return;
      }

      if (key === "ArrowDown") {
        event.preventDefault();
        this.moveQuestionOption(1);
        return;
      }

      if (key === " ") {
        event.preventDefault();
        this.selectFocusedQuestionOption();
      }
      return;
    }

    if (this.currentScreen === GAME_STATES.FEEDBACK) {
      if (key === " " || key === "Enter") {
        event.preventDefault();
        this.advanceFromAlert();
      }
      return;
    }

    if (this.currentScreen === GAME_STATES.END) {
      if (key === "ArrowLeft") {
        event.preventDefault();
        this.moveEndPanel(-1);
        return;
      }

      if (key === "ArrowRight") {
        event.preventDefault();
        this.moveEndPanel(1);
        return;
      }

      if (key === "ArrowUp") {
        event.preventDefault();
        this.moveReview(-1);
        return;
      }

      if (key === "ArrowDown") {
        event.preventDefault();
        this.moveReview(1);
      }
    }
  }

  renderQuestionFocus() {
    const buttons = Array.from(this.refs.questionOptions?.querySelectorAll(".impuro-option-btn") || []);
    buttons.forEach((button, index) => {
      const isFocused = index === this.state.questionFocusIndex;
      button.classList.toggle("is-focused", isFocused);
      button.setAttribute("aria-current", isFocused ? "true" : "false");
    });
  }

  openStoryModal() {
    const entry = this.getCurrentEntry();
    if (!entry || !this.refs.storyModal) {
      return;
    }

    this.state.storyModalOpen = true;
    this.audio.play("ui.story.open");
    this.refs.storyModal.hidden = false;
    this.refs.storyModal.setAttribute("aria-hidden", "false");
    this.renderSceneArchive(entry);
    this.refs.storyModalClose?.focus();
  }

  closeStoryModal() {
    if (!this.refs.storyModal) {
      return;
    }

    const wasOpen = this.state.storyModalOpen;
    if (wasOpen) {
      this.audio.play("ui.story.close");
    }
    this.state.storyModalOpen = false;
    this.refs.storyModal.hidden = true;
    this.refs.storyModal.setAttribute("aria-hidden", "true");
    if (wasOpen) {
      this.refs.storyBtn?.focus();
    }
  }

  getCurrentEntry() {
    if (this.state.inFinale) {
      const presenter = this.config.finale?.presenter || {};
      const question = ensureArray(this.config.finale?.questions)[this.state.finaleIndex];
      return question
        ? {
            ...question,
            accent: presenter.accent || question.accent,
            background: presenter.background || question.background,
            characterId: presenter.characterId || "morelos",
            character: {
              name: presenter.name || "Evaluacion final",
              role: presenter.role || "Guia",
              image: presenter.image || ""
            }
          }
        : null;
    }

    return ensureArray(this.config.scenes)[this.state.sceneIndex] || null;
  }

  getCorrectOptionLabel(entry) {
    return entry?.question?.options?.find((option) => option.isCorrect)?.label || "";
  }

  inferCharacterId(name) {
    const normalized = String(name || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    if (normalized.includes("allende")) {
      return "allende";
    }
    if (normalized.includes("morelos")) {
      return "morelos";
    }
    return "hidalgo";
  }

  getCharacterProfile(entry) {
    const characterId = entry?.characterId || this.inferCharacterId(entry?.character?.name);
    return this.characterProfiles.get(characterId) || null;
  }

  getEntryKey(entry) {
    if (entry?.id) {
      return String(entry.id);
    }
    return this.state.inFinale ? `finale-${this.state.finaleIndex}` : `scene-${this.state.sceneIndex}`;
  }

  getAnswerRecord(entry) {
    const key = this.getEntryKey(entry);
    return this.state.answers.find((answer) => answer.id === key) || null;
  }

  shuffleIndexes(length) {
    const values = Array.from({ length }, (_, index) => index);
    for (let index = values.length - 1; index > 0; index -= 1) {
      const target = Math.floor(Math.random() * (index + 1));
      const current = values[index];
      values[index] = values[target];
      values[target] = current;
    }
    return values;
  }

  getOptionOrder(entry) {
    const key = this.getEntryKey(entry);
    const options = ensureArray(entry?.question?.options);
    const existing = this.state.optionOrderByEntry[key];
    if (existing && existing.length === options.length) {
      return existing;
    }

    const shuffled = this.shuffleIndexes(options.length);
    const correctOriginalIndex = options.findIndex((option) => option?.isCorrect);
    const correctDisplayIndex = shuffled.indexOf(correctOriginalIndex);

    if (correctDisplayIndex === 0 && shuffled.length > 1) {
      const shouldMoveFromFirst = Math.random() < 0.7;
      if (shouldMoveFromFirst) {
        const target = 1 + Math.floor(Math.random() * (shuffled.length - 1));
        const temp = shuffled[target];
        shuffled[target] = shuffled[0];
        shuffled[0] = temp;
      }
    }

    this.state.optionOrderByEntry[key] = shuffled;
    return shuffled;
  }

  getDisplayedOptions(entry) {
    const options = ensureArray(entry?.question?.options);
    const order = this.getOptionOrder(entry);
    return order
      .map((originalIndex, displayIndex) => ({
        option: options[originalIndex],
        originalIndex,
        displayIndex
      }))
      .filter((item) => item.option);
  }

  getWrongOptionsSet(entry) {
    const key = this.getEntryKey(entry);
    return new Set(this.state.wrongOptionsByEntry[key] || []);
  }

  markWrongOption(entry, optionIndex) {
    const key = this.getEntryKey(entry);
    const current = new Set(this.state.wrongOptionsByEntry[key] || []);
    current.add(optionIndex);
    this.state.wrongOptionsByEntry[key] = Array.from(current);
  }

  createCounterfactualNarrative(entry, option) {
    if (option?.whatIfText) {
      return option.whatIfText;
    }

    const context = String(option?.historicalNote || option?.message || "").toLowerCase();
    const year = entry?.year ? `en ${entry.year}` : "en ese momento";

    if (/(despues|más adelante|mas adelante|aun no|todavia no|todavía no|cronolog)/.test(context)) {
      return `Si esa decision se hubiera tomado ${year}, la historia insurgente habria perdido su secuencia: se estaria forzando un hecho de otra etapa y el proceso habria entrado en contradiccion temporal.`;
    }

    if (/(puerto|geograf|region|región|territorio)/.test(context)) {
      return `Si esa decision hubiera guiado la ruta ${year}, el movimiento habria marchado hacia un objetivo equivocado y se habrian debilitado los frentes realmente decisivos de la insurgencia.`;
    }

    return `Si esa decision se hubiera impuesto ${year}, la ruta historica se habria desviado: las alianzas y prioridades del movimiento insurgente habrian cambiado, debilitando el avance que finalmente conocemos.`;
  }

  buildCounterfactual(entry, option) {
    const text = this.createCounterfactualNarrative(entry, option);
    const reason = option?.historicalNote || "Ese escenario contradice la cronologia historica o rompe la relacion temporal entre hechos y personajes.";
    const image = option?.whatIfImage || entry?.counterfactualImage || entry?.background || "";
    return { text, reason, image };
  }

  get storageAvailable() {
    try {
      return typeof window !== "undefined" && Boolean(window.localStorage);
    } catch (_error) {
      return false;
    }
  }

  readSavedProgress() {
    if (!this.storageAvailable) {
      return null;
    }

    try {
      const raw = window.localStorage.getItem(PROGRESS_STORAGE_KEY);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      return parsed?.state ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  writeSavedProgress() {
    if (!this.storageAvailable) {
      return;
    }

    const payload = {
      version: 1,
      savedAt: Date.now(),
      state: cloneData(this.state),
      screen: this.currentScreen
    };
    window.localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(payload));
  }

  clearSavedProgress() {
    if (!this.storageAvailable) {
      return;
    }

    window.localStorage.removeItem(PROGRESS_STORAGE_KEY);
  }

  updateContinueAvailability() {
    this.state.hasSavedProgress = Boolean(this.readSavedProgress());
    if (this.refs.continueMenuBtn) {
      this.refs.continueMenuBtn.hidden = !this.state.hasSavedProgress;
    }
  }

  continueFromMenu() {
    const snapshot = this.readSavedProgress();
    if (!snapshot?.state) {
      this.updateContinueAvailability();
      return;
    }

    this.state = cloneData(snapshot.state);
    this.state.storyModalOpen = false;
    this.state.exitModalOpen = false;
    const targetScreen = snapshot.screen === GAME_STATES.END
      ? GAME_STATES.END
      : (snapshot.screen === GAME_STATES.FEEDBACK ? GAME_STATES.FEEDBACK : GAME_STATES.PLAY);
    this.stateMachine.current = targetScreen;
    this.render();
  }

  openExitModal() {
    if (!this.refs.exitModal) {
      return;
    }

    this.state.exitModalOpen = true;
    this.audio.pauseBackground();
    this.audio.play("ui.menu.open");
    this.refs.exitModal.hidden = false;
    this.refs.exitModal.setAttribute("aria-hidden", "false");
    this.refs.exitMenuBtn?.focus();
  }

  closeExitModal(restoreMusic = true) {
    if (!this.refs.exitModal) {
      return;
    }

    this.state.exitModalOpen = false;
    this.audio.play("ui.menu.close");
    if (restoreMusic) {
      this.audio.resumeBackground();
    }
    this.refs.exitModal.hidden = true;
    this.refs.exitModal.setAttribute("aria-hidden", "true");
    this.refs.menuBtn?.focus();
  }

  leaveToMenu(keepProgress) {
    if (keepProgress) {
      this.writeSavedProgress();
    } else {
      this.clearSavedProgress();
      this.state = this.createInitialState();
      this.lastRenderedEntryId = null;
    }

    this.closeExitModal(false);
    this.audio.stopBackground();
    this.closeStoryModal();
    this.stateMachine.current = GAME_STATES.INTRO;
    this.state.playPanelIndex = 0;
    this.state.alert = null;
    this.render();
  }

  startGame() {
    this.clearSavedProgress();
    this.updateContinueAvailability();
    if (!this.setScreen(GAME_STATES.PLAY)) {
      return;
    }
    this.state.playPanelIndex = 0;
    this.state.questionFocusIndex = 0;
    this.state.storyModalOpen = false;
    if (this.refs.storyModal) {
      this.refs.storyModal.hidden = true;
      this.refs.storyModal.setAttribute("aria-hidden", "true");
    }
    this.audio.play("ui.start");
    this.render();
  }

  restart() {
    this.cancelTypewriter();
    this.clearSavedProgress();
    this.updateContinueAvailability();
    this.state = this.createInitialState();
    this.stateMachine.reset();
    this.lastRenderedEntryId = null;
    this.closeStoryModal();
    this.syncBackgroundTrack();
    this.render();
  }

  handleAnswer(optionIndex) {
    if (this.currentScreen !== GAME_STATES.PLAY || this.state.alert) {
      return;
    }

    const entry = this.getCurrentEntry();
    const wrongOptions = this.getWrongOptionsSet(entry);
    if (wrongOptions.has(optionIndex)) {
      return;
    }

    const option = entry?.question?.options?.[optionIndex];
    if (!entry || !option) {
      return;
    }

    const answerRecord = this.getAnswerRecord(entry);
    this.state.questionFocusIndex = 0;

    if (option.isCorrect) {
      if (!answerRecord) {
        const points = Number(entry.question.points || this.config.gameplay?.pointsPerCorrect || 0);
        this.state.score += points;
        this.state.streak += 1;          // sube la racha solo en primera respuesta correcta
        this.state.answers.push({
          id: this.getEntryKey(entry),
          eventTitle: entry.eventTitle,
          prompt: entry.question.prompt,
          selectedLabel: option.label,
          correctLabel: this.getCorrectOptionLabel(entry),
          isCorrect: true
        });
      }

      this.pushJournal(entry, option);
      this.state.alert = {
        tone: option.tone || "success",
        title: option.title || "Respuesta correcta",
        message: option.message || "",
        note: option.historicalNote || "",
        buttonLabel: this.isOnLastStep() ? this.config.meta.finishLabel : this.config.meta.continueLabel,
        isCorrect: true,
        retry: false,
        whatIf: null
      };
    } else {
      const penalty = Math.abs(Number(this.config.gameplay?.pointsPenaltyWrong ?? 3));
      this.state.score = Math.max(0, this.state.score - penalty);
      this.state.streak = 0;             // se rompe la racha al fallar
      if (!answerRecord) {
        this.state.answers.push({
          id: this.getEntryKey(entry),
          eventTitle: entry.eventTitle,
          prompt: entry.question.prompt,
          selectedLabel: option.label,
          correctLabel: this.getCorrectOptionLabel(entry),
          isCorrect: false
        });
      }
      this.markWrongOption(entry, optionIndex);
      const counterfactual = this.buildCounterfactual(entry, option);
      this.state.alert = {
        tone: option.tone || "warning",
        title: option.title || "Consecuencia alternativa",
        message: option.message || "Tu eleccion no coincide con la cronologia de esta ruta.",
        note: `Penalizacion: -${penalty} puntos. Puedes intentar otra respuesta.`,
        buttonLabel: "Intentar otra respuesta",
        isCorrect: false,
        retry: true,
        whatIf: counterfactual
      };
    }

    if (!this.setScreen(GAME_STATES.FEEDBACK)) {
      return;
    }

    this.state.playPanelIndex = 1;
    this.audio.play(option.isCorrect ? "ui.choice.correct" : "ui.choice.incorrect");
    this.flashState(option.isCorrect ? "is-score-pulse" : "is-mistake");
    if (option.isCorrect) {
      this.flashElement(this.refs.questionJournalCard, "is-correct");
      this.launchConfetti();
    }
    this.render();
  }

  pushJournal(entry, option) {
    const text = option.journalEntry || option.historicalNote;
    if (!text) {
      return;
    }

    if (this.state.journal.some((item) => item.text === text)) {
      return;
    }

    this.state.journal.unshift({
      title: entry.eventTitle,
      text,
      tone: option.tone || "warning"
    });

    const limit = Number(this.config.gameplay?.journalLimit || 8);
    this.state.journal = this.state.journal.slice(0, limit);
  }

  isOnLastStep() {
    if (!this.state.inFinale) {
      return (
        this.state.sceneIndex === ensureArray(this.config.scenes).length - 1 &&
        ensureArray(this.config.finale?.questions).length === 0
      );
    }

    return this.state.finaleIndex === ensureArray(this.config.finale?.questions).length - 1;
  }

  advanceFlow() {
    if (!this.state.inFinale) {
      if (this.state.sceneIndex < ensureArray(this.config.scenes).length - 1) {
        this.state.sceneIndex += 1;
        this.state.playPanelIndex = 0;
        return;
      }

      if (ensureArray(this.config.finale?.questions).length > 0) {
        this.state.inFinale = true;
        this.state.finaleIndex = 0;
        this.state.playPanelIndex = 0;
        return;
      }

      this.finishGame();
      return;
    }

    if (this.state.finaleIndex < ensureArray(this.config.finale?.questions).length - 1) {
      this.state.finaleIndex += 1;
      this.state.playPanelIndex = 0;
      return;
    }

    this.finishGame();
  }

  advanceFromAlert() {
    if (!this.state.alert || this.currentScreen !== GAME_STATES.FEEDBACK) {
      return;
    }

    // Quitar el pulso del botón al avanzar
    this.refs.continueBtn?.classList.remove("is-pulsing");

    const shouldRetry = Boolean(this.state.alert.retry);
    this.state.alert = null;

    if (shouldRetry) {
      if (!this.setScreen(GAME_STATES.PLAY)) {
        return;
      }

      const entry = this.getCurrentEntry();
      const wrongOptions = this.getWrongOptionsSet(entry);
      const displayed = this.getDisplayedOptions(entry);
      const nextAvailable = displayed.find((item) => !wrongOptions.has(item.originalIndex));
      this.state.questionFocusIndex = nextAvailable ? nextAvailable.displayIndex : 0;
      this.state.playPanelIndex = 1;
      this.render();
      return;
    }

    this.audio.play("scene.advance");

    if (this.isOnLastStep()) {
      this.finishGame();
      return;
    }

    if (!this.setScreen(GAME_STATES.PLAY)) {
      return;
    }

    this.advanceFlow();
    this.render();
  }

  finishGame() {
    if (!this.setScreen(GAME_STATES.END)) {
      return;
    }
    this.state.endPanelIndex = 0;
    this.state.reviewIndex = 0;
    this.state.finalArchiveTab = "hidalgo";
    this.audio.play("ending.reveal");
    this.syncBackgroundTrack();
    this.render();

    if (this.onFinish) {
      this.onFinish(this.getSummary());
    }
  }

  getSummary() {
    const totalQuestions = this.getTotalQuestions();
    const correctAnswers = this.state.answers.filter((answer) => answer.isCorrect).length;
    const ranking = resolveRank(this.config.finale?.rankings, this.state.score);
    return {
      score: this.state.score,
      totalQuestions,
      correctAnswers,
      ranking,
      answers: cloneData(this.state.answers),
      journal: cloneData(this.state.journal)
    };
  }

  flashState(className) {
    if (!this.refs.app) {
      return;
    }

    this.refs.app.classList.remove(className);
    void this.refs.app.offsetWidth;
    this.refs.app.classList.add(className);
    window.setTimeout(() => this.refs.app?.classList.remove(className), 520);
  }

  // ----------------------------------------------------------------
  // Confetti — Canvas API puro, sin dependencias
  // ----------------------------------------------------------------
  launchConfetti() {
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);

    const ctx    = canvas.getContext("2d");
    const COLORS = ["#f5c842", "#27c26b", "#e84545", "#4fc3f7", "#ff8a65", "#ce93d8", "#ffffff"];
    const SHAPES = ["rect", "circle", "ribbon"];

    // Cada partícula nace desde la mitad superior de la pantalla
    const particles = Array.from({ length: 110 }, () => ({
      x:     Math.random() * canvas.width,
      y:     Math.random() * canvas.height * 0.4 - canvas.height * 0.1,
      w:     Math.random() * 10 + 5,
      h:     Math.random() * 6  + 3,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      shape: SHAPES[Math.floor(Math.random() * SHAPES.length)],
      vx:    (Math.random() - 0.5) * 5,
      vy:    Math.random() * 3 + 1.5,
      rot:   Math.random() * Math.PI * 2,
      rotV:  (Math.random() - 0.5) * 0.25,
      alpha: 1,
      decay: Math.random() * 0.008 + 0.006
    }));

    let frame;
    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;

      for (const p of particles) {
        p.x   += p.vx;
        p.y   += p.vy;
        p.vy  += 0.07;           // gravedad suave
        p.vx  *= 0.99;           // fricción del aire
        p.rot += p.rotV;
        p.alpha -= p.decay;

        if (p.alpha <= 0) {
          continue;
        }
        alive = true;

        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;

        if (p.shape === "circle") {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.shape === "ribbon") {
          ctx.fillRect(-p.w / 2, -p.h / 4, p.w, p.h / 2);
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }

        ctx.restore();
      }

      if (alive) {
        frame = requestAnimationFrame(tick);
      } else {
        canvas.remove();
      }
    };

    frame = requestAnimationFrame(tick);

    // Límite de seguridad: limpia a los 4s pase lo que pase
    window.setTimeout(() => {
      cancelAnimationFrame(frame);
      canvas.remove();
    }, 4000);
  }

  /** Aplica una clase de animación a un elemento específico y la remueve al terminar. */
  flashElement(element, className, duration = 600) {
    if (!element) {
      return;
    }
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
    window.setTimeout(() => element.classList.remove(className), duration);
  }

  // ----------------------------------------------------------------
  // Typewriter — escribe texto letra a letra en un contenedor
  // Soporta múltiples párrafos en secuencia.
  // Llama a cancelTypewriter() antes de arrancar uno nuevo.
  // ----------------------------------------------------------------
  cancelTypewriter() {
    if (this._typewriterCancel) {
      this._typewriterCancel();
      this._typewriterCancel = null;
    }
  }

  /**
   * Escribe `lines` (array de strings) como párrafos <p> dentro de `container`.
   * Cada letra aparece cada `speed` ms. Al terminar cada párrafo arranca el siguiente.
   * @param {HTMLElement} container
   * @param {string[]}    lines
   * @param {number}      speed  ms por carácter (default 22)
   */
  typewriteLines(container, lines, speed = 22) {
    this.cancelTypewriter();

    if (!container || !lines?.length) {
      return;
    }

    container.innerHTML = "";
    let cancelled = false;
    this._typewriterCancel = () => { cancelled = true; };

    // Crea todos los <p> vacíos ya — el layout no salta mientras se escribe
    const paragraphs = lines.map(() => {
      const p = document.createElement("p");
      container.appendChild(p);
      return p;
    });

    const writeParagraph = (pIndex) => {
      if (cancelled || pIndex >= paragraphs.length) {
        return;
      }

      const p    = paragraphs[pIndex];
      const text = lines[pIndex] ?? "";
      let   charIndex = 0;

      const tick = () => {
        if (cancelled) {
          // Si se cancela, rellenamos el resto del texto de golpe para no dejar a medias
          p.textContent = text;
          return;
        }
        if (charIndex < text.length) {
          p.textContent += text[charIndex++];
          window.setTimeout(tick, speed);
        } else {
          // Párrafo terminado → arranca el siguiente con una pequeña pausa
          window.setTimeout(() => writeParagraph(pIndex + 1), speed * 4);
        }
      };

      tick();
    };

    writeParagraph(0);
  }

  /** Activa la animación de entrada de escena en el background. */
  animateSceneEnter() {
    if (!this.refs.background) {
      return;
    }
    this.flashElement(this.refs.background, "is-scene-enter", 700);
  }

  animateReveal(element) {
    if (!element) {
      return;
    }

    element.classList.remove("is-revealing");
    void element.offsetWidth;
    element.classList.add("is-revealing");
  }

  setIframeContent(iframe, html) {
    if (!iframe) {
      return;
    }

    if (iframe._impuroDoc === html) {
      return;
    }

    iframe.srcdoc = html;
    iframe._impuroDoc = html;
  }

  buildIframeDocument({ title, subtitle, paragraphs, bullets, accent, linkUrl, linkLabel }) {
    const safeAccent = escapeHtml(accent || "#c79c5c");
    const safeTitle = escapeHtml(title || "");
    const safeSubtitle = escapeHtml(subtitle || "");
    const bodyParagraphs = ensureArray(paragraphs)
      .filter(Boolean)
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("");
    const bulletMarkup = ensureArray(bullets).length
      ? `<ul>${ensureArray(bullets).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join("")}</ul>`
      : "";
    const linkMarkup = linkUrl
      ? `<a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkLabel || "Abrir referencia externa")}</a>`
      : "";

    return `
      <!doctype html>
      <html lang="es">
      <head>
        <meta charset="utf-8">
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            padding: 18px;
            box-sizing: border-box;
            font-family: Georgia, "Times New Roman", serif;
            color: #f6ead6;
            background: linear-gradient(180deg, rgba(31,20,16,0.98), rgba(12,8,7,1));
          }
          .chip {
            display: inline-block;
            margin-bottom: 10px;
            padding: 6px 10px;
            border-radius: 999px;
            background: rgba(255,255,255,0.06);
            color: ${safeAccent};
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
          }
          h1 {
            margin: 0 0 10px;
            font-size: 26px;
            line-height: 1.1;
          }
          h2 {
            margin: 0 0 12px;
            font-size: 14px;
            font-weight: normal;
            color: rgba(246,234,214,0.78);
          }
          p, li {
            font-size: 14px;
            line-height: 1.45;
          }
          ul {
            margin: 12px 0 0;
            padding-left: 18px;
          }
          a {
            display: inline-block;
            margin-top: 16px;
            color: ${safeAccent};
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <span class="chip">Lectura guiada</span>
        <h1>${safeTitle}</h1>
        <h2>${safeSubtitle}</h2>
        ${bodyParagraphs}
        ${bulletMarkup}
        ${linkMarkup}
      </body>
      </html>
    `;
  }

  buildEventIframe(entry) {
    return this.buildIframeDocument({
      title: entry.eventTitle,
      subtitle: `${entry.year || ""} | ${entry.location || ""}`,
      paragraphs: [...ensureArray(entry.narration), entry.historicalContext, entry.characterLink],
      accent: entry.accent,
      linkUrl: entry.wikiUrl,
      linkLabel: "Abrir referencia historica"
    });
  }

  buildCharacterIframe(profile, entry) {
    return this.buildIframeDocument({
      title: profile?.name || entry.character?.name,
      subtitle: profile?.role || entry.character?.role || "Personaje",
      paragraphs: [profile?.summary || entry.characterLink],
      bullets: profile?.highlights || [],
      accent: entry.accent,
      linkUrl: profile?.wikiUrl,
      linkLabel: "Abrir perfil del personaje"
    });
  }

  getProfileImageSource(profileId) {
    const scene = ensureArray(this.config.scenes).find((item) => item.characterId === profileId && item.character?.image);
    return scene?.character?.image || "";
  }

  normalizeExternalUrl(url) {
    const value = String(url || "").trim();
    if (!value) {
      return "";
    }
    if (/^https?:\/\//i.test(value)) {
      return value;
    }
    return `https://${value.replace(/^\/+/, "")}`;
  }

  buildTimelineIframe() {
    const bullets = ensureArray(this.config.scenes).map((scene, index) => {
      const summary = ensureArray(scene.narration)[0] || scene.historicalContext || "";
      return `${index + 1}. ${scene.year} | ${scene.eventTitle}: ${summary}`;
    });

    return this.buildIframeDocument({
      title: "Ruta completa de la novela",
      subtitle: "Orden historico de lectura",
      paragraphs: [
        "La novela recorre conspiracion, levantamiento, crisis del mando inicial y reorganizacion politica del movimiento insurgente."
      ],
      bullets,
      accent: "#c79c5c"
    });
  }

  renderDotButtons(container, kind, total, activeIndex) {
    if (!container) {
      return;
    }

    const attr = kind === "play" ? "data-play-panel" : "data-end-panel";
    container.innerHTML = new Array(total)
      .fill(null)
      .map(
        (_, index) => `
          <button
            type="button"
            class="impuro-dot ${index === activeIndex ? "is-active" : ""}"
            ${attr}="${index}"
            aria-label="Ir a la pagina ${index + 1}"
          ></button>
        `
      )
      .join("");
  }

  render() {
    const screen = this.currentScreen;
    this.state.screen = screen;

    this.refs.intro.hidden = screen !== GAME_STATES.INTRO;
    this.refs.play.hidden = screen !== GAME_STATES.PLAY && screen !== GAME_STATES.FEEDBACK;
    this.refs.end.hidden = screen !== GAME_STATES.END;
    if (this.refs.exitModal) {
      this.refs.exitModal.hidden = !this.state.exitModalOpen;
      this.refs.exitModal.setAttribute("aria-hidden", this.state.exitModalOpen ? "false" : "true");
    }

    if (screen === GAME_STATES.INTRO) {
      this.updateContinueAvailability();
    }

    this.updateSoundToggle();

    this.syncBackgroundTrack();

    if (screen === GAME_STATES.PLAY || screen === GAME_STATES.FEEDBACK) {
      this.renderPlay();
    }

    if (screen === GAME_STATES.END) {
      this.renderEnding();
    }
  }

  getSceneThemeFile(entry) {
    if (!entry) {
      return null;
    }

    if (entry.theme) {
      return entry.theme;
    }

    const characterName = String(entry.character?.name || "personaje")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const sceneNumber = this.state.inFinale
      ? ensureArray(this.config.scenes).length + this.state.finaleIndex + 1
      : this.state.sceneIndex + 1;

    return `scene_${sceneNumber}_${characterName}.mp3`;
  }

  syncBackgroundTrack() {
    if (!this.audio?.enabled) {
      return;
    }

    if (this.currentScreen === GAME_STATES.INTRO) {
      this.audio.playBackground(this.audio.background.menu || "menu_theme.mp3");
      return;
    }

    if (this.currentScreen === GAME_STATES.PLAY || this.currentScreen === GAME_STATES.FEEDBACK) {
      const entry = this.getCurrentEntry();
      this.audio.playBackground(this.getSceneThemeFile(entry));
      return;
    }

    if (this.currentScreen === GAME_STATES.END) {
      this.audio.playBackground(this.audio.background.ending || "end_game_complete.mp3");
      return;
    }

    this.audio.stopBackground();
  }

  renderPlay() {
    const entry = this.getCurrentEntry();
    if (!entry) {
      return;
    }

    const progressCurrent = Math.min(this.state.answers.length + 1, this.getTotalQuestions());
    const routeText = `${entry.year || ""} | ${entry.location || ""}`;

    this.refs.app?.style.setProperty("--scene-accent", entry.accent || "#f5c842");
    this.refs.background.style.backgroundImage = `url("${encodeURI(entry.background || "")}")`;
    this.animateSceneEnter();

    this.refs.hudAct.textContent = entry.sequenceLabel || (this.state.inFinale ? "Evaluacion" : "Ruta");
    this.refs.hudScore.textContent = String(this.state.score);
    this.refs.hudProgress.textContent = `${progressCurrent}/${this.getTotalQuestions()}`;
    // Actualizar barra de progreso visual
    if (this.refs.hudProgressFill) {
      const pct = this.getTotalQuestions() > 0
        ? Math.round((progressCurrent / this.getTotalQuestions()) * 100)
        : 0;
      this.refs.hudProgressFill.style.width = `${pct}%`;
    }
    this.refs.hudPage.textContent = `${this.state.playPanelIndex + 1}/${this.getPlayPanelCount()}`;
    this.refs.playTrack.style.transform = `translateX(-${this.state.playPanelIndex * 100}%)`;
    this.refs.playPrevBtn.disabled = this.state.playPanelIndex === 0;
    this.refs.playNextBtn.disabled = this.state.playPanelIndex === this.getPlayPanelCount() - 1;
    this.renderDotButtons(this.refs.playDots, "play", this.getPlayPanelCount(), this.state.playPanelIndex);

    this.refs.characterImage.src = encodeURI(entry.character?.image || "");
    this.refs.characterImage.alt = entry.character?.name || "Personaje";
    this.refs.characterRole.textContent = entry.character?.role || "";
    this.refs.characterName.textContent = entry.character?.name || "";
    const profile = this.getCharacterProfile(entry);
    this.refs.characterSummary.textContent = entry.character?.description || profile?.summary || "";

    this.refs.storySequence.textContent = entry.sequenceLabel || "";
    this.refs.storyRoute.textContent = routeText;
    this.refs.storyTitle.textContent = entry.eventTitle || "";
    // Typewriter solo cuando la escena cambia; si es el mismo entry no re-escribe
    if (this.lastRenderedEntryId !== entry.id) {
      this.typewriteLines(this.refs.storyNarration, ensureArray(entry.narration));
    }
    this.refs.storyContext.textContent = entry.historicalContext || "";
    this.refs.storyLink.textContent = entry.characterLink || "";
    this.refs.questionPrompt.textContent = entry.question?.prompt || "";

    this.renderOptions(entry);
    this.renderJournal();
    this.renderSceneArchive(entry);
    this.renderAlert();
    this.renderStreak();
    this.renderQuestionFocus();
    this.renderMobileAccordion();

    if (this.lastRenderedEntryId !== entry.id) {
      this.animateReveal(this.refs.characterCard);
      this.animateReveal(this.refs.storyCard);
      this.animateReveal(this.refs.questionJournalCard);
      this.lastRenderedEntryId = entry.id;
    }
  }

  renderOptions(entry) {
    const displayedOptions = this.getDisplayedOptions(entry);
    const wrongOptions = this.getWrongOptionsSet(entry);
    const isLocked = Boolean(this.state.alert);
    const availableOptions = displayedOptions.filter((item) => !wrongOptions.has(item.originalIndex));

    if (!availableOptions.length) {
      this.state.questionFocusIndex = 0;
    } else {
      const focused = displayedOptions[this.state.questionFocusIndex];
      if (!focused || wrongOptions.has(focused.originalIndex)) {
        this.state.questionFocusIndex = availableOptions[0].displayIndex;
      }
    }

    this.refs.questionOptions.innerHTML = displayedOptions
      .map(
        (item, index) => {
          const option = item.option;
          const isDisabled = isLocked || wrongOptions.has(item.originalIndex);
          return `
          <button
            type="button"
            class="impuro-option-btn ${index === this.state.questionFocusIndex ? "is-focused" : ""}"
            data-option-index="${item.originalIndex}"
            style="--option-order:${index};"
            aria-current="${index === this.state.questionFocusIndex ? "true" : "false"}"
            ${isDisabled ? "disabled" : ""}
          >
            <span class="impuro-option-index">${index + 1}</span>
            <span>${escapeHtml(option.label)}</span>
          </button>
        `;
        }
      )
      .join("");
  }

  renderSceneArchive(entry) {
    const profile = this.getCharacterProfile(entry);
    const lines = [
      ...ensureArray(entry.narration),
      entry.historicalContext,
      entry.characterLink
    ].filter(Boolean);

    if (this.refs.storyModalTitle) {
      this.refs.storyModalTitle.textContent = entry.eventTitle || "Historia del episodio";
    }
    if (this.refs.storyModalMeta) {
      this.refs.storyModalMeta.textContent = `${entry.year || ""}${entry.location ? ` · ${entry.location}` : ""}`;
    }
    if (this.refs.storyModalBody) {
      this.refs.storyModalBody.innerHTML = toParagraphs(lines);
    }
    if (this.refs.storyModalNote) {
      this.refs.storyModalNote.textContent = profile
        ? `Personaje vinculado: ${profile.name} · ${profile.role}`
        : "";
    }
    if (this.refs.storyModalLink) {
      this.refs.storyModalLink.href = entry.wikiUrl || profile?.wikiUrl || "#";
      this.refs.storyModalLink.hidden = !(entry.wikiUrl || profile?.wikiUrl);
    }
  }

  renderJournal() {
    if (!this.state.journal.length) {
      this.refs.journalList.innerHTML = '<li class="impuro-journal-empty">Tus hallazgos historicos apareceran aqui.</li>';
      return;
    }

    this.refs.journalList.innerHTML = this.state.journal
      .slice(0, 4)
      .map(
        (entry) => `
          <li class="impuro-journal-item impuro-journal-item--${escapeHtml(entry.tone)}">
            <strong>${escapeHtml(entry.title)}</strong>
            <span>${escapeHtml(entry.text)}</span>
          </li>
        `
      )
      .join("");
  }

  renderAlert() {
    const alert = this.state.alert;
    this.refs.alertPanel.hidden = !alert;

    if (!alert) {
      this.refs.alertCard.className = "impuro-alert-card";
      this.refs.alertWhatIf.hidden = true;
      return;
    }

    this.refs.alertCard.className = `impuro-alert-card impuro-alert-card--${escapeHtml(alert.tone)}`;
    this.refs.alertTag.textContent = alert.isCorrect ? "Acierto historico" : "Alerta de aprendizaje";
    this.refs.alertTitle.textContent = alert.title;
    this.refs.alertMessage.textContent = alert.message;
    this.refs.alertNote.textContent = alert.note;
    const hasWhatIf = Boolean(alert.whatIf);
    this.refs.alertWhatIf.hidden = !hasWhatIf;
    if (hasWhatIf) {
      this.refs.alertWhatIfTitle.textContent = "Si eso hubiera pasado:";
      this.refs.alertWhatIfText.textContent = alert.whatIf.text;
      this.refs.alertImage.src = encodeURI(alert.whatIf.image || "");
      this.refs.alertImage.alt = "Escenario alternativo de la respuesta incorrecta";
      this.refs.alertNote.textContent = alert.whatIf.reason;
    }
    this.refs.continueBtn.textContent = alert.buttonLabel;
    this.refs.continueBtn.classList.add("is-pulsing");
    this.refs.continueBtn.focus();
  }

  // ---------------------------------------------------------------
  // Streak badge — muestra la racha activa en el HUD
  // ---------------------------------------------------------------
  renderStreak() {
    const el = this.refs.hudStreak;
    if (!el) {
      return;
    }

    const streak = this.state.streak;

    // Solo mostrar desde racha >= 2
    if (streak < 2) {
      el.hidden = true;
      el.textContent = "";
      return;
    }

    // Elige el emoji y mensaje según el nivel de racha
    let emoji;
    if      (streak >= 7) { emoji = "🌟"; }
    else if (streak >= 5) { emoji = "⚡"; }
    else if (streak >= 3) { emoji = "🔥"; }
    else                   { emoji = "✨"; }

    const prev = el.textContent;
    const next = `${emoji} x${streak}`;

    if (prev !== next) {
      el.hidden = false;
      el.textContent = next;
      // Pequeña animación de entrada cada vez que sube
      el.classList.remove("is-streak-pop");
      void el.offsetWidth;
      el.classList.add("is-streak-pop");
    }
  }

  renderEnding() {
    const summary = this.getSummary();
    const ranking = summary.ranking || {
      title: "Ruta completada",
      description: "Terminaste el recorrido historico."
    };

    this.refs.endingRank.textContent = ranking.title;
    this.refs.endingScore.textContent = `Puntaje final: ${summary.score} | Aciertos: ${summary.correctAnswers}/${summary.totalQuestions}`;
    this.refs.endingDescription.textContent = ranking.description;
    this.refs.endTrack.style.transform = `translateX(-${this.state.endPanelIndex * 100}%)`;
    this.refs.endPrevBtn.disabled = this.state.endPanelIndex === 0;
    this.refs.endNextBtn.disabled = this.state.endPanelIndex === this.getEndPanelCount() - 1;
    this.renderDotButtons(this.refs.endDots, "end", this.getEndPanelCount(), this.state.endPanelIndex);
    this.renderEndingReview();
    this.renderEndingArchive();
  }

  renderEndingReview() {
    if (!this.state.answers.length) {
      this.refs.reviewPosition.textContent = "Sin respuestas registradas";
      this.refs.reviewEventTitle.textContent = "No hay decisiones para mostrar";
      this.refs.reviewPrompt.textContent = "";
      this.refs.reviewSelected.textContent = "-";
      this.refs.reviewCorrect.textContent = "-";
      this.refs.reviewStatus.textContent = "";
      this.refs.reviewPrevBtn.disabled = true;
      this.refs.reviewNextBtn.disabled = true;
      return;
    }

    const answer = this.state.answers[this.state.reviewIndex];
    this.refs.reviewPosition.textContent = `Tarjeta ${this.state.reviewIndex + 1} de ${this.state.answers.length}`;
    this.refs.reviewEventTitle.textContent = answer.eventTitle;
    this.refs.reviewPrompt.textContent = answer.prompt;
    this.refs.reviewSelected.textContent = answer.selectedLabel;
    this.refs.reviewCorrect.textContent = answer.correctLabel;
    this.refs.reviewStatus.textContent = answer.isCorrect
      ? "Tu respuesta coincide con la correcta."
      : "Compara tu eleccion con la respuesta correcta para reforzar la cronologia.";
    this.refs.reviewStatus.className = `impuro-review-status ${answer.isCorrect ? "is-success" : "is-warning"}`;
    this.refs.reviewPrevBtn.disabled = this.state.reviewIndex === 0;
    this.refs.reviewNextBtn.disabled = this.state.reviewIndex === this.state.answers.length - 1;
  }

  renderEndingArchive() {
    this.setIframeContent(this.refs.timelineIframe, this.buildTimelineIframe());

    const profiles = ensureArray(this.config.characterProfiles);
    this.refs.finalArchiveTabs.innerHTML = profiles
      .map(
        (profile) => `
          <button
            type="button"
            class="impuro-tab-btn ${profile.id === this.state.finalArchiveTab ? "is-active" : ""}"
            data-final-archive-tab="${escapeHtml(profile.id)}"
          >
            ${escapeHtml(profile.name.split(" ")[0])}
          </button>
        `
      )
      .join("");

    const selectedProfile =
      this.characterProfiles.get(this.state.finalArchiveTab) || profiles[0] || null;

    if (!selectedProfile) {
      return;
    }

    const profileImage = selectedProfile.image || this.getProfileImageSource(selectedProfile.id);
    if (this.refs.finalCharacterImage) {
      this.refs.finalCharacterImage.src = encodeURI(profileImage || "");
      this.refs.finalCharacterImage.alt = selectedProfile.name || "Personaje historico";
      this.refs.finalCharacterImage.hidden = !profileImage;
    }
    if (this.refs.finalCharacterRole) {
      this.refs.finalCharacterRole.textContent = selectedProfile.role || "";
    }
    if (this.refs.finalCharacterName) {
      this.refs.finalCharacterName.textContent = selectedProfile.name || "";
    }
    if (this.refs.finalCharacterSummary) {
      this.refs.finalCharacterSummary.textContent = selectedProfile.summary || "";
    }
    if (this.refs.finalCharacterHighlights) {
      this.refs.finalCharacterHighlights.innerHTML = ensureArray(selectedProfile.highlights)
        .map((highlight) => `<li>${escapeHtml(highlight)}</li>`)
        .join("");
    }
    this.refs.finalCharacterCaption.textContent = `Archivo final de ${selectedProfile.name}.`;
    const wikiUrl = this.normalizeExternalUrl(selectedProfile.wikiUrl);
    this.refs.finalCharacterLink.href = wikiUrl || "#";
    this.refs.finalCharacterLink.hidden = !wikiUrl;
  }

  destroy() {
    this.cancelTypewriter();
    this.audio.stopBackground();
    this.abortController.abort();
    this.root.innerHTML = "";
  }
}

async function loadConfig(options = {}) {
  if (options.config) {
    return cloneData(options.config);
  }

  const configPath = options.configPath || DEFAULT_CONFIG_PATH;
  const response = await fetch(configPath, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`No se pudo cargar ${configPath}: ${response.status}`);
  }

  return response.json();
}

function destroy(root) {
  const existing = ACTIVE_GAMES.get(root);
  if (existing) {
    existing.destroy();
    ACTIVE_GAMES.delete(root);
  }
  if (CURRENT_ROOT === root) {
    CURRENT_ROOT = null;
  }
}

function renderBootError(root, error) {
  root.innerHTML = `
    <section class="impuro-error">
      <h1>IMPURO</h1>
      <p>No se pudo iniciar la novela grafica.</p>
      <p>${escapeHtml(error?.message || "Error desconocido")}</p>
      <p>Si estas usando archivos locales, levanta un servidor para que el navegador pueda leer src/data/game-config.json.</p>
    </section>
  `;
}

async function mount(root, options = {}) {
  if (!root) {
    throw new Error("No se encontro un contenedor para montar IMPURO.");
  }

  if (CURRENT_ROOT && CURRENT_ROOT !== root) {
    destroy(CURRENT_ROOT);
  }

  destroy(root);

  try {
    const config = await loadConfig(options);
    const runtime = options.runtime || RUNTIME.STANDALONE;
    const game = new ImpuroStoryGame(root, { ...options, config, runtime });
    ACTIVE_GAMES.set(root, game);
    CURRENT_ROOT = root;
    game.init();
    return game;
  } catch (error) {
    renderBootError(root, error);
    throw error;
  }
}

async function bootstrapStandalone() {
  const root = document.querySelector("[data-impuro-root]");
  if (!root || root.dataset.impuroBooted === "true") {
    return null;
  }

  root.dataset.impuroBooted = "true";

  try {
    return await mount(root, { runtime: RUNTIME.STANDALONE });
  } catch (error) {
    return null;
  }
}

window.ImpuroGame = {
  mount,
  destroy,
  loadConfig,
  bootstrapStandalone,
  RUNTIME
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    bootstrapStandalone();
  });
} else {
  bootstrapStandalone();
}
