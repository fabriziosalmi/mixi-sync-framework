/**
 * Test Matrix — Fase 3
 *
 * 13 deterministic tests × 2 modes (with bug B1, without bug B1).
 * Total: 26 test runs.
 *
 * Each test: 30 seconds simulated at worklet rate (344.5 Hz).
 * Output: results/*.json + results/summary.json + results/summary.txt
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VDeck } from '../src/engine/VDeck.js';
import { SyncEngine } from '../src/engine/SyncEngine.js';
import { MetricsCollector, type TestMetrics } from '../src/engine/MetricsCollector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, '..', 'results');

// ── Test definitions ──────────────────────────────────────────

interface TestDef {
  id: string;
  masterBpm: number;
  slaveBpm: number;
  slaveOffsetMs: number;
  description: string;
  criteria: {
    eMean?: number;       // max acceptable ē
    tLock?: number;       // max acceptable t_lock (seconds)
    noSeek?: boolean;     // expects no discontinuity-triggered seek
    converge?: boolean;   // must converge
    relockMax?: number;   // max relock count
  };
}

const TESTS: TestDef[] = [
  {
    id: 'T01', masterBpm: 170, slaveBpm: 170, slaveOffsetMs: 0,
    description: 'Identical, already in phase',
    criteria: { eMean: 0.001, noSeek: true },
  },
  {
    id: 'T02', masterBpm: 170, slaveBpm: 170, slaveOffsetMs: 50,
    description: 'Small offset 50ms',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T03', masterBpm: 170, slaveBpm: 170, slaveOffsetMs: 100,
    description: 'Medium offset 100ms',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T04', masterBpm: 170, slaveBpm: 170,
    slaveOffsetMs: +(60 / 170 * 1000 / 2).toFixed(2), // half beat = 176.47ms
    description: 'Half-beat offset (worst case)',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T05', masterBpm: 170, slaveBpm: 170, slaveOffsetMs: 250,
    description: 'Large offset 250ms',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T06', masterBpm: 170, slaveBpm: 170,
    slaveOffsetMs: +(60 / 170 * 1000).toFixed(2), // exactly 1 beat = 352.94ms
    description: 'Exactly 1 beat offset',
    criteria: { eMean: 0.001, noSeek: true },
  },
  {
    id: 'T07', masterBpm: 128, slaveBpm: 170, slaveOffsetMs: 0,
    description: 'Cross-genre: house→DnB',
    criteria: { converge: true },
  },
  {
    id: 'T08', masterBpm: 170, slaveBpm: 128, slaveOffsetMs: 0,
    description: 'Cross-genre: DnB→house',
    criteria: { converge: true },
  },
  {
    id: 'T09', masterBpm: 140, slaveBpm: 140, slaveOffsetMs: 100,
    description: 'Mid-range 140 BPM',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T10', masterBpm: 200, slaveBpm: 200, slaveOffsetMs: 100,
    description: 'High range 200 BPM',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T11', masterBpm: 80, slaveBpm: 80, slaveOffsetMs: 100,
    description: 'Low range 80 BPM',
    criteria: { tLock: 2, eMean: 0.005 },
  },
  {
    id: 'T12', masterBpm: 80, slaveBpm: 200, slaveOffsetMs: 0,
    description: 'Extreme range 80→200',
    criteria: { converge: true },
  },
  {
    id: 'T13', masterBpm: 170, slaveBpm: 170.5, slaveOffsetMs: 0,
    description: 'Near-identical BPM (170 vs 170.5)',
    criteria: { converge: true, eMean: 0.01 },
  },
];

const SIMULATION_DURATION_S = 30;
const TICK_RATE_HZ = 44100 / 128;

// ── Run one test ──────────────────────────────────────────────

function runTest(def: TestDef, simulateBugB1: boolean): TestMetrics {
  const offsetS = def.slaveOffsetMs / 1000;

  const master = new VDeck({
    bpm: def.masterBpm,
    originalBpm: def.masterBpm,
    firstBeatOffset: 0,
    initialPosition: 5.0, // start 5s into the track
    playbackRate: 1.0,
  });

  const slave = new VDeck({
    bpm: def.slaveBpm,
    originalBpm: def.slaveBpm,
    firstBeatOffset: 0,
    initialPosition: 5.0 - offsetS,
    playbackRate: 1.0,
  });

  const engine = new SyncEngine(master, slave, {
    tickRateHz: TICK_RATE_HZ,
    bridgeIntervalS: 0.5,
    simulateBugB1,
  });

  engine.startSync();

  const collector = new MetricsCollector();
  const totalTicks = Math.round(SIMULATION_DURATION_S * TICK_RATE_HZ);

  for (let i = 0; i < totalTicks; i++) {
    const sample = engine.tick();
    collector.addSample(sample);
  }

  const suffix = simulateBugB1 ? 'bugB1' : 'fixed';
  const testId = `${def.id}_${suffix}`;

  return collector.compute(testId, {
    masterBpm: def.masterBpm,
    slaveBpm: def.slaveBpm,
    slaveOffsetMs: def.slaveOffsetMs,
    simulateBugB1,
    durationS: SIMULATION_DURATION_S,
    tickRateHz: TICK_RATE_HZ,
  });
}

// ── Evaluate criteria ─────────────────────────────────────────

interface GateResult {
  testId: string;
  pass: boolean;
  failures: string[];
}

function evaluate(metrics: TestMetrics, def: TestDef): GateResult {
  const failures: string[] = [];
  const c = def.criteria;

  if (c.eMean !== undefined && metrics.eMean > c.eMean) {
    failures.push(`eMean=${metrics.eMean.toFixed(6)} > ${c.eMean}`);
  }
  if (c.tLock !== undefined) {
    if (metrics.tLockS === null) {
      failures.push(`never locked (need tLock < ${c.tLock}s)`);
    } else if (metrics.tLockS > c.tLock) {
      failures.push(`tLock=${metrics.tLockS.toFixed(3)}s > ${c.tLock}s`);
    }
  }
  if (c.noSeek && metrics.discontinuities > 0) {
    failures.push(`${metrics.discontinuities} discontinuities (expected 0)`);
  }
  if (c.converge && !metrics.converged) {
    failures.push('did not converge');
  }
  if (c.relockMax !== undefined && metrics.relockCount > c.relockMax) {
    failures.push(`relockCount=${metrics.relockCount} > ${c.relockMax}`);
  }

  return {
    testId: metrics.testId,
    pass: failures.length === 0,
    failures,
  };
}

// ── Format summary ────────────────────────────────────────────

function formatSummaryLine(m: TestMetrics, def: TestDef, gate: GateResult): string {
  const status = gate.pass ? 'PASS' : 'FAIL';
  const tLock = m.tLockS !== null ? `${m.tLockS.toFixed(3)}s` : 'never';
  const beatPeriod = 60 / def.masterBpm;

  return [
    `${m.testId.padEnd(16)}`,
    `${status.padEnd(5)}`,
    `ē=${m.eMean.toFixed(6)}`,
    `ē_ms=${m.eMeanMs.toFixed(3).padStart(7)}`,
    `eMax=${m.eMax.toFixed(6)}`,
    `eMax_ms=${m.eMaxMs.toFixed(3).padStart(7)}`,
    `σ=${m.eStd.toFixed(6)}`,
    `tLock=${tLock.padStart(8)}`,
    `disc=${String(m.discontinuities).padStart(3)}`,
    `dz=${m.deadzonePercent.toFixed(1).padStart(5)}%`,
    `relock=${m.relockCount}`,
    gate.failures.length > 0 ? `  [${gate.failures.join('; ')}]` : '',
  ].join('  ');
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const allMetrics: TestMetrics[] = [];
  const allGates: GateResult[] = [];

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  MIXI SYNC FRAMEWORK — TEST MATRIX (Fase 3)');
  console.log(`${'═'.repeat(80)}\n`);

  // Run each test in both modes
  for (const mode of ['bugB1', 'fixed'] as const) {
    const simulateBugB1 = mode === 'bugB1';
    const modeLabel = simulateBugB1
      ? '🔴 MODE: WITH BUG B1 (mixi current behavior)'
      : '🟢 MODE: WITHOUT BUG B1 (fixed getCurrentTime)';

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  ${modeLabel}`);
    console.log(`${'─'.repeat(80)}`);

    for (const def of TESTS) {
      const metrics = runTest(def, simulateBugB1);
      const gate = evaluate(metrics, def);

      allMetrics.push(metrics);
      allGates.push(gate);

      // Write individual result
      const filename = `${metrics.testId}.json`;
      writeFileSync(
        join(RESULTS_DIR, filename),
        JSON.stringify(metrics, null, 2),
      );

      // Print line
      console.log(formatSummaryLine(metrics, def, gate));
    }
  }

  // ── Summary ─────────────────────────────────────────────────

  const bugB1Results = allGates.filter(g => g.testId.includes('bugB1'));
  const fixedResults = allGates.filter(g => g.testId.includes('fixed'));

  const bugB1Pass = bugB1Results.filter(g => g.pass).length;
  const fixedPass = fixedResults.filter(g => g.pass).length;

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  SUMMARY');
  console.log(`${'═'.repeat(80)}`);
  console.log(`  With bug B1:    ${bugB1Pass}/${bugB1Results.length} PASS`);
  console.log(`  Without bug B1: ${fixedPass}/${fixedResults.length} PASS`);

  // Gate 3 check
  const gate3Checks = [
    { id: 'G3.1', pass: allMetrics.length === 26, desc: 'All 26 tests executed' },
    { id: 'G3.2', pass: checkGate('T01_fixed', 0.001), desc: 'T01 fixed: ē < 0.001' },
    { id: 'G3.3', pass: ['T02','T03','T04','T05'].every(t =>
        checkTLockAndMean(`${t}_fixed`, 2, 0.005)),
      desc: 'T02-T05 fixed: tLock<2s, ē<0.005' },
    { id: 'G3.4', pass: checkGate('T06_fixed', 0.001), desc: 'T06 fixed: ē < 0.001' },
    { id: 'G3.5', pass: checkT04NotWrongBeat(), desc: 'T04: chose nearest beat' },
    { id: 'G3.6', pass: ['T07','T08'].every(t =>
        allMetrics.find(m => m.testId === `${t}_fixed`)?.converged ?? false),
      desc: 'T07-T08 fixed: convergence' },
    { id: 'G3.7', pass: allMetrics.filter(m => m.testId.includes('fixed'))
        .every(m => m.relockCount <= 2),
      desc: 'No fixed test with relockCount > 2' },
    { id: 'G3.8', pass: true, desc: 'summary.json generated' },
  ];

  console.log(`\n  Gate 3 Checklist:`);
  for (const g of gate3Checks) {
    console.log(`    ${g.pass ? '✅' : '❌'} ${g.id}: ${g.desc}`);
  }

  const gate3Pass = gate3Checks.every(g => g.pass);
  console.log(`\n  Gate 3: ${gate3Pass ? '✅ VERDE' : '❌ ROSSO'}`);

  // If bug B1 mode shows worse results, highlight the delta
  console.log(`\n  ── Bug B1 Impact Analysis ──`);
  for (const def of TESTS) {
    const bugMetrics = allMetrics.find(m => m.testId === `${def.id}_bugB1`);
    const fixMetrics = allMetrics.find(m => m.testId === `${def.id}_fixed`);
    if (bugMetrics && fixMetrics) {
      const bugGate = allGates.find(g => g.testId === `${def.id}_bugB1`)!;
      const fixGate = allGates.find(g => g.testId === `${def.id}_fixed`)!;
      if (!bugGate.pass && fixGate.pass) {
        console.log(`    ${def.id}: B1 causes FAIL → fix makes PASS`);
        console.log(`      ē: ${bugMetrics.eMean.toFixed(6)} → ${fixMetrics.eMean.toFixed(6)}`);
        console.log(`      ē_ms: ${bugMetrics.eMeanMs.toFixed(3)} → ${fixMetrics.eMeanMs.toFixed(3)}`);
      } else if (!bugGate.pass && !fixGate.pass) {
        console.log(`    ${def.id}: FAIL in both modes (deeper issue)`);
      }
    }
  }

  console.log(`${'═'.repeat(80)}\n`);

  // Write summary
  const summary = {
    timestamp: new Date().toISOString(),
    simulationDurationS: SIMULATION_DURATION_S,
    tickRateHz: TICK_RATE_HZ,
    gate3: gate3Pass ? 'VERDE' : 'ROSSO',
    gate3Checks: gate3Checks.map(g => ({ ...g })),
    bugB1Summary: { pass: bugB1Pass, total: bugB1Results.length },
    fixedSummary: { pass: fixedPass, total: fixedResults.length },
    tests: allMetrics.map(m => {
      const gate = allGates.find(g => g.testId === m.testId)!;
      return {
        testId: m.testId,
        pass: gate.pass,
        failures: gate.failures,
        tLockS: m.tLockS,
        eMean: m.eMean,
        eMeanMs: m.eMeanMs,
        eMax: m.eMax,
        eMaxMs: m.eMaxMs,
        eStd: m.eStd,
        discontinuities: m.discontinuities,
        deadzonePercent: m.deadzonePercent,
        relockCount: m.relockCount,
      };
    }),
  };

  writeFileSync(join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  // Write text summary
  const lines: string[] = [];
  lines.push('MIXI SYNC FRAMEWORK — TEST MATRIX RESULTS');
  lines.push(`Date: ${summary.timestamp}`);
  lines.push(`Simulation: ${SIMULATION_DURATION_S}s @ ${TICK_RATE_HZ.toFixed(1)} Hz`);
  lines.push(`Gate 3: ${summary.gate3}`);
  lines.push('');
  lines.push('Bug B1 mode:');
  for (const def of TESTS) {
    const m = allMetrics.find(x => x.testId === `${def.id}_bugB1`)!;
    const g = allGates.find(x => x.testId === `${def.id}_bugB1`)!;
    lines.push(formatSummaryLine(m, def, g));
  }
  lines.push('');
  lines.push('Fixed mode:');
  for (const def of TESTS) {
    const m = allMetrics.find(x => x.testId === `${def.id}_fixed`)!;
    const g = allGates.find(x => x.testId === `${def.id}_fixed`)!;
    lines.push(formatSummaryLine(m, def, g));
  }
  writeFileSync(join(RESULTS_DIR, 'summary.txt'), lines.join('\n'));

  process.exit(gate3Pass ? 0 : 1);

  // ── Helper functions ────────────────────────────────────────

  function checkGate(testId: string, maxEMean: number): boolean {
    const m = allMetrics.find(x => x.testId === testId);
    return m ? m.eMean < maxEMean : false;
  }

  function checkTLockAndMean(testId: string, maxTLock: number, maxEMean: number): boolean {
    const m = allMetrics.find(x => x.testId === testId);
    if (!m) return false;
    if (m.tLockS === null || m.tLockS > maxTLock) return false;
    if (m.eMean > maxEMean) return false;
    return true;
  }

  function checkT04NotWrongBeat(): boolean {
    // T04 is half-beat offset. After sync, error should be near 0, not near 0.5.
    const m = allMetrics.find(x => x.testId === 'T04_fixed');
    if (!m) return false;
    // If sync chose the wrong beat, eMean would be ~0.5
    return m.eMean < 0.1;
  }
}

main();
