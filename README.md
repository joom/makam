# Makam

A web app that renders Turkish makam music as tab for fretless bass, guitar, violin, or oud — with decimal fret positions that preserve full 53-TET microtonal detail — and plays it back with Web Audio.

## Run

```bash
# One-time: grab the corpus (only needed if you want to rebuild bundles)
git clone https://github.com/MTG/SymbTr.git SymbTr-2.4
node build-index.js          # parses txt/* -> songs.json + data/<makam>.bin

# Serve
python3 -m http.server 8000
```

The repo only ships `songs.json` (~420 KB) and `data/*.bin` (~7 MB, 155 makam bundles). The raw [SymbTr](https://github.com/MTG/SymbTr) corpus isn't tracked — it's build-time input.

## Instruments

4-string bass (EADG), 6-string bass (BEADGC), guitar (EADGBE), violin (GDAE), oud (D-A-B-E-A-D).

## How it works

- Each `Koma53` integer in SymbTr gives a 53-TET pitch; `midi = 72 + (koma − 318) × 12/53` keeps Turkish commas (~22.64¢) exact instead of rounding to quarter-tones.
- The app picks a string for the selected instrument and computes `fret = midi − openStringMidi`. Fractional frets render as `4.5`, `7.33`, etc.
- Bundles are per-makam, fetched on first song-select and cached — switching songs within a makam is zero-network.
- Playback uses Web Audio oscillators at the exact microtonal frequency with per-instrument timbres.
