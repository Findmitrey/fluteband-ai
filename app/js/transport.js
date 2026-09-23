// FluteBand AI — транспорт: темп, метроном, счёт-ин, повтор, позиция.
// Так как минус синтезируется из нот, темп и транспонирование не меняют высоту звука.

export class Transport {
  constructor({
    synth,
    onPosition = () => {},
    onState = () => {},
    lookahead = 0.14,
    intervalMs = 25,
    clickSink = null,
  } = {}) {
    this.synth = synth;
    this.ctx = synth.ctx;
    this.onPosition = onPosition;
    this.onState = onState;
    this.lookahead = lookahead;
    this.intervalMs = intervalMs;
    this.clickSink = clickSink || this.ctx.destination;
    this.clickGain = this.ctx.createGain();
    this.clickGain.gain.value = 0.35;
    this.clickGain.connect(this.clickSink);

    this.events = [];
    this.bpm = 100;
    this.meter = { beats: 4, beatType: 4 };
    this.totalBeats = 0;
    this.loopStart = null;
    this.loopEnd = null;
    this.metronome = false;
    this.countIn = false;
    this.playing = false;

    this.anchorBeat = 0;
    this.anchorTime = 0;
    this.scheduledUntil = 0;
    this.nextIndex = 0;
    this.timer = null;
  }

  load({ events = [], tempo = 100, meter = { beats: 4, beatType: 4 }, totalBeats = 0 } = {}) {
    this.events = [...events].sort((a, b) => a.startBeat - b.startBeat || (a.midi?.[0] ?? 0) - (b.midi?.[0] ?? 0));
    this.bpm = tempo || 100;
    this.meter = meter || { beats: 4, beatType: 4 };
    this.totalBeats = totalBeats || 0;
    this.loopStart = null;
    this.loopEnd = null;
    this.stop();
    this.onPosition(this.positionBeats);
  }

  get measureBeats() {
    return (this.meter.beats * 4) / (this.meter.beatType || 4);
  }

  get secondsPerBeat() {
    return 60 / (this.bpm || 100);
  }

  beatAt(time) {
    return this.anchorBeat + (time - this.anchorTime) / this.secondsPerBeat;
  }

  timeAt(beat) {
    return this.anchorTime + (beat - this.anchorBeat) * this.secondsPerBeat;
  }

  get positionBeats() {
    if (!this.playing) return this.anchorBeat;
    return Math.max(0, this.beatAt(this.ctx.currentTime));
  }

  get positionSeconds() {
    return this.positionBeats * this.secondsPerBeat;
  }

  play({ countIn = this.countIn } = {}) {
    if (this.playing) return;
    this.ctx.resume?.();
    const start = this.loopStart ?? 0;
    this.anchorBeat = start;
    this.scheduledUntil = start;
    this.nextIndex = this.#firstIndexAtOrAfter(start);
    const t0 = this.ctx.currentTime + 0.12;
    const preBeats = countIn ? this.measureBeats : 0;
    if (preBeats > 0) {
      for (let i = 0; i < preBeats; i += 1) {
        this.#click(t0 + i * this.secondsPerBeat, i === 0 ? 1 : 0.65);
      }
    }
    this.anchorTime = t0 + preBeats * this.secondsPerBeat;
    this.playing = true;
    this.onState('playing');
    this.#tick();
    this.timer = setInterval(() => this.#tick(), this.intervalMs);
  }

  pause() {
    if (!this.playing) return;
    this.anchorBeat = this.positionBeats;
    this.playing = false;
    this.#stopTimer();
    this.synth.allNotesOff();
    this.onState('paused');
    this.onPosition(this.anchorBeat);
  }

  stop() {
    this.playing = false;
    this.#stopTimer();
    this.synth.allNotesOff();
    this.anchorBeat = this.loopStart ?? 0;
    this.scheduledUntil = this.anchorBeat;
    this.nextIndex = this.#firstIndexAtOrAfter(this.anchorBeat);
    this.onState('stopped');
    this.onPosition(this.anchorBeat);
  }

  seek(beat) {
    const target = Math.max(0, Math.min(this.totalBeats, beat));
    if (this.playing) {
      this.synth.allNotesOff();
      this.anchorBeat = target;
      this.anchorTime = this.ctx.currentTime + 0.05;
      this.scheduledUntil = target;
      this.nextIndex = this.#firstIndexAtOrAfter(target);
    } else {
      this.anchorBeat = target;
      this.scheduledUntil = target;
      this.nextIndex = this.#firstIndexAtOrAfter(target);
    }
    this.onPosition(target);
  }

  setTempo(bpm) {
    const next = Math.max(20, Math.min(240, Math.round(bpm)));
    if (this.playing) {
      const now = this.ctx.currentTime;
      this.anchorBeat = Math.max(0, this.beatAt(now));
      this.anchorTime = now;
    }
    this.bpm = next;
    return next;
  }

  setLoopRange(startBeat, endBeat) {
    if (startBeat == null || endBeat == null || endBeat - startBeat < 0.25) {
      this.loopStart = null;
      this.loopEnd = null;
      return null;
    }
    this.loopStart = Math.max(0, startBeat);
    this.loopEnd = Math.min(this.totalBeats, endBeat);
    return { start: this.loopStart, end: this.loopEnd };
  }

  setMetronome(on) {
    this.metronome = !!on;
  }

  setCountIn(on) {
    this.countIn = !!on;
  }

  setClickVolume(value) {
    this.clickGain.gain.value = Math.max(0, Math.min(1, value));
  }

  #stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  #firstIndexAtOrAfter(beat) {
    let i = 0;
    while (i < this.events.length && this.events[i].startBeat < beat - 1e-9) i += 1;
    return i;
  }

