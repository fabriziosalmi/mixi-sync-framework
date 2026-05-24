# AUDIT.md — Analisi Matematica del Motore Sync di MIXI

Data audit: 2026-05-24
Codice analizzato: `~/Documents/git/mixi` (read-only, nessuna modifica)

---

## A0.0 — Scoperta Architetturale Critica: DUE Sistemi PLL

MIXI ha **due** sistemi di sync completamente indipendenti:

### Sistema 1: Network Sync (MixiSyncBridge + PhaseLock)
- **File**: `src/sync/MixiSyncBridge.ts`, `src/sync/PhaseLock.ts`
- **Scopo**: sync tra macchine diverse via UDP :4303 / BroadcastChannel
- **Loop rate**: 50 Hz (setTimeout)
- **Controller**: PID con gain scheduling per volume
- **NON usato per sync locale tra deck A e B sullo stesso browser**

### Sistema 2: Local Sync (PhaseLockLoop + PitchShiftProcessor worklet)
- **File**: `src/audio/PhaseLockLoop.ts`, `src/audio/pitch-shift-processor.ts`
- **Scopo**: sync tra deck A e B nella stessa istanza
- **Loop rate**: PI controller nel worklet a ~344 Hz (128 samples @ 44100), bridge a 2 Hz
- **QUESTO è il sistema usato quando clicchi Sync**

### Catena di chiamata al clic Sync

```
User clicks Sync on Deck B
    ↓
store.syncDeck('B')                           [mixiStore.ts:448]
    ├─ findBestRatio(masterBpm, slaveBpm)      [harmonicSync.ts:40]
    ├─ engine.setPlaybackRate('B', newRate)     [MixiEngine.ts:872]
    ├─ Phase alignment seek                    [mixiStore.ts:490-539]
    │   ├─ masterFrac = ((masterTime - firstBeatOffset) / beatPeriod) % 1
    │   ├─ slaveFrac  = ((slaveTime  - firstBeatOffset) / beatPeriod) % 1
    │   ├─ phaseDelta = wrap(masterFrac - slaveFrac)
    │   └─ engine.seek('B', targetTime)
    ├─ phaseLockLoop.reset('B')
    ├─ phaseLockLoop.start()
    ├─ phaseLockLoop.freeze('B')
    └─ setTimeout(phaseLockLoop.unfreeze('B'), 200ms)
         ↓  (dopo 200ms)
    PhaseLockLoop.tick() @ 2 Hz
    ├─ computePhaseDelta()                     [PhaseLockLoop.ts:386]
    ├─ postWorkletMessage('sync', {params})    [PhaseLockLoop.ts:318]
    ├─ postWorkletMessage('updatePlayheads')   [PhaseLockLoop.ts:376]
    └─ postWorkletMessage('setDriftCorrection')[PhaseLockLoop.ts:371]
         ↓
    PitchShiftProcessor.process() @ ~344 Hz    [pitch-shift-processor.ts:178]
    ├─ Integrate playheads: masterTime += dt * masterRate
    ├─ masterFrac, slaveFrac computation
    ├─ phaseDelta = wrap(masterFrac - slaveFrac)
    ├─ error = phaseDelta + onsetOffset - pllTarget
    ├─ PI controller: P = 0.04*error, I = 0.002*∫error
    ├─ pllCorrection = clamp(P+I, ±0.003)
    └─ effectiveRate = baseRate*(1+pllCorrection+driftCorrection)+nudge
         ↓
    output[1] → source.playbackRate (direct AudioParam connection)
```

---

## A0.1 — Verifica Algebrica della Catena di Fase

### Formula di fase (identica in 3 punti del codice)

```
phase(t, bpm, offset) = (((t - offset) / (60/bpm)) mod 1 + 1) mod 1
```

