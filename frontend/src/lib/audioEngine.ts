"use client";

import * as Tone from "tone";

const MAX_NOTES_PER_SECOND = 5;

type PlayEvent = {
  line: string;
  note: string;
};

export class CTAAudioEngine {
  private lineToInstrument: Partial<Record<string, Tone.Synth>> = {};

  private noteWindowStart = Date.now();
  private noteCountInWindow = 0;
  private isMuted = false;
  private volumeDb = -8;
  private isReady = false;
  private fallbackInstrument: Tone.Synth | null = null;
  private masterCompressor: Tone.Compressor | null = null;
  private masterLimiter: Tone.Limiter | null = null;

  async start(): Promise<void> {
    if (Tone.context.state !== "running") {
      await Tone.start();
    }
    if (!this.isReady) {
      this.initializeInstruments();
      this.isReady = true;
    }
    Tone.Transport.start();
    Tone.Destination.volume.value = this.isMuted ? -Infinity : this.volumeDb;
  }

  setMuted(next: boolean): void {
    this.isMuted = next;
    Tone.Destination.volume.value = next ? -Infinity : this.volumeDb;
  }

  setVolume(db: number): void {
    this.volumeDb = db;
    if (!this.isMuted) {
      Tone.Destination.volume.value = db;
    }
  }

  schedulePlay(event: PlayEvent): boolean {
    if (!this.isReady) {
      return false;
    }
    const now = Date.now();
    if (now - this.noteWindowStart >= 1000) {
      this.noteWindowStart = now;
      this.noteCountInWindow = 0;
    }

    if (this.noteCountInWindow >= MAX_NOTES_PER_SECOND) {
      return false;
    }

    const canonicalLine = event.line.trim();
    const instrument =
      this.lineToInstrument[canonicalLine] ??
      this.lineToInstrument[
        canonicalLine.charAt(0).toUpperCase() +
          canonicalLine.slice(1).toLowerCase()
      ] ??
      this.fallbackInstrument;
    if (!instrument) return false;

    this.noteCountInWindow += 1;
    try {
      instrument.triggerAttackRelease(event.note, 0.5, Tone.now() + 0.01);
    } catch {
      // Ignore malformed events so audio graph stays healthy.
    }

    return true;
  }

  private initializeInstruments(): void {
    this.masterCompressor = new Tone.Compressor({
      threshold: -24,
      ratio: 3,
      attack: 0.01,
      release: 0.12,
    });
    this.masterLimiter = new Tone.Limiter(-3).toDestination();
    this.masterCompressor.connect(this.masterLimiter);

    const makeSawSynth = () =>
      new Tone.Synth({
        oscillator: { type: "sine" },
        envelope: {
          attack: 0.04,
          decay: 0.04,
          sustain: 1,
          release: 0.08,
        },
      }).connect(this.masterCompressor!);

    this.lineToInstrument = {
      Red: makeSawSynth(),
      Blue: makeSawSynth(),
      Brown: makeSawSynth(),
      Green: makeSawSynth(),
      Orange: makeSawSynth(),
      Pink: makeSawSynth(),
      Purple: makeSawSynth(),
      Yellow: makeSawSynth(),
    };
    this.fallbackInstrument = makeSawSynth();
  }
}

export const audioEngine = new CTAAudioEngine();
