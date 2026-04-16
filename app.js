// Fretless Bass Turkish Makam player
// Reads prebuilt per-makam binary bundles, renders fretless tab with decimal fret positions, plays via Web Audio

// --- Instrument definitions ---
// Each instrument has named strings (high to low, as displayed top to bottom)
// and a max reachable position on the fingerboard.
const INSTRUMENTS = {
  bass4: {
    name: '4-string Bass (EADG)',
    maxFret: 24,
    defaultTranspose: -24,
    voice: { wave: 'triangle', attack: 0.02, decay: 0.1, sustain: 0.7, release: 0.08, volume: 0.22, vibrato: 0, harmonics: null },
    strings: [
      { name: 'G', midi: 43 },
      { name: 'D', midi: 38 },
      { name: 'A', midi: 33 },
      { name: 'E', midi: 28 },
    ],
  },
  bass6: {
    name: '6-string Bass (BEADGC)',
    maxFret: 24,
    defaultTranspose: -24,
    voice: { wave: 'triangle', attack: 0.02, decay: 0.1, sustain: 0.7, release: 0.08, volume: 0.22, vibrato: 0, harmonics: null },
    strings: [
      { name: 'C', midi: 48 },
      { name: 'G', midi: 43 },
      { name: 'D', midi: 38 },
      { name: 'A', midi: 33 },
      { name: 'E', midi: 28 },
      { name: 'B', midi: 23 },
    ],
  },
  violin: {
    name: 'Violin (GDAE)',
    maxFret: 15,
    defaultTranspose: 0,
    voice: { wave: 'sawtooth', attack: 0.08, decay: 0.05, sustain: 0.85, release: 0.12, volume: 0.14, vibrato: 0, harmonics: null },
    strings: [
      { name: 'E', midi: 76 },
      { name: 'A', midi: 69 },
      { name: 'D', midi: 62 },
      { name: 'G', midi: 55 },
    ],
  },
  guitar: {
    name: 'Guitar (EADGBE)',
    maxFret: 24,
    defaultTranspose: -12,
    voice: { wave: 'custom', attack: 0.005, decay: 0.3, sustain: 0.2, release: 0.15, volume: 0.18, vibrato: 0, harmonics: [0, 1, 0.5, 0.33, 0.25, 0.15, 0.08] },
    strings: [
      { name: 'e', midi: 64 },
      { name: 'B', midi: 59 },
      { name: 'G', midi: 55 },
      { name: 'D', midi: 50 },
      { name: 'A', midi: 45 },
      { name: 'E', midi: 40 },
    ],
  },
  oud: {
    name: 'Oud (D A B E A D)',
    maxFret: 12,
    defaultTranspose: -12,
    voice: { wave: 'custom', attack: 0.003, decay: 0.4, sustain: 0.08, release: 0.3, volume: 0.20, vibrato: 0, harmonics: [0, 1, 0.7, 0.3, 0.5, 0.15, 0.1, 0.08] },
    strings: [
      { name: 'd', midi: 62 },
      { name: 'a', midi: 57 },
      { name: 'E', midi: 52 },
      { name: 'B', midi: 47 },
      { name: 'A', midi: 45 },
      { name: 'D', midi: 38 },
    ],
  },
};
let STRINGS = INSTRUMENTS.bass4.strings;
let MAX_FRET = INSTRUMENTS.bass4.maxFret;
const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// SymbTr Koma53 -> MIDI. The corpus encodes pitch in 53-TET (Holdrian commas):
// 53 commas per octave, so 1 comma = 12/53 semitones ≈ 22.6415 cents.
// Empirical anchor verified across many files: Koma53=318 is labelled "C5".
// We place that at equal-tempered MIDI 72 so frequencies are anchored to A4=440.
// This preserves exact microtonal intervals (no rounding to quarter tones).
const KOMA_C5 = 318;
const KOMA_PER_OCTAVE = 53;
function komaToMidi(koma) {
  return 72 + (koma - KOMA_C5) * 12 / KOMA_PER_OCTAVE;
}

// --- State ---
let songs = [];
let currentNotes = []; // [{midi, durSec, startSec, isRest, measure}]
let totalDurSec = 0;
let audioCtx = null;
let audioStartTime = 0; // audioCtx.currentTime when playback started (pauses freeze it via suspend())
let playbackTimer = null;
let activeSources = [];
let isPlaying = false;
let isPaused = false;
let tempoMultAtStart = 1;
let seekedOffsetSec = 0; // remembered seek position for next play

// --- Element refs ---
const makamInput = document.getElementById('makam-filter');
const songInput = document.getElementById('song-select');
const transposeInput = document.getElementById('transpose');
const tempoMultInput = document.getElementById('tempo-mult');
const playBtn = document.getElementById('play');
const pauseBtn = document.getElementById('pause');
const stopBtn = document.getElementById('stop');
const tabContainer = document.getElementById('tab-container');

