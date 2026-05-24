# PLAN.md — mixi-sync-framework

## Missione

Sync perfetto tra due deck in mixi: zero vibe-coding, solo matematica.
Ogni fase ha un **gate** con KPI misurabili. Gate rosso = non si avanza.

---

## Definizioni matematiche

```
beat_period(bpm) = 60 / bpm                         [secondi]
phase(t, bpm, offset) = ((t - offset) / beat_period(bpm)) mod 1.0   [0, 1)
phase_error(φ_master, φ_slave) = wrap(φ_master - φ_slave)           [-0.5, 0.5)
  dove wrap(x) = x - round(x)

sync_error_ms(φ_err, bpm) = |φ_err| × beat_period(bpm) × 1000     [ms]

A 170 BPM:
  beat_period = 352.941 ms
  1 sample @ 44100 Hz = 0.02268 ms
  phase di 1 sample = 0.0000642
  phase di 1 ms = 0.00283
  soglia udibile ≈ 5 ms = phase 0.01416
```

---

## KPI globali — Missione "ACHIEVED"

| KPI | Simbolo | Soglia PASS | Soglia PERFECT | Unità |
|-----|---------|-------------|----------------|-------|
| Errore fase residuo medio | ē | < 0.005 | < 0.001 | phase [0,1) |
| Errore fase residuo in ms | ē_ms | < 1.76 | < 0.35 | ms |
| Errore fase massimo post-lock | e_max | < 0.015 | < 0.003 | phase |
| Tempo di convergenza | t_lock | < 2.0 | < 0.5 | secondi |
| Jitter fase (σ) post-lock | σ_φ | < 0.003 | < 0.001 | phase |
| BPM detection accuracy | Δ_bpm | < 0.1 | < 0.01 | BPM |
| Octave error rate | OER | 0% | 0% | % |
| Beat grid offset error | Δ_offset | < 5 | < 1 | ms |

**Missione ACHIEVED** = tutti i KPI a soglia PASS su tutta la test matrix.
**Missione PERFECT** = tutti i KPI a soglia PERFECT.

---

## Fase 0 — Audit matematico del motore sync (read-only)

**Input**: codice sorgente in `~/Documents/git/mixi`
**Output**: `AUDIT.md` con analisi formale
**Regola**: non si modifica nessun file in mixi

### Analisi da eseguire

#### A0.1 — Verifica algebrica della catena di fase

Tracciare la formula esatta di `beatPhase` dal file sorgente, partendo da:
```
MixiEngine → startedAt, currentTime, playbackRate, firstBeatOffset
     ↓
MixiSyncBridge.publishHeartbeat() → beatPhase nel pacchetto
     ↓
PhaseLock.onHeartbeat() → phase_error
     ↓
PhaseLock.tick() → correction
     ↓
setDeckPlaybackRate() → playbackRate aggiornato
     ↓  (loop)
MixiEngine → nuova posizione
```

Per ogni passaggio: scrivere la formula, verificare la coerenza dimensionale, cercare errori di segno o di riferimento temporale.

#### A0.2 — Analisi di stabilità del PID

Con i gain documentati nel codice:
```
Kp = 0.05..1.0 (dipende dal volume)
Ki = 0.01..0.2
Kd = 0.0..0.3
Tick rate = 50 Hz → dt = 0.02s
```

Calcolare:
- Poli del sistema discreto z-transform
- Margine di fase e di guadagno
- Tempo di assestamento teorico (2% band) per ogni set di gain
- Condizione di instabilità (esiste un volume dove il PID oscilla?)

#### A0.3 — Analisi BPM detection

Verificare in `bpm.rs`:
- Range di BPM accettato da open-bpm (default min/max)
- Logica di octave resolution (come sceglie tra 85/170/340?)
- Precisione di `grid_offset` e conversione in `firstBeatOffset`

#### A0.4 — Analisi timing