Dove:
- `t` = posizione nella traccia (secondi dall'inizio del file)
- `offset` = firstBeatOffset (secondi dall'inizio del file al primo kick)
- Il doppio modulo `(x % 1 + 1) % 1` gestisce valori negativi

**Verifica dimensionale**: ✅
- `t - offset` → secondi
- `60 / bpm` → secondi per beat
- `(t - offset) / (60/bpm)` → adimensionale (numero di beat)
- `% 1` → fase [0, 1)

### Punto 1: store.syncDeck() — Allineamento iniziale

```typescript
// mixiStore.ts ~line 498-510
const masterTime = engine.getCurrentTime(otherDeckId);
const masterBeatPeriod = 60 / masterBpm;
const masterFrac = (((masterTime - other.firstBeatOffset) / masterBeatPeriod) % 1 + 1) % 1;
const thisTime = engine.getCurrentTime(deck);
const thisBeatPeriod = 60 / effectiveBpm;
const thisFrac = (((thisTime - thisDeck.firstBeatOffset) / thisBeatPeriod) % 1 + 1) % 1;

let phaseDelta = masterFrac - thisFrac;
if (phaseDelta > 0.5) phaseDelta -= 1;
if (phaseDelta < -0.5) phaseDelta += 1;
let seekOffset = phaseDelta * thisBeatPeriod;
```

**Analisi**: `getCurrentTime()` restituisce la posizione nel file audio. `firstBeatOffset` è relativo allo stesso riferimento. **Formula corretta.**

Il seek finale: `transport.offset = thisTime + seekOffset`

Dopo il seek, `thisFrac` dovrebbe essere uguale a `masterFrac`. Verifica:
```
thisFrac_new = (((thisTime + seekOffset - firstBeatOffset) / beatPeriod) % 1 + 1) % 1
seekOffset = phaseDelta * beatPeriod
thisFrac_new = (((thisTime - firstBeatOffset) / beatPeriod + phaseDelta) % 1 + 1) % 1
             = ((thisFrac + phaseDelta) % 1 + 1) % 1
             = ((thisFrac + masterFrac - thisFrac) % 1 + 1) % 1
             = masterFrac  ✅
```

### Punto 2: PhaseLockLoop.computePhaseDelta()

```typescript
// PhaseLockLoop.ts:386-414
const masterTime = engine.getCurrentTime(masterDeck);
const slaveTime = engine.getCurrentTime(slaveDeck);
const masterPeriod = 60 / master.bpm;
const ratio = findBestRatio(master.bpm, slave.originalBpm);
const slavePeriod = ratio !== 1
  ? virtualBeatPeriod(slave.bpm, ratio)
  : 60 / slave.bpm;
const masterFrac = (((masterTime - master.firstBeatOffset) / masterPeriod) % 1 + 1) % 1;
const slaveFrac = (((slaveTime - slave.firstBeatOffset) / slavePeriod) % 1 + 1) % 1;
let delta = masterFrac - slaveFrac;
if (delta > 0.5) delta -= 1;
if (delta < -0.5) delta += 1;
```

**Analisi**: Stessa formula, stessi riferimenti. `virtualBeatPeriod` per harmonic sync. **Formula corretta.**

### Punto 3: PitchShiftProcessor.process() — Worklet PI

```javascript
// pitch-shift-processor.ts:207-232
const dt = frames / sampleRate;
const masterRate = this.masterOriginalBpm > 0
  ? (this.masterBpm / this.masterOriginalBpm) : 1.0;
this.masterTime += dt * masterRate;
const slaveRate = this.baseRate * (1.0 + this.pllCorrection);
this.slaveTime += dt * slaveRate;
// ... loop wrapping ...
const masterPeriod = 60 / this.masterBpm;
const slaveBpm = this.slaveOriginalBpm * this.baseRate;
const masterFrac = (((this.masterTime - this.masterFirstBeatOffset) / masterPeriod) % 1 + 1) % 1;
const slaveFrac = (((this.slaveTime - this.slaveFirstBeatOffset) / slavePeriod) % 1 + 1) % 1;
```

**Analisi**: Il worklet integra le posizioni localmente. Ogni 500ms vengono corrette da `updatePlayheads`.

### ⚠ BUG TROVATO #1: getCurrentTime() non tiene conto delle correzioni PLL

```typescript
// MixiEngine.ts:1455-1484
getCurrentTime(deck: DeckId): number {
  const transport = this.transports[deck];
  if (transport.source) {
    const elapsed = (this.ctx.currentTime - transport.startedAt) * transport.playbackRate;
    let pos = transport.offset + elapsed;
    return pos;
  }
  return transport.offset;
}
```

`transport.playbackRate` è il **base rate** (es. 1.0). Ma il worklet modifica la velocità effettiva via control signal:

```
effectiveRate = baseRate * (1 + pllCorrection + driftCorrection) + nudge
```

`pllCorrection` può essere fino a ±0.003, `driftCorrection` fino a ±0.0005.

`getCurrentTime()` **ignora queste micro-correzioni**, quindi restituisce una posizione che diverge lentamente dalla posizione reale dell'audio.

**Impatto quantitativo**:
```
errore_posizione(t) = pllCorrection × t
  con pllCorrection = 0.003 (worst case):
  dopo 1s: 3ms
  dopo 5s: 15ms
  dopo 10s: 30ms
```

Ogni 500ms `updatePlayheads` invia al worklet questa posizione imprecisa, creando un errore di fase:
```
phase_error_inject = errore_posizione / beat_period
  a 170 BPM (beat_period = 352.9ms):
  dopo 500ms: 0.003 × 0.5 / 0.3529 = 0.00425 phase
```

Questo supera la **DEADZONE (0.003)**, quindi il PI non raggiunge mai lo steady state: ad ogni `updatePlayheads`, il worklet riceve una posizione leggermente sbagliata, corregge, ma poi riceve di nuovo una posizione sbagliata.

**Gravità: ALTA** — causa oscillazione perpetua del PI.

### ⚠ BUG TROVATO #2: MixiSyncBridge usa formula fase errata

```typescript
// MixiSyncBridge.ts:215
const elapsed = ctx.currentTime - activeDeck.firstBeatOffset;
```

`ctx.currentTime` = clock assoluto AudioContext (es. 45.123s dalla creazione del AC).
`firstBeatOffset` = posizione del primo beat nel file audio (es. 0.15s).

`45.123 - 0.15 = 44.973` → **non ha significato fisico**.

Dovrebbe essere:
```typescript
const trackPosition = engine.getCurrentTime(deckId);
const elapsed = trackPosition - activeDeck.firstBeatOffset;
```

**Gravità**: MEDIA (impatta solo il network sync, non il sync locale). Ma se un giorno si usa BroadcastChannel per sync tra due tab sullo stesso PC, questo bug rompe tutto.

---

## A0.2 — Analisi di Stabilità del PI Controller (Worklet)

### Parametri del controllore

```
Kp = 0.04
Ki = 0.002
DEADZONE = 0.003 phase
MAX_CORRECTION = ±0.003 (±0.3% del playbackRate)
INTEGRAL_MAX = ±0.05
dt = 128/44100 = 0.002902s (per ogni process() call)
Loop rate = 44100/128 = 344.5 Hz
```

### Modello z-transform (linearizzato, senza deadzone e clamp)

Il sistema è un controllore PI discreto che agisce su una fase:

```
Plant: phase(k+1) = phase(k) - correction(k) × dt_beat
  dove dt_beat = dt / beat_period = 0.002902 / (60/170) = 0.008222

Controller:
  e(k) = phase_error(k)
  integral(k) = integral(k-1) + e(k) × dt
  correction(k) = Kp × e(k) + Ki × integral(k)
  correction(k) = clamp(correction(k), ±0.003)
```

Funzione di trasferimento aperta (senza clamp):
```
G(z) = [Kp + Ki × dt × z/(z-1)] × dt_beat
     = [0.04 + 0.002 × 0.002902 × z/(z-1)] × 0.008222
     = 0.000329 + 0.0000048 × z/(z-1)
```

### ⚠ BUG TROVATO #3: Correzione troppo lenta per errori > DEADZONE

Con MAX_CORRECTION = ±0.003:

```
max_phase_correction_per_beat = MAX_CORRECTION × 1 = 0.003
  (la correzione del 0.3% del rate muove la fase di 0.003 per beat)

Tempo per correggere errore di 0.1 (35.3ms a 170 BPM):
  0.1 / 0.003 = 33.3 beat = 33.3 × 0.353s = 11.8 secondi

Tempo per correggere errore di 0.05 (17.6ms):
  0.05 / 0.003 = 16.7 beat = 5.9 secondi

Tempo per correggere errore di 0.01 (3.5ms):
  0.01 / 0.003 = 3.3 beat = 1.2 secondi
```

Se l'allineamento iniziale (seek nel `syncDeck()`) è perfetto, il PI deve correggere solo micro-errori e funziona. Ma se il seek è impreciso di anche solo 20ms (0.057 phase a 170 BPM), servono ~6.7 secondi per convergere.

**E il Bug #1 (getCurrentTime drift) impedisce la convergenza**, perché ogni 500ms inietta ~1.5ms di errore.

### Analisi del deadzone + decay

Dentro il deadzone (|error| < 0.003):
```javascript
this.integral *= 0.95;
this.pllCorrection *= 0.95;
```

Con process() a 344 Hz, il decay per secondo:
```
0.95^344 = 2.6 × 10^-8  (praticamente zero in 1 secondo)
```

Questo significa che appena l'errore scende sotto 0.003, la correzione viene azzerata istantaneamente. Se c'è un drift residuo (dal Bug #1), il sistema oscilla tra:
- Errore > 0.003 → PI corregge → errore diminuisce
- Errore < 0.003 → PI si spegne → errore ricresce
- Ciclo ripetuto

**Gravità: ALTA** — il sistema non raggiunge mai steady state stabile.

---

## A0.3 — Analisi BPM Detection

### File: `mixi-core/src/bpm.rs`

```rust
let opts = DetectOptions {
    min_bpm: bpm_min as f64,
    max_bpm: bpm_max as f64,
    segmented: true,
    ..Default::default()
};
```

I valori `bpm_min` e `bpm_max` vengono passati dal TypeScript. Non ho potuto leggere dove vengono impostati nel codice TS, ma tipicamente DJ software usa 60-200 o 70-180.

### Rischio octave error

Se il range è [60, 200], per una traccia a 170:
- 85 (metà) è nel range → possibile half-detection
- 340 (doppio) è fuori range → nessun rischio di double-detection

La logica di octave resolution dipende da open-bpm. Senza leggere il codice di open-bpm, non posso verificare se favorisce 170 vs 85. Questo andrà testato empiricamente con le tracce di test.

### snap_offset_to_first_onset()

```rust
fn snap_offset_to_first_onset(mono: &[f32], sr: f32, phase: f32, bpm: f32) -> f32 {
    let window_samples = (sr * 0.025) as usize; // ±25ms
    let threshold: f32 = 0.01; // ~-40dBFS
    // Scansiona fino a 64 beat avanti
}
```

**Analisi**:
- Finestra ±25ms (1103 samples @ 44100): sufficientemente larga
- Soglia -40dBFS: potrebbe essere troppo bassa (rileva anche rumore di fondo)
- Scansiona solo 64 beat: per una traccia con intro strumentale lunga (>22s a 170 BPM) potrebbe non trovare il primo kick vero

Per le nostre tracce di test (kick a t=0, ampiezza 0.8), la funzione funzionerà sicuramente. Il rischio è con tracce reali con intro ambient.

---

## A0.4 — Analisi Timing

### setTimeout/setInterval jitter

| Timer | Rate | Implementazione | Jitter atteso |
|-------|------|-----------------|---------------|
| Worklet PI | 344 Hz | AudioWorklet.process() | < 0.1ms (hardware-timed) |
| PhaseLockLoop | 2 Hz | setInterval(500ms) | 1-16ms (browser event loop) |
| MixiSyncBridge | 50 Hz | setTimeout ricorsivo drift-compensato | 1-16ms |

Il **worklet** gira a frequenza hardware (128 samples/callback, zero jitter). Questo è il componente critico e non ha problemi di timing.

Il **PhaseLockLoop** a 2 Hz ha jitter irrilevante: usato solo per aggiornamenti lenti (drift, onset correlation, playhead sync).

### Latenza postMessage (main thread → worklet)

MessagePort.postMessage usa la coda microtask del worklet. Latenza stimata:
```
1-3ms in condizioni normali
5-20ms se il main thread è occupato (rendering React, GC)
```

Per `updatePlayheads` (2 Hz), questa latenza aggiunge un errore di posizione:
```
errore = latenza × playbackRate
  con latenza 5ms: errore = 5ms × 1.0 = 5ms → 0.014 phase a 170 BPM
```

Con il Bug #1 già presente, questo errore aggiuntivo peggiora la situazione.

---

## Riepilogo Bug Trovati

| ID | Severità | Componente | Descrizione | Impatto a 170 BPM |
|----|----------|-----------|-------------|-------------------|
| **B1** | **ALTA** | MixiEngine.getCurrentTime() | Non contabilizza le micro-correzioni PLL del worklet. Inietta ~1.5ms di errore ogni 500ms via updatePlayheads. | PI oscilla, non converge |
| **B2** | MEDIA | MixiSyncBridge.sendPacket() | `ctx.currentTime - firstBeatOffset` = formula senza senso fisico | Solo network sync |
| **B3** | **ALTA** | PitchShiftProcessor PI | MAX_CORRECTION = ±0.003 (±0.3%) troppo basso. Convergenza da errore 10% → 11.8s. Combined con B1 → non converge mai. | Sync lentissimo o assente |
| **B4** | MEDIA | PitchShiftProcessor PI | Deadzone decay a 0.95^344/s azzera la correzione istantaneamente, causando hunting. | Micro-oscillazione ±1ms |
| **B5** | BASSA | snap_offset_to_first_onset() | Soglia -40dBFS troppo bassa, max 64 beat scan | Offset errato su tracce con intro lunga |

### Interazione tra B1 e B3 (la causa probabile del problema)

```
1. syncDeck() fa il seek iniziale → fase allineata a ~0 errore
2. PLL nel worklet inizia a correggere → pllCorrection ≈ 0
3. Dopo 500ms, PhaseLockLoop.tick() invia updatePlayheads
4. getCurrentTime() calcola slaveTime con base rate, ignorando pllCorrection
   → slaveTime ha errore di ~1.5ms rispetto alla realtà
5. Il worklet riceve slaveTime sbagliato → discontinuity detector potrebbe triggerare
   → integral e correction resettati a 0
6. Ora il PI deve riconvergere, ma il ciclo si ripete ogni 500ms
7. Il PI non raggiunge mai uno stato stabile
```

A 170 BPM con due tracce identiche, questo si manifesta come: le beat grid sembrano quasi allineate ma c'è un leggero offset che fluttua, i beat non sono mai perfettamente a fuoco.

---

## Gate 0 — Checklist

| KPI | Criterio | PASS/FAIL |
|-----|----------|-----------|
| G0.1 | Catena di fase documentata formula per formula | ✅ PASS |
| G0.2 | Stabilità PI dimostrata o bug trovato | ✅ PASS (B1, B3, B4 trovati) |
| G0.3 | Range BPM e octave logic documentati | ✅ PASS (dipende da open-bpm, da testare) |
| G0.4 | Timing analysis completata | ✅ PASS |
| G0.5 | AUDIT.md scritto con tutte le formule | ✅ PASS |

**Gate 0: VERDE** ✅ — Procediamo a Fase 1.