// --- Typeahead combobox ---
// Fuzzy-matching dropdown attached to a text input. Ranks matches by:
//   exact (3) > prefix (2+) > substring (1 + position bonus) > subsequence (0.5).
// Turkish diacritics are folded to ASCII so the user can type "sarki" and match "Şarkı".
function foldDiacritics(s) {
  return s.toLowerCase()
    .replace(/[çĉ]/g, 'c').replace(/[ğ]/g, 'g')
    .replace(/[ıîï]/g, 'i').replace(/[öô]/g, 'o')
    .replace(/[şŝ]/g, 's').replace(/[üû]/g, 'u')
    .replace(/[âä]/g, 'a').replace(/[éêë]/g, 'e');
}

function fuzzyScore(haystack, needle) {
  if (!needle) return 1;
  const h = foldDiacritics(haystack);
  const n = foldDiacritics(needle);
  if (h === n) return 4;
  if (h.startsWith(n)) return 3;
  const idx = h.indexOf(n);
  if (idx >= 0) return 2 + 1 / (idx + 1);
  // Subsequence: every needle char appears in order.
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    hi = h.indexOf(n[ni], hi);
    if (hi < 0) return 0;
    hi++;
  }
  return 1;
}

// Create a typeahead over `getItems() -> [{value, label, search}]`.
// Calls `onSelect(value)` when the user commits a choice.
function makeCombo({ input, list, getItems, onSelect, emptyOption }) {
  let currentValue = '';
  let currentLabel = '';
  let activeIdx = 0;
  let lastRendered = [];
  const MAX_VISIBLE = 200;

  function labelFor(value) {
    if (emptyOption && value === '') return emptyOption.label;
    const hit = getItems().find(it => it.value === value);
    return hit ? hit.label : '';
  }

  function setValue(value, { fire = false } = {}) {
    currentValue = value;
    currentLabel = labelFor(value);
    input.value = currentLabel;
    if (fire) onSelect(currentValue);
  }

  function filter(query) {
    const items = getItems().slice();
    if (emptyOption) items.unshift(emptyOption);
    if (!query.trim()) return items;
    const scored = [];
    for (const it of items) {
      const score = fuzzyScore(it.search || it.label, query);
      if (score > 0) scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.it);
  }

  function render() {
    const query = input.value === currentLabel ? '' : input.value;
    lastRendered = filter(query).slice(0, MAX_VISIBLE);
    list.innerHTML = '';
    if (!lastRendered.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matches';
      list.appendChild(li);
      return;
    }
    if (activeIdx >= lastRendered.length) activeIdx = 0;
    lastRendered.forEach((it, i) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      li.dataset.value = it.value;
      if (i === activeIdx) li.classList.add('active');
      li.addEventListener('mousedown', e => {
        e.preventDefault(); // keep focus so blur-close doesn't fire first
        setValue(it.value, { fire: true });
        closeList();
      });
      list.appendChild(li);
    });
    // Scroll active into view.
    const active = list.children[activeIdx];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function openList() {
    list.hidden = false;
    activeIdx = 0;
    render();
  }
  function closeList() {
    list.hidden = true;
    input.value = currentLabel;
  }

  input.addEventListener('focus', () => {
    input.select();
    openList();
  });
  input.addEventListener('input', () => {
    activeIdx = 0;
    list.hidden = false;
    render();
  });
  input.addEventListener('blur', () => setTimeout(closeList, 120));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') {
      if (list.hidden) openList();
      else { activeIdx = Math.min(activeIdx + 1, lastRendered.length - 1); render(); }
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      activeIdx = Math.max(0, activeIdx - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const it = lastRendered[activeIdx];
      if (it) {
        setValue(it.value, { fire: true });
        closeList();
        input.blur();
      }
      e.preventDefault();
    } else if (e.key === 'Escape') {
      closeList();
      input.blur();
    }
  });

  return {
    setValue,
    get value() { return currentValue; },
    refresh() { if (!list.hidden) render(); },
  };
}

// --- Init ---
const LS_MAKAM = 'fretless.makam';
const LS_SONG = 'fretless.song';
const LS_INSTRUMENT = 'fretless.instrument';

const instrumentSelect = document.getElementById('instrument');

function applyInstrument(id) {
  const inst = INSTRUMENTS[id];
  if (!inst) return;
  STRINGS = inst.strings;
  MAX_FRET = inst.maxFret;
  transposeInput.value = inst.defaultTranspose;
}

let makamCombo = null;
let songCombo = null;

