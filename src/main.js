// 入力・HUD・画面遷移・メタ進行
import { TILE, COLS, CROPS, BUILDINGS, BUILD_ORDER, DIRS, TECH, FARM_TIERS, META_PERKS, DAYS_PER_QUOTA, DAY_LENGTH } from './data.js';
import { loadSprites, drawSprite, itemSpriteKey, assetStatus } from './sprites.js';
import { initAudio, tickAudio, sfx, setAudioEnabled, isAudioEnabled, setCombo } from './audio.js';
import { Game, MAX_PLAYERS, PLAYER_COLORS } from './game.js';
import { runCommand } from './console.js';
import { Net, makeRoomCode, serverBase } from './net.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');

// ---- メタ進行の保存 ---------------------------------------------------------
const META_KEY = 'harvest-rogue-meta-v1';
function loadMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(META_KEY));
    if (m && typeof m === 'object') return { seeds: m.seeds || 0, perks: m.perks || {}, best: m.best || 0, runs: m.runs || 0 };
  } catch (e) { /* 保存できない環境では毎回リセット */ }
  return { seeds: 0, perks: {}, best: 0, runs: 0 };
}
function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* noop */ }
}
let meta = loadMeta();

// ---- 状態 ------------------------------------------------------------------
let game = null;
let paused = false;
let tool = null;          // 建設中の建物 / 'demolish' / 'move'
let toolDir = 0;
let movingBox = null;
let cursor = null;
let consoleOpen = false;
const consoleHistory = [];
let historyIdx = -1;

// オンライン
let mode = 'local';       // local | host | guest
let net = null;
let myIndex = 0;          // 自分が操作するプレイヤー番号
const peerToPlayer = new Map();
const guestInput = { up: false, down: false, left: false, right: false };
let snapTimer = 0;
const SNAP_INTERVAL = 0.1;

// 小さなアイコン用キャンバス
function iconCanvas(key, size = 24, draw) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (draw) draw(g); else drawSprite(g, key, 0, 0, size, size);
  return c;
}

function buildingIcon(type) {
  return iconCanvas(null, 40, (g) => {
    if (!game) return;
    game.drawBuilding(g, { type, x: 0, y: 0, dir: 0, anim: 0.3, store: [], fuel: 0, burn: 0 });
  });
}

// ---- 画面 ------------------------------------------------------------------
function show(id, on) { $(id).classList.toggle('hidden', !on); }

function renderMetaShop() {
  $('meta-seeds').textContent = meta.seeds;
  $('meta-best').textContent = meta.runs ? `これまでのラン: ${meta.runs} 回 / 最高ノルマ達成数: ${meta.best}` : '';
  const shop = $('meta-shop');
  shop.innerHTML = '';
  for (const [key, perk] of Object.entries(META_PERKS)) {
    const lv = meta.perks[key] || 0;
    const div = document.createElement('div');
    div.className = 'perk';
    const maxed = lv >= perk.max;
    const cost = maxed ? 0 : perk.cost[lv];
    div.innerHTML = `<div><div class="name">${perk.name} <span class="lv">Lv ${lv}/${perk.max}</span></div><div class="desc">${perk.desc}</div></div>`;
    const btn = document.createElement('button');
    btn.textContent = maxed ? '最大' : `種籾 ${cost}`;
    btn.disabled = maxed || meta.seeds < cost;
    btn.onclick = () => {
      meta.seeds -= cost;
      meta.perks[key] = lv + 1;
      saveMeta();
      sfx('build');
      renderMetaShop();
    };
    div.appendChild(btn);
    shop.appendChild(div);
  }
}