Misurare teoricamente:
- Latenza introdotta da BroadcastChannel vs direct call
- Jitter di setTimeout a 50 Hz (letteratura: 1-16ms in browser)
- Impatto del jitter sulla stabilità del PID (sensitivity analysis)

### Gate 0

| KPI | Criterio | PASS/FAIL |
|-----|----------|-----------|
| G0.1 | Catena di fase documentata formula per formula | ☐ |
| G0.2 | Stabilità PID dimostrata o bug trovato | ☐ |
| G0.3 | Range BPM e octave logic documentati | ☐ |
| G0.4 | Timing analysis completata | ☐ |
| G0.5 | AUDIT.md scritto con tutte le formule | ☐ |

**Gate 0 VERDE** = tutti i checkbox ☑

---

## Fase 1 — Generare tracce di test deterministiche

**Output**: `test-tracks/*.mp3` + `test-tracks/manifest.json`

### Specifiche matematiche del segnale

```python
# Parametri globali
SAMPLE_RATE = 44100
DURATION = 240  # 4 minuti
CHANNELS = 2    # stereo

# Kick: sinusoide con pitch sweep esponenziale
kick(t) = A × sin(2π × f(t) × t) × env(t)
  f(t) = f_start × (f_end / f_start)^(t / t_decay)
  f_start = 150 Hz, f_end = 45 Hz, t_decay = 0.15s
  env(t) = exp(-t / 0.1)
  A = 0.8

# Snare: noise filtrato + sinusoide
snare(t) = A_noise × bandpass(noise, 200, 8000) × env_fast(t)
         + A_tone × sin(2π × 180 × t) × env_fast(t)
  env_fast(t) = exp(-t / 0.05)
  A_noise = 0.4, A_tone = 0.3

# Hi-hat: noise passa-alto
hihat(t) = A × highpass(noise, 6000) × env_vfast(t)
  env_vfast(t) = exp(-t / 0.02)
  A = 0.25

# Perc: noise band-pass stretto
perc(t) = A × bandpass(noise, 800, 3000) × env(t)
  env(t) = exp(-t / 0.04)
  A = 0.2
```

### Pattern (per beat, in 16th notes)

```
Beat:    |1 . . . |2 . . . |3 . . . |4 . . . |
Kick:    |X . . . |X . . . |X . . . |X . . . |
Snare:   |. . . . |X . . . |. . . . |X . . . |
Hi-hat:  |X . X . |X . X . |X . X . |X . X . |
Perc:    |. . X . |. . . X |. . X . |. . . . |
```

Variazione: ogni 32 battute, inversione del pattern perc.

### BPM set

```
BPM_SET = [80, 90, 100, 110, 120, 125, 128, 130, 135, 140,
           145, 150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200]
```

### Vincoli

| Vincolo | Specifica | Verifica |
|---------|-----------|----------|
| V1.1 | Primo sample non-zero a t=0 (sample index 0) | `assert wav[0] != 0` |
| V1.2 | Kick a t=0 con ampiezza picco ≥ 0.5 | `assert max(wav[0:441]) >= 0.5` |
| V1.3 | Beat period esatto: `beat_n_start = round(n × 60/bpm × sr)` | Verifica per ogni beat |
| V1.4 | Durata esatta: `len(wav) == sr × duration × channels` | `assert` |
| V1.5 | Nessun clipping: `max(abs(wav)) <= 1.0` | `assert` |
| V1.6 | MP3 encoding a 320kbps CBR, no padding header | Verifica con ffprobe |

### manifest.json

```json
{
  "generator": "mixi-sync-framework/generate_test_tracks.py",
  "sample_rate": 44100,
  "channels": 2,
  "duration_s": 240,
  "first_beat_sample": 0,
  "tracks": [
    {
      "file": "techno_080bpm.mp3",
      "bpm_exact": 80.0,
      "beat_period_ms": 750.0,
      "total_beats": 1280,
      "md5": "..."
    }
  ]
}
```