async function init() {
  // Populate instrument selector.
  for (const [id, inst] of Object.entries(INSTRUMENTS)) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = inst.name;
    instrumentSelect.appendChild(opt);
  }
  const savedInst = localStorage.getItem(LS_INSTRUMENT);
  if (savedInst && INSTRUMENTS[savedInst]) instrumentSelect.value = savedInst;
  applyInstrument(instrumentSelect.value);

  const res = await fetch('songs.json');
  songs = await res.json();

  // Makam combobox: deduped list of makam slugs; "" means no filter.
  const makamLabels = new Map();
  for (const s of songs) {
    if (!makamLabels.has(s.makam)) makamLabels.set(s.makam, s.makamDisplay || s.makam);
  }
  const makamItems = [...makamLabels.entries()]
    .map(([value, label]) => ({ value, label, search: `${label} ${value}` }))
    .sort((a, b) => a.label.localeCompare(b.label, 'tr'));

  makamCombo = makeCombo({
    input: makamInput,
    list: makamInput.nextElementSibling,
    getItems: () => makamItems,
    emptyOption: { value: '', label: 'All', search: 'all' },
    onSelect: value => {
      localStorage.setItem(LS_MAKAM, value);
      populateSongs();
    },
  });

  // Song combobox: items depend on the currently selected makam filter.
  songCombo = makeCombo({
    input: songInput,
    list: songInput.nextElementSibling,
    getItems: () => {
      const m = makamCombo ? makamCombo.value : '';
      const pool = m ? songs.filter(s => s.makam === m) : songs;
      return pool.map(s => {
        const makam = s.makamDisplay || s.makam;
        const form = s.formDisplay || s.form;
        const name = s.nameDisplay || s.name;
        const composer = s.composerDisplay || s.composer;
        const label = `[${makam}] ${form}${name ? ' — ' + name : ''}${composer ? ' · ' + composer : ''}`;
        const search = `${label} ${s.filename}`;
        return { value: s.filename, label, search };
      });
    },
    onSelect: value => {
      localStorage.setItem(LS_SONG, value);
      loadCurrent();
    },
  });

  // Restore last selection (if still valid).
  const savedMakam = localStorage.getItem(LS_MAKAM) || '';
  if (savedMakam && makamLabels.has(savedMakam)) {
    makamCombo.setValue(savedMakam);
  } else {
    makamCombo.setValue('');
  }
  populateSongs(localStorage.getItem(LS_SONG));

  instrumentSelect.addEventListener('change', () => {
    localStorage.setItem(LS_INSTRUMENT, instrumentSelect.value);
    applyInstrument(instrumentSelect.value);
    if (currentNotes.length) restartIfPlaying();
  });
  transposeInput.addEventListener('change', () => { if (currentNotes.length) restartIfPlaying(); });
  tempoMultInput.addEventListener('change', () => { if (currentNotes.length) restartIfPlaying(); });
  playBtn.addEventListener('click', () => playOrResume());
  pauseBtn.addEventListener('click', pause);
  stopBtn.addEventListener('click', stop);
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (currentNotes.length) renderTab(); }, 120);
  });
  // Spacebar: toggle play/pause. Ignore when a form control has focus.
  tabContainer.addEventListener('click', onTabClick);
  document.addEventListener('keydown', e => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (isPlaying && !isPaused) pause();
    else playOrResume();
  });
  updateButtons();
  loadCurrent();
}

function populateSongs(preferFilename) {
  if (!songCombo) return;
  const m = makamCombo ? makamCombo.value : '';
  const pool = m ? songs.filter(s => s.makam === m) : songs;
  if (!pool.length) return;
  // Keep previous selection if it's in the filtered pool; otherwise pick first.
  const candidate = preferFilename && pool.some(s => s.filename === preferFilename)
    ? preferFilename
    : pool[0].filename;
  songCombo.setValue(candidate);
  localStorage.setItem(LS_SONG, candidate);
  loadCurrent();
}

// Binary bundle format: 8 bytes per note (little-endian), packed at build time.
//   bytes 0..1  int16   koma (−1 = rest)
//   bytes 2..5  uint32  duration in ms
//   bytes 6..7  uint16  measure number
// One bundle per makam; switching songs within a makam reuses the cached ArrayBuffer.
const BYTES_PER_NOTE = 8;
const bundleCache = new Map();

