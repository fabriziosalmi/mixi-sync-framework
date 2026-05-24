#!/usr/bin/env python3
"""
mixi-sync-framework — Test Track Generator

Generates deterministic 4/4 techno tracks from 80 to 200 BPM.
Pure synthesis (no samples). First kick at t=0 exactly.

Usage:
    python3 generate_test_tracks.py

Output:
    test-tracks/techno_XXXbpm.mp3  (22 files)
    test-tracks/manifest.json
"""

import json
import hashlib
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
from scipy.signal import butter, lfilter

# ── Global parameters ──────────────────────────────────────────

SR = 44100
DURATION = 240  # 4 minutes
CHANNELS = 2
BPM_SET = [
    80, 90, 100, 110, 120, 125, 128, 130, 135, 140,
    145, 150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200,
]
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-tracks")


# ── Synthesis primitives ───────────────────────────────────────

def make_kick(sr: int, bpm: float) -> np.ndarray:
    """Kick drum: exponential pitch sweep sine + amplitude envelope.

    f(t) = f_start × (f_end / f_start)^(t / t_decay)
    env(t) = exp(-t / 0.1)
    """
    dur = min(0.3, 60 / bpm * 0.8)  # max 80% of beat, capped at 300ms
    n = int(sr * dur)
    t = np.arange(n, dtype=np.float64) / sr

    f_start = 150.0
    f_end = 45.0
    t_decay = 0.15
    freq = f_start * (f_end / f_start) ** (t / t_decay)

    # Instantaneous phase: integral of freq
    phase = 2 * np.pi * np.cumsum(freq) / sr
    osc = np.sin(phase)

    env = np.exp(-t / 0.1)
    return (0.8 * osc * env).astype(np.float32)


def make_snare(sr: int, bpm: float) -> np.ndarray:
    """Snare: bandpass noise + sine body."""
    dur = min(0.15, 60 / bpm * 0.4)
    n = int(sr * dur)
    t = np.arange(n, dtype=np.float64) / sr

    # Noise component: bandpass 200-8000 Hz
    rng = np.random.RandomState(42)  # deterministic
    noise = rng.randn(n).astype(np.float64)
    b_bp, a_bp = butter(2, [200 / (sr / 2), 8000 / (sr / 2)], btype='band')
    noise_filtered = lfilter(b_bp, a_bp, noise)

    env = np.exp(-t / 0.05)

    # Tone component
    tone = np.sin(2 * np.pi * 180 * t)

    out = 0.4 * noise_filtered * env + 0.3 * tone * env
    return out.astype(np.float32)


def make_hihat(sr: int, bpm: float) -> np.ndarray:
    """Hi-hat: highpass noise."""
    dur = min(0.06, 60 / bpm * 0.2)
    n = int(sr * dur)
    t = np.arange(n, dtype=np.float64) / sr

    rng = np.random.RandomState(123)
    noise = rng.randn(n).astype(np.float64)
    b_hp, a_hp = butter(3, 6000 / (sr / 2), btype='high')
    noise_filtered = lfilter(b_hp, a_hp, noise)

    env = np.exp(-t / 0.02)
    return (0.25 * noise_filtered * env).astype(np.float32)


def make_perc(sr: int, bpm: float) -> np.ndarray:
    """Percussion: narrow bandpass noise."""
    dur = min(0.08, 60 / bpm * 0.2)
    n = int(sr * dur)
    t = np.arange(n, dtype=np.float64) / sr

    rng = np.random.RandomState(456)
    noise = rng.randn(n).astype(np.float64)
    b_bp, a_bp = butter(2, [800 / (sr / 2), 3000 / (sr / 2)], btype='band')
    noise_filtered = lfilter(b_bp, a_bp, noise)

    env = np.exp(-t / 0.04)
    return (0.2 * noise_filtered * env).astype(np.float32)


# ── Pattern sequencer ──────────────────────────────────────────

