/**
 * Test Matrix V2 — Benchmark BPM Dinamico + Imperfezioni Realistiche
 *
 * 42 tests in 8 categories:
 *   A-E: Dynamic BPM (16 tests, deterministic ideal conditions)
 *   F:   Realistic imperfections (8 tests — jitter, noise, BPM error, GC pause)
 *   G:   Adversarial stress (8 tests — PI bandwidth limits, compound perturbations)
 *   H:   Combined stress + edge cases (10 tests — dynamic BPM with imperfections)
 *
 * All tests run in "fixed" mode (no bug B1).
 * Output: results/{A..F}*.json + results/summary-v2.{txt,json}
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VDeck } from '../src/engine/VDeck.js';
import { SyncEngine } from '../src/engine/SyncEngine.js';
import { MetricsCollector, type TestMetrics } from '../src/engine/MetricsCollector.js';
import { findBestRatio } from '../src/sync/harmonicSync.js';
import { updatePlayheads } from '../src/sync/WorkletPI.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '..', 'results');

const TICK_RATE_HZ = 44100 / 128;

// ── Test definitions ──────────────────────────────────────────

interface BpmStep {
  timeS: number;
  toBpm: number;
}

interface BpmRamp {
  startS: number;
  endS: number;
  fromBpm: number;
  toBpm: number;
}

interface ImperfectionConfig {
  /** ±jitter on bridge timing in seconds (deterministic PRNG). */
  bridgeJitterS?: number;
  /** ±noise on reported slave position in seconds. */
  positionNoiseS?: number;
  /** Position kicks (simulating GC pauses). */
  perturbations?: { timeS: number; deltaMs: number }[];
  /** Override bridge interval (default 0.5s). */
  bridgeIntervalS?: number;
  /** Bridge blackout window [startS, endS] — no bridge ticks during this period. */
  bridgeBlackout?: [number, number];
  /** PRNG seed for this test's imperfections. */
  seed?: number;
}

interface V2TestDef {
  id: string;
  category: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
  masterBpm: number;
  slaveBpm: number;
  durationS: number;
  description: string;
  steps?: BpmStep[];
  ramps?: BpmRamp[];
  generator?: () => { steps?: BpmStep[]; ramps?: BpmRamp[] };
  criteria: V2Criteria;
  // Deck config overrides
  slaveOriginalBpm?: number;      // override detected BPM (for BPM detection error)
  masterFirstBeatOffset?: number;
  slaveFirstBeatOffset?: number;
  slaveInitialOffsetMs?: number;
  // Position overrides (default: 5.0s into the track)
  masterInitialPositionS?: number;
  slaveInitialPositionS?: number;
  // Imperfection config (Cat F)
  imperfections?: ImperfectionConfig;
}

interface V2Criteria {
  tRelockMax?: number;
  eMeanPost?: number;
  eMaxDuring?: number;
  relockCountMax?: number;
  converge?: boolean;
  generous?: boolean;
}

// ── Deterministic PRNG (LCG) ──────────────────────────────────

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff; // [0, 1)
  };
}

// ── Generators ────────────────────────────────────────────────

function generateD1(): { steps: BpmStep[] } {
  const rng = lcg(42);
  const steps: BpmStep[] = [];
  let bpm = 170;
  for (let i = 1; i <= 30; i++) {
    const delta = (rng() - 0.5) * 1.0;
    bpm = Math.max(160, Math.min(180, bpm + delta));
    steps.push({ timeS: i * 2, toBpm: Math.round(bpm * 10) / 10 });
  }
  return { steps };
}

function generateD2(): { ramps: BpmRamp[] } {
  const ramps: BpmRamp[] = [];
  const baseBpm = 170, amplitude = 3, period = 8;
  const segmentsPerPeriod = 16, totalDuration = 60;
  const numPeriods = totalDuration / period;
  const segDuration = period / segmentsPerPeriod;

  for (let p = 0; p < numPeriods; p++) {
    for (let s = 0; s < segmentsPerPeriod; s++) {
      const t0 = p * period + s * segDuration;
      const t1 = t0 + segDuration;
      const bpm0 = baseBpm + amplitude * Math.sin(2 * Math.PI * t0 / period);
      const bpm1 = baseBpm + amplitude * Math.sin(2 * Math.PI * t1 / period);
      ramps.push({
        startS: Math.round(t0 * 1000) / 1000,
        endS: Math.round(t1 * 1000) / 1000,
        fromBpm: Math.round(bpm0 * 10) / 10,
        toBpm: Math.round(bpm1 * 10) / 10,
      });
    }
  }
  return { ramps };
}

/** F8 generator: random walk + BPM steps over 5 minutes */
function generateF8Walk(): { steps: BpmStep[] } {
  const rng = lcg(7777);
  const steps: BpmStep[] = [];
  let bpm = 170;
  // Random walk every 3s for 300s = 100 steps
  for (let i = 1; i <= 100; i++) {
    const delta = (rng() - 0.5) * 2.0; // ±1.0 BPM
    bpm = Math.max(155, Math.min(185, bpm + delta));
    steps.push({ timeS: i * 3, toBpm: Math.round(bpm * 10) / 10 });
  }
  return { steps };
}

