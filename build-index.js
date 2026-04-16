// Preprocesses the SymbTr-2.4/txt/ corpus into compact per-makam binary bundles.
// Emits:
//   songs.json       — manifest (metadata + {offset, count} into each makam's bundle)
//   data/<makam>.bin — packed notes, 8 bytes each: int16 koma, uint32 ms, uint16 measure
// Run: node build-index.js

const fs = require('fs');
const path = require('path');

const TXT_DIR = path.join(__dirname, 'SymbTr-2.4', 'txt');
const DATA_DIR = path.join(__dirname, 'data');
const BYTES_PER_NOTE = 8;

// --- SymbTr .txt parser (build-time twin of the old runtime parser) ---
// Columns: Sira, Kod, Nota53, NotaAE, Koma53, KomaAE, Pay, Payda, Ms, LNS, Bas, Soz1, Offset
// Kod=9 is a note; Kod=51 is a time-signature row (pay/payda = numerator/denominator).
// Koma53 is pitch in 53-TET commas; Ms is duration in milliseconds.
function parseSymbTrTxt(txt) {
  const notes = [];
  const lines = txt.split(/\r?\n/);
  let measure = 1;
  let beatsPerMeasure = 4;
  let beatCursor = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const kod = parseInt(cols[1], 10);
    const komaStr = cols[4];
    const koma = komaStr === '' ? NaN : parseFloat(komaStr);
    const pay = parseFloat(cols[6]) || 0;
    const payda = parseFloat(cols[7]) || 0;
    const ms = parseFloat(cols[8]) || 0;
    if (kod === 51) {
      if (pay && payda) beatsPerMeasure = pay * (4 / payda);
      continue;
    }
    if (ms <= 0) continue;
    const isRest = !Number.isFinite(koma) || koma === 0;
    notes.push({
      koma: isRest ? -1 : Math.round(koma),
      ms: Math.round(ms),
      measure,
    });
    if (pay && payda) {
      beatCursor += pay / payda * 4;
      while (beatCursor >= beatsPerMeasure - 1e-6) {
        beatCursor -= beatsPerMeasure;
        measure++;
      }
    }
  }
  return notes;
}

function parseFilename(filename) {
  const base = filename.replace(/\.txt$/, '');
  const [makam = '', form = '', usul = '', name = '', composer = ''] = base.split('--');
  return {
    makam,
    form,
    usul,
    name: name.replace(/_/g, ' '),
    composer: composer.replace(/_/g, ' '),
  };
}

function main() {
  const files = fs.readdirSync(TXT_DIR).filter(f => f.endsWith('.txt'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.endsWith('.bin')) fs.unlinkSync(path.join(DATA_DIR, f));
  }

  const byMakam = new Map();
  for (const filename of files) {
    const txt = fs.readFileSync(path.join(TXT_DIR, filename), 'utf8');
    const notes = parseSymbTrTxt(txt);
    const meta = parseFilename(filename);
    if (!byMakam.has(meta.makam)) byMakam.set(meta.makam, []);
    byMakam.get(meta.makam).push({ filename, meta, notes });
  }

  const songs = [];
  const makams = [...byMakam.keys()].sort();
  let totalBytes = 0;
  let totalNotes = 0;

  for (const makam of makams) {
    const group = byMakam.get(makam);
    group.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
    const noteCount = group.reduce((n, s) => n + s.notes.length, 0);
    const buf = Buffer.alloc(noteCount * BYTES_PER_NOTE);
    let byteOffset = 0;

    for (const { filename, meta, notes } of group) {
      const startIdx = byteOffset / BYTES_PER_NOTE;
      for (const n of notes) {
        buf.writeInt16LE(n.koma, byteOffset);
        buf.writeUInt32LE(n.ms, byteOffset + 2);
        buf.writeUInt16LE(Math.min(n.measure, 65535), byteOffset + 6);
        byteOffset += BYTES_PER_NOTE;
      }
      songs.push({
        filename,
        makam: meta.makam,
        form: meta.form,
        usul: meta.usul,
        name: meta.name,
        composer: meta.composer,
        offset: startIdx,
        count: notes.length,
      });
    }

    fs.writeFileSync(path.join(DATA_DIR, `${makam}.bin`), buf);
    totalBytes += buf.length;
    totalNotes += noteCount;
  }

  songs.sort((a, b) => a.makam.localeCompare(b.makam) || a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(__dirname, 'songs.json'), JSON.stringify(songs));

  console.log(`Indexed ${songs.length} songs across ${makams.length} makams`);
  console.log(`Notes: ${totalNotes.toLocaleString()}`);
  console.log(`Bundle total: ${(totalBytes / 1024 / 1024).toFixed(2)} MB (${makams.length} files)`);
}

main();
