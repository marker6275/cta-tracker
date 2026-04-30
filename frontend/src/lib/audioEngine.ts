"use client";

import * as Tone from "tone";

const MAX_NOTES_PER_SECOND = 5;

type PlayEvent = {
  line: string;
  note: string;
};

export class CTAAudioEngine {
  private lineToInstrument: Partial<
    Record<
      string,
      | Tone.Synth
      | Tone.FMSynth
      | Tone.PluckSynth
      | Tone.MembraneSynth
      | Tone.PolySynth
      | Tone.DuoSynth
    >
  > = {};

  private noteWindowStart = Date.now();
  private noteCountInWindow = 0;
  private isMuted = false;
  private volumeDb = -8;
  private isReady = false;
  private fallbackInstrument: Tone.Synth | null = null;

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
        canonicalLine.charAt(0).toUpperCase() + canonicalLine.slice(1).toLowerCase()
      ] ??
      this.fallbackInstrument;
    if (!instrument) return false;

    this.noteCountInWindow += 1;
    Tone.Transport.scheduleOnce(() => {
      try {
        instrument.triggerAttackRelease(event.note, "8n");
      } catch {
        // Ignore malformed events so audio graph stays healthy.
      }
    }, "+0.1");

    return true;
  }

  private initializeInstruments(): void {
    this.lineToInstrument = {
      Red: new Tone.Synth().toDestination(),
      Blue: new Tone.FMSynth().toDestination(),
      Brown: new Tone.PluckSynth().toDestination(),
      Green: new Tone.MembraneSynth().toDestination(),
      Orange: new Tone.Synth({ oscillator: { type: "sawtooth" } }).toDestination(),
      Pink: new Tone.Synth({ oscillator: { type: "triangle" } }).toDestination(),
      Purple: new Tone.PolySynth().toDestination(),
      Yellow: new Tone.DuoSynth().toDestination(),
    };
    this.fallbackInstrument = new Tone.Synth({
      oscillator: { type: "triangle" },
    }).toDestination();
  }
}

export const audioEngine = new CTAAudioEngine();
