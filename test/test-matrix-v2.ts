/**
 * Test Matrix V2 — Benchmark BPM Dinamico
 *
 * 18 tests in 5 categories that stress-test the sync engine
 * under dynamic BPM conditions (steps, ramps, endurance, stress).
 *
 * All tests run in "fixed" mode (no bug B1).
 * Output: results/A*.json, B*.json, C*.json, D*.json, E*.json
 *         results/summary-v2.txt
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VDeck } from '../src/engine/VDeck.js';
import { SyncEngine } from '../src/engine/SyncEngine.js';
import { MetricsCollector, type TestMetrics } from '../src/engine/MetricsCollector.js';
import { findBestRatio } from '../src/sync/harmonicSync.js';

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

interface V2TestDef {
  id: string;
  category: 'A' | 'B' | 'C' | 'D' | 'E';
  masterBpm: number;
  slaveBpm: number;
  durationS: number;
  description: string;
  steps?: BpmStep[];
  ramps?: BpmRamp[];
  /** Generator function for complex patterns (D1, D2). Called once to produce steps/ramps. */
  generator?: () => { steps?: BpmStep[]; ramps?: BpmRamp[] };
  criteria: V2Criteria;
}

interface V2Criteria {
  tRelockMax?: number;     // max relock time after any step (seconds)
  eMeanPost?: number;      // max eMean post-relock
  eMaxDuring?: number;     // max eMax during ramp
  relockCountMax?: number; // max relock count
  converge?: boolean;      // must converge at least once
  // Generous mode for stress tests
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

/** D1: Random walk ±0.5 BPM every 2s, 30 events over 60s */
function generateD1(): { steps: BpmStep[] } {
  const rng = lcg(42);
  const steps: BpmStep[] = [];
  let bpm = 170;
  for (let i = 1; i <= 30; i++) {
    const delta = (rng() - 0.5) * 1.0; // ±0.5 BPM
    bpm = Math.max(160, Math.min(180, bpm + delta));
    steps.push({ timeS: i * 2, toBpm: Math.round(bpm * 10) / 10 });
  }
  return { steps };
}

/** D2: Sinusoidal 170 ± 3 BPM, period 8s, approximated with 16 linear segments per period */
function generateD2(): { ramps: BpmRamp[] } {
  const ramps: BpmRamp[] = [];
  const baseBpm = 170;
  const amplitude = 3;
  const period = 8;
  const segmentsPerPeriod = 16;
  const totalDuration = 60;
  const numPeriods = totalDuration / period;
  const segDuration = period / segmentsPerPeriod;

  for (let p = 0; p < numPeriods; p++) {
    for (let s = 0; s < segmentsPerPeriod; s++) {
      const t0 = p * period + s * segDuration;
      const t1 = t0 + segDuration;
      const angle0 = (2 * Math.PI * (t0 / period));
      const angle1 = (2 * Math.PI * (t1 / period));
      const bpm0 = baseBpm + amplitude * Math.sin(angle0);
      const bpm1 = baseBpm + amplitude * Math.sin(angle1);
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
    // 30 steps → each recordBpmChange resets lock detector → up to 30 relocks expected
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
      { timeS: 5, toBpm: 160 },
      { timeS: 10, toBpm: 170 },
      { timeS: 15, toBpm: 160 },
      { timeS: 20, toBpm: 170 },
      { timeS: 25, toBpm: 160 },
      { timeS: 30, toBpm: 170 },
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
];

// ── Simulation runner ─────────────────────────────────────────

function runV2Test(def: V2TestDef): TestMetrics {
  // Expand generator if present
  let steps = def.steps ?? [];
  let ramps = def.ramps ?? [];
  if (def.generator) {
    const gen = def.generator();
    if (gen.steps) steps = gen.steps;
    if (gen.ramps) ramps = gen.ramps;
  }

  const master = new VDeck({
    bpm: def.masterBpm,
    originalBpm: def.masterBpm,
    firstBeatOffset: 0,
    initialPosition: 5.0,
    playbackRate: 1.0,
  });

  const slave = new VDeck({
    bpm: def.slaveBpm,
    originalBpm: def.slaveBpm,
    firstBeatOffset: 0,
    initialPosition: 5.0,
    playbackRate: 1.0,
  });

  const engine = new SyncEngine(master, slave, {
    tickRateHz: TICK_RATE_HZ,
    bridgeIntervalS: 0.5,
    simulateBugB1: false,
  });

  engine.startSync();

  const collector = new MetricsCollector();
  // Initialize segment tracking with initial BPM
  collector.recordBpmChange(0, def.masterBpm, def.masterBpm, false);

  const totalTicks = Math.round(def.durationS * TICK_RATE_HZ);
  const dt = 1 / TICK_RATE_HZ;

  // Pre-sort steps by time for efficient processing
  const sortedSteps = [...steps].sort((a, b) => a.timeS - b.timeS);
  let nextStepIdx = 0;

  // Track current BPM for ramp change detection
  let currentMasterBpm = def.masterBpm;
  let lastRampBpm: number | null = null;

  for (let i = 0; i < totalTicks; i++) {
    const t = (i + 1) * dt;

    // Process steps
    while (nextStepIdx < sortedSteps.length && t >= sortedSteps[nextStepIdx].timeS) {
      const step = sortedSteps[nextStepIdx];
      const bpmBefore = currentMasterBpm;
      const ratioBefore = findBestRatio(bpmBefore, def.slaveBpm);
      engine.changeMasterBpm(step.toBpm);
      const ratioAfter = findBestRatio(step.toBpm, def.slaveBpm);
      collector.recordBpmChange(t, bpmBefore, step.toBpm, ratioBefore !== ratioAfter);
      currentMasterBpm = step.toBpm;
      lastRampBpm = null;
      nextStepIdx++;
    }

    // Process ramps (interpolation per tick)
    for (const ramp of ramps) {
      if (t >= ramp.startS && t <= ramp.endS) {
        const frac = (t - ramp.startS) / (ramp.endS - ramp.startS);
        const bpm = ramp.fromBpm + frac * (ramp.toBpm - ramp.fromBpm);
        const roundedBpm = Math.round(bpm * 10) / 10;

        if (lastRampBpm === null || Math.abs(roundedBpm - lastRampBpm) >= 0.1) {
          const bpmBefore = currentMasterBpm;
          const ratioBefore = findBestRatio(bpmBefore, def.slaveBpm);
          engine.changeMasterBpm(roundedBpm);
          const ratioAfter = findBestRatio(roundedBpm, def.slaveBpm);

          // Only log significant changes (>=1 BPM or ratio change) to avoid flooding
          if (Math.abs(roundedBpm - bpmBefore) >= 1.0 || ratioBefore !== ratioAfter) {
            collector.recordBpmChange(t, bpmBefore, roundedBpm, ratioBefore !== ratioAfter);
          }

          currentMasterBpm = roundedBpm;
          lastRampBpm = roundedBpm;
        } else {
          // Still apply the BPM even without logging
          engine.changeMasterBpm(roundedBpm);
          currentMasterBpm = roundedBpm;
        }
        break; // only one ramp active at a time
      }
    }

    const sample = engine.tick();
    collector.addSample(sample);
  }

  return collector.compute(def.id, {
    masterBpm: def.masterBpm,
    slaveBpm: def.slaveBpm,
    slaveOffsetMs: 0,
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

  // tRelockMax: check all segments' relock times
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

  // eMeanPost: post-lock mean error
  if (c.eMeanPost !== undefined && metrics.eMean > c.eMeanPost) {
    const msg = `eMean=${metrics.eMean.toFixed(6)} > ${c.eMeanPost}`;
    if (c.generous) { info.push(msg); } else { failures.push(msg); }
  }

  // eMaxDuring: max error during the entire run
  if (c.eMaxDuring !== undefined && metrics.eMax > c.eMaxDuring) {
    const msg = `eMax=${metrics.eMax.toFixed(6)} > ${c.eMaxDuring}`;
    if (c.generous) { info.push(msg); } else { failures.push(msg); }
  }

  // relockCountMax
  if (c.relockCountMax !== undefined && metrics.relockCount > c.relockCountMax) {
    const msg = `relockCount=${metrics.relockCount} > ${c.relockCountMax}`;
    if (c.generous) { info.push(msg); } else { failures.push(msg); }
  }

  // converge: must lock at least once
  if (c.converge && !metrics.converged) {
    failures.push('never converged');
  }

  return {
    testId: def.id,
    pass: failures.length === 0,
    failures,
    info,
  };
}

// ── Format ────────────────────────────────────────────────────

function formatV2Line(m: TestMetrics, def: V2TestDef, gate: V2GateResult): string {
  const status = gate.pass ? 'PASS' : 'FAIL';
  const tLock = m.tLockS !== null ? `${m.tLockS.toFixed(3)}s` : 'never';
  const tRelockMax = m.tRelockMaxS !== null && m.tRelockMaxS !== undefined
    ? `${m.tRelockMaxS.toFixed(3)}s`
    : 'n/a';

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

  if (gate.failures.length > 0) {
    parts.push(` [${gate.failures.join('; ')}]`);
  }
  if (gate.info.length > 0) {
    parts.push(` (${gate.info.join('; ')})`);
  }

  return parts.join('  ');
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const allMetrics: TestMetrics[] = [];
  const allGates: V2GateResult[] = [];

  console.log(`\n${'='.repeat(100)}`);
  console.log('  MIXI SYNC FRAMEWORK -- TEST MATRIX V2 (Dynamic BPM Benchmark)');
  console.log(`${'='.repeat(100)}\n`);

  const categories = [
    { key: 'A', label: 'Cat A -- Step singolo' },
    { key: 'B', label: 'Cat B -- Rampe graduali' },
    { key: 'C', label: 'Cat C -- Cross-genre sotto cambio BPM' },
    { key: 'D', label: 'Cat D -- Endurance (60s)' },
    { key: 'E', label: 'Cat E -- Stress estremo' },
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

      // Write individual result
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
      const m = allMetrics.find(x => x.testId === g.testId)!;
      const def = TESTS.find(t => t.id === g.testId)!;
      const statusChar = g.pass ? '+' : '-';
      console.log(`    ${statusChar} ${g.testId}: ${def.description}`);
      if (g.failures.length > 0) {
        console.log(`      FAIL: ${g.failures.join('; ')}`);
      }
      if (g.info.length > 0) {
        console.log(`      INFO: ${g.info.join('; ')}`);
      }
    }
  }

  const totalPass = allGates.filter(g => g.pass).length;
  const totalTests = allGates.length;
  console.log(`\n  Total: ${totalPass}/${totalTests} PASS`);

  // ── Write summary file ──────────────────────────────────────

  const summaryLines: string[] = [];
  summaryLines.push('MIXI SYNC FRAMEWORK -- TEST MATRIX V2 RESULTS');
  summaryLines.push(`Date: ${new Date().toISOString()}`);
  summaryLines.push(`Total: ${totalPass}/${totalTests} PASS`);
  summaryLines.push('');

  for (const cat of categories) {
    summaryLines.push(`--- ${cat.label} ---`);
    const catTests = TESTS.filter(t => t.category === cat.key);
    for (const def of catTests) {
      const m = allMetrics.find(x => x.testId === def.id)!;
      const g = allGates.find(x => x.testId === def.id)!;
      summaryLines.push(formatV2Line(m, def, g));
    }
    summaryLines.push('');
  }

  writeFileSync(join(RESULTS_DIR, 'summary-v2.txt'), summaryLines.join('\n'));

  // Write summary JSON
  const summaryJson = {
    timestamp: new Date().toISOString(),
    totalPass,
    totalTests,
    tests: allGates.map(g => {
      const m = allMetrics.find(x => x.testId === g.testId)!;
      return {
        testId: g.testId,
        pass: g.pass,
        failures: g.failures,
        info: g.info,
        tLockS: m.tLockS,
        eMean: m.eMean,
        eMax: m.eMax,
        discontinuities: m.discontinuities,
        relockCount: m.relockCount,
        tRelockMaxS: m.tRelockMaxS,
        bpmEvents: m.bpmEvents?.length ?? 0,
        segments: m.segments?.length ?? 0,
      };
    }),
  };
  writeFileSync(join(RESULTS_DIR, 'summary-v2.json'), JSON.stringify(summaryJson, null, 2));

  console.log(`\n${'='.repeat(100)}\n`);

  // Exit with 0 — V2 is a benchmark, not a gate (some FAILs are expected data)
  process.exit(0);
}

main();