function startGame(players, { online = null, name = '' } = {}) {
  initAudio();
  game = new Game({ playerCount: online === 'guest' ? 0 : players, meta });
  if (online === 'host') { game.players[0].name = name || 'ホスト'; game.players[0].netId = net.id; }
  mode = online || 'local';
  myIndex = 0;
  game.onTerminal = () => openConsole();
  paused = false;
  tool = null; movingBox = null;
  show('title', false); show('over', false); show('upgrade', false); show('paused', false);
  lastSig = {};
  shownState = 'playing';
  buildPlayersPanel();
  renderToolbar();
  consoleLines = [];
  printConsole(['FARM-TERMINAL 起動。ノルマを確認するには quota と入力。']);
}

function toTitle() {
  game = null;
  if (net) { net.close(); net = null; }
  mode = 'local';
  peerToPlayer.clear();
  $('room-badge').textContent = '';
  setMpStatus('');
  show('over', false); show('upgrade', false);
  renderMetaShop();
  show('title', true);
  setCombo(0);
}

function endRun(note = '') {
  const reward = game.metaReward();
  meta.seeds += reward;
  meta.runs += 1;
  meta.best = Math.max(meta.best, game.quotasCleared);
  saveMeta();
  $('over-stats').innerHTML = `${note ? `<p>${note}</p>` : ''}
    ノルマ達成数: <b>${game.quotasCleared}</b><br>
    納品した作物: <b>${game.totalDelivered}</b> 個<br>
    稼いだコイン: <b>${game.totalCoins}</b><br>
    最大コンボ: <b>${game.bestCombo}</b><br>
    農地: <b>${FARM_TIERS[game.tech.farm].name}</b><br>
    持ち帰った種籾: <b>+${reward}</b>（合計 ${meta.seeds}）`;
  show('over', true);
  setCombo(0);
}

function showUpgrade() {
  const wrap = $('upgrade-cards');
  wrap.innerHTML = '';
  game.upgradeOffers.forEach((o, i) => {
    const b = document.createElement('button');
    b.className = `upgrade-card cat-${o.id}`;
    b.innerHTML = `<div class="key">${i + 1}</div><div class="t">${o.title}</div><div class="d">${o.desc}</div>`;
    b.onclick = () => intent({ t: 'choose', i });
    wrap.appendChild(b);
  });
  show('upgrade', true);
}

function localPlayer() { return game && game.players[myIndex]; }

// ---- 操作の適用（ホスト／ローカルではその場で、ゲストはホストへ送る） -------
function intent(m, pi = myIndex) {
  if (!game) return;
  if (mode === 'guest') { net.send(m); return; }
  apply(pi, m);
}

function apply(pi, m, fromPeer = null) {
  const p = game.players[pi];
  if (!p) return;
  switch (m.t) {
    case 'in': for (const k of ['up', 'down', 'left', 'right']) p.input[k] = !!m.k?.[k]; break;
    case 'act': game.action(pi); break;
    case 'eat': game.eat(pi); break;
    case 'build': if (BUILDINGS[m.type]) game.build(m.type, m.x | 0, m.y | 0, m.dir | 0); break;
    case 'demolish': game.demolish(m.x | 0, m.y | 0); break;
    case 'move': { const b = game.bAt[m.fy]?.[m.fx]; if (b) game.moveBox(b, m.x | 0, m.y | 0); break; }
    case 'seed': if (game.crops.includes(m.c)) p.seed = m.c; break;
    case 'choose':
      if (game.state === 'upgrade') { game.chooseUpgrade(m.i | 0); show('upgrade', false); renderToolbar(); }
      break;
    case 'cmd': {
      const res = runCommand(game, String(m.line || '').slice(0, 200), pi);
      if (fromPeer !== null) net.send({ t: 'to', id: fromPeer, d: { t: 'cmdout', lines: res.lines } });
      return res;
    }
    default: break;
  }
  return null;
}