  #hardEnd() {
    return this.loopEnd != null ? this.loopEnd : this.totalBeats;
  }

  #advanceTo(targetBeat) {
    let guard = 0;
    while (this.scheduledUntil < targetBeat - 1e-9 && guard < 500) {
      guard += 1;
      const limit = Math.min(targetBeat, this.#hardEnd());
      this.#scheduleRange(this.scheduledUntil, limit);
      this.scheduledUntil = limit;

      if (this.loopEnd != null && this.scheduledUntil >= this.loopEnd - 1e-9) {
        const wrapTime = this.timeAt(this.loopEnd);
        this.anchorBeat = this.loopStart ?? 0;
        this.anchorTime = wrapTime;
        this.scheduledUntil = this.anchorBeat;
        this.nextIndex = this.#firstIndexAtOrAfter(this.anchorBeat);
      } else if (this.scheduledUntil >= this.totalBeats - 1e-9) {
        this.#finishAt(this.timeAt(this.totalBeats));
        break;
      }
    }
  }

  #scheduleRange(fromBeat, toBeat) {
    while (this.nextIndex < this.events.length) {
      const ev = this.events[this.nextIndex];
      if (ev.startBeat >= toBeat - 1e-9) break;
      if (ev.startBeat >= fromBeat - 1e-9) {
        const when = this.timeAt(ev.startBeat);
        const dur = (ev.durBeats || 0.5) * this.secondsPerBeat * 0.97;
        this.synth.noteOn(ev.midi, when, dur, ev.velocity ?? 0.8);
      }
      this.nextIndex += 1;
    }
    if (this.metronome) {
      const first = Math.ceil(fromBeat - 1e-9);
      for (let beat = first; beat < toBeat - 1e-9; beat += 1) {
        const accent = Math.abs(beat % this.measureBeats) < 1e-6;
        this.#click(this.timeAt(beat), accent ? 1 : 0.6);
      }
    }
  }

  #click(time, accent = 1) {
    const ctx = this.ctx;
    const when = Math.max(time, ctx.currentTime);
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1600 : 1100;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(0.5 * accent, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain);
    gain.connect(this.clickGain);
    osc.start(when);
    osc.stop(when + 0.07);
  }

  #finishAt(time) {
    const delayMs = Math.max(0, (time - this.ctx.currentTime) * 1000);
    setTimeout(() => {
      if (!this.playing) return;
      this.playing = false;
      this.#stopTimer();
      this.anchorBeat = this.loopStart ?? 0;
      this.onState('ended');
      this.onPosition(this.anchorBeat);
    }, delayMs);
  }

  #tick() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    const target = this.beatAt(now + this.lookahead);
    this.#advanceTo(target);
    this.onPosition(Math.max(0, Math.min(this.#hardEnd(), this.beatAt(now))));
  }
}