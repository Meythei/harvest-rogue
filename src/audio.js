// サウンド: WebAudio で合成するブレイクビーツと効果音。
// コンボ数に応じてドラムのパートが重なり、コンボが切れると音が抜ける（Amen Break 風の演出）。

let ac = null;
let master = null;
let enabled = true;
let nextStepTime = 0;
let step = 0;
let comboLevel = 0;
let noiseBuf = null;
const BPM = 138;

// 16分音符16ステップ。Amen Break を下敷きにしたパターン
const PATTERN = {
  kick:  [1,0,1,0, 0,0,0,0, 0,0,1,1, 0,0,0,0],
  snare: [0,0,0,0, 1,0,0,1, 0,1,0,0, 1,0,0,1],
  ghost: [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,1,0],
  hat:   [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
  ride:  [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0],
  bass:  [1,0,0,0, 0,0,1,0, 0,0,1,0, 0,0,0,0],
};
const BASS_NOTES = [55, 55, 65.4, 49];

export function initAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  ac = new Ctx();
  master = ac.createGain();
  master.gain.value = 0.5;
  master.connect(ac.destination);
  noiseBuf = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  nextStepTime = ac.currentTime + 0.05;
}

export function setAudioEnabled(v) { enabled = v; if (master) master.gain.value = v ? 0.5 : 0; }
export function isAudioEnabled() { return enabled; }

// コンボ数 → 重なるステムの段階
export function setCombo(combo) {
  const lv = combo >= 15 ? 5 : combo >= 10 ? 4 : combo >= 6 ? 3 : combo >= 3 ? 2 : combo >= 1 ? 1 : 0;
  if (lv < comboLevel && comboLevel >= 2) sfx('break');
  comboLevel = lv;
}

export function tickAudio() {
  if (!ac || !enabled) return;
  const stepDur = 60 / BPM / 4;
  while (nextStepTime < ac.currentTime + 0.12) {
    playStep(step, nextStepTime);
    nextStepTime += stepDur;
    step = (step + 1) % 16;
  }
}

function playStep(s, t) {
  // 常に鳴るのは控えめなハイハットだけ。コンボで重なっていく
  if (PATTERN.hat[s]) hat(t, comboLevel >= 1 ? 0.12 : 0.04);
  if (comboLevel >= 2 && PATTERN.kick[s]) kick(t);
  if (comboLevel >= 3 && PATTERN.snare[s]) snare(t, 0.35);
  if (comboLevel >= 4 && PATTERN.ghost[s]) snare(t, 0.12);
  if (comboLevel >= 4 && PATTERN.ride[s]) hat(t, 0.08, 0.12);
  if (comboLevel >= 5 && PATTERN.bass[s]) bass(t, BASS_NOTES[Math.floor(s / 4)]);
}

function env(g, t, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
}

function kick(t) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  env(g, t, 0.002, 0.9, 0.2);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + 0.25);
}

function noise(t, dur, peak, type, freq) {
  const src = ac.createBufferSource(); src.buffer = noiseBuf;
  const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = ac.createGain(); env(g, t, 0.001, peak, dur);
  src.connect(f).connect(g).connect(master);
  src.start(t); src.stop(t + dur + 0.05);
}

function snare(t, vol) {
  noise(t, 0.14, vol, 'bandpass', 1800);
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.value = 190; env(g, t, 0.001, vol * 0.6, 0.08);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.12);
}

function hat(t, vol, dur = 0.04) { noise(t, dur, vol, 'highpass', 7000); }

function bass(t, f) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = 'triangle'; o.frequency.value = f;
  env(g, t, 0.005, 0.35, 0.3);
  o.connect(g).connect(master); o.start(t); o.stop(t + 0.35);
}

function tone(f, dur, type = 'square', vol = 0.15, slide = 0) {
  if (!ac || !enabled) return;
  const t = ac.currentTime;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t + dur);
  env(g, t, 0.003, vol, dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
}

export function sfx(name) {
  if (!ac || !enabled) return;
  switch (name) {
    case 'till': noise(ac.currentTime, 0.08, 0.25, 'lowpass', 900); break;
    case 'plant': tone(520, 0.06, 'square', 0.08); break;
    case 'harvest': tone(660, 0.08, 'square', 0.1, 300); break;
    case 'pickup': tone(880, 0.04, 'square', 0.06); break;
    case 'deliver': tone(988, 0.06, 'square', 0.1); setTimeout(() => tone(1319, 0.1, 'square', 0.1), 60); break;
    case 'eat': tone(300, 0.1, 'sawtooth', 0.1, -120); break;
    case 'pump': tone(200, 0.05, 'triangle', 0.15, 80); break;
    case 'burn': noise(ac.currentTime, 0.25, 0.2, 'lowpass', 500); break;
    case 'build': tone(330, 0.08, 'square', 0.12); setTimeout(() => tone(440, 0.08, 'square', 0.12), 70); break;
    case 'deny': tone(140, 0.12, 'square', 0.12); break;
    case 'break': tone(600, 0.35, 'sawtooth', 0.12, -500); break;
    case 'warn': tone(880, 0.15, 'square', 0.1); setTimeout(() => tone(660, 0.15, 'square', 0.1), 180); break;
    case 'hit': noise(ac.currentTime, 0.06, 0.2, 'highpass', 3000); break;
    case 'quota': [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.14, 'square', 0.12), i * 90)); break;
    case 'fail': [392, 330, 262, 196].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'triangle', 0.15), i * 150)); break;
    case 'warp': tone(400, 0.2, 'sine', 0.15, 900); break;
    case 'cut': noise(ac.currentTime, 0.04, 0.3, 'highpass', 4000); break;
    default: break;
  }
}