async function getBundle(makam) {
  if (bundleCache.has(makam)) return bundleCache.get(makam);
  const res = await fetch(`data/${makam}.bin`);
  if (!res.ok) throw new Error(`bundle ${makam} failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  bundleCache.set(makam, buf);
  return buf;
}

function decodeNotes(buf, offset, count) {
  const view = new DataView(buf, offset * BYTES_PER_NOTE, count * BYTES_PER_NOTE);
  currentNotes = [];
  let timeSec = 0;
  for (let i = 0; i < count; i++) {
    const p = i * BYTES_PER_NOTE;
    const koma = view.getInt16(p, true);
    const ms = view.getUint32(p + 2, true);
    const measure = view.getUint16(p + 6, true);
    const isRest = koma === -1;
    const durSec = ms / 1000;
    currentNotes.push({
      midi: isRest ? null : komaToMidi(koma),
      koma: isRest ? null : koma,
      durSec, startSec: timeSec, isRest, measure,
    });
    timeSec += durSec;
  }
  totalDurSec = timeSec;
}

async function loadCurrent() {
  stop();
  const filename = songCombo ? songCombo.value : '';
  if (!filename) return;
  const song = songs.find(s => s.filename === filename);
  if (!song) return;
  const buf = await getBundle(song.makam);
  decodeNotes(buf, song.offset, song.count);
  renderTab();
}

// --- Fret computation ---
// Two goals, in order of priority:
//   1. Consistency: the same pitch should always land on the same (string, fret)
//      throughout a piece — you don't want to relearn where a note lives.
//   2. Comfort: keep most notes within a small hand span (~4 frets). Crossing
//      strings under a fixed hand position is easy; sliding the hand is not.
//
// Approach:
//   a. Enumerate candidate (string, fret) positions for each distinct pitch.
//   b. Pick one global hand-centre fret that minimises total cost across the
//      piece (cost = distance to centre, with a steep penalty past HAND_SPAN).
//   c. Commit each pitch to its candidate nearest that centre — forever.
const HAND_SPAN = 3;
const OUT_OF_SPAN_PENALTY = 4;

function candidatesFor(midi) {
  const cs = [];
  for (const s of STRINGS) {
    const fret = midi - s.midi;
    if (fret >= 0 && fret <= MAX_FRET) cs.push({ string: s, fret });
  }
  return cs;
}

function positionCost(fret, centre) {
  const d = Math.abs(fret - centre);
  const beyond = Math.max(0, d - HAND_SPAN);
  // Prefer the low end (index finger / leftmost position) of the hand span.
  // A note at centre - HAND_SPAN (leftmost) costs 0; at centre it costs more;
  // at centre + HAND_SPAN (rightmost) costs a bit less than centre but more
  // than leftmost. This biases common notes to the index-finger anchor.
  const leftDist = (fret - (centre - HAND_SPAN)); // 0 at leftmost, 2*HAND_SPAN at rightmost
  const edgeCost = Math.max(0, leftDist) * 0.4;
  return edgeCost + beyond * OUT_OF_SPAN_PENALTY + fret * 0.001;
}

function computePositions(transpose) {
  // Distinct pitches -> candidate positions. Use an integer key so floating
  // point koma-derived MIDIs compare reliably.
  const pitchKey = midi => Math.round(midi * 1000);
  const candsByPitch = new Map();
  for (const n of currentNotes) {
    if (n.isRest || n.midi == null) continue;
    const midi = n.midi + transpose;
    const key = pitchKey(midi);
    if (!candsByPitch.has(key)) candsByPitch.set(key, candidatesFor(midi));
  }

  // Pick the hand centre that minimises the total per-pitch cost. Weight each
  // pitch by how often it occurs so frequent notes dominate the decision.
  const weights = new Map();
  for (const n of currentNotes) {
    if (n.isRest || n.midi == null) continue;
    const key = pitchKey(n.midi + transpose);
    weights.set(key, (weights.get(key) || 0) + 1);
  }
  // Search at 0.5-fret granularity so the centre can sit between frets —
  // edge-aligned optima often aren't integers.
  let bestCentre = 5, bestTotal = Infinity;
  for (let c = 0; c <= MAX_FRET; c += 0.5) {
    let total = 0;
    for (const [key, cands] of candsByPitch) {
      if (!cands.length) continue;
      let minCost = Infinity;
      for (const x of cands) minCost = Math.min(minCost, positionCost(x.fret, c));
      total += minCost * weights.get(key);
    }
    if (total < bestTotal) { bestTotal = total; bestCentre = c; }
  }

  // Commit one position per pitch.
  const posByPitch = new Map();
  for (const [key, cands] of candsByPitch) {
    if (!cands.length) continue;
    let best = null;
    for (const x of cands) {
      const c = positionCost(x.fret, bestCentre);
      if (!best || c < best.c) best = { string: x.string, fret: x.fret, c };
    }
    posByPitch.set(key, { string: best.string, fret: best.fret });
  }

  return currentNotes.map(n => {
    if (n.isRest || n.midi == null) return null;
    return posByPitch.get(pitchKey(n.midi + transpose)) || null;
  });
}

// Single-note fallback (used for the current-note highlight on the neck
// during playback — it always matches the precomputed position for that idx).
let currentPositions = [];
function midiToFret(midi) {
  let best = null;
  for (const s of STRINGS) {
    const fret = midi - s.midi;
    if (fret >= 0 && fret <= MAX_FRET && (!best || fret < best.fret)) best = { string: s, fret };
  }
  return best;
}

function formatFret(fret) {
  // No snapping — preserve full 53-TET precision.
  // 1 comma = 12/53 ≈ 0.22642 semitones. 3 decimals (0.001 semitone = 1 cent)
  // resolves every distinct koma value uniquely; trim trailing zeros for legibility.
  let s = fret.toFixed(2);
  s = s.replace(/\.?0+$/, '');
  return s || '0';
}

// --- Rendering ---
function renderTab() {
  const transpose = parseInt(transposeInput.value, 10) || 0;
  currentPositions = computePositions(transpose);
  const LANE_H = 34;
  const PAD_TOP = 20;
  const PAD_LEFT = 50;
  const PAD_RIGHT = 20;
  const FONT_SIZE = 13;
  const CHAR_W = FONT_SIZE * 0.62; // approximate monospace char width

  // Compute the widest label so we can size cells to prevent overlap.
  let maxLabelLen = 1;
  for (let i = 0; i < currentPositions.length; i++) {
    const pos = currentPositions[i];
    if (pos) maxLabelLen = Math.max(maxLabelLen, formatFret(pos.fret).length);
  }
  const MIN_NOTE_W = maxLabelLen * CHAR_W + 14; // label + padding

  // clientWidth includes the container's horizontal padding (40px total), subtract it.
  const availW = Math.max(400, tabContainer.clientWidth - 40);
  const laneW = availW - PAD_LEFT - PAD_RIGHT;
  const maxNotesPerRow = Math.max(4, Math.floor(laneW / MIN_NOTE_W));

  // Group notes into measures, preserving note indices.
  const measures = [];
  let curM = null;
  for (let i = 0; i < currentNotes.length; i++) {
    const m = currentNotes[i].measure;
    if (!curM || curM.measure !== m) {
      curM = { measure: m, startIdx: i, count: 0 };
      measures.push(curM);
    }
    curM.count++;
  }

  // Pack measures into rows: greedily fit whole measures, then stretch to fill.
  const rowLayouts = []; // [{startIdx, noteCount, measures: [...]}]
  let ri = 0;
  while (ri < measures.length) {
    let notesInRow = 0;
    const rowMeasures = [];
    while (ri < measures.length && notesInRow + measures[ri].count <= maxNotesPerRow) {
      rowMeasures.push(measures[ri]);
      notesInRow += measures[ri].count;
      ri++;
    }
    // If a single measure is wider than maxNotesPerRow, take it alone.
    if (rowMeasures.length === 0) {
      rowMeasures.push(measures[ri]);
      notesInRow = measures[ri].count;
      ri++;
    }
    rowLayouts.push({
      startIdx: rowMeasures[0].startIdx,
      noteCount: notesInRow,
      measures: rowMeasures,
    });
  }

  const rowH = LANE_H * STRINGS.length + 30;
  const height = PAD_TOP + rowLayouts.length * rowH + 20;
  const width = availW;

  // Scale font down if cells are tight, so labels never overflow their cell.
  const minNoteW = Math.min(...rowLayouts.map(r => laneW / r.noteCount));
  const fontSize = Math.min(FONT_SIZE, (minNoteW - 6) / (maxLabelLen * 0.62));
  let svg = `<svg id="tab-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="font-size:${fontSize.toFixed(1)}px">`;

  // Per-row geometry for cursor positioning: [{startIdx, noteCount, noteW}]
  const rowGeoms = [];

  for (let row = 0; row < rowLayouts.length; row++) {
    const layout = rowLayouts[row];
    const NOTE_W = laneW / layout.noteCount;
    rowGeoms.push({ startIdx: layout.startIdx, noteCount: layout.noteCount, noteW: NOTE_W });
    const yTop = PAD_TOP + row * rowH;
    // String lines & labels
    for (let si = 0; si < STRINGS.length; si++) {
      const y = yTop + si * LANE_H + LANE_H / 2;
      svg += `<line class="string-line" x1="${PAD_LEFT}" y1="${y}" x2="${width - 10}" y2="${y}"/>`;
      svg += `<text class="string-label" x="20" y="${y + 4}">${STRINGS[si].name}</text>`;
    }
    // Notes
    let lastMeasure = -1;
    for (let j = 0; j < layout.noteCount; j++) {
      const i = layout.startIdx + j;
      const note = currentNotes[i];
      const x = PAD_LEFT + j * NOTE_W + NOTE_W / 2;
      if (note.measure !== lastMeasure) {
        svg += `<line class="measure-bar" x1="${x - NOTE_W / 2}" y1="${yTop}" x2="${x - NOTE_W / 2}" y2="${yTop + STRINGS.length * LANE_H}"/>`;
        svg += `<text class="measure-num" x="${x - NOTE_W / 2 + 3}" y="${yTop + STRINGS.length * LANE_H + 12}">m${note.measure}</text>`;
        lastMeasure = note.measure;
      }
      if (note.isRest || note.midi == null) {
        const y = yTop + LANE_H / 2;
        svg += `<text class="note-text note-rest" data-idx="${i}" x="${x}" y="${y}">—</text>`;
        continue;
      }
      const pos = currentPositions[i];
      if (!pos) {
        const y = yTop + LANE_H / 2;
        const midi = note.midi + (parseInt(transposeInput.value, 10) || 0);
        const arrow = midi > STRINGS[0].midi + MAX_FRET ? '↑' : '↓';
        const title = `out of range (MIDI ${midi.toFixed(2)}) — try adjusting transpose`;
        svg += `<g><title>${title}</title><text class="note-text note-oor" data-idx="${i}" x="${x}" y="${y}">${arrow}</text></g>`;
        continue;
      }
      const si = STRINGS.indexOf(pos.string);
      const y = yTop + si * LANE_H + LANE_H / 2;
      const label = formatFret(pos.fret);
      const w = Math.min(NOTE_W - 2, Math.max(26, label.length * CHAR_W + 8));
      const cents = (pos.fret - Math.round(pos.fret)) * 100;
      const title = `koma53=${note.koma}  fret=${pos.fret}  (${cents >= 0 ? '+' : ''}${cents.toFixed(2)}¢ from fret ${Math.round(pos.fret)})`;
      svg += `<g><title>${title}</title>`;
      svg += `<rect class="note-bg" data-idx="${i}" x="${x - w / 2}" y="${y - 11}" width="${w}" height="22" rx="3"/>`;
      svg += `<text class="note-text" data-idx="${i}" x="${x}" y="${y + 1}">${label}</text>`;
      svg += `</g>`;
    }
    // Closing measure bar at end of row
    const endX = PAD_LEFT + layout.noteCount * NOTE_W;
    svg += `<line class="measure-bar" x1="${endX}" y1="${yTop}" x2="${endX}" y2="${yTop + STRINGS.length * LANE_H}"/>`;
  }
  svg += `<line id="cursor" class="cursor" x1="0" y1="0" x2="0" y2="0" style="display:none"/>`;
  svg += `</svg>`;
  tabContainer.innerHTML = svg;

  tabContainer._geom = { PAD_TOP, PAD_LEFT, rowGeoms, rowH, LANE_H, STRINGS };
  renderNeck();
}

// --- Fretless neck panel ---
// Vertical neck: strings top-to-bottom G, D, A, E (left to right), nut at top.
// Fret positions use real logarithmic spacing so decimal frets land where
// your finger actually goes on a physical bass.
function renderNeck() {
  const transpose = parseInt(transposeInput.value, 10) || 0;
  const neckSvg = document.getElementById('neck-svg');

  // Horizontal neck: nut on left, highest fret on right.
  // Strings top-to-bottom: G (highest pitch) on top, E on bottom — as seen
  // by the player looking down at the fretboard while playing.
  // Width follows the panel so microtones spread across the whole window.
  const PAD_L = 22;
  const PAD_R = 28;
  const PAD_T = 18;
  const NECK_H = 80 + STRINGS.length * 16;
  const panelW = document.getElementById('neck-panel').clientWidth - 40; // minus panel padding
  const totalW = Math.max(600, panelW);
  // We want fret MAX_FRET to land at the right edge. fretToX(f) = NUT_X + SCALE_X·(1 − 2^(−f/12)),
  // so SCALE_X must be (visible length) / (1 − 2^(−MAX_FRET/12)).
  const visibleLen = totalW - PAD_L - PAD_R;
  const NECK_LEN = visibleLen / (1 - Math.pow(2, -MAX_FRET / 12));
  const NUT_X = PAD_L;
  const SCALE_X = NECK_LEN;
  const stringOrder = [...STRINGS]; // STRINGS is already G,D,A,E top-to-bottom
  const stringYs = stringOrder.map((_, i) => PAD_T + 10 + i * ((NECK_H - 20) / (stringOrder.length - 1)));

  const fretToX = fret => NUT_X + SCALE_X * (1 - Math.pow(2, -fret / 12));
  const totalH = PAD_T + NECK_H + 10;

  let s = '';
  const boardEnd = NUT_X + SCALE_X * (1 - Math.pow(2, -MAX_FRET / 12));
  s += `<rect class="neck-wood" x="${NUT_X}" y="${PAD_T}" width="${boardEnd - NUT_X}" height="${NECK_H}" rx="4"/>`;

  // Inlay markers at classic positions
  const inlays = [3, 5, 7, 9, 15, 17, 19, 21].filter(f => f <= MAX_FRET);
  const midY = PAD_T + NECK_H / 2;
  for (const f of inlays) {
    const x = (fretToX(f - 1) + fretToX(f)) / 2;
    s += `<circle class="neck-marker" cx="${x}" cy="${midY}" r="4"/>`;
  }
  // Double-dot at 12
  if (MAX_FRET >= 12) {
    const x12 = (fretToX(11) + fretToX(12)) / 2;
    s += `<circle class="neck-marker" cx="${x12}" cy="${midY - 18}" r="4"/>`;
    s += `<circle class="neck-marker" cx="${x12}" cy="${midY + 18}" r="4"/>`;
  }

  // Fret lines
  const labelFrets = [3, 5, 7, 12, 15, 17, 19, 24].filter(f => f <= MAX_FRET);
  for (let f = 0; f <= MAX_FRET; f++) {
    const x = fretToX(f);
    const cls = f === 0 ? 'neck-fret-nut' : 'neck-fret';
    s += `<line class="${cls}" x1="${x}" y1="${PAD_T}" x2="${x}" y2="${PAD_T + NECK_H}"/>`;
    if (labelFrets.includes(f)) {
      s += `<text class="neck-label" x="${x}" y="${PAD_T + NECK_H + 10}" text-anchor="middle">${f}</text>`;
    }
  }
  // Strings
  for (let i = 0; i < stringOrder.length; i++) {
    s += `<line class="neck-string" x1="${NUT_X}" y1="${stringYs[i]}" x2="${boardEnd}" y2="${stringYs[i]}"/>`;
    s += `<text class="neck-label" x="${NUT_X - 6}" y="${stringYs[i] + 3}" text-anchor="end">${stringOrder[i].name}</text>`;
  }

  // All unique note positions used in the piece.
  const seen = new Map();
  currentPositions.forEach(pos => {
    if (!pos) return;
    const key = `${STRINGS.indexOf(pos.string)}|${pos.fret.toFixed(4)}`;
    if (!seen.has(key)) seen.set(key, { stringIdx: STRINGS.indexOf(pos.string), fret: pos.fret });
  });
  for (const [key, { stringIdx, fret }] of seen) {
    const cx = fretToX(fret);
    const cy = stringYs[stringIdx];
    s += `<circle class="neck-dot" data-key="${key}" cx="${cx}" cy="${cy}" r="6"/>`;
  }
  s += `<circle id="neck-active" class="neck-dot-active" cx="-10" cy="-10" r="7" style="display:none"/>`;

  neckSvg.setAttribute('width', totalW);
  neckSvg.setAttribute('height', totalH);
  neckSvg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);
  neckSvg.innerHTML = s;
  neckSvg._geom = { stringYs, fretToX };
}