// ---- オンライン --------------------------------------------------------------
function setMpStatus(text, bad = false) {
  const el = $('mp-status');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

const MP_ERRORS = {
  no_room: 'その部屋は見つかりませんでした',
  full: '部屋が満員です（最大4人）',
  room_taken: 'その部屋コードは使用中です。もう一度お試しください',
  connect_failed: 'サーバーに接続できませんでした',
  closed: 'サーバーに接続できませんでした',
};

async function hostRoom() {
  if (!serverBase()) { setMpStatus('このページからはオンラインに接続できません（Cloudflare版で遊んでください）', true); return; }
  initAudio();
  const room = makeRoomCode();
  const name = $('mp-name').value.trim().slice(0, 12);
  setMpStatus('部屋を作成中…');
  net = new Net({ room, create: true, name, onMessage: onHostMessage, onClose: () => onDisconnected('サーバーとの接続が切れました') });
  try {
    await net.ready;
  } catch (e) {
    setMpStatus(MP_ERRORS[e.message] || e.message, true); net = null; return;
  }
  startGame(1, { online: 'host', name });
  $('room-badge').textContent = `部屋 ${room}`;
  printConsole([`部屋 ${room} を作成しました。友だちにコードを伝えてください。`]);
}

async function joinRoom() {
  if (!serverBase()) { setMpStatus('このページからはオンラインに接続できません（Cloudflare版で遊んでください）', true); return; }
  const room = $('mp-code').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(room)) { setMpStatus('部屋コードを入力してください', true); return; }
  initAudio();
  const name = $('mp-name').value.trim().slice(0, 12);
  setMpStatus('接続中…');
  net = new Net({ room, create: false, name, onMessage: onGuestMessage, onClose: () => onDisconnected('ホストとの接続が切れました') });
  try {
    await net.ready;
  } catch (e) {
    setMpStatus(MP_ERRORS[e.message] || e.message, true); net = null; return;
  }
  setMpStatus('ホストからの画面を待っています…');
  net.room = room;
}

function onDisconnected(msg) {
  if (!game) { setMpStatus(msg, true); net = null; return; }
  if (game.state !== 'over') { game.state = 'over'; shownState = 'over'; endRun(msg); }
}

function onHostMessage(msg) {
  if (!game) return;
  if (msg.t === 'peer_join') {
    // 抜けた人の枠があれば再利用する
    let idx = game.players.findIndex((p) => p.away);
    if (idx >= 0) {
      const p = game.players[idx];
      Object.assign(p, { away: false, name: msg.name || `P${idx + 1}`, netId: msg.id, x: 19 * TILE + TILE / 2, y: 3 * TILE + TILE / 2, inv: [], hunger: p.maxHunger });
    } else idx = game.addPlayer(msg.name || '', msg.id);
    if (idx < 0) return;
    peerToPlayer.set(msg.id, idx);
    game.say(`${game.players[idx].name} が参加しました`);
    game.floater(game.players[idx].x, game.players[idx].y - 40, `${game.players[idx].name} 参加！`, PLAYER_COLORS[idx]);
    lastSig.players = null;
  } else if (msg.t === 'peer_leave') {
    const idx = peerToPlayer.get(msg.id);
    peerToPlayer.delete(msg.id);
    const p = game.players[idx];
    if (p) {
      p.away = true;
      for (const k in p.input) p.input[k] = false;
      game.say(`${p.name} が退出しました`);
    }
  } else if (msg.from !== undefined) {
    const idx = peerToPlayer.get(msg.from);
    if (idx !== undefined && msg.m && typeof msg.m === 'object') apply(idx, msg.m, msg.from);
  }
}

function onGuestMessage(msg) {
  if (msg.t === 'snap') {
    if (!game) {
      startGame(0, { online: 'guest' });
      $('room-badge').textContent = `部屋 ${net.room}`;
    }
    game.applySnapshot(msg.d);
    const idx = game.players.findIndex((p) => p && p.netId === net.id);
    if (idx >= 0) myIndex = idx;
  } else if (msg.t === 'cmdout') {
    printConsole(msg.lines || []);
    renderToolbar();
  } else if (msg.t === 'host_left') {
    onDisconnected('ホストが退出したため終了しました');
  }
}