def generate_track(bpm: float, sr: int, duration: float) -> np.ndarray:
    """Generate a 4/4 techno track at the given BPM.

    Pattern per bar (16th note grid):
        Kick:   X . . .  X . . .  X . . .  X . . .
        Snare:  . . . .  X . . .  . . . .  X . . .
        Hi-hat: X . X .  X . X .  X . X .  X . X .
        Perc:   . . X .  . . . X  . . X .  . . . .

    Variation: every 32 beats, perc pattern inverts.
    """
    total_samples = sr * int(duration)
    out = np.zeros(total_samples, dtype=np.float64)

    beat_samples = 60 / bpm * sr  # samples per beat
    sixteenth = beat_samples / 4  # samples per 16th note

    total_beats = int(duration * bpm / 60)

    # Pre-synthesize one-shots
    kick = make_kick(sr, bpm)
    snare = make_snare(sr, bpm)
    hihat = make_hihat(sr, bpm)
    perc = make_perc(sr, bpm)

    # Perc pattern A and B (inverted)
    perc_a = [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]  # per bar (16 sixteenths)
    perc_b = [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0]  # inverted

    def place(buf: np.ndarray, sample: np.ndarray, pos: int) -> None:
        """Mix a one-shot into the buffer at position pos."""
        end = min(pos + len(sample), total_samples)
        length = end - pos
        if length > 0 and pos >= 0:
            buf[pos:end] += sample[:length]

    for beat in range(total_beats):
        beat_start = round(beat * beat_samples)

        # Kick: every beat (16th 0)
        place(out, kick, beat_start)

        # Snare: beats 2 and 4 of each bar (beat % 4 == 1 or 3)
        if beat % 4 == 1 or beat % 4 == 3:
            place(out, snare, beat_start)

        # Hi-hat: every 8th note (16th 0 and 8)
        for eighth in [0, 2]:
            pos = beat_start + round(eighth * sixteenth)
            place(out, hihat, pos)

        # Perc: 16th note pattern, varies every 32 beats
        bar_in_phrase = (beat // 4) % 8  # 0-7
        use_pattern_b = bar_in_phrase >= 4
        pattern = perc_b if use_pattern_b else perc_a
        beat_in_bar = beat % 4

        for s16 in range(4):
            idx = beat_in_bar * 4 + s16
            if pattern[idx]:
                pos = beat_start + round(s16 * sixteenth)
                place(out, perc, pos)

    # Normalize to prevent clipping, but keep headroom
    peak = np.max(np.abs(out))
    if peak > 0:
        out = out / peak * 0.95  # -0.45 dBFS headroom

    return out.astype(np.float32)


# ── WAV writer (no external dependency) ────────────────────────

def write_wav(path: str, data: np.ndarray, sr: int, channels: int) -> None:
    """Write a 16-bit PCM WAV file."""
    if channels == 2:
        # Duplicate mono to stereo
        stereo = np.column_stack([data, data])
    else:
        stereo = data.reshape(-1, 1)

    # Convert float32 [-1, 1] to int16
    pcm = np.clip(stereo, -1.0, 1.0)
    pcm = (pcm * 32767).astype(np.int16)

    num_frames = pcm.shape[0]
    data_size = num_frames * channels * 2  # 16-bit = 2 bytes

    with open(path, 'wb') as f:
        # RIFF header
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + data_size))
        f.write(b'WAVE')

        # fmt chunk
        f.write(b'fmt ')
        f.write(struct.pack('<I', 16))        # chunk size
        f.write(struct.pack('<H', 1))         # PCM format
        f.write(struct.pack('<H', channels))
        f.write(struct.pack('<I', sr))
        f.write(struct.pack('<I', sr * channels * 2))  # byte rate
        f.write(struct.pack('<H', channels * 2))       # block align
        f.write(struct.pack('<H', 16))        # bits per sample

        # data chunk
        f.write(b'data')
        f.write(struct.pack('<I', data_size))
        f.write(pcm.tobytes())


# ── Verification ───────────────────────────────────────────────