function setActiveNeckNote(idx) {
  const neckSvg = document.getElementById('neck-svg');
  const active = document.getElementById('neck-active');
  if (!neckSvg || !active || !neckSvg._geom) return;
  const pos = currentPositions[idx];
  if (!pos) { active.style.display = 'none'; return; }
  const { stringYs, fretToX } = neckSvg._geom;
  active.setAttribute('cx', fretToX(pos.fret));
  active.setAttribute('cy', stringYs[STRINGS.indexOf(pos.string)]);
  active.style.display = '';
}

function positionCursorForNoteIdx(idx) {
  const g = tabContainer._geom;
  if (!g) return;
  const cursor = document.getElementById('cursor');
  if (!cursor) return;

  // Find which row this note index falls in.
  let rowIdx = 0;
  for (let r = 0; r < g.rowGeoms.length; r++) {
    const rg = g.rowGeoms[r];
    if (idx >= rg.startIdx && idx < rg.startIdx + rg.noteCount) { rowIdx = r; break; }
    if (r === g.rowGeoms.length - 1) rowIdx = r; // last row fallback
  }
  const rg = g.rowGeoms[rowIdx];
  const col = idx - rg.startIdx;
  const x = g.PAD_LEFT + col * rg.noteW + rg.noteW / 2;
  const yTop = g.PAD_TOP + rowIdx * g.rowH;

  cursor.setAttribute('x1', x);
  cursor.setAttribute('x2', x);
  cursor.setAttribute('y1', yTop - 5);
  cursor.setAttribute('y2', yTop + g.LANE_H * g.STRINGS.length + 5);
  cursor.style.display = '';

  // Auto-scroll the tab container so the cursor row stays in view.
  const rowCenter = yTop + (g.LANE_H * g.STRINGS.length) / 2;
  const viewH = tabContainer.clientHeight;
  const desired = rowCenter - viewH / 3;
  const maxScroll = tabContainer.scrollHeight - viewH;
  const target = Math.max(0, Math.min(maxScroll, desired));
  if (Math.abs(tabContainer.scrollTop - target) > 4) {
    tabContainer.scrollTop = target;
  }
}