### Gate 1

| KPI | Criterio | PASS/FAIL |
|-----|----------|-----------|
| G1.1 | Script esegue senza errori | ☐ |
| G1.2 | 22 file MP3 generati | ☐ |
| G1.3 | Vincoli V1.1-V1.6 verificati per ogni file | ☐ |
| G1.4 | manifest.json generato con MD5 corretti | ☐ |
| G1.5 | BPM di ogni file verificato con tool esterno (ffprobe/aubio) | ☐ |

---

## Fase 2 — Estrazione motore sync (harness isolato)

**Output**: motore sync funzionante in Node.js senza browser, senza UI

### Architettura

```
┌─────────────────────────────────────────────────┐
│                  TestRunner                      │
│                                                  │
│  ┌──────────┐    ┌──────────┐                   │
│  │ VDeck A  │    │ VDeck B  │   VDeck = Virtual │
│  │ bpm      │    │ bpm      │   Deck (no audio) │
│  │ offset   │    │ offset   │                   │
│  │ position │    │ position │                   │
│  │ rate     │    │ rate     │                   │
│  └────┬─────┘    └────┬─────┘                   │
│       │               │                          │
│       ▼               ▼                          │
│  ┌─────────────────────────┐                    │
│  │    SyncEngine           │                    │
│  │  (PhaseLock + Bridge)   │                    │
│  │                         │                    │
│  │  master_phase ──────┐   │                    │
│  │  slave_phase  ──┐   │   │                    │
│  │                 ▼   ▼   │                    │
│  │           PID loop      │                    │
│  │              │          │                    │
│  │              ▼          │                    │
│  │     rate_correction     │                    │
│  └─────────────────────────┘                    │
│              │                                   │
│              ▼                                   │
│  ┌─────────────────────────┐                    │
│  │     MetricsCollector    │                    │
│  │  - phase_error[t]       │                    │
│  │  - rate[t]              │                    │
│  │  - locked[t]            │                    │
│  │  - seeks                │                    │
│  └─────────────────────────┘                    │
│              │                                   │
│              ▼                                   │
│         results/*.json                           │
└─────────────────────────────────────────────────┘
```

### Virtual Deck (simulazione deterministica)

Niente Web Audio API. Simulazione matematica pura:

```typescript
class VDeck {
  bpm: number;
  firstBeatOffset: number;  // seconds
  position: number;         // seconds (posizione nel file)
  playbackRate: number;     // 1.0 = velocità originale

  // Avanza di dt secondi (chiamato a 50 Hz → dt = 0.02)
  tick(dt: number): void {
    this.position += dt * this.playbackRate;
  }

  // Fase corrente [0, 1)
  get phase(): number {
    const beatPeriod = 60 / this.bpm;
    return ((this.position - this.firstBeatOffset) / beatPeriod) % 1;
  }
}
```

Questo elimina TUTTE le variabili browser (AudioContext, setTimeout jitter, garbage collection) e testa la logica pura.

### Componenti da copiare da mixi (verbatim)

| Sorgente mixi | Destinazione | Modifiche ammesse |
|---------------|-------------|-------------------|
| `src/sync/PhaseLock.ts` | `src/sync/PhaseLock.ts` | Solo rimozione import UI |
| `src/sync/protocol.ts` | `src/sync/protocol.ts` | Solo tipi |
| `src/audio/variableBeatgrid.ts` | `src/audio/variableBeatgrid.ts` | Nessuna |

**Regola**: il codice sync copiato deve essere **identico** alla versione mixi. Qualsiasi divergenza deve essere documentata e giustificata.

### Gate 2