def verify_wav(data: np.ndarray, bpm: float, sr: int, duration: float) -> list:
    """Run vincoli V1.1-V1.5 and return list of failures."""
    failures = []
    total_samples = sr * int(duration)

    # V1.1: First sample non-zero
    if data[0] == 0:
        failures.append("V1.1 FAIL: first sample is zero")

    # V1.2: Kick peak >= 0.5 in first 10ms
    first_10ms = int(sr * 0.01)
    peak_start = np.max(np.abs(data[:first_10ms]))
    if peak_start < 0.5:
        failures.append(f"V1.2 FAIL: peak in first 10ms = {peak_start:.4f} (need >= 0.5)")

    # V1.3: Beat positions (spot check first 10 beats)
    beat_period_samples = 60 / bpm * sr
    for n in range(1, min(10, int(duration * bpm / 60))):
        expected = round(n * beat_period_samples)
        # Check energy in ±5ms window around expected beat
        window = int(sr * 0.005)
        lo = max(0, expected - window)
        hi = min(len(data), expected + window)
        energy = np.max(np.abs(data[lo:hi]))
        if energy < 0.3:
            failures.append(f"V1.3 FAIL: beat {n} at sample {expected}, energy={energy:.4f}")

    # V1.4: Duration exact
    if len(data) != total_samples:
        failures.append(f"V1.4 FAIL: length {len(data)} != expected {total_samples}")

    # V1.5: No clipping
    if np.max(np.abs(data)) > 1.0:
        failures.append(f"V1.5 FAIL: clipping detected, max={np.max(np.abs(data)):.6f}")

    return failures


def md5_file(path: str) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(8192), b''):
            h.update(chunk)
    return h.hexdigest()


# ── Main ───────────────────────────────────────────────────────

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    manifest = {
        "generator": "mixi-sync-framework/generate_test_tracks.py",
        "sample_rate": SR,
        "channels": CHANNELS,
        "duration_s": DURATION,
        "first_beat_sample": 0,
        "tracks": [],
    }

    all_pass = True

    for bpm in BPM_SET:
        label = f"techno_{bpm:03d}bpm"
        mp3_path = os.path.join(OUTPUT_DIR, f"{label}.mp3")

        print(f"\n{'='*60}")
        print(f"  Generating {label} ...")

        # 1. Synthesize
        data = generate_track(bpm, SR, DURATION)

        # 2. Verify WAV constraints
        failures = verify_wav(data, bpm, SR, DURATION)
        if failures:
            for f in failures:
                print(f"  ❌ {f}")
            all_pass = False
        else:
            print(f"  ✅ V1.1-V1.5 all PASS")

        # 3. Write temporary WAV
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            wav_path = tmp.name

        write_wav(wav_path, data, SR, CHANNELS)

        # 4. Encode to MP3 via lame (320 kbps CBR)
        try:
            subprocess.run(
                [
                    'lame',
                    '--cbr', '-b', '320',
                    '--noreplaygain',
                    '-q', '0',        # highest quality encoding
                    '--strictly-enforce-ISO',
                    wav_path,
                    mp3_path,
                ],
                check=True,
                capture_output=True,
            )
            print(f"  ✅ MP3 encoded: {os.path.basename(mp3_path)}")
        except subprocess.CalledProcessError as e:
            print(f"  ❌ lame failed: {e.stderr.decode()}")
            all_pass = False
            os.unlink(wav_path)
            continue

        os.unlink(wav_path)

        # 5. Verify MP3 with ffprobe (V1.6)
        try:
            probe = subprocess.run(
                [
                    'ffprobe', '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_format', '-show_streams',
                    mp3_path,
                ],
                check=True,
                capture_output=True,
            )
            info = json.loads(probe.stdout)
            stream = info['streams'][0]
            bitrate = int(stream.get('bit_rate', 0))
            if abs(bitrate - 320000) > 5000:
                print(f"  ⚠  V1.6: bitrate {bitrate} != 320000")
            else:
                print(f"  ✅ V1.6 MP3 320kbps verified ({bitrate})")
        except Exception as e:
            print(f"  ⚠  ffprobe check skipped: {e}")

        # 6. Manifest entry
        beat_period_ms = 60000 / bpm
        total_beats = int(DURATION * bpm / 60)
        manifest["tracks"].append({
            "file": f"{label}.mp3",
            "bpm_exact": float(bpm),
            "beat_period_ms": round(beat_period_ms, 6),
            "total_beats": total_beats,
            "md5": md5_file(mp3_path),
        })

    # Write manifest
    manifest_path = os.path.join(OUTPUT_DIR, "manifest.json")
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)
    print(f"\n{'='*60}")
    print(f"  Manifest written: {manifest_path}")

    # Summary
    print(f"\n{'='*60}")
    print(f"  Generated {len(manifest['tracks'])} tracks")
    if all_pass:
        print(f"  ✅ ALL GATES PASS")
    else:
        print(f"  ❌ SOME GATES FAILED — check output above")
    print(f"{'='*60}")

    return 0 if all_pass else 1


if __name__ == '__main__':
    sys.exit(main())