// --- Playback ---
// Design: all oscillators are scheduled once at play time against audioCtx.currentTime.
// Pausing uses audioCtx.suspend(), which freezes currentTime — so the pre-scheduled
// start/stop times stay aligned and the UI elapsed calculation stays correct.
let playbackOffsetSec = 0; // where in the song audioStartTime maps to

function updateButtons() {
  playBtn.disabled = isPlaying && !isPaused;
  pauseBtn.disabled = !isPlaying || isPaused;
  stopBtn.disabled = !isPlaying && seekedOffsetSec === 0;
}

function playOrResume(fromOffsetSec) {
  if (isPlaying && isPaused && fromOffsetSec == null) {
    audioCtx.resume();
    isPaused = false;
    startCursorLoop();
    updateButtons();
    return;
  }
  if (isPlaying) stop();
  if (!currentNotes.length) return;

  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const transpose = parseInt(transposeInput.value, 10) || 0;
  tempoMultAtStart = parseFloat(tempoMultInput.value) || 1;
  const t0 = audioCtx.currentTime + 0.05;
  audioStartTime = t0;
  playbackOffsetSec = fromOffsetSec != null ? fromOffsetSec : seekedOffsetSec;

  const inst = INSTRUMENTS[instrumentSelect.value] || INSTRUMENTS.bass4;
  const v = inst.voice;

  // Build a PeriodicWave if the instrument uses custom harmonics.
  let periodicWave = null;
  if (v.wave === 'custom' && v.harmonics) {
    const real = new Float32Array(v.harmonics.length);
    const imag = new Float32Array(v.harmonics.length);
    for (let h = 0; h < v.harmonics.length; h++) imag[h] = v.harmonics[h];
    periodicWave = audioCtx.createPeriodicWave(real, imag, { disableNormalization: false });
  }

  for (const note of currentNotes) {
    if (note.isRest || note.midi == null) continue;
    if (note.startSec + note.durSec <= playbackOffsetSec) continue;
    const midi = note.midi + transpose;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const relStart = Math.max(0, note.startSec - playbackOffsetSec);
    const skipped = Math.max(0, playbackOffsetSec - note.startSec);
    const start = t0 + relStart / tempoMultAtStart;
    const dur = Math.max(0, (note.durSec - skipped) / tempoMultAtStart);

    const osc = audioCtx.createOscillator();
    if (periodicWave) osc.setPeriodicWave(periodicWave);
    else osc.type = v.wave;
    osc.frequency.value = freq;

    // Vibrato (bowed instruments like violin).
    if (v.vibrato > 0) {
      const lfo = audioCtx.createOscillator();
      const lfoGain = audioCtx.createGain();
      lfo.frequency.value = v.vibrato;
      lfoGain.gain.value = freq * 0.008; // ~14 cents depth
      lfo.connect(lfoGain).connect(osc.frequency);
      lfo.start(start + Math.min(0.15, dur * 0.3)); // vibrato onset after attack
      lfo.stop(start + dur + 0.05);
      activeSources.push(lfo);
    }

    // ADSR envelope.
    const gain = audioCtx.createGain();
    const atk = Math.min(v.attack, dur * 0.4);
    const rel = Math.min(v.release, dur * 0.4);
    const susStart = start + atk;
    const susEnd = start + Math.max(atk + 0.001, dur - rel);
    const peakVol = v.volume;
    const susVol = peakVol * v.sustain;

    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peakVol, start + atk);
    if (v.decay > 0) {
      const decayEnd = Math.min(susStart + v.decay, susEnd);
      gain.gain.linearRampToValueAtTime(susVol, decayEnd);
      gain.gain.setValueAtTime(susVol, susEnd);
    } else {
      gain.gain.setValueAtTime(peakVol, susEnd);
    }
    gain.gain.linearRampToValueAtTime(0, start + dur);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
    activeSources.push(osc);
  }

  isPlaying = true;
  isPaused = false;
  startCursorLoop();
  updateButtons();
}