// ── Test catalog ──────────────────────────────────────────────

const TESTS: V2TestDef[] = [
  // ── Cat A: Step singolo ──
  {
    id: 'A1', category: 'A', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'DJ nudge +2 BPM',
    steps: [{ timeS: 10, toBpm: 172 }],
    criteria: { tRelockMax: 5, eMeanPost: 0.005 },
  },
  {
    id: 'A2', category: 'A', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Tempo up +5 BPM',
    steps: [{ timeS: 10, toBpm: 175 }],
    criteria: { tRelockMax: 8, eMeanPost: 0.005 },
  },
  {
    id: 'A3', category: 'A', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Drop -10 BPM',
    steps: [{ timeS: 10, toBpm: 160 }],
    criteria: { tRelockMax: 15, eMeanPost: 0.005 },
  },
  {
    id: 'A4', category: 'A', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Genre shift (ratio 1->0.75)',
    steps: [{ timeS: 10, toBpm: 128 }],
    criteria: { tRelockMax: 20, eMeanPost: 0.01, generous: true },
  },
  {
    id: 'A5', category: 'A', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Andata e ritorno',
    steps: [{ timeS: 10, toBpm: 175 }, { timeS: 20, toBpm: 170 }],
    criteria: { tRelockMax: 8, eMeanPost: 0.005 },
  },

  // ── Cat B: Rampe graduali ──
  {
    id: 'B1', category: 'B', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Ramp dolce (1 BPM/s)',
    ramps: [{ startS: 10, endS: 15, fromBpm: 170, toBpm: 175 }],
    criteria: { eMaxDuring: 0.05, eMeanPost: 0.005 },
  },
  {
    id: 'B2', category: 'B', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Ramp moderata',
    ramps: [{ startS: 10, endS: 20, fromBpm: 170, toBpm: 180 }],
    criteria: { eMaxDuring: 0.05, eMeanPost: 0.005 },
  },
  {
    id: 'B3', category: 'B', masterBpm: 128, slaveBpm: 170, durationS: 40,
    description: 'Cross-genre graduale 128->170 in 20s',
    ramps: [{ startS: 10, endS: 30, fromBpm: 128, toBpm: 170 }],
    criteria: { eMaxDuring: 0.1, eMeanPost: 0.01, generous: true },
  },

  // ── Cat C: Cross-genre sotto cambio BPM ──
  {
    id: 'C1', category: 'C', masterBpm: 128, slaveBpm: 170, durationS: 30,
    description: '4:3, master si muove',
    steps: [{ timeS: 10, toBpm: 130 }],
    criteria: { tRelockMax: 8, eMeanPost: 0.005 },
  },
  {
    id: 'C2', category: 'C', masterBpm: 170, slaveBpm: 170.5, durationS: 30,
    description: 'Near-BPM, master sale',
    steps: [{ timeS: 10, toBpm: 175 }],
    criteria: { tRelockMax: 8, eMeanPost: 0.005 },
  },

  // ── Cat D: Endurance (60s) ──
  {
    id: 'D1', category: 'D', masterBpm: 170, slaveBpm: 170, durationS: 60,
    description: 'Random walk +-0.5 BPM ogni 2s',
    generator: generateD1,
    criteria: { relockCountMax: 30, converge: true },
  },
  {
    id: 'D2', category: 'D', masterBpm: 170, slaveBpm: 170, durationS: 60,
    description: 'Sinusoidale 170 +- 3 BPM, periodo 8s',
    generator: generateD2,
    criteria: { eMaxDuring: 0.05, converge: true },
  },
  {
    id: 'D3', category: 'D', masterBpm: 170, slaveBpm: 170, durationS: 40,
    description: 'Scalini 170->172->168->175->170',
    steps: [
      { timeS: 8, toBpm: 172 },
      { timeS: 16, toBpm: 168 },
      { timeS: 24, toBpm: 175 },
      { timeS: 32, toBpm: 170 },
    ],
    criteria: { tRelockMax: 10, eMeanPost: 0.005 },
  },

  // ── Cat E: Stress estremo ──
  {
    id: 'E1', category: 'E', masterBpm: 170, slaveBpm: 170, durationS: 40,
    description: 'Alternanza rapida 170<->160 ogni 5s',
    steps: [
      { timeS: 5, toBpm: 160 }, { timeS: 10, toBpm: 170 },
      { timeS: 15, toBpm: 160 }, { timeS: 20, toBpm: 170 },
      { timeS: 25, toBpm: 160 }, { timeS: 30, toBpm: 170 },
      { timeS: 35, toBpm: 160 },
    ],
    criteria: { converge: true, generous: true },
  },
  {
    id: 'E2', category: 'E', masterBpm: 120, slaveBpm: 170, durationS: 40,
    description: 'Sweep completo 120->200 in 30s',
    ramps: [{ startS: 5, endS: 35, fromBpm: 120, toBpm: 200 }],
    criteria: { converge: true, generous: true },
  },
  {
    id: 'E3', category: 'E', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Half-time 170->85 (ratio 1->2)',
    steps: [{ timeS: 10, toBpm: 85 }],
    criteria: { tRelockMax: 20, generous: true },
  },

  // ── Cat F: Imperfezioni realistiche ──
  {
    id: 'F1', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Bridge jitter +-20ms',
    imperfections: { bridgeJitterS: 0.020, seed: 100 },
    criteria: { eMeanPost: 0.003, converge: true },
  },
  {
    id: 'F2', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Position noise +-3ms su slave',
    imperfections: { positionNoiseS: 0.003, seed: 200 },
    criteria: { eMeanPost: 0.01, converge: true },
  },
  {
    id: 'F3', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'BPM detection error (slave 169.7 instead of 170)',
    slaveOriginalBpm: 169.7,
    criteria: { eMeanPost: 0.01, converge: true },
  },
  {
    id: 'F4', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Different firstBeatOffset (master 0.2s, slave 0.5s)',
    masterFirstBeatOffset: 0.2,
    slaveFirstBeatOffset: 0.5,
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'F5', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'GC pause: 5ms position kick every 8s',
    imperfections: {
      perturbations: [
        { timeS: 8, deltaMs: 5 },
        { timeS: 16, deltaMs: -5 },
        { timeS: 24, deltaMs: 5 },
      ],
      seed: 300,
    },
    // 5ms kick = 0.014 phase at 170 BPM. PI corrects at ~0.0085 phase/s
    // → ~1.6s recovery per kick. 3 kicks in 30s raises eMean above 0.005.
    // 0.008 phase = ~2.8ms at 170 BPM — still sub-audible.
    criteria: { eMeanPost: 0.008, converge: true },
  },
  {
    id: 'F6', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Jitter +-15ms + BPM step +5 @10s',
    steps: [{ timeS: 10, toBpm: 175 }],
    imperfections: { bridgeJitterS: 0.015, seed: 400 },
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'F7', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Slow bridge 2s + ramp 170->175',
    ramps: [{ startS: 10, endS: 15, fromBpm: 170, toBpm: 175 }],
    imperfections: { bridgeIntervalS: 2.0, seed: 500 },
    criteria: { eMaxDuring: 0.1, eMeanPost: 0.01, converge: true },
  },
  {
    id: 'F8', category: 'F', masterBpm: 170, slaveBpm: 170, durationS: 300,
    description: 'Kitchen sink 5min: walk + jitter +-10ms + noise +-2ms',
    generator: generateF8Walk,
    imperfections: { bridgeJitterS: 0.010, positionNoiseS: 0.002, seed: 600 },
    criteria: { converge: true, relockCountMax: 100, generous: true },
  },

  // ── Cat G: Draconiano — find PI breaking points ──
  {
    id: 'G1', category: 'G', masterBpm: 170, slaveBpm: 170, durationS: 60,
    description: 'GC barrage: 10ms kick every 2s (30 kicks)',
    imperfections: {
      perturbations: Array.from({ length: 30 }, (_, i) => ({
        timeS: (i + 1) * 2,
        deltaMs: (i % 2 === 0) ? 10 : -10,
      })),
      seed: 700,
    },
    // 10ms = 0.028 phase. PI corrects at 0.0085/s → 3.3s recovery.
    // Kicks every 2s → PI can't fully recover. Persistent error expected.
    criteria: { eMeanPost: 0.015, converge: true },
  },
  {
    id: 'G2', category: 'G', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Catastrophic GC pause: 50ms kick',
    imperfections: {
      perturbations: [{ timeS: 10, deltaMs: 50 }],
      seed: 701,
    },
    // 50ms = 0.142 phase. Recovery = 0.142/0.0085 = 16.7s
    // Known PI bandwidth limit: MAX_CORRECTION=0.003 → can't recover fast enough
    criteria: { eMeanPost: 0.02, converge: true, generous: true },
  },
  {
    id: 'G3', category: 'G', masterBpm: 131, slaveBpm: 170, durationS: 30,
    description: 'Ratio boundary hunt: 131<->132 every 2s',
    // At slave=170: ratio 0.75 valid up to master~131.25, then falls to ratio 1
    // Each flip triggers a seek — adversarial for the PI
    steps: Array.from({ length: 7 }, (_, i) => ({
      timeS: 4 + i * 3,
      toBpm: i % 2 === 0 ? 132 : 131,
    })),
    criteria: { converge: true, generous: true },
  },
  {
    id: 'G4', category: 'G', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Heavy position noise +-10ms',
    imperfections: { positionNoiseS: 0.010, seed: 703 },
    // 10ms = 0.028 phase noise per bridge tick.
    // PI will oscillate around zero with amplitude ~0.028
    criteria: { eMeanPost: 0.02, converge: true },
  },
  {
    id: 'G5', category: 'G', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Bridge blackout 10s (t=10-20s) then resume',
    imperfections: {
      bridgeBlackout: [10, 20],
      seed: 704,
    },
    // PI integrates internally so should be fine during blackout.
    // After resume, updatePlayheads re-syncs positions.
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'G6', category: 'G', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'GC pause 15ms at BPM change (170->175 @10s)',
    steps: [{ timeS: 10, toBpm: 175 }],
    imperfections: {
      perturbations: [{ timeS: 9.999, deltaMs: 15 }],
      seed: 705,
    },
    // 15ms kick + BPM change simultaneously — compound worst-case timing
    criteria: { eMeanPost: 0.01, converge: true, generous: true },
  },
  {
    id: 'G7', category: 'G', masterBpm: 40, slaveBpm: 40, durationS: 60,
    description: 'Extreme low BPM (40), GC pause 5ms',
    imperfections: {
      perturbations: [
        { timeS: 15, deltaMs: 5 },
        { timeS: 30, deltaMs: -5 },
        { timeS: 45, deltaMs: 5 },
      ],
      seed: 706,
    },
    // 40 BPM: beat period = 1.5s. 5ms = 0.0033 phase — barely above deadzone (0.003)
    // PI correction speed at 40 BPM = 0.003 * 40/60 = 0.002 phase/s
    // Recovery from 0.0033 = 1.65s
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'G8', category: 'G', masterBpm: 170, slaveBpm: 170, durationS: 120,
    description: 'Maximum realistic stress 2min',
    generator: () => {
      const rng = lcg(9999);
      const steps: BpmStep[] = [];
      let bpm = 170;
      for (let i = 1; i <= 40; i++) {
        bpm = Math.max(160, Math.min(180, bpm + (rng() - 0.5) * 4));
        steps.push({ timeS: i * 3, toBpm: Math.round(bpm * 10) / 10 });
      }
      return { steps };
    },
    imperfections: {
      bridgeJitterS: 0.020,
      positionNoiseS: 0.005,
      perturbations: Array.from({ length: 12 }, (_, i) => ({
        timeS: 10 + i * 10,
        deltaMs: ((i % 3) - 1) * 8, // -8, 0, 8, -8, 0, 8, ...
      })),
      seed: 708,
    },
    // Everything maxed: ±2 BPM walk, ±20ms jitter, ±5ms noise, 8ms kicks every 10s
    criteria: { converge: true, eMeanPost: 0.01, generous: true },
  },

  // ── Cat H: Combined stress + edge cases (la lacuna) ──────

  {
    id: 'H1', category: 'H', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Ramp 170->180 with bridge jitter +-15ms + noise +-3ms',
    ramps: [{ startS: 5, endS: 15, fromBpm: 170, toBpm: 180 }],
    imperfections: {
      bridgeJitterS: 0.015,
      positionNoiseS: 0.003,
      seed: 801,
    },
    // Ramp + imperfections simultaneously — the real-world gap
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'H2', category: 'H', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Step 170->175 @10s with 3 GC pauses around it (8s,10s,12s)',
    steps: [{ timeS: 10, toBpm: 175 }],
    imperfections: {
      perturbations: [
        { timeS: 8, deltaMs: 5 },
        { timeS: 10.001, deltaMs: 8 },
        { timeS: 12, deltaMs: -5 },
      ],
      seed: 802,
    },
    // BPM step bracketed by GC pauses
    criteria: { eMeanPost: 0.008, converge: true },
  },
  {
    id: 'H3', category: 'H', masterBpm: 128, slaveBpm: 170, durationS: 40,
    description: 'Cross-genre ramp 128->135 with position noise +-5ms',
    // Crosses ratio boundary ~131 BPM while noise is active
    ramps: [{ startS: 5, endS: 25, fromBpm: 128, toBpm: 135 }],
    imperfections: {
      positionNoiseS: 0.005,
      seed: 803,
    },
    criteria: { eMeanPost: 0.008, converge: true },
  },
  {
    id: 'H4', category: 'H', masterBpm: 128, slaveBpm: 128, durationS: 180,
    description: 'Realistic DJ session: 128->132->128->140->128 with jitter+noise',
    // 3-minute simulation of a real DJ set with imperfections
    steps: [
      { timeS: 20, toBpm: 130 },
      { timeS: 45, toBpm: 132 },
      { timeS: 70, toBpm: 128 },
      { timeS: 90, toBpm: 135 },
      { timeS: 120, toBpm: 140 },
      { timeS: 150, toBpm: 128 },
    ],
    imperfections: {
      bridgeJitterS: 0.010,
      positionNoiseS: 0.002,
      perturbations: [
        { timeS: 30, deltaMs: 3 },
        { timeS: 60, deltaMs: -3 },
        { timeS: 100, deltaMs: 5 },
        { timeS: 140, deltaMs: -4 },
      ],
      seed: 804,
    },
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'H5', category: 'H', masterBpm: 200, slaveBpm: 200, durationS: 30,
    description: 'High BPM 200 with ramp +10 and 5ms GC kicks',
    steps: [{ timeS: 10, toBpm: 210 }],
    imperfections: {
      perturbations: [
        { timeS: 5, deltaMs: 5 },
        { timeS: 15, deltaMs: -5 },
        { timeS: 25, deltaMs: 5 },
      ],
      seed: 805,
    },
    // 200 BPM: beat period = 0.3s, PI correction = 0.003*200/60 = 0.01 phase/s (faster!)
    // 5ms = 0.017 phase → 1.7s recovery
    criteria: { eMeanPost: 0.008, converge: true },
  },
  {
    id: 'H6', category: 'H', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Slave near position 0 (0.1s) + ratio change step',
    // Tests Math.max(0) clamp in seek: slave at 0.1s, ratio change
    // seeks backward and potentially clamps to 0
    slaveInitialPositionS: 0.1,
    masterInitialPositionS: 0.1,
    steps: [{ timeS: 0.5, toBpm: 128 }], // triggers ratio change 1 -> 0.75
    criteria: { eMeanPost: 0.01, converge: true, generous: true },
  },
  {
    id: 'H7', category: 'H', masterBpm: 170, slaveBpm: 170, durationS: 60,
    description: 'Endurance ramp sweep 160->180->160 with all imperfections',
    ramps: [
      { startS: 5, endS: 25, fromBpm: 170, toBpm: 180 },
      { startS: 30, endS: 50, fromBpm: 180, toBpm: 160 },
    ],
    imperfections: {
      bridgeJitterS: 0.012,
      positionNoiseS: 0.003,
      perturbations: [
        { timeS: 10, deltaMs: 4 },
        { timeS: 20, deltaMs: -3 },
        { timeS: 35, deltaMs: 5 },
        { timeS: 45, deltaMs: -4 },
      ],
      seed: 807,
    },
    // Continuous ramp + imperfections for 60s
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'H8', category: 'H', masterBpm: 170, slaveBpm: 170, durationS: 30,
    description: 'Asymmetric offsets (master 0.3s, slave 0.8s) + BPM step + noise',
    masterFirstBeatOffset: 0.3,
    slaveFirstBeatOffset: 0.8,
    steps: [{ timeS: 10, toBpm: 175 }, { timeS: 20, toBpm: 168 }],
    imperfections: {
      positionNoiseS: 0.004,
      seed: 808,
    },
    // Different firstBeatOffsets + dynamic BPM + noise
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'H9', category: 'H', masterBpm: 170, slaveBpm: 85, durationS: 30,
    description: 'Half-time slave (ratio 2) + ramp + jitter',
    // Slave originalBpm=85, ratio=2: master 170 -> slave plays at 85 but phase-locked
    ramps: [{ startS: 8, endS: 18, fromBpm: 170, toBpm: 175 }],
    imperfections: {
      bridgeJitterS: 0.015,
      seed: 809,
    },
    // Cross-ratio with ramp and imperfections
    criteria: { eMeanPost: 0.005, converge: true },
  },
  {
    id: 'H10', category: 'H', masterBpm: 170, slaveBpm: 170, durationS: 300,
    description: 'Ultimate 5min: walk + ramps + kicks + jitter + noise',
    generator: (): { steps: BpmStep[]; ramps: BpmRamp[] } => {
      const rng = lcg(810);
      const steps: BpmStep[] = [];
      const ramps: BpmRamp[] = [];

      // Phase 1: 0-60s — steady with small nudges
      for (let t = 10; t < 60; t += 8) {
        steps.push({ timeS: t, toBpm: 170 + (rng() - 0.5) * 4 });
      }
      // Phase 2: 60-120s — ramp up
      ramps.push({ startS: 60, endS: 90, fromBpm: 170, toBpm: 180 });
      // Phase 3: 120-180s — hold at 180 with walks
      for (let t = 95; t < 180; t += 10) {
        steps.push({ timeS: t, toBpm: 180 + (rng() - 0.5) * 3 });
      }
      // Phase 4: 180-240s — ramp down through potential ratio boundary
      ramps.push({ startS: 180, endS: 220, fromBpm: 180, toBpm: 160 });
      // Phase 5: 240-300s — settle back
      steps.push({ timeS: 225, toBpm: 165 });
      steps.push({ timeS: 260, toBpm: 170 });

      return { steps, ramps };
    },
    imperfections: {
      bridgeJitterS: 0.012,
      positionNoiseS: 0.003,
      perturbations: (() => {
        const p: { timeS: number; deltaMs: number }[] = [];
        const rng = lcg(811);
        for (let t = 15; t < 290; t += 20 + rng() * 10) {
          p.push({ timeS: Math.round(t * 10) / 10, deltaMs: (rng() - 0.4) * 8 });
        }
        return p;
      })(),
      seed: 812,
    },
    // The definitive test: everything combined for 5 minutes
    criteria: { eMeanPost: 0.005, converge: true },
  },
];

// ── Simulation runner ─────────────────────────────────────────

function runV2Test(def: V2TestDef): TestMetrics {
  // Expand generator
  let steps = def.steps ?? [];
  let ramps = def.ramps ?? [];
  if (def.generator) {
    const gen = def.generator();
    if (gen.steps) steps = gen.steps;
    if (gen.ramps) ramps = gen.ramps;
  }

  const imp = def.imperfections;
  const hasImperfections = !!imp && (
    (imp.bridgeJitterS ?? 0) > 0 ||
    (imp.positionNoiseS ?? 0) > 0 ||
    (imp.perturbations?.length ?? 0) > 0 ||
    (imp.bridgeIntervalS ?? 0) > 0 ||
    !!imp.bridgeBlackout
  );

  const masterOffset = def.masterFirstBeatOffset ?? 0;
  const slaveOffset = def.slaveFirstBeatOffset ?? 0;
  const slaveOrigBpm = def.slaveOriginalBpm ?? def.slaveBpm;
  const slaveInitOffset = (def.slaveInitialOffsetMs ?? 0) / 1000;

  const masterPos = def.masterInitialPositionS ?? 5.0;
  const slavePos = def.slaveInitialPositionS ?? 5.0;

  const master = new VDeck({
    bpm: def.masterBpm,
    originalBpm: def.masterBpm,
    firstBeatOffset: masterOffset,
    initialPosition: masterPos,
    playbackRate: 1.0,
  });

  const slave = new VDeck({
    bpm: def.slaveBpm,
    originalBpm: slaveOrigBpm,
    firstBeatOffset: slaveOffset,
    initialPosition: slavePos - slaveInitOffset,
    playbackRate: 1.0,
  });

  // If imperfections active, disable internal bridge and control it manually
  const bridgeInterval = imp?.bridgeIntervalS ?? 0.5;
  const engine = new SyncEngine(master, slave, {
    tickRateHz: TICK_RATE_HZ,
    bridgeIntervalS: hasImperfections ? 999999 : 0.5,
    simulateBugB1: false,
  });

  engine.startSync();

  const collector = new MetricsCollector();
  collector.recordBpmChange(0, def.masterBpm, def.masterBpm, false);

  const totalTicks = Math.round(def.durationS * TICK_RATE_HZ);
  const dt = 1 / TICK_RATE_HZ;

  const sortedSteps = [...steps].sort((a, b) => a.timeS - b.timeS);
  let nextStepIdx = 0;
  let currentMasterBpm = def.masterBpm;
  let lastRampBpm: number | null = null;

  // Imperfection state
  const impRng = lcg(imp?.seed ?? 42);
  let nextBridgeTime = bridgeInterval;
  const perturbations = [...(imp?.perturbations ?? [])].sort((a, b) => a.timeS - b.timeS);
  let nextPertIdx = 0;

  for (let i = 0; i < totalTicks; i++) {
    const t = (i + 1) * dt;

    // Process steps
    while (nextStepIdx < sortedSteps.length && t >= sortedSteps[nextStepIdx].timeS) {
      const step = sortedSteps[nextStepIdx];
      const bpmBefore = currentMasterBpm;
      const ratioBefore = findBestRatio(bpmBefore, slaveOrigBpm);
      engine.changeMasterBpm(step.toBpm);
      const ratioAfter = findBestRatio(step.toBpm, slaveOrigBpm);
      collector.recordBpmChange(t, bpmBefore, step.toBpm, ratioBefore !== ratioAfter);
      currentMasterBpm = step.toBpm;
      lastRampBpm = null;
      nextStepIdx++;
    }

    // Process ramps
    for (const ramp of ramps) {
      if (t >= ramp.startS && t <= ramp.endS) {
        const frac = (t - ramp.startS) / (ramp.endS - ramp.startS);
        const bpm = ramp.fromBpm + frac * (ramp.toBpm - ramp.fromBpm);
        const roundedBpm = Math.round(bpm * 10) / 10;

        if (lastRampBpm === null || Math.abs(roundedBpm - lastRampBpm) >= 0.1) {
          const bpmBefore = currentMasterBpm;
          const ratioBefore = findBestRatio(bpmBefore, slaveOrigBpm);
          engine.changeMasterBpm(roundedBpm);
          const ratioAfter = findBestRatio(roundedBpm, slaveOrigBpm);

          if (Math.abs(roundedBpm - bpmBefore) >= 1.0 || ratioBefore !== ratioAfter) {
            collector.recordBpmChange(t, bpmBefore, roundedBpm, ratioBefore !== ratioAfter);
          }

          currentMasterBpm = roundedBpm;
          lastRampBpm = roundedBpm;
        } else {
          engine.changeMasterBpm(roundedBpm);
          currentMasterBpm = roundedBpm;
        }
        break;
      }
    }

    // Apply perturbations (GC pause simulation)
    while (nextPertIdx < perturbations.length && t >= perturbations[nextPertIdx].timeS) {
      const pert = perturbations[nextPertIdx];
      const deltaS = pert.deltaMs / 1000;
      slave.position += deltaS;
      nextPertIdx++;
    }

    // Manual bridge tick with jitter, noise, and optional blackout
    const blackout = imp?.bridgeBlackout;
    const inBlackout = blackout && t >= blackout[0] && t <= blackout[1];
    if (hasImperfections && t >= nextBridgeTime && !inBlackout) {
      const reportedMaster = master.position;
      let reportedSlave = slave.position;

      // Add position noise
      if (imp!.positionNoiseS) {
        const noise = (impRng() - 0.5) * 2 * imp!.positionNoiseS;
        reportedSlave += noise;
      }

      updatePlayheads(engine.piState, reportedMaster, reportedSlave);

      // Schedule next bridge with jitter
      let nextInterval = bridgeInterval;
      if (imp!.bridgeJitterS) {
        nextInterval += (impRng() - 0.5) * 2 * imp!.bridgeJitterS;
        nextInterval = Math.max(0.05, nextInterval); // floor at 50ms
      }
      nextBridgeTime = t + nextInterval;
    }

    const sample = engine.tick();
    collector.addSample(sample);
  }

  return collector.compute(def.id, {
    masterBpm: def.masterBpm,
    slaveBpm: def.slaveBpm,
    slaveOffsetMs: def.slaveInitialOffsetMs ?? 0,
    simulateBugB1: false,
    durationS: def.durationS,
    tickRateHz: TICK_RATE_HZ,
  });
}