| KPI | Criterio | PASS/FAIL |
|-----|----------|-----------|
| G2.1 | `npm run build` compila senza errori | ☐ |
| G2.2 | VDeck.phase restituisce valori corretti per input noti | ☐ |
| G2.3 | `diff` tra file copiati e sorgenti mixi mostra solo rimozione import | ☐ |
| G2.4 | Smoke test: VDeck A a 170, VDeck B a 170, offset 0 → phase_error = 0 | ☐ |
| G2.5 | Smoke test: VDeck A a 170, VDeck B a 170, offset 100ms → phase_error = 0.283 ± 0.001 | ☐ |

---

## Fase 3 — Test matrix con benchmark quantitativo

### Ambiente deterministico

```
Tick rate: 50 Hz (dt = 0.02s fisso, nessun jitter)
Durata simulazione: 30 secondi per test
Campionamento metriche: ogni tick (1500 data points per test)
```

### Test matrix

| ID | Deck A BPM | Deck B BPM | Offset B (ms) | Descrizione | Criterio PASS |
|----|-----------|-----------|---------------|-------------|---------------|
| T01 | 170 | 170 | 0 | Identico, già in fase | ē < 0.001, no seek |
| T02 | 170 | 170 | 50 | Piccolo offset | t_lock < 2s, ē < 0.005 |
| T03 | 170 | 170 | 100 | Offset medio | t_lock < 2s, ē < 0.005 |
| T04 | 170 | 170 | 176.47 | Mezzo beat (worst case) | Sceglie beat vicino, t_lock < 2s |
| T05 | 170 | 170 | 250 | Offset grande | t_lock < 2s, ē < 0.005 |
| T06 | 170 | 170 | 352.94 | Esattamente 1 beat | ē < 0.001, no seek |
| T07 | 128 | 170 | 0 | BPM diversi | Tempo match + phase lock |
| T08 | 170 | 128 | 0 | BPM diversi (inverso) | Tempo match + phase lock |
| T09 | 140 | 140 | 100 | Mid-range | t_lock < 2s, ē < 0.005 |
| T10 | 200 | 200 | 100 | Alto range | t_lock < 2s, ē < 0.005 |
| T11 | 80 | 80 | 100 | Basso range | t_lock < 2s, ē < 0.005 |
| T12 | 80 | 200 | 0 | Estremi range | Tempo match + phase lock |
| T13 | 170 | 170.5 | 0 | BPM quasi uguale | Lock stabile, drift < 0.01/s |

### Metriche raccolte per ogni test

```typescript
interface TestMetrics {
  test_id: string;
  // Convergenza
  t_lock_s: number;           // primo istante dove |e| < 0.002 per 500ms
  converged: boolean;         // t_lock_s < 30s
  // Errore post-lock (calcolato da t_lock a fine simulazione)
  e_mean: number;             // media |phase_error|
  e_max: number;              // max |phase_error|
  e_std: number;              // deviazione standard (jitter)
  e_mean_ms: number;          // e_mean × beat_period × 1000
  // Azioni
  seeks: number;              // numero di seek forzati
  rate_corrections: number;   // totale correzioni applicate
  rate_min: number;           // min playbackRate raggiunto
  rate_max: number;           // max playbackRate raggiunto
  // Stabilità
  relock_count: number;       // quante volte perde e riacquista il lock
  // Serie temporale (per grafici)
  timeseries: {
    t: number[];              // tempo [s]
    phase_error: number[];    // errore fase
    rate: number[];           // playbackRate deck B
    locked: boolean[];        // stato lock
  };
}
```

### Output

```
results/
  T01_170_170_0ms.json       ← TestMetrics serializzato
  T02_170_170_50ms.json
  ...
  summary.json               ← tabella riassuntiva tutti i test
  summary.txt                ← versione leggibile
```

### Gate 3