// ---- HUD -------------------------------------------------------------------
let lastSig = {};
function changed(key, sig) {
  if (lastSig[key] === sig) return false;
  lastSig[key] = sig;
  return true;
}

function fmtTime(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function updateHud() {
  const g = game;
  const q = g.quota;
  $('quota-no').textContent = `#${g.quotaIndex + 1}`;
  if (changed('quota-icon', q.crop)) { $('quota-icon').innerHTML = ''; $('quota-icon').appendChild(iconCanvas(itemSpriteKey(q.crop))); }
  $('quota-text').textContent = `${CROPS[q.crop].name} ${Math.floor(q.have)} / ${q.need}`;
  $('quota-bar').style.width = `${Math.min(100, (q.have / q.need) * 100)}%`;
  const rem = g.quotaRemaining();
  $('time-text').textContent = `${g.quotaDay()}/${DAYS_PER_QUOTA}日目 残り${fmtTime(rem)}`;
  $('time-bar').style.width = `${(rem / (DAYS_PER_QUOTA * DAY_LENGTH)) * 100}%`;
  $('time-bar').classList.toggle('danger', rem < 20);
  $('coin-text').textContent = `🪙 ${g.coins}`;
  $('power-text').textContent = g.tech.energy ? `${Math.floor(g.power)} / ${g.powerCap()}` : '未解放';
  $('power-bar').style.width = `${(g.power / g.powerCap()) * 100}%`;
  $('combo-text').textContent = g.combo ? `${g.combo} ×${g.comboMult().toFixed(2)}` : '—';
  $('combo-bar').style.width = `${g.combo ? (g.comboTimer / g.comboWindow) * 100 : 0}%`;
  document.querySelector('.combo').classList.toggle('hot', g.combo >= 6);

  const w = g.weather;
  const wkey = w.phase === 'clear' ? 'weather_sunny' : w.kind === 'hail' ? 'weather_hail' : 'weather_storm';
  if (changed('weather', wkey)) {
    const wc = $('weather-icon').getContext('2d');
    wc.clearRect(0, 0, 32, 32); wc.imageSmoothingEnabled = false;
    drawSprite(wc, wkey, 0, 0, 32, 32);
  }
  const wt = $('weather-text');
  wt.textContent = w.phase === 'clear' ? '晴れ' : `${w.kind === 'hail' ? '雹' : '嵐'}${w.phase === 'warning' ? '接近中！' : '発生中'}`;
  wt.classList.toggle('alert', w.phase !== 'clear');

  // プレイヤー
  if (changed('players', g.players.map((p) => `${p.name}:${p.away}`).join('|') + myIndex)) buildPlayersPanel();
  g.players.forEach((p) => {
    const el = $(`p${p.id}`);
    if (!el) return;
    el.querySelector('.hv').textContent = `${Math.ceil(p.hunger)} / ${p.maxHunger}`;
    el.querySelector('.hunger .bar > div').style.width = `${(p.hunger / p.maxHunger) * 100}%`;
    el.querySelector('.hunger').classList.toggle('low', p.hunger < p.maxHunger * 0.2);
    const sig = p.inv.join(',') + '|' + g.invCap;
    if (changed(`inv${p.id}`, sig)) {
      const inv = el.querySelector('.inv');
      inv.innerHTML = '';
      for (let i = 0; i < g.invCap; i++) {
        if (p.inv[i]) {
          const c = iconCanvas(itemSpriteKey(p.inv[i]));
          c.title = CROPS[p.inv[i]].name;
          inv.appendChild(c);
        } else {
          const e = document.createElement('div'); e.className = 'empty'; inv.appendChild(e);
        }
      }
    }
  });

  const tsig = [g.coins >= 0 ? Math.floor(g.coins / 1) : 0, JSON.stringify(g.tech), JSON.stringify(g.unlocks), g.crops.join(), localPlayer()?.seed, tool, toolDir].join('|');
  if (changed('toolbar', tsig)) renderToolbar();
}

function buildPlayersPanel() {
  const wrap = $('players');
  wrap.innerHTML = '';
  for (const k of Object.keys(lastSig)) if (k.startsWith('inv')) delete lastSig[k];
  game.players.forEach((p) => {
    if (!p || p.away) return;
    const d = document.createElement('div');
    d.className = 'pcard';
    d.id = `p${p.id}`;
    const all = 'WASD・矢印 / Space・Enter / Q';
    const keys = mode !== 'local' ? (p.id === myIndex ? `あなた（${all}）` : '') : p.id === 0 ? (game.players.length > 1 ? 'WASD / Space / Q' : all) : '矢印 / Enter / 右Shift';
    d.style.borderColor = PLAYER_COLORS[p.id];
    d.innerHTML = `<div class="who">${escapeHtml(p.name)}</div>
      <div class="hunger"><div class="label">空腹度（行動力） <span class="hv"></span> <span class="small">${keys}</span></div><div class="bar"><div></div></div></div>
      <div class="inv"></div>`;
    d.querySelector('.who').prepend(iconCanvas(`player${p.id + 1}`, 28));
    wrap.appendChild(d);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderToolbar() {
  if (!game) return;
  const seeds = $('seed-buttons');
  seeds.innerHTML = '';
  game.crops.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = localPlayer()?.seed === c ? 'active' : '';
    b.title = `${CROPS[c].name}: 成長${CROPS[c].grow}秒 / 空腹+${CROPS[c].food} / 燃料${CROPS[c].fuel} / 価値${CROPS[c].value}`;
    b.append(iconCanvas(itemSpriteKey(c), 18), `${i + 1}`);
    b.onclick = () => { intent({ t: 'seed', c }); if (localPlayer()) localPlayer().seed = c; renderToolbar(); };
    seeds.appendChild(b);
  });
  const builds = $('build-buttons');
  builds.innerHTML = '';
  let any = false;
  for (const type of BUILD_ORDER) {
    if (!game.isUnlocked(type)) continue;
    any = true;
    const def = BUILDINGS[type];
    const b = document.createElement('button');
    b.className = tool === type ? 'active' : '';
    b.title = def.desc;
    b.disabled = game.coins < def.cost;
    const cost = document.createElement('span'); cost.className = 'cost'; cost.textContent = def.cost;
    b.append(buildingIcon(type), def.name, cost);
    b.onclick = () => selectTool(tool === type ? null : type);
    builds.appendChild(b);
  }
  if (!any) builds.innerHTML = '<span class="small">ノルマを達成してアップグレードすると建物が解放されます</span>';
  $('build-hint').textContent = tool && BUILDINGS[tool] ? `${BUILDINGS[tool].name}${BUILDINGS[tool].rotate ? ` 向き${DIRS[toolDir].name}（R で回転）` : ''} — 右クリックで解除` : tool === 'demolish' ? '撤去: クリックした建物を半額で売却' : tool === 'move' ? (movingBox ? '置き場所をクリック' : '動かす納品ボックスをクリック') : '';
  $('tool-move').disabled = game.tech.deliver < 2;
  $('tool-move').classList.toggle('active', tool === 'move');
  $('tool-demolish').classList.toggle('active', tool === 'demolish');
  $('btn-sound').textContent = isAudioEnabled() ? '音 ON' : '音 OFF';
}

function selectTool(t) {
  tool = t;
  movingBox = null;
  renderToolbar();
}

// ---- 端末 ------------------------------------------------------------------
let consoleLines = [];
function printConsole(lines) {
  consoleLines.push(...lines);
  if (consoleLines.length > 300) consoleLines = consoleLines.slice(-300);
  const out = $('console-out');
  out.textContent = consoleLines.join('\n');
  out.scrollTop = out.scrollHeight;
}
function openConsole() {
  if (!game) return;
  consoleOpen = true;
  show('console', true);
  clearInputs();
  setTimeout(() => $('console-input').focus(), 0);
}
function closeConsole() {
  consoleOpen = false;
  show('console', false);
  $('console-input').blur();
}
$('console-input').addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const line = e.target.value;
    e.target.value = '';
    if (line.trim()) { consoleHistory.push(line); historyIdx = consoleHistory.length; }
    printConsole([`> ${line}`]);
    const cmd = line.trim().split(/\s+/)[0];
    if (cmd === 'clear') { consoleLines = []; printConsole([]); return; }
    if (cmd === 'exit') { closeConsole(); return; }
    if (mode === 'guest') {
      if (cmd === 'giveup') { printConsole(['giveup はホストだけが使えます']); return; }
      net.send({ t: 'cmd', line });
      return;
    }
    if (mode === 'host' && cmd === 'giveup' && !line.includes('!')) { printConsole(['全員のランが終了します。本当に諦める場合は giveup ! と入力']); return; }
    const res = apply(myIndex, { t: 'cmd', line: line.replace(/\s*!$/, '') });
    if (res.clear) consoleLines = [];
    printConsole(res.lines);
    if (res.exit) closeConsole();
    renderToolbar();
  } else if (e.key === 'Escape' || (e.key === '`' && !e.target.value)) {
    e.preventDefault();
    closeConsole();
  } else if (e.key === 'ArrowUp') {
    historyIdx = Math.max(0, historyIdx - 1);
    e.target.value = consoleHistory[historyIdx] || '';
  } else if (e.key === 'ArrowDown') {
    historyIdx = Math.min(consoleHistory.length, historyIdx + 1);
    e.target.value = consoleHistory[historyIdx] || '';
  }
});
$('console-input').addEventListener('keyup', (e) => e.stopPropagation());