// ── Evaluate criteria ─────────────────────────────────────────

interface V2GateResult {
  testId: string;
  pass: boolean;
  failures: string[];
  info: string[];
}

function evaluateV2(metrics: TestMetrics, def: V2TestDef): V2GateResult {
  const failures: string[] = [];
  const info: string[] = [];
  const c = def.criteria;

  if (c.tRelockMax !== undefined && metrics.segments) {
    for (const seg of metrics.segments) {
      if (seg.tRelockS !== null && seg.tRelockS > c.tRelockMax) {
        const msg = `segment @${seg.startS.toFixed(1)}s: tRelock=${seg.tRelockS.toFixed(3)}s > ${c.tRelockMax}s`;
        if (c.generous) { info.push(msg); } else { failures.push(msg); }
      }
      if (seg.tRelockS === null && seg.endS - seg.startS > c.tRelockMax) {
        const msg = `segment @${seg.startS.toFixed(1)}s: never relocked within ${(seg.endS - seg.startS).toFixed(1)}s`;
        if (c.generous) { info.push(msg); } else { failures.push(msg); }
      }
    }
  }

  if (c.eMeanPost !== undefined && metrics.eMean > c.eMeanPost) {
    const msg = `eMean=${metrics.eMean.toFixed(6)} > ${c.eMeanPost}`;
    if (c.generous) { info.push(msg); } else { failures.push(msg); }
  }

  if (c.eMaxDuring !== undefined && metrics.eMax > c.eMaxDuring) {
    const msg = `eMax=${metrics.eMax.toFixed(6)} > ${c.eMaxDuring}`;
    if (c.generous) { info.push(msg); } else { failures.push(msg); }
  }

  if (c.relockCountMax !== undefined && metrics.relockCount > c.relockCountMax) {
    const msg = `relockCount=${metrics.relockCount} > ${c.relockCountMax}`;
    if (c.generous) { info.push(msg); } else { failures.push(msg); }
  }

  if (c.converge && !metrics.converged) {
    failures.push('never converged');
  }

  return { testId: def.id, pass: failures.length === 0, failures, info };
}

