// 物理演算（実験機能）
// 地面の作物に重さ・高さ・弾み・ぶつかり合いを持たせる。既定ではオフで、
// 端末の `physics on|off` か URL の `?physics=1` / `?physics=0` で切り替える。
// オフのときは従来どおりの動き（摩擦で止まる・壁で止まる）のまま。
import { TILE, COLS, ROWS } from './data.js';

const PREF_KEY = 'harvest-rogue-physics';

export const PHYS = {
  gravity: 900,        // 高さ方向の重力（px/s^2）
  bounce: 0.35,        // 着地したときの弾み
  wallBounce: 0.45,    // 壁に当たったときの跳ね返り
  groundFriction: 4.0, // 接地中の減速
  airDrag: 0.6,        // 空中の減速
  radius: 9,           // 作物どうしの当たり判定
  restitution: 0.25,   // 作物どうしの反発
  playerRadius: 14,    // プレイヤーが作物を押しのける半径
  kick: 70,            // プレイヤーに押されたときの初速
  popMin: 140,         // 収穫などで出てきたときに跳ね上がる速さ
  popMax: 220,
  hailRadius: 30,      // 雹が当たった作物を弾く半径
  hailKick: 140,
};

// 重い作物ほど風や扇風機で動きにくく、ぶつかったときに相手を押しやすい
const MASS = { kabocha: 3, daikon: 1.6, corn: 1.2, ninjin: 1, kabu: 0.9, tomato: 0.8, rotten: 0.8 };
export const itemMass = (crop) => MASS[crop] || 1;

export function loadPhysicsPref() {
  try {
    const q = new URLSearchParams(globalThis.location?.search || '').get('physics');
    if (q === '1' || q === 'on') { savePhysicsPref(true); return true; }
    if (q === '0' || q === 'off') { savePhysicsPref(false); return false; }
    return globalThis.localStorage?.getItem(PREF_KEY) === '1';
  } catch (e) { return false; }
}

export function savePhysicsPref(on) {
  try { globalThis.localStorage?.setItem(PREF_KEY, on ? '1' : '0'); } catch (e) { /* 保存できない環境では毎回オフ */ }
}

// 出てきた作物を少し跳ね上げる
export function popItem(it) {
  it.z = 0;
  it.vz = PHYS.popMin + Math.random() * (PHYS.popMax - PHYS.popMin);
}

// 高さと減速。接地中だけ地面の摩擦がかかる
export function stepHeightAndDrag(it, dt) {
  if (it.z === undefined) { it.z = 0; it.vz = 0; }
  if (it.z > 0 || it.vz > 0) {
    it.vz -= PHYS.gravity * dt;
    it.z += it.vz * dt;
    if (it.z <= 0) {
      it.z = 0;
      it.vz = Math.abs(it.vz) > 60 ? -it.vz * PHYS.bounce : 0;
    }
  }
  const f = Math.max(0, 1 - (it.z > 0 ? PHYS.airDrag : PHYS.groundFriction) * dt);
  it.vx *= f; it.vy *= f;
}

// 移動と壁との衝突。止めずに跳ね返す
export function moveWithBounce(it, dt, blocked) {
  let nx = it.x + it.vx * dt, ny = it.y + it.vy * dt;
  if (blocked(nx, it.y)) { nx = it.x; it.vx = -it.vx * PHYS.wallBounce; }
  if (blocked(nx, ny)) { ny = it.y; it.vy = -it.vy * PHYS.wallBounce; }
  return [nx, ny];
}

// 作物どうし・プレイヤーと作物のぶつかり合い
export function resolveContacts(game, blocked) {
  const items = game.items.filter((it) => !it.dead && it.state === 'ground');
  // マスごとに振り分けて、近くの作物だけを調べる
  const grid = new Map();
  const key = (tx, ty) => ty * COLS + tx;
  for (const it of items) {
    const k = key(Math.floor(it.x / TILE), Math.floor(it.y / TILE));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(it);
  }
  const r2 = PHYS.radius * 2;
  for (const a of items) {
    const tx = Math.floor(a.x / TILE), ty = Math.floor(a.y / TILE);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (tx + ox < 0 || ty + oy < 0 || tx + ox >= COLS || ty + oy >= ROWS) continue;
        const cell = grid.get(key(tx + ox, ty + oy));
        if (!cell) continue;
        for (const b of cell) {
          if (b.id <= a.id) continue;
          // 高さが大きく違えば飛び越える
          if (Math.abs((a.z || 0) - (b.z || 0)) > 14) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d >= r2) continue;
          if (d < 0.01) { const t = Math.random() * Math.PI * 2; dx = Math.cos(t); dy = Math.sin(t); d = 1; }
          const nx = dx / d, ny = dy / d;
          const ma = itemMass(a.crop), mb = itemMass(b.crop);
          const ia = 1 / ma, ib = 1 / mb;
          // めり込みを質量の逆比で押し戻す
          const push = (r2 - d) / (ia + ib) * 0.8;
          separate(a, -nx * push * ia, -ny * push * ia, blocked);
          separate(b, nx * push * ib, ny * push * ib, blocked);
          // 近づいているときだけ跳ね返す
          const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rel < 0) {
            const j = -(1 + PHYS.restitution) * rel / (ia + ib);
            a.vx -= j * ia * nx; a.vy -= j * ia * ny;
            b.vx += j * ib * nx; b.vy += j * ib * ny;
          }
        }
      }
    }
  }
  // プレイヤーは作物を押しのけて進む
  const pr = PHYS.playerRadius + PHYS.radius;
  for (const p of game.players) {
    for (const it of items) {
      if (it.dead || it.onConveyor || (it.z || 0) > 16) continue;
      const dx = it.x - p.x, dy = it.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d >= pr || d < 0.01) continue;
      const nx = dx / d, ny = dy / d;
      separate(it, nx * (pr - d), ny * (pr - d), blocked);
      if (p.moving) {
        const k = PHYS.kick / itemMass(it.crop);
        it.vx += nx * k * 0.2; it.vy += ny * k * 0.2;
        if (it.vx * nx + it.vy * ny < k * 0.6) { it.vx = nx * k; it.vy = ny * k; }
      }
    }
  }
}

function separate(it, dx, dy, blocked) {
  if (!blocked(it.x + dx, it.y)) it.x += dx;
  if (!blocked(it.x, it.y + dy)) it.y += dy;
}

// 雹が地面に当たったとき、近くの作物を弾き飛ばす
export function hailImpact(game, x, y) {
  for (const it of game.items) {
    if (it.dead || it.state !== 'ground' || it.onConveyor) continue;
    const dx = it.x - x, dy = it.y - y;
    const d = Math.hypot(dx, dy);
    if (d > PHYS.hailRadius) continue;
    const m = itemMass(it.crop);
    const s = PHYS.hailKick * (1 - d / PHYS.hailRadius) / m;
    const n = d < 0.01 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
    it.vx += n.x * s; it.vy += n.y * s;
    it.vz = Math.max(it.vz || 0, s * 0.8);
    if (!it.z) it.z = 0.01;
  }
}