// ---- ヘルプ ----------------------------------------------------------------
function renderHelp() {
  const rows = (obj) => Object.entries(obj).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  $('help-body').innerHTML = `
  <h2>基本</h2>
  <table>${rows({
    'アクション': '向いているマスに対して「耕す → 植える → 収穫する」、地面の作物を拾う、建物を使う（納品・発電・燃やす・加工）',
    '食べる': '手持ちの作物を1つ食べて空腹度を回復（ノルマ対象以外を優先）',
    '空腹度': '手作業と移動で減る。0になると動きが遅くなり作業できない',
    'コンボ': `納品が途切れずに続くと倍率が上がる。上限は輸送・納品の技術で解放される`,
    'ノルマ': `${DAYS_PER_QUOTA}日（1日${DAY_LENGTH}秒）以内に指定の作物を納品。倍率込みで数える`,
  })}</table>
  <h2>技術ツリー</h2>
  <table>${rows({
    '回収': TECH.collect.join(' → '),
    '輸送': TECH.transport.join(' → '),
    '納品': TECH.deliver.join(' → '),
    'エネルギー': TECH.energy.slice(1).join(' → '),
    '農地': FARM_TIERS.map((f) => f.name).join(' → '),
  })}</table>
  <h2>建物</h2>
  <table>${BUILD_ORDER.map((t) => `<tr><td>${BUILDINGS[t].name}</td><td>${BUILDINGS[t].desc}（${BUILDINGS[t].cost}コイン）</td></tr>`).join('')}</table>
  <h2>作物</h2>
  <table>${Object.values(CROPS).map((c) => `<tr><td>${c.name}</td><td>成長${c.grow}秒 / 空腹回復${c.food} / 燃料${c.fuel} / 価値${c.value} / 収量${c.yield}</td></tr>`).join('')}</table>`;
}
function toggleHelp(on) {
  const open = on ?? $('help').classList.contains('hidden');
  if (open) renderHelp();
  show('help', open);
}

