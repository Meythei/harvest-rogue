// スプライト管理: DOT ILLUST の画像を読み込み、失敗したら代替ドット絵を使う
import { DOT_ILLUST, DOT_ILLUST_BASE, CROPS } from './data.js';

const images = {};      // key -> HTMLImageElement（読み込み成功時のみ）
const fallbacks = {};   // key -> canvas
export const assetStatus = { loaded: 0, failed: 0, total: 0 };

export function loadSprites(useRemote = true) {
  const keys = Object.keys(DOT_ILLUST);
  assetStatus.total = keys.length;
  if (!useRemote) {
    assetStatus.failed = keys.length;
    return Promise.resolve();
  }
  return Promise.all(keys.map((key) => new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok && img.naturalWidth > 0) { images[key] = img; assetStatus.loaded++; }
      else assetStatus.failed++;
      resolve();
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    setTimeout(() => finish(false), 8000);
    img.referrerPolicy = 'no-referrer';
    img.src = DOT_ILLUST_BASE + DOT_ILLUST[key] + '.png';
  })));
}

// 画像の縦横比を保ったまま (x, y, w, h) に収めて描く
export function drawSprite(ctx, key, x, y, w, h) {
  const img = images[key];
  const src = img || getFallback(key);
  if (!src) return;
  const sw = img ? img.naturalWidth : src.width;
  const sh = img ? img.naturalHeight : src.height;
  const s = Math.min(w / sw, h / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

// 地面タイルは隙間なく敷き詰める
export function drawTile(ctx, key, x, y, size) {
  const img = images[key];
  ctx.drawImage(img || getFallback(key), x, y, size, size);
}

export function hasImage(key) { return !!images[key]; }

export function itemSpriteKey(crop) { return 'item_' + crop; }

// ---- 代替ドット絵 ---------------------------------------------------------

function canvas16(draw, size = 16) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const p = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  draw(p, g);
  return c;
}

function noiseTile(base, dots, seed) {
  return canvas16((p) => {
    p(0, 0, 16, 16, base);
    let s = seed;
    const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 26; i++) p(Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1, 1, dots[i % dots.length]);
  });
}

function cropItem(col, leaf = '#3d9b3d', shape = 'round') {
  return canvas16((p) => {
    if (shape === 'long') {
      p(7, 1, 1, 3, leaf); p(5, 2, 1, 2, leaf); p(9, 2, 1, 2, leaf);
      p(6, 4, 4, 3, col); p(6, 7, 3, 3, col); p(7, 10, 2, 3, col); p(7, 13, 1, 2, col);
      p(6, 5, 1, 1, '#0002');
    } else if (shape === 'corn') {
      p(5, 3, 6, 11, col); p(6, 2, 4, 1, col); p(4, 6, 2, 8, leaf); p(10, 6, 2, 8, leaf);
      for (let y = 4; y < 13; y += 2) p(6, y, 4, 1, '#d9a92b');
    } else {
      p(7, 1, 2, 3, leaf); p(5, 2, 2, 2, leaf); p(9, 2, 2, 2, leaf);
      p(4, 4, 8, 9, col); p(3, 6, 10, 5, col); p(5, 13, 6, 1, col);
      p(5, 5, 2, 2, '#ffffff55');
    }
  });
}

function personSprite(shirt) {
  return canvas16((p) => {
    p(5, 1, 6, 2, '#5b3a1e'); p(4, 3, 8, 1, '#5b3a1e');       // 帽子
    p(5, 4, 6, 4, '#f2c9a0'); p(6, 5, 1, 1, '#222'); p(9, 5, 1, 1, '#222');
    p(4, 8, 8, 4, shirt); p(3, 9, 1, 3, '#f2c9a0'); p(12, 9, 1, 3, '#f2c9a0');
    p(5, 12, 2, 3, '#3a4a8a'); p(9, 12, 2, 3, '#3a4a8a');
  });
}

function boxSprite(col, rim) {
  return canvas16((p) => {
    p(2, 5, 12, 9, col); p(2, 3, 12, 3, rim); p(2, 8, 12, 1, rim); p(7, 7, 2, 3, '#fff2a8');
    p(2, 13, 12, 1, '#0004');
  });
}