function startCursorLoop() {
  if (playbackTimer) clearInterval(playbackTimer);
  playbackTimer = setInterval(() => {
    const elapsed = (audioCtx.currentTime - audioStartTime) * tempoMultAtStart + playbackOffsetSec;
    if (elapsed >= totalDurSec) { stop(); return; }
    let idx = 0;
    for (let i = 0; i < currentNotes.length; i++) {
      if (currentNotes[i].startSec <= elapsed) idx = i; else break;
    }
    positionCursorForNoteIdx(idx);
    setActiveNeckNote(idx);
  }, 30);
}

function onTabClick(e) {
  // Walk up from click target to find a data-idx attribute (on note text/rects).
  let el = e.target;
  while (el && el !== tabContainer) {
    const idx = el.getAttribute('data-idx');
    if (idx != null) { seekTo(parseInt(idx, 10)); return; }
    el = el.parentElement;
  }
}

function restartIfPlaying() {
  const wasPlaying = isPlaying && !isPaused;
  let elapsed = 0;
  if (isPlaying && audioCtx) {
    elapsed = (audioCtx.currentTime - audioStartTime) * tempoMultAtStart + playbackOffsetSec;
  }
  if (wasPlaying) stop();
  renderTab();
  if (wasPlaying) playOrResume(elapsed);
}

function pause() {
  if (!isPlaying || isPaused) return;
  audioCtx.suspend();
  isPaused = true;
  if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
  updateButtons();
}

function stop() {
  if (playbackTimer) { clearInterval(playbackTimer); playbackTimer = null; }
  for (const s of activeSources) { try { s.stop(); } catch (e) {} }
  activeSources = [];
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  isPlaying = false;
  isPaused = false;
  seekedOffsetSec = 0;
  const cursor = document.getElementById('cursor');
  if (cursor) cursor.style.display = 'none';
  const active = document.getElementById('neck-active');
  if (active) active.style.display = 'none';
  updateButtons();
}

function seekTo(idx) {
  if (idx < 0 || idx >= currentNotes.length) return;
  const wasPlaying = isPlaying && !isPaused;
  stop();
  const offset = currentNotes[idx].startSec;
  seekedOffsetSec = offset;
  positionCursorForNoteIdx(idx);
  setActiveNeckNote(idx);
  if (wasPlaying) playOrResume(offset);
  else updateButtons();
}

init();