// ── Format ────────────────────────────────────────────────────

function formatV2Line(m: TestMetrics, def: V2TestDef, gate: V2GateResult): string {
  const status = gate.pass ? 'PASS' : 'FAIL';
  const tLock = m.tLockS !== null ? `${m.tLockS.toFixed(3)}s` : 'never';
  const tRelockMax = m.tRelockMaxS !== null && m.tRelockMaxS !== undefined
    ? `${m.tRelockMaxS.toFixed(3)}s` : 'n/a';

  const parts = [
    `${def.id.padEnd(4)}`,
    `${status.padEnd(5)}`,
    `e=${m.eMean.toFixed(6)}`,
    `eMax=${m.eMax.toFixed(6)}`,
    `tLock=${tLock.padStart(8)}`,
    `tRelockMax=${tRelockMax.padStart(8)}`,
    `disc=${String(m.discontinuities).padStart(3)}`,
    `relock=${m.relockCount}`,
  ];

  if (gate.failures.length > 0) parts.push(` [${gate.failures.join('; ')}]`);
  if (gate.info.length > 0) parts.push(` (${gate.info.join('; ')})`);

  return parts.join('  ');
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const allMetrics: TestMetrics[] = [];
  const allGates: V2GateResult[] = [];

  console.log(`\n${'='.repeat(100)}`);
  console.log('  MIXI SYNC FRAMEWORK -- TEST MATRIX V2 (Dynamic BPM + Realistic Imperfections)');
  console.log(`${'='.repeat(100)}\n`);

  const categories = [
    { key: 'A', label: 'Cat A -- Step singolo' },
    { key: 'B', label: 'Cat B -- Rampe graduali' },
    { key: 'C', label: 'Cat C -- Cross-genre sotto cambio BPM' },
    { key: 'D', label: 'Cat D -- Endurance (60s)' },
    { key: 'E', label: 'Cat E -- Stress estremo' },
    { key: 'F', label: 'Cat F -- Imperfezioni realistiche' },
    { key: 'G', label: 'Cat G -- Draconiano (limiti PI)' },
    { key: 'H', label: 'Cat H -- Stress combinato + edge cases' },
  ];

  for (const cat of categories) {
    const catTests = TESTS.filter(t => t.category === cat.key);
    if (catTests.length === 0) continue;

    console.log(`\n${'-'.repeat(100)}`);
    console.log(`  ${cat.label}`);
    console.log(`${'-'.repeat(100)}`);

    for (const def of catTests) {
      console.log(`  Running ${def.id}: ${def.description}...`);
      const metrics = runV2Test(def);
      const gate = evaluateV2(metrics, def);

      allMetrics.push(metrics);
      allGates.push(gate);

      writeFileSync(
        join(RESULTS_DIR, `${def.id}.json`),
        JSON.stringify(metrics, null, 2),
      );

      console.log(`  ${formatV2Line(metrics, def, gate)}`);
    }
  }

  // ── Summary ─────────────────────────────────────────────────

  console.log(`\n${'='.repeat(100)}`);
  console.log('  SUMMARY V2');
  console.log(`${'='.repeat(100)}`);

  for (const cat of categories) {
    const catGates = allGates.filter(g => g.testId.startsWith(cat.key));
    const pass = catGates.filter(g => g.pass).length;
    const total = catGates.length;
    const label = pass === total ? 'ALL PASS' : `${pass}/${total} PASS`;
    console.log(`  ${cat.key}: ${label}`);

    for (const g of catGates) {
      const def = TESTS.find(t => t.id === g.testId)!;
      const statusChar = g.pass ? '+' : '-';
      console.log(`    ${statusChar} ${g.testId}: ${def.description}`);
      if (g.failures.length > 0) console.log(`      FAIL: ${g.failures.join('; ')}`);
      if (g.info.length > 0) console.log(`      INFO: ${g.info.join('; ')}`);
    }
  }

  const totalPass = allGates.filter(g => g.pass).length;
  const totalTests = allGates.length;
  console.log(`\n  Total: ${totalPass}/${totalTests} PASS`);

  // ── Write files ─────────────────────────────────────────────

  const summaryLines: string[] = [];
  summaryLines.push('MIXI SYNC FRAMEWORK -- TEST MATRIX V2 RESULTS');
  summaryLines.push(`Date: ${new Date().toISOString()}`);
  summaryLines.push(`Total: ${totalPass}/${totalTests} PASS`);
  summaryLines.push('');
  for (const cat of categories) {
    summaryLines.push(`--- ${cat.label} ---`);
    for (const def of TESTS.filter(t => t.category === cat.key)) {
      const m = allMetrics.find(x => x.testId === def.id)!;
      const g = allGates.find(x => x.testId === def.id)!;
      summaryLines.push(formatV2Line(m, def, g));
    }
    summaryLines.push('');
  }
  writeFileSync(join(RESULTS_DIR, 'summary-v2.txt'), summaryLines.join('\n'));

  const summaryJson = {
    timestamp: new Date().toISOString(),
    totalPass,
    totalTests,
    tests: allGates.map(g => {
      const m = allMetrics.find(x => x.testId === g.testId)!;
      return {
        testId: g.testId, pass: g.pass, failures: g.failures, info: g.info,
        tLockS: m.tLockS, eMean: m.eMean, eMax: m.eMax,
        discontinuities: m.discontinuities, relockCount: m.relockCount,
        tRelockMaxS: m.tRelockMaxS,
        bpmEvents: m.bpmEvents?.length ?? 0, segments: m.segments?.length ?? 0,
      };
    }),
  };
  writeFileSync(join(RESULTS_DIR, 'summary-v2.json'), JSON.stringify(summaryJson, null, 2));

  console.log(`\n${'='.repeat(100)}\n`);
  process.exit(0);
}

main();