const FALLBACK_DEFS = {
  grass: () => noiseTile('#6fbf4a', ['#5aa83a', '#86d35e'], 7),
  grassFlower: () => noiseTile('#6fbf4a', ['#5aa83a', '#ffffff', '#f7d84a'], 11),
  soil: () => noiseTile('#8b5a2b', ['#7a4c22', '#9c6935'], 3),
  soilTilled: () => canvas16((p) => {
    p(0, 0, 16, 16, '#7a4c22');
    for (let y = 1; y < 16; y += 4) p(0, y, 16, 1, '#5e3a18');
  }),
  field_ninjin: () => fieldWith('#f08a24'),
  field_daikon: () => fieldWith('#eeeeee'),
  field_kabu: () => fieldWith('#f4f1e6'),
  item_ninjin: () => cropItem('#f08a24', '#3d9b3d', 'long'),
  item_daikon: () => cropItem('#f2f2f2', '#3d9b3d', 'long'),
  item_kabu: () => cropItem('#f4f1e6'),
  item_tomato: () => cropItem('#e3342f'),
  item_corn: () => cropItem('#f6c945', '#4f9b3a', 'corn'),
  item_kabocha: () => cropItem('#2f7d3a', '#6b4b22'),
  player1: () => personSprite('#3d9b3d'),
  player2: () => personSprite('#d35b8f'),
  player3: () => personSprite('#3a7bd5'),
  player4: () => personSprite('#e08a2c'),
  box1: () => boxSprite('#a0642c', '#c98a3c'),
  box2: () => boxSprite('#8a8f99', '#c9ced6'),
  box3: () => boxSprite('#b8860b', '#f0c419'),
  wall: () => canvas16((p) => {
    p(0, 0, 16, 16, '#8a8a8a');
    for (let y = 0; y < 16; y += 4) { p(0, y, 16, 1, '#5e5e5e'); p((y / 4) % 2 ? 4 : 10, y, 1, 4, '#5e5e5e'); }
  }),
  weather_sunny: () => canvas16((p) => { p(5, 5, 6, 6, '#f7b733'); p(7, 1, 2, 3, '#f7b733'); p(7, 12, 2, 3, '#f7b733'); p(1, 7, 3, 2, '#f7b733'); p(12, 7, 3, 2, '#f7b733'); }),
  weather_hail: () => canvas16((p) => { p(3, 3, 10, 5, '#c9d3dd'); p(2, 5, 12, 3, '#c9d3dd'); p(4, 10, 2, 2, '#fff'); p(8, 12, 2, 2, '#fff'); p(11, 10, 2, 2, '#fff'); }),
  weather_storm: () => canvas16((p) => { p(3, 3, 10, 5, '#5d6673'); p(2, 5, 12, 3, '#5d6673'); p(8, 8, 2, 3, '#f7d84a'); p(7, 10, 2, 3, '#f7d84a'); p(6, 12, 2, 2, '#f7d84a'); }),
  hailstone: () => canvas16((p) => { p(5, 5, 6, 6, '#e9f3fb'); p(6, 4, 4, 8, '#e9f3fb'); p(6, 6, 2, 2, '#fff'); }),
  battery: () => canvas16((p) => { p(5, 2, 6, 13, '#333'); p(7, 1, 2, 1, '#999'); p(6, 3, 4, 11, '#f7d84a'); }),
  crow: () => canvas16((p) => { p(4, 6, 8, 6, '#222'); p(10, 4, 4, 4, '#222'); p(14, 6, 2, 1, '#e0a020'); p(12, 5, 1, 1, '#fff'); p(1, 7, 4, 3, '#333'); p(6, 12, 1, 2, '#e0a020'); p(9, 12, 1, 2, '#e0a020'); }),
  oracle_good: () => canvas16((p) => { p(4, 1, 8, 2, '#ffe066'); p(5, 3, 6, 4, '#f2d9b8'); p(6, 4, 1, 1, '#333'); p(9, 4, 1, 1, '#333'); p(5, 7, 6, 3, '#fff'); p(3, 10, 10, 5, '#f4f1e6'); p(7, 10, 2, 5, '#ffe066'); }),
  oracle_bad: () => canvas16((p) => { p(4, 1, 8, 10, '#3a2a4a'); p(6, 3, 4, 4, '#ddd'); p(6, 4, 1, 1, '#000'); p(9, 4, 1, 1, '#000'); p(3, 10, 10, 5, '#2a1a3a'); p(13, 1, 1, 13, '#999'); p(10, 1, 3, 1, '#ccc'); }),
  crate: () => boxSprite('#8a5a2b', '#6b4422'),
  charm: () => canvas16((p) => { p(6, 2, 6, 6, '#3fbf7f'); p(5, 4, 3, 6, '#3fbf7f'); p(6, 9, 4, 3, '#3fbf7f'); p(9, 4, 2, 2, '#1e6b45'); p(7, 3, 2, 1, '#bff0d8'); }),
  item_rotten: () => cropItem('#7a5b8f', '#4a3a2a'),
  coin: () => canvas16((p) => { p(4, 2, 8, 12, '#e0a020'); p(2, 4, 12, 8, '#e0a020'); p(5, 3, 6, 10, '#ffd23f'); p(3, 5, 10, 6, '#ffd23f'); p(7, 5, 2, 6, '#e0a020'); }),
  harvester_bot: () => canvas16((p) => { p(2, 5, 12, 8, '#c0392b'); p(3, 6, 10, 4, '#e74c3c'); p(3, 13, 3, 2, '#222'); p(10, 13, 3, 2, '#222'); }),
};

function fieldWith(col) {
  return canvas16((p) => {
    p(0, 0, 16, 16, '#7a4c22');
    for (const [x, y] of [[3, 4], [11, 4], [7, 10]]) {
      p(x, y, 3, 3, col); p(x + 1, y - 2, 1, 2, '#3d9b3d'); p(x - 1, y - 1, 1, 1, '#3d9b3d'); p(x + 3, y - 1, 1, 1, '#3d9b3d');
    }
  });
}

function getFallback(key) {
  if (!fallbacks[key]) {
    const def = FALLBACK_DEFS[key];
    if (!def) return null;
    fallbacks[key] = def();
  }
  return fallbacks[key];
}

// 作物の成長途中（芽）
export function drawSprout(ctx, x, y, size, stage, crop) {
  const u = size / 16;
  ctx.fillStyle = '#3d9b3d';
  if (stage < 0.33) {
    ctx.fillRect(x + 7 * u, y + 9 * u, 2 * u, 3 * u);
    ctx.fillRect(x + 5 * u, y + 8 * u, 2 * u, 1 * u);
  } else {
    ctx.fillRect(x + 7 * u, y + 6 * u, 2 * u, 6 * u);
    ctx.fillRect(x + 4 * u, y + 5 * u, 3 * u, 2 * u);
    ctx.fillRect(x + 9 * u, y + 4 * u, 3 * u, 2 * u);
    ctx.fillStyle = CROPS[crop].color;
    ctx.fillRect(x + 6 * u, y + 11 * u, 4 * u, 2 * u);
  }
}