// ---- 入力 ------------------------------------------------------------------
const P1 = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
const P2 = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

function clearInputs() {
  if (!game) return;
  if (mode === 'guest') {
    for (const k in guestInput) guestInput[k] = false;
    net?.send({ t: 'in', k: guestInput });
    return;
  }
  for (const p of game.players) if (p) for (const k in p.input) p.input[k] = false;
}

// ローカル2人プレイのときだけ、矢印キー側を2P に割り当てる
function twoLocal() { return mode === 'local' && game.players.length > 1; }

function setKey(code, down) {
  if (!game) return false;
  const dir = P1[code] || P2[code];
  if (!dir) return false;
  if (mode === 'guest') {
    if (guestInput[dir] !== down) { guestInput[dir] = down; net.send({ t: 'in', k: guestInput }); }
    return true;
  }
  const pi = P2[code] && twoLocal() ? 1 : myIndex;
  if (game.players[pi]) game.players[pi].input[dir] = down;
  return true;
}

window.addEventListener('keydown', (e) => {
  if (consoleOpen) return;
  initAudio();
  if (!game) {
    if (e.code === 'Enter') startGame(1);
    return;
  }
  if (game.state === 'upgrade') {
    if (['Digit1', 'Digit2', 'Digit3'].includes(e.code)) intent({ t: 'choose', i: Number(e.code.slice(-1)) - 1 });
    return;
  }
  if (game.state === 'over') { if (e.code === 'Enter') toTitle(); return; }
  if (setKey(e.code, true)) { e.preventDefault(); return; }
  const p2 = twoLocal() ? 1 : myIndex;
  switch (e.code) {
    case 'Space': e.preventDefault(); if (!e.repeat && !paused) intent({ t: 'act' }); break;
    case 'Enter': e.preventDefault(); if (!e.repeat && !paused) intent({ t: 'act' }, p2); break;
    case 'KeyQ': if (!paused) intent({ t: 'eat' }); break;
    case 'ShiftRight': case 'Slash': if (!paused) intent({ t: 'eat' }, p2); break;
    case 'KeyR': toolDir = (toolDir + 1) % 4; renderToolbar(); break;
    case 'KeyX': selectTool(tool === 'demolish' ? null : 'demolish'); break;
    case 'KeyT': case 'Backquote': e.preventDefault(); openConsole(); break;
    case 'KeyH': toggleHelp(); break;
    case 'KeyP': if (mode === 'local') { paused = !paused; show('paused', paused); clearInputs(); } break;
    case 'Escape': selectTool(null); toggleHelp(false); break;
    default:
      if (/^Digit[1-6]$/.test(e.code)) {
        const c = game.crops[Number(e.code.slice(-1)) - 1];
        if (c) { intent({ t: 'seed', c }); if (localPlayer()) localPlayer().seed = c; renderToolbar(); }
      }
  }
});
window.addEventListener('keyup', (e) => { if (!consoleOpen) setKey(e.code, false); });
window.addEventListener('blur', clearInputs);