| KPI | Criterio | PASS/FAIL |
|-----|----------|-----------|
| G3.1 | Tutti i 13 test eseguiti | ☐ |
| G3.2 | T01 (identico): ē < 0.001 | ☐ |
| G3.3 | T02-T05 (offset): t_lock < 2s e ē < 0.005 | ☐ |
| G3.4 | T06 (1 beat offset): ē < 0.001 | ☐ |
| G3.5 | T04 (mezzo beat): non sceglie il beat lontano | ☐ |
| G3.6 | T07-T08 (BPM diversi): convergenza | ☐ |
| G3.7 | Nessun test con relock_count > 2 | ☐ |
| G3.8 | summary.json generato | ☐ |

---

## Fase 4 — Diagnosi e fix

### Procedura

1. **Se Gate 3 tutto VERDE**: il motore sync funziona in isolamento → il bug è nell'integrazione browser (timing, AudioContext, store). Passare a Fase 4b.

2. **Se Gate 3 ha ROSSI**: il bug è nella logica sync pura.
   - Per ogni test FAIL, analizzare la timeseries:
     - `phase_error` diverge? → PID instabile → ricalcolare gain
     - `phase_error` oscilla? → PID underdamped → aumentare Kd o ridurre Kp
     - `phase_error` converge lentamente? → PID overdamped → aumentare Kp
     - `phase_error` converge a valore non-zero? → bias sistematico → bug formula fase
     - `seeks` eccessivi? → soglia seek troppo bassa
   - Applicare fix **uno alla volta**, ri-eseguire tutta la test matrix dopo ogni fix

### Regole fix

| Regola | Descrizione |
|--------|-------------|
| F1 | Un fix per commit, con ID test che risolve |
| F2 | Ogni fix deve migliorare almeno un KPI senza peggiorarne altri |
| F3 | Nessun magic number: ogni costante deve avere derivazione matematica |
| F4 | Prima il fix nel harness, poi backport in mixi solo dopo Gate 3 VERDE |

### Gate 4

| KPI | Criterio | PASS/FAIL |
|-----|----------|-----------|
| G4.1 | Gate 3 tutto VERDE (post-fix) | ☐ |
| G4.2 | Nessuna regressione: test che erano PASS restano PASS | ☐ |
| G4.3 | Diff dei fix documentato in CHANGELOG.md | ☐ |
| G4.4 | Backport pronto (patch file o branch) | ☐ |

---

## Fase 4b — Test di integrazione browser (se Fase 4 non basta)

Solo se la logica pura passa ma mixi ha ancora problemi.

Creare una pagina HTML minimale che:
1. Carica due MP3 di test con Web Audio API
2. Esegue il sync engine reale (con AudioContext timing)
3. Logga le stesse metriche della Fase 3
4. Confronta i risultati con la simulazione deterministica

Differenza attesa: jitter aggiuntivo da setTimeout.
Se la differenza supera le soglie → il problema è il browser timing → soluzione: migrare a AudioWorklet scheduler.

---

## Stack

| Componente | Tecnologia | Motivazione |
|-----------|-----------|-------------|
| Generazione tracce | Python 3 + numpy + scipy | Controllo matematico del segnale |
| Encoding MP3 | lame (via subprocess) | Standard, CBR preciso |
| Test harness | TypeScript + Node.js | Stesso linguaggio di mixi |
| BPM detection | Rust + wasm-pack (opzionale) | Verifica open-bpm accuracy |
| Runner | Vitest | Test runner con assertions |
| Grafici (opzionale) | Python matplotlib | Visualizzazione timeseries |

---

## Sequenza e dipendenze

```
Fase 0 ─── Gate 0 ──→ Fase 1 ─── Gate 1 ──→ Fase 2 ─── Gate 2 ──→ Fase 3 ─── Gate 3 ──→ Fase 4
                                                                                    │
                                                                              (se VERDE)
                                                                                    │
                                                                                    ▼
                                                                            MISSIONE ACHIEVED
                                                                                    │
                                                                              (se ancora
                                                                               problemi
                                                                               in mixi)
                                                                                    │
                                                                                    ▼
                                                                               Fase 4b
```

Nessuna fase inizia prima che il gate precedente sia VERDE.
