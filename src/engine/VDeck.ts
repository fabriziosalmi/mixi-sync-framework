/**
 * VDeck — Virtual Deck for deterministic sync testing.
 *
 * No Web Audio API. Pure math.
 * Simulates a deck playing an audio file at a given BPM.
 */

export interface VDeckConfig {
  bpm: number;
  originalBpm: number;
  firstBeatOffset: number;
  initialPosition: number;
  playbackRate: number;
}

export class VDeck {
  bpm: number;
  originalBpm: number;
  firstBeatOffset: number;
  position: number;
  playbackRate: number;

  constructor(config: VDeckConfig) {
    this.bpm = config.bpm;
    this.originalBpm = config.originalBpm;
    this.firstBeatOffset = config.firstBeatOffset;
    this.position = config.initialPosition;
    this.playbackRate = config.playbackRate;
  }

  /**
   * Advance the playhead by dt seconds at current playbackRate.
   */
  tick(dt: number): void {
    this.position += dt * this.playbackRate;
  }

  /**
   * Current beat phase [0, 1).
   * Formula identical to mixi's phase computation.
   */
  get phase(): number {
    const beatPeriod = 60 / this.bpm;
    return (((this.position - this.firstBeatOffset) / beatPeriod) % 1 + 1) % 1;
  }

  /**
   * Current fractional beat number.
   */
  get beatNumber(): number {
    const beatPeriod = 60 / this.bpm;
    return (this.position - this.firstBeatOffset) / beatPeriod;
  }

  /**
   * Beat period in seconds.
   */
  get beatPeriod(): number {
    return 60 / this.bpm;
  }
}
