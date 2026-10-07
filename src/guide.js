// 画面の案内: 次にやることのヒント・お知らせ欄・ラン終了の理由
// main.js からは毎フレーム updateGuide(game) を呼ぶだけにしてある
import { CROPS } from './data.js';

const $ = (id) => document.getElementById(id);
const FEED_LINES = 3;
const FEED_LIFE = 8; // 秒（ゲーム内時間）

function anyTile(game, fn) {
  for (const row of game.tiles) for (const t of row) if (fn(t)) return true;
  return false;
}

// 最初のノルマのあいだだけ、基本の手順を1行で案内する
function nextStep(game, p) {
  if (!p) return '';
  const q = game.quota;
  if (p.hunger < p.maxHunger * 0.25 && p.inv.length) return '空腹度が少なくなっています。Q で手持ちの作物を食べましょう';
  if (game.quotaIndex > 0) return '';
  if (!anyTile(game, (t) => t.soil)) return '左上の点線の枠が畑です。枠の中で Space を押して耕しましょう';
  if (!anyTile(game, (t) => t.crop)) return '耕した土の前で Space を押すと、選んでいる作物（1〜6キー）を植えます';
  if (anyTile(game, (t) => t.crop && t.crop.ripe)) return '熟した作物の前で Space を押して収穫し、落ちた作物も Space で拾います';
  if (p.inv.includes(q.crop)) return `納品ボックス（宝箱）の前で Space を押すと、手持ちの${CROPS[q.crop].name}を納品できます`;
  return '育つまでのあいだに、畑を耕して植える数を増やしましょう';
}

function renderFeed(game) {
  const el = $('feed');
  if (!el) return;
  const recent = (game.log || []).filter((l) => game.t - l.t < FEED_LIFE).slice(-FEED_LINES);
  const sig = recent.map((l) => `${l.t}:${l.msg}`).join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.innerHTML = '';
  for (const l of recent) {
    const d = document.createElement('div');
    d.textContent = l.msg;
    el.appendChild(d);
  }
}

function overReason(game) {
  const q = game.quota;
  const last = game.log?.[game.log.length - 1]?.msg || '';
  if (last.includes('放棄')) return 'ランを放棄しました';
  if (q && q.have < q.need) return `ノルマ #${game.quotaIndex + 1} 未達（${CROPS[q.crop].name} ${Math.floor(q.have)} / ${q.need}）`;
  return '';
}

export function updateGuide(game, myIndex = 0) {
  const hint = $('guide');
  if (hint) {
    const text = game.state === 'playing' ? nextStep(game, game.players[myIndex]) : '';
    if (hint.textContent !== text) hint.textContent = text;
    hint.classList.toggle('hidden', !text);
  }
  renderFeed(game);
  const reason = $('over-reason');
  if (reason && game.state === 'over') {
    const text = overReason(game);
    if (reason.textContent !== text) reason.textContent = text;
  }
}