function canvasTile(e) {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * canvas.width;
  const y = ((e.clientY - r.top) / r.height) * canvas.height;
  return { x: Math.floor(x / TILE), y: Math.floor(y / TILE) };
}

canvas.addEventListener('mousemove', (e) => { cursor = canvasTile(e); });
canvas.addEventListener('mouseleave', () => { cursor = null; });
canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); selectTool(null); });
canvas.addEventListener('mousedown', (e) => {
  if (!game || game.state !== 'playing' || e.button !== 0 || paused) return;
  initAudio();
  const { x, y } = canvasTile(e);
  if (!tool) return;
  if (tool === 'demolish') { intent({ t: 'demolish', x, y }); return; }
  if (tool === 'move') {
    if (!movingBox) {
      const b = game.bAt[y]?.[x];
      if (b && b.type === 'box') { movingBox = { x: b.x, y: b.y }; renderToolbar(); }
    } else if (!game.bAt[y]?.[x]) {
      intent({ t: 'move', fx: movingBox.x, fy: movingBox.y, x, y });
      movingBox = null; renderToolbar();
    }
    return;
  }
  intent({ t: 'build', type: tool, x, y, dir: toolDir });
});

$('start-1p').onclick = () => startGame(1);
$('start-2p').onclick = () => startGame(2);
$('mp-create').onclick = hostRoom;
$('mp-join').onclick = joinRoom;
$('mp-code').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') joinRoom(); });
$('mp-name').addEventListener('keydown', (e) => e.stopPropagation());
try { $('mp-name').value = localStorage.getItem('harvest-rogue-name') || ''; } catch (e) { /* noop */ }
$('mp-name').addEventListener('change', () => { try { localStorage.setItem('harvest-rogue-name', $('mp-name').value); } catch (e) { /* noop */ } });
if (!serverBase()) setMpStatus('このページではオンラインは使えません');
$('over-back').onclick = toTitle;
$('help-close').onclick = () => toggleHelp(false);
$('btn-help').onclick = () => toggleHelp();
$('btn-console').onclick = openConsole;
$('tool-move').onclick = () => selectTool(tool === 'move' ? null : 'move');
$('tool-demolish').onclick = () => selectTool(tool === 'demolish' ? null : 'demolish');
$('btn-sound').onclick = () => { initAudio(); setAudioEnabled(!isAudioEnabled()); renderToolbar(); };

// ---- ループ ----------------------------------------------------------------
let last = performance.now();
let acc = 0;
const STEP = 1 / 60;
let shownState = 'playing';

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  tickAudio();
  if (game) {
    if (mode === 'guest') {
      game.smooth(dt);
    } else if (!paused && !(consoleOpen && mode === 'local') && game.state === 'playing') {
      acc += dt;
      while (acc >= STEP) { game.update(STEP); acc -= STEP; }
    } else acc = 0;
    if (mode === 'host' && net) {
      snapTimer -= dt;
      if (snapTimer <= 0) { snapTimer = SNAP_INTERVAL; net.sendRaw('S' + JSON.stringify(game.serialize())); }
    }
    if (game.state !== shownState) {
      shownState = game.state;
      show('upgrade', false);
      if (game.state === 'upgrade') showUpgrade();
      if (game.state === 'over') endRun();
      renderToolbar();
    }
    game.render(ctx, { cursor: cursor && tool ? { ...cursor, tool, dir: toolDir } : null, movingBox });
    updateHud();
  } else {
    drawTitleBackground(now / 1000);
  }
  requestAnimationFrame(frame);
}

// タイトル背景: 畑のタイルを敷き詰める
function drawTitleBackground(t) {
  ctx.imageSmoothingEnabled = false;
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < COLS; x++) {
      const k = (x + y) % 7 === 0 ? 'field_ninjin' : (x * 3 + y) % 11 === 0 ? 'field_daikon' : (x + y * 2) % 5 === 0 ? 'soil' : 'grass';
      drawSprite(ctx, k, x * TILE, y * TILE, TILE, TILE);
    }
  }
  const crops = ['ninjin', 'tomato', 'daikon', 'corn', 'kabocha', 'kabu'];
  for (let i = 0; i < 12; i++) {
    const a = t * 0.8 + (i / 12) * Math.PI * 2;
    drawSprite(ctx, itemSpriteKey(crops[i % 6]), 480 + Math.cos(a) * 220 - 16, 300 + Math.sin(a) * 120 - 16, 32, 32);
  }
}

loadSprites(new URLSearchParams(location.search).get('assets') !== 'off').then(() => {
  $('asset-status').textContent = assetStatus.loaded ? `（${assetStatus.loaded}/${assetStatus.total} 点を読み込み済み）` : '（代替のドット絵で表示中）';
});
renderMetaShop();
requestAnimationFrame(frame);

// デバッグ用（ブラウザのコンソールから参照できるように）
window.harvest = { get game() { return game; } };
