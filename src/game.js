// ゲーム本体: シミュレーションと描画
import {
  TILE, COLS, ROWS, DAY_LENGTH, DAYS_PER_QUOTA, QUOTA_GROWTH, CROPS, CROP_ORDER, HUNGER_COST,
  FARM_TIERS, FARM_ORIGIN, TECH, BUILDINGS, DIRS,
} from './data.js';
import {
  CHARMS, CHARM_KEYS, deliveryHand, BOSSES, BOSS_KEYS, ORACLES, GOOD_ORACLES, BAD_ORACLES, rollSupply,
  PACTS, ROT_TIME, DEFAULT_GAMBITS,
} from './extras.js';
import { drawSprite, drawTile, drawSprout, itemSpriteKey } from './sprites.js';
import { sfx as playSfx, setCombo } from './audio.js';

const W = COLS * TILE;
const H = ROWS * TILE;
const BLOCKS_PLAYER = new Set(['wall', 'fan', 'bike', 'biomass', 'fusion', 'pylon', 'collector', 'drone', 'board', 'box', 'terminal', 'wireless', 'sprinkler', 'harvester', 'kakashi']);
const BLOCKS_ITEM = new Set(['wall', 'fan', 'bike', 'fusion', 'pylon', 'drone', 'terminal', 'sprinkler', 'harvester', 'kakashi']);
const BOARD_CHARGES = 4; // 手でまな板を使える1日の回数
const CONVEYORS = { belt: 1.6, pipe: 4.5 }; // マス/秒
const BOX_LIMIT = 3;
const DRONE_CAP = 6;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tileOf = (px) => Math.floor(px / TILE);
const center = (t) => t * TILE + TILE / 2;

let nextId = 1;
export const MAX_PLAYERS = 4;
// 同期で作物を番号にするときの並び（腐った作物も含む）
const SYNC_CROPS = Object.keys(CROPS);
export const PLAYER_COLORS = ['#ffe066', '#ff9ad5', '#7fd4ff', '#9fe870'];

export class Game {
  constructor({ playerCount = 1, meta = { perks: {} }, trait = 'none', pacts = [] } = {}) {
    const perks = meta.perks || {};
    this.trait = trait;
    this.pacts = pacts.filter((k) => PACTS[k]);
    this.tiles = [];
    for (let y = 0; y < ROWS; y++) {
      const row = [];
      for (let x = 0; x < COLS; x++) row.push({ soil: false, crop: null, flower: Math.random() < 0.08 });
      this.tiles.push(row);
    }
    this.bAt = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.buildings = [];
    this.items = [];
    this.drones = [];
    this.particles = [];
    this.floaters = [];
    this.hail = [];
    this.log = [];

    this.tech = {
      collect: perks.handy ? 2 : 1,
      transport: 1,
      deliver: 1,
      energy: perks.bike ? 1 : 0,
      farm: perks.garden ? 1 : 0,
    };
    this.unlocks = { pylon: false, board: false, warp: false, sprinkler: false, harvester: false };
    this.charms = [];
    this.charmSlots = 3 + (perks.pocket || 0);
    this.boardCharges = BOARD_CHARGES;
    this.oracle = null;
    this.banner = null;
    this.discount = false;
    this.crates = [];
    this.crateTimer = 30;
    this.dayIdx = -1;
    this.shopOffers = [];
    this.rerollCost = 5;
    this.seasonal = null;
    this.crows = [];
    this.crowsTomorrow = false;
    this.calcPop = null;
    this.gambits = DEFAULT_GAMBITS.map((g) => ({ ...g }));
    this.crops = ['ninjin', 'kabu'];
    this.slots = [];
    this.comboWindow = 5 + (perks.rhythm || 0);
    this.combo = 0;
    this.comboTimer = 0;
    this.bestCombo = 0;
    this.coins = 30 + 40 * (perks.coins || 0);
    this.power = 0;
    this.powered = false;
    this.pylonPowered = false;
    this.droneMode = 'gambit';
    this.invCap = 12;
    if (perks.charm) this.addCharm(pick(CHARM_KEYS));

    this.t = 0;
    this.quotaIndex = 0;
    this.quotasCleared = 0;
    this.totalDelivered = 0;
    this.totalCoins = 0;
    this.state = 'playing'; // playing | upgrade | over
    this.pendingUpgrade = false;

    this.weather = { phase: 'clear', kind: null, timer: 30, cx: 0, cy: 0, r: 0, wind: { x: 1, y: 0 }, flash: 0 };

    this.players = [];
    this.place('terminal', 22, 1, 0, true);
    this.place('box', 21, 4, 0, true);

    this.maxHunger = 100 + 20 * (perks.stomach || 0) + (trait === 'glutton' ? 40 : 0) - (trait === 'tinkerer' ? 20 : 0) - (this.pactOn('famine') ? 30 : 0);
    this.netEvents = [];
    for (let i = 0; i < playerCount; i++) this.addPlayer();
    this.startQuota();
    this.say('農場管理端末に接続しました。ノルマを確認してください。');
  }

  // ---- プレイヤー -----------------------------------------------------------

  addPlayer(name = '', netId = null) {
    const i = this.players.length;
    if (i >= MAX_PLAYERS) return -1;
    this.players.push({
      id: i, name: name || `P${i + 1}`, netId, away: false,
      x: center(19), y: center(3 + i * 2), dir: 2, hunger: this.maxHunger, maxHunger: this.maxHunger,
      inv: ['ninjin', 'ninjin'], sick: 0, moving: false, anim: 0, warpCd: 0, fullDeliver: false, seed: 'ninjin',
      input: { up: false, down: false, left: false, right: false },
    });
    return i;
  }

  // 効果音。オンライン時はゲストにも同じ音を鳴らすため記録しておく
  sfx(name) {
    playSfx(name);
    this.netEvents.push(name);
    if (this.netEvents.length > 40) this.netEvents.shift();
  }

  activePlayers() { return this.players.filter((p) => !p.away); }

  // ---- 基本情報 ------------------------------------------------------------

  farmRect() {
    const f = FARM_TIERS[this.tech.farm];
    return { x: FARM_ORIGIN.x, y: FARM_ORIGIN.y, w: f.w, h: f.h };
  }

  inFarm(x, y) {
    const r = this.farmRect();
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; }

  powerCap() { return 100 + this.tech.energy * 100; }

  comboCap() { return 10 + (this.tech.transport - 1) * 10 + (this.tech.deliver - 1) * 5; }

  comboMult() { return 1 + Math.min(this.combo, this.comboCap()) * 0.05; }

  // 倍率スロットは足し算で重なる（同じスロットを重ねても指数的には伸びない）
  slotMult(type, crop) {
    let m = 1;
    for (const s of this.slots) if (s.type === type && (!s.crop || s.crop === crop)) m += s.mult - 1;
    return m;
  }

  has(charm) { return this.charms.includes(charm); }

  pactOn(key) { return this.pacts.includes(key); }

  rotTime() { return ROT_TIME * (this.pactOn('rotting') ? 0.5 : 1); }

  bossIs(key) { return this.quota?.boss === key; }

  coinMult() {
    return (this.trait === 'merchant' ? 1.5 : 1) * (this.bossIs('tax') ? 0.5 : 1) * (this.oracle === 'slump' ? 0.6 : 1);
  }

  foodMult() {
    return (this.has('omnivore') ? 1.5 : 1) * (this.bossIs('picky') ? 0.5 : 1) * (this.trait === 'glutton' ? 0.75 : 1);
  }

  moveCostMult() {
    if (this.oracle === 'wind') return 0;
    return (this.bossIs('heavy') ? 2 : 1) * (this.trait === 'hasty' ? 1.5 : 1);
  }

  workMult() { return this.oracle === 'fatigue' ? 1.3 : 1; }

  buildCost(type) {
    const c = (BUILDINGS[type]?.cost || 0) * (this.pactOn('inflation') ? 1.3 : 1);
    return Math.floor(this.trait === 'tinkerer' ? c * 0.8 : c);
  }

  weatherDamageMult() { return (this.has('scarecrow') ? 0.5 : 1) * (this.trait === 'devout' ? 1.25 : 1); }

  // 作物ごとの成長倍率（シムシティ風の施設の効果範囲と隣接効果を含む）
  growthMult(x, y, kind) {
    let m = this.slotMult('growth', kind);
    if (this.bossIs('drought')) m *= 0.7;
    if (this.has('earlybird') && this.dayIdx === 0) m *= 1.5;
    if (this.powered && this.buildings.some((b) => b.type === 'sprinkler' && Math.abs(b.x - x) <= 2 && Math.abs(b.y - y) <= 2)) m *= 1.4;
    for (const d of DIRS) {
      const n = this.tiles[y + d.y]?.[x + d.x]?.crop;
      if (n && n.kind !== kind) { m *= this.has('companion') ? 1.4 : 1.2; break; }
    }
    return m;
  }

  say(msg) {
    this.log.push({ t: this.t, msg });
    if (this.log.length > 60) this.log.shift();
  }

  floater(x, y, text, color = '#fff') { this.floaters.push({ x, y, text, color, life: 1.2 }); }

  burst(x, y, color, n = 8) {
    for (let i = 0; i < n; i++) {
      this.particles.push({ x, y, vx: rand(-80, 80), vy: rand(-120, -20), life: rand(0.3, 0.7), color, size: rand(2, 4) });
    }
  }

  // ---- ノルマ --------------------------------------------------------------

  // 次のノルマを前もって決めておく（作物とボスを予告できるように）
  planQuota(q) {
    return { crop: q === 0 ? 'ninjin' : pick(this.crops), boss: q % 3 === 2 ? pick(BOSS_KEYS) : null };
  }

  quotaNeed(q, crop) {
    // 成長の速さに加えて収穫数でも割り戻す。協力プレイは人数に応じて増える
    const coop = 1 + 0.6 * (Math.max(1, this.players.length) - 1);
    const trait = this.trait === 'merchant' ? 1.1 : 1;
    const c = CROPS[crop];
    return Math.max(3, Math.round(6 * Math.pow(QUOTA_GROWTH, q) * Math.sqrt(16 / c.grow) * c.yield * coop * trait));
  }

  startQuota() {
    const q = this.quotaIndex;
    const plan = this.upcoming || this.planQuota(q);
    const crop = plan.crop;
    const need = this.quotaNeed(q, crop);
    this.quota = { crop, need, have: 0, start: this.t, end: this.t + DAYS_PER_QUOTA * DAY_LENGTH, boss: plan.boss };
    this.upcoming = this.planQuota(q + 1);
    this.dayIdx = -1;
    // 悪天候は3つ目のノルマから
    const calm = q <= 1 && !this.pactOn('stormy');
    this.weather = { ...this.weather, phase: 'clear', timer: calm ? 9999 : rand(12, 30) };
    this.say(`新しいノルマ: ${DAYS_PER_QUOTA}日以内に${CROPS[crop].name}を${need}個納品`);
    if (plan.boss) this.say(`ボスノルマ「${BOSSES[plan.boss].name}」: ${BOSSES[plan.boss].desc}`);
  }

  // ---- 1日の区切り（ゴッドフィールド風の神託） --------------------------------

  updateDay() {
    const d = Math.floor((this.t - this.quota.start) / DAY_LENGTH);
    if (d === this.dayIdx || d >= DAYS_PER_QUOTA) return;
    if (this.dayIdx >= 0) this.endOfDay();
    this.dayIdx = d;
    this.startDay();
  }

  startDay() {
    this.boardCharges = BOARD_CHARGES;
    if (this.has('rancher')) for (const p of this.players) p.hunger = Math.min(p.maxHunger, p.hunger + 25);
    this.oracle = null;
    // ペルソナ風: 毎日ひとつ「旬」の作物が決まる。収穫に空腹度を使わず、納品のコインが1.5倍
    this.seasonal = pick(this.crops);
    // 前日に予告されたカラスの群れがやってくる。翌日の予告もここで決める
    if (this.crowsTomorrow) this.spawnCrows();
    this.crowsTomorrow = this.pactOn('crows') || (this.quotaIndex >= 1 && Math.random() < 0.3);
    if (this.crowsTomorrow) this.say('明日はカラスの群れが来そうだ。かかしを立てておこう。');
    if (this.quotaIndex === 0 && this.dayIdx === 0) return;
    const goodChance = this.trait === 'devout' ? 0.85 : 0.6;
    const key = Math.random() < goodChance ? pick(GOOD_ORACLES) : pick(BAD_ORACLES);
    this.oracle = key;
    const o = ORACLES[key];
    switch (key) {
      case 'rain':
        for (const row of this.tiles) for (const t of row) if (t.crop && !t.crop.ripe) t.crop.t += 8;
        break;
      case 'gold': this.coins += 30; break;
      case 'bless': for (const p of this.players) p.hunger = p.maxHunger; break;
      case 'merchant': this.discount = true; break;
      case 'locust': {
        const growing = [];
        this.tiles.forEach((row, y) => row.forEach((t, x) => { if (t.crop && !t.crop.ripe) growing.push({ x, y }); }));
        const n = Math.round(6 * this.weatherDamageMult());
        for (let i = 0; i < n && growing.length; i++) {
          const { x, y } = growing.splice(Math.floor(Math.random() * growing.length), 1)[0];
          this.tiles[y][x].crop = null;
          this.burst(center(x), center(y), '#6b8e23', 6);
        }
        break;
      }
      default: break;
    }
    this.banner = { title: `${this.dayIdx + 1}日目の神託「${o.name}」`, desc: o.desc, good: o.good, life: 4 };
    this.say(`神託「${o.name}」: ${o.desc}`);
    this.sfx(o.good ? 'oracle' : 'warn');
  }

  endOfDay() {
    if (this.has('piggy')) {
      const interest = Math.min(10, Math.floor(this.coins / 10));
      if (interest > 0) { this.coins += interest; this.say(`貯金箱の利息 +${interest} コイン`); }
    }
    // 夜になるとお腹が減る（空腹度を「時間の圧力」にもする）
    for (const p of this.players) p.hunger = Math.max(0, p.hunger - 8);
  }

  quotaDay() { return Math.min(DAYS_PER_QUOTA, Math.floor((this.t - this.quota.start) / DAY_LENGTH) + 1); }

  quotaRemaining() { return Math.max(0, this.quota.end - this.t); }

  // ---- 建物 ----------------------------------------------------------------

  isUnlocked(type) {
    const req = BUILDINGS[type].req;
    if (req.unlock) return this.unlocks[req.unlock];
    return Object.entries(req).every(([k, v]) => this.tech[k] >= v);
  }

  canPlace(type, x, y) {
    if (!this.inBounds(x, y) || this.bAt[y][x]) return false;
    if (this.tiles[y][x].crop) return false;
    if (type === 'box' && this.buildings.filter((b) => b.type === 'box').length >= BOX_LIMIT) return false;
    for (const p of this.players) {
      if (p.away) continue;
      if (BLOCKS_PLAYER.has(type) && tileOf(p.x) === x && tileOf(p.y) === y) return false;
    }
    return true;
  }

  place(type, x, y, dir = 0, free = false) {
    if (!this.canPlace(type, x, y)) return null;
    const cost = free ? 0 : this.buildCost(type);
    if (this.coins < cost) return null;
    this.coins -= cost;
    const b = { id: nextId++, type, x, y, dir, fuel: 0, burn: 0, store: [], cd: 0, anim: 0 };
    if (type === 'warp') {
      const lone = this.buildings.find((o) => o.type === 'warp' && !o.pair);
      if (lone) { lone.pair = b; b.pair = lone; }
    }
    this.buildings.push(b);
    this.bAt[y][x] = b;
    return b;
  }

  build(type, x, y, dir) {
    if (!this.isUnlocked(type)) return false;
    if (this.coins < this.buildCost(type)) { this.floater(center(x), center(y), 'コイン不足', '#ff8080'); this.sfx('deny'); return false; }
    const b = this.place(type, x, y, BUILDINGS[type].rotate ? dir : 0);
    if (!b) { this.sfx('deny'); return false; }
    this.sfx('build');
    this.burst(center(x), center(y), '#ddd', 6);
    return true;
  }

  demolish(x, y) {
    const b = this.inBounds(x, y) && this.bAt[y][x];
    if (!b || b.type === 'terminal') return false;
    if (b.type === 'box' && this.buildings.filter((o) => o.type === 'box').length <= 1) {
      this.floater(center(x), center(y), '最後の納品ボックスは壊せない', '#ff8080');
      return false;
    }
    this.coins += Math.floor(this.buildCost(b.type) / 2);
    for (const c of b.store) this.spawnItem(c, center(x), center(y));
    if (b.pair) b.pair.pair = null;
    if (b.type === 'drone') this.drones = this.drones.filter((d) => d.station !== b);
    this.buildings = this.buildings.filter((o) => o !== b);
    this.bAt[y][x] = null;
    this.sfx('till');
    return true;
  }

  moveBox(box, x, y) {
    if (!box || box.type !== 'box' || this.tech.deliver < 2) return false;
    this.bAt[box.y][box.x] = null;
    if (!this.canPlace('box', x, y) && !(x === box.x && y === box.y)) {
      // canPlace は自分自身を数えるので、移動時は数の制限を無視する
      const free = this.inBounds(x, y) && !this.bAt[y][x] && !this.tiles[y][x].crop;
      if (!free) { this.bAt[box.y][box.x] = box; this.sfx('deny'); return false; }
    }
    box.x = x; box.y = y;
    this.bAt[y][x] = box;
    this.sfx('build');
    return true;
  }

  nearest(type, x, y) {
    let best = null, bd = Infinity;
    for (const b of this.buildings) {
      if (b.type !== type) continue;
      const d = (center(b.x) - x) ** 2 + (center(b.y) - y) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // ---- 作物・アイテム ------------------------------------------------------

  spawnItem(crop, x, y, extra = {}) {
    const it = { id: nextId++, crop, x, y, vx: rand(-40, 40), vy: rand(-40, 40), state: 'ground', cut: false, lastTile: null, cd: 0, age: 0, ...extra };
    this.items.push(it);
    return it;
  }

  removeItem(it) { it.dead = true; }

  // extra: 納品の役などで上乗せされる倍率
  deliver(crop, x, y, extra = 0) {
    if (crop === 'rotten') {
      this.floater(x, y - 10, '腐っている…', '#c9a0dc');
      return { coins: 0, base: 0 };
    }
    const investor = this.has('investor') ? Math.min(0.5, Math.floor(this.coins / 25) * 0.05) : 0;
    let mult = (this.comboMult() + extra + investor) * this.slotMult('deliver', crop);
    if (this.has('allin') && crop === this.quota.crop) mult *= 1.25;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.comboTimer = this.comboWindow;
    setCombo(this.combo);
    const base = CROPS[crop].value * (crop === this.seasonal ? 1.5 : 1);
    const coins = Math.max(1, Math.round(base * mult * this.coinMult()));
    this.coins += coins;
    this.totalCoins += coins;
    this.totalDelivered++;
    if (crop === this.quota.crop) this.quota.have += mult;
    this.floater(x, y - 10, `+${coins}`, crop === this.quota.crop ? '#ffe066' : '#fff');
    this.sfx('deliver');
    return { coins, base };
  }

  isProtected(x, y) {
    if (!this.pylonPowered) return false;
    return this.buildings.some((b) => b.type === 'pylon' && (b.x - x) ** 2 + (b.y - y) ** 2 <= 9.5);
  }

  // ---- プレイヤー操作 ------------------------------------------------------

  facingTile(p) {
    const d = DIRS[p.dir];
    return { x: tileOf(p.x + d.x * TILE * 0.75), y: tileOf(p.y + d.y * TILE * 0.75) };
  }

  // essential な作業（収穫・拾う・納品）は空腹度0でも行える。詰み防止のため
  spend(p, amount, essential = false) {
    if (p.hunger <= 0 && amount > 0 && !essential) {
      this.floater(p.x, p.y - 30, 'お腹が空いて動けない…', '#ff9090');
      this.sfx('deny');
      return false;
    }
    p.hunger = Math.max(0, p.hunger - amount * this.workMult());
    return true;
  }

  action(pi) {
    const p = this.players[pi];
    if (!p || p.away || this.state !== 'playing') return;
    const { x, y } = this.facingTile(p);
    if (!this.inBounds(x, y)) return;
    const b = this.bAt[y][x];
    if (b) return this.interact(p, b);

    // 手作業で拾う
    const near = this.items.filter((it) => it.state === 'ground' && !it.dead
      && Math.hypot(it.x - center(x), it.y - center(y)) < TILE * 0.9);
    if (near.length && p.inv.length < this.invCap) {
      const cost = this.pickupCost();
      for (const it of near) {
        if (p.inv.length >= this.invCap) break;
        if (!this.spend(p, cost, true)) break;
        p.inv.push(it.crop);
        this.removeItem(it);
      }
      this.sfx('pickup');
      return;
    }

    const tile = this.tiles[y][x];
    if (tile.crop) {
      if (tile.crop.ripe) {
        const cost = tile.crop.kind === this.seasonal ? 0 : HUNGER_COST.harvest;
        if (!this.spend(p, cost, true)) return;
        this.harvestTile(x, y);
      }
      return;
    }
    const hoe = this.has('hoe') ? 0 : 1;
    if (tile.soil) {
      if (!this.spend(p, HUNGER_COST.plant * hoe)) return;
      tile.crop = { kind: this.crops.includes(p.seed) ? p.seed : 'ninjin', t: 0, ripe: false };
      this.sfx('plant');
      return;
    }
    if (this.inFarm(x, y)) {
      if (!this.spend(p, HUNGER_COST.till * hoe)) return;
      tile.soil = true;
      this.burst(center(x), center(y), '#8b5a2b', 6);
      this.sfx('till');
    }
  }

  // 収穫して地面に作物を落とす。放射能で巨大化した作物・お守り・神託で収穫数が増える
  harvestTile(x, y) {
    const crop = this.tiles[y][x].crop;
    const c = crop.kind;
    this.tiles[y][x].crop = null;
    let n = CROPS[c].yield + (crop.mut ? 1 : 0);
    if (this.has('goddess') && Math.random() < 0.2) n++;
    if (this.oracle === 'harvest' && Math.random() < 0.3) n++;
    for (let i = 0; i < n; i++) this.spawnItem(c, center(x) + rand(-6, 6), center(y) + rand(-6, 6));
    this.burst(center(x), center(y), crop.mut ? '#7dff5a' : CROPS[c].color, 6);
    if (n > CROPS[c].yield) this.floater(center(x), center(y) - 8, `×${n}`, '#9fe870');
    this.sfx('harvest');
    return c;
  }

  pickupCost() { return this.tech.collect >= 3 ? 0 : this.tech.collect === 2 ? 0.2 : HUNGER_COST.pickup; }

  interact(p, b) {
    const cx = center(b.x), cy = center(b.y);
    switch (b.type) {
      case 'box': {
        if (!p.inv.length) { this.floater(cx, cy, '手持ちが空です', '#ccc'); return; }
        if (!this.spend(p, HUNGER_COST.deliver, true)) return;
        // 手持ちを全部納品する（食べる分は先に食べておく）。中身の組み合わせで役が付く
        const full = p.inv.length >= this.invCap;
        const batch = p.inv.splice(0);
        const fresh = batch.filter((c) => c !== 'rotten');
        const hand = this.bossIs('single') ? null : deliveryHand(fresh);
        let extra = hand ? hand.mult * (this.has('bulkorder') ? 1.5 : 1) : 0;
        if (full && this.has('crow')) extra += 0.5;
        if (hand) { this.say(`納品の役「${hand.name}」 倍率 +${extra.toFixed(2)}`); this.sfx('hand'); }
        const combo0 = this.comboMult();
        let base = 0, total = 0;
        batch.forEach((c, i) => {
          const r = this.deliver(c, cx + rand(-8, 8), cy - i * 6, extra);
          base += r.base; total += r.coins;
        });
        // Balatro 風: 「基本 × 倍率 = 獲得」の内訳を表示する
        if (fresh.length) this.calcPop = { x: cx, y: cy - 30, n: fresh.length, rotten: batch.length - fresh.length, base: Math.round(base), combo: combo0, hand, extra, total, life: 2.6 };
        return;
      }
      case 'bike': {
        if (this.power >= this.powerCap()) { this.floater(cx, cy, '満タン', '#ccc'); return; }
        if (!this.spend(p, HUNGER_COST.pump)) return;
        this.power = Math.min(this.powerCap(), this.power + 4);
        b.anim += 1;
        this.floater(cx, cy - 10, '+4⚡', '#ffe066');
        this.sfx('pump');
        return;
      }
      case 'biomass': {
        const idx = this.pickFuel(p.inv);
        if (idx < 0) { this.floater(cx, cy, '燃やす作物がない', '#ccc'); return; }
        const c = p.inv.splice(idx, 1)[0];
        b.fuel += this.fuelOf(c);
        this.burst(cx, cy, '#ff9a3c', 8);
        this.sfx('burn');
        return;
      }
      case 'board': {
        const idx = p.inv.findIndex(() => true);
        if (idx < 0) { this.floater(cx, cy, '切る作物がない', '#ccc'); return; }
        if (p.inv.length >= this.invCap) { this.floater(cx, cy, '手持ちがいっぱい', '#ccc'); return; }
        // 手で切るのは1日の回数に上限がある（無限に増やせないように）
        if (this.boardCharges <= 0) { this.floater(cx, cy, '今日はもう切れない', '#ccc'); this.sfx('deny'); return; }
        if (!this.spend(p, HUNGER_COST.cut)) return;
        this.boardCharges--;
        p.inv.push(p.inv[idx]);
        this.floater(cx, cy, '×2', '#9fe870');
        this.sfx('cut');
        return;
      }
      case 'collector': {
        while (b.store.length && p.inv.length < this.invCap) p.inv.push(b.store.pop());
        this.sfx('pickup');
        return;
      }
      case 'terminal':
        this.onTerminal?.();
        return;
      default:
        return;
    }
  }

  fuelOf(c) { return CROPS[c].fuel * (this.has('alchemist') ? 2 : 1); }

  // ノルマ対象以外で燃料効率の良いものから燃やす
  pickFuel(inv) {
    let best = -1, score = -Infinity;
    inv.forEach((c, i) => {
      const s = CROPS[c].fuel - (c === this.quota.crop ? 100 : 0) + (c === 'rotten' ? 50 : 0);
      if (s > score) { score = s; best = i; }
    });
    return best;
  }

  eat(pi) {
    const p = this.players[pi];
    if (!p || this.state !== 'playing' || !p.inv.length) return;
    if (p.hunger >= p.maxHunger - 1) { this.floater(p.x, p.y - 30, 'お腹いっぱい', '#ccc'); return; }
    // ノルマ対象以外を優先して食べる
    // ノルマ対象以外を優先して食べる。腐った作物は最後の手段
    let idx = p.inv.findIndex((c) => c !== this.quota.crop && c !== 'rotten');
    if (idx < 0) idx = p.inv.findIndex((c) => c !== 'rotten');
    if (idx < 0) idx = 0;
    const c = p.inv.splice(idx, 1)[0];
    const food = Math.round(CROPS[c].food * this.foodMult());
    p.hunger = Math.min(p.maxHunger, p.hunger + food);
    if (c === 'rotten') {
      // Fallout の放射能のように、腐った作物を食べると最大空腹度が減る（ノルマを達成すると治る）
      const loss = Math.min(5, p.maxHunger - 40);
      if (loss > 0) { p.maxHunger -= loss; p.sick += loss; p.hunger = Math.min(p.hunger, p.maxHunger); }
      this.floater(p.x, p.y - 30, `胃病み 最大空腹度 -${loss}`, '#c9a0dc');
      this.sfx('rot');
      return;
    }
    this.floater(p.x, p.y - 30, `+${food} 空腹度`, '#9fe870');
    this.sfx('eat');
  }

  // ---- 更新 ----------------------------------------------------------------

  update(dt) {
    if (this.state !== 'playing') return;
    this.t += dt;
    this.updateDay();
    this.updatePower(dt);
    this.updatePlayers(dt);
    this.updateCrops(dt);
    this.updateBuildings(dt);
    this.updateItems(dt);
    this.updateDrones(dt);
    this.updateWeather(dt);
    this.updateCombo(dt);
    this.updateCrates(dt);
    this.updateCrows(dt);
    this.updateEffects(dt);
    this.checkQuota();
  }

  updatePower(dt) {
    let demand = 0;
    for (const b of this.buildings) demand += (BUILDINGS[b.type]?.power || 0) * dt;
    this.powered = this.power >= demand && this.power > 0;
    if (this.powered) this.power -= demand;
    for (const b of this.buildings) {
      if (b.type === 'fusion') this.power += 6 * dt;
      if (b.type === 'biomass' && (b.fuel > 0 || b.burn > 0)) {
        if (b.burn <= 0) { b.fuel -= 1; b.burn = 5; } // 燃料1で電力20
        b.burn -= dt;
        this.power += 4 * dt;
        if (Math.random() < dt * 8) this.particles.push({ x: center(b.x) + rand(-6, 6), y: center(b.y) - 14, vx: rand(-10, 10), vy: -40, life: 0.6, color: '#888a', size: 4 });
      }
    }
    // パイロンは悪天候のときだけ電力を使う
    const pylons = this.buildings.filter((b) => b.type === 'pylon').length;
    if (this.weather.phase === 'active' && pylons) {
      const need = pylons * 1.2 * dt;
      this.pylonPowered = this.power >= need;
      if (this.pylonPowered) this.power -= need;
    } else this.pylonPowered = pylons > 0;
    this.power = clamp(this.power, 0, this.powerCap());
  }

  updatePlayers(dt) {
    for (const p of this.players) {
      if (p.away) continue;
      p.warpCd = Math.max(0, p.warpCd - dt);
      let dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
      let dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
      p.moving = dx !== 0 || dy !== 0;
      if (p.moving) {
        if (Math.abs(dx) >= Math.abs(dy)) p.dir = dx > 0 ? 0 : 2; else p.dir = dy > 0 ? 1 : 3;
        const len = Math.hypot(dx, dy);
        dx /= len; dy /= len;
        const speed = TILE * 4.2 * (p.hunger <= 0 ? 0.45 : 1) * (this.trait === 'hasty' ? 1.25 : 1);
        const ox = p.x, oy = p.y;
        this.movePlayer(p, dx * speed * dt, 0);
        this.movePlayer(p, 0, dy * speed * dt);
        const dist = Math.hypot(p.x - ox, p.y - oy) / TILE;
        p.hunger = Math.max(0, p.hunger - dist * (HUNGER_COST.movePerTile + HUNGER_COST.carryPerTilePerItem * p.inv.length) * this.moveCostMult());
        p.anim += dt * 10;
      }
      // ワープゲート
      const b = this.bAt[tileOf(p.y)]?.[tileOf(p.x)];
      if (b && b.type === 'warp' && b.pair && p.warpCd <= 0) {
        p.x = center(b.pair.x); p.y = center(b.pair.y);
        p.warpCd = 1;
        this.sfx('warp');
        this.burst(p.x, p.y, '#b48cff', 12);
      }
      this.collectAround(p, dt);
    }
  }

  movePlayer(p, dx, dy) {
    const r = 11;
    const nx = p.x + dx, ny = p.y + dy;
    const corners = [[nx - r, ny - r], [nx + r, ny - r], [nx - r, ny + r], [nx + r, ny + r]];
    for (const [cx, cy] of corners) {
      const tx = tileOf(cx), ty = tileOf(cy);
      if (!this.inBounds(tx, ty)) return;
      const b = this.bAt[ty][tx];
      if (b && BLOCKS_PLAYER.has(b.type)) return;
    }
    p.x = nx; p.y = ny;
  }

  collectAround(p, dt) {
    const tier = this.tech.collect;
    if (tier < 2) return;
    const full = p.inv.length >= this.invCap;
    for (const it of this.items) {
      if (it.dead || full) continue;
      if (it.state === 'orbit' && it.owner === p) continue;
      if (it.state !== 'ground') continue;
      const d = Math.hypot(it.x - p.x, it.y - p.y);
      if (tier === 2 && d < TILE * 0.6) {
        p.hunger = Math.max(0, p.hunger - this.pickupCost());
        p.inv.push(it.crop); this.removeItem(it); this.sfx('pickup');
        if (p.inv.length >= this.invCap) break;
      } else if (tier >= 3 && d < TILE * 2.6) {
        // 回転しながら吸い寄せられる演出
        it.state = 'orbit';
        it.owner = p;
        it.ang = Math.atan2(it.y - p.y, it.x - p.x);
        it.r = d;
      }
    }
    // 回転中のアイテム
    for (const it of this.items) {
      if (it.dead || it.state !== 'orbit' || it.owner !== p) continue;
      it.ang += dt * 9;
      it.r -= dt * TILE * 2.2;
      it.x = p.x + Math.cos(it.ang) * Math.max(0, it.r);
      it.y = p.y - 8 + Math.sin(it.ang) * Math.max(0, it.r) * 0.6;
      if (it.r <= 4) {
        if (p.inv.length < this.invCap) { p.inv.push(it.crop); this.removeItem(it); this.sfx('pickup'); }
        else { it.state = 'ground'; it.vx = it.vy = 0; }
      }
    }
  }

  updateCrops(dt) {
    // Fallout 風: 核融合炉の近くで熟した作物は放射能で巨大化して収穫数 +1
    const reactors = this.buildings.filter((b) => b.type === 'fusion');
    const rr = 2 + (this.has('leadsuit') ? 2 : 0);
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const c = this.tiles[y][x].crop;
        if (!c || c.ripe) continue;
        c.t += dt * this.growthMult(x, y, c.kind);
        if (c.t >= CROPS[c.kind].grow) {
          c.ripe = true;
          if (reactors.some((b) => Math.abs(b.x - x) <= rr && Math.abs(b.y - y) <= rr)) c.mut = true;
          this.burst(center(x), center(y), c.mut ? '#7dff5a' : '#fff8', 3);
        }
      }
    }
  }

  // 自動収穫機: 半径2マスの熟した作物を1つずつ収穫して、同じ作物を植え直す
  harvesterTick(b) {
    if (!this.powered || b.cd > 0) return;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = b.x + dx, y = b.y + dy;
        const t = this.tiles[y]?.[x];
        if (!t || !t.crop || !t.crop.ripe) continue;
        const kind = this.harvestTile(x, y);
        t.crop = { kind, t: 0, ripe: false };
        b.cd = 0.5;
        b.anim += 1;
        return;
      }
    }
  }

  // Fallout 風の補給物資。畑の外にときどき落ちてきて、拾うと中身が手に入る
  updateCrates(dt) {
    this.crateTimer -= dt * (this.has('scavenger') ? 2 : 1);
    if (this.crateTimer <= 0) {
      this.crateTimer = rand(35, 55);
      for (let tries = 0; tries < 30; tries++) {
        const x = Math.floor(rand(1, COLS - 1)), y = Math.floor(rand(1, ROWS - 1));
        if (this.inFarm(x, y) || this.bAt[y][x] || this.crates.some((c) => c.x === x && c.y === y)) continue;
        this.crates.push({ x, y, life: 40 });
        this.say('補給物資が落ちてきた！');
        this.sfx('crate');
        break;
      }
    }
    for (const c of this.crates) {
      c.life -= dt;
      const p = this.players.find((pl) => Math.hypot(pl.x - center(c.x), pl.y - center(c.y)) < TILE * 0.7);
      if (p) { this.openCrate(c, p); c.life = 0; }
    }
    this.crates = this.crates.filter((c) => c.life > 0);
  }

  openCrate(c, p) {
    const s = rollSupply(Math.random, this.crops);
    const cx = center(c.x), cy = center(c.y);
    let text;
    if (s.kind === 'coins') { this.coins += s.amount; text = `+${s.amount} コイン`; }
    else if (s.kind === 'food') {
      for (let i = 0; i < s.amount; i++) {
        if (p.inv.length < this.invCap) p.inv.push(s.crop); else this.spawnItem(s.crop, cx, cy);
      }
      text = `${CROPS[s.crop].name} ×${s.amount}`;
    } else if (s.kind === 'power') { this.power = Math.min(this.powerCap(), this.power + s.amount); text = `電池 +${s.amount}⚡`; }
    else {
      const free = CHARM_KEYS.filter((k) => !this.has(k));
      if (this.charms.length < this.charmSlots && free.length) {
        const k = pick(free);
        this.addCharm(k);
        text = `お守り「${CHARMS[k].name}」`;
      } else { this.coins += 40; text = '+40 コイン'; }
    }
    this.floater(cx, cy - 10, text, '#ffe066');
    this.say(`補給物資: ${text}`);
    this.burst(cx, cy, '#c9a227', 10);
    this.sfx('select');
  }

  // ---- カラスの襲来（前日に予告される） ------------------------------------

  scaredAt(x, y) {
    return this.buildings.some((b) => b.type === 'kakashi' && Math.abs(b.x - x) <= 2 && Math.abs(b.y - y) <= 2);
  }

  crowTarget() {
    const spots = [];
    this.tiles.forEach((row, y) => row.forEach((t, x) => {
      if (t.crop && !this.scaredAt(x, y) && !this.crows.some((c) => c.tx === x && c.ty === y)) spots.push({ x, y });
    }));
    return spots.length ? pick(spots) : null;
  }

  spawnCrows() {
    const n = Math.min(10, 3 + this.quotaIndex);
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5;
      this.crows.push({
        x: side ? (Math.random() < 0.5 ? -20 : W + 20) : rand(0, W), y: side ? rand(0, H) : -20,
        tx: null, ty: null, state: 'seek', t: 0, eaten: 0, flap: Math.random() * 6,
      });
    }
    this.say(`カラスの群れ（${n}羽）が来た！ 近づくと追い払える。`);
    this.sfx('crow');
  }

  updateCrows(dt) {
    for (const c of this.crows) {
      c.flap += dt * 14;
      if (c.state === 'seek') {
        const t = this.crowTarget();
        if (!t) { c.state = 'leave'; continue; }
        c.tx = t.x; c.ty = t.y; c.state = 'fly';
      }
      if (c.state === 'leave') {
        const ex = c.x < W / 2 ? -40 : W + 40;
        c.x += Math.sign(ex - c.x) * 220 * dt; c.y -= 120 * dt;
        if (c.x < -30 || c.x > W + 30 || c.y < -30) c.gone = true;
        continue;
      }
      // 人が近づくと逃げる。かかしの範囲に入った作物はあきらめる
      if (this.players.some((p) => Math.hypot(p.x - c.x, p.y - c.y) < TILE * 1.4)) {
        c.state = 'leave'; this.floater(c.x, c.y - 16, 'カァ！', '#ddd'); this.sfx('crow'); continue;
      }
      const crop = this.tiles[c.ty]?.[c.tx]?.crop;
      if (!crop || this.scaredAt(c.tx, c.ty)) { c.state = 'seek'; continue; }
      const gx = center(c.tx), gy = center(c.ty);
      if (c.state === 'fly') {
        const d = Math.hypot(gx - c.x, gy - c.y);
        if (d < 4) { c.state = 'peck'; c.t = (this.has('scarecrow') ? 2 : 1) * 3; }
        else { const s = Math.min(d, 140 * dt); c.x += (gx - c.x) / d * s; c.y += (gy - c.y) / d * s; }
      } else if (c.state === 'peck') {
        c.t -= dt;
        if (c.t <= 0) {
          this.tiles[c.ty][c.tx].crop = null;
          this.burst(gx, gy, CROPS[crop.kind].color, 6);
          this.floater(gx, gy - 10, '食べられた', '#ff8080');
          this.sfx('hit');
          c.eaten++;
          c.state = c.eaten >= 2 ? 'leave' : 'seek';
        }
      }
    }
    this.crows = this.crows.filter((c) => !c.gone);
  }

  updateBuildings(dt) {
    for (const b of this.buildings) {
      b.cd -= dt;
      if (b.type === 'fan') this.fanPush(b, dt);
      if (b.type === 'collector') this.collectorTick(b, dt);
      if (b.type === 'harvester') this.harvesterTick(b);
      if (b.type === 'drone' && !this.drones.some((d) => d.station === b)) {
        this.drones.push({ station: b, x: center(b.x), y: center(b.y), carry: [], target: null, dest: null, bob: Math.random() * 6 });
      }
      if (b.type === 'belt' || b.type === 'pipe') { if (this.powered) b.anim += dt * CONVEYORS[b.type]; }
      if (b.type === 'fan' || b.type === 'fusion') b.anim += dt;
    }
  }

  fanPush(b, dt) {
    const d = DIRS[b.dir];
    const reach = [];
    for (let i = 1; i <= 5; i++) {
      const x = b.x + d.x * i, y = b.y + d.y * i;
      if (!this.inBounds(x, y)) break;
      const o = this.bAt[y][x];
      if (o && BLOCKS_ITEM.has(o.type)) break;
      reach.push(`${x},${y}`);
    }
    for (const it of this.items) {
      if (it.dead || it.state !== 'ground') continue;
      if (!reach.includes(`${tileOf(it.x)},${tileOf(it.y)}`)) continue;
      it.vx += d.x * 420 * dt; it.vy += d.y * 420 * dt;
      // 風の軸に寄せる
      if (d.x) it.vy += (center(b.y) - it.y) * 3 * dt; else it.vx += (center(b.x) - it.x) * 3 * dt;
      const sp = Math.hypot(it.vx, it.vy);
      if (sp > 170) { it.vx *= 170 / sp; it.vy *= 170 / sp; }
    }
    if (Math.random() < dt * 6) {
      this.particles.push({ x: center(b.x) + d.x * 14, y: center(b.y) + d.y * 14, vx: d.x * 160, vy: d.y * 160, life: 0.5, color: '#ffffff66', size: 2 });
    }
  }

  collectorTick(b, dt) {
    const cx = center(b.x), cy = center(b.y);
    if (this.powered) {
      for (const it of this.items) {
        if (it.dead || it.state !== 'ground' || b.store.length >= 30) continue;
        const d = Math.hypot(it.x - cx, it.y - cy);
        if (d < TILE * 3.2) { it.state = 'suck'; it.target = b; }
      }
    }
    if (b.cd <= 0 && b.store.length && this.powered) {
      b.cd = 0.35;
      const d = DIRS[b.dir];
      const ox = b.x + d.x, oy = b.y + d.y;
      if (!this.inBounds(ox, oy)) return;
      const o = this.bAt[oy][ox];
      if (o && o.type === 'box') { this.deliver(b.store.pop(), center(ox), center(oy)); return; }
      if (o && BLOCKS_ITEM.has(o.type)) return;
      if (this.items.some((it) => !it.dead && it.state === 'ground' && tileOf(it.x) === ox && tileOf(it.y) === oy && Math.hypot(it.x - center(ox), it.y - center(oy)) < 14)) return;
      const it = this.spawnItem(b.store.pop(), center(ox) - d.x * 12, center(oy) - d.y * 12, { vx: d.x * 60, vy: d.y * 60, noSuck: 1 });
      it.lastTile = `${ox},${oy}`;
    }
  }

  updateItems(dt) {
    const storm = this.weather.phase === 'active' && this.weather.kind === 'storm';
    const rotAt = this.rotTime();
    for (const it of this.items) {
      if (it.dead) continue;
      it.age += dt;
      if (it.age >= rotAt && it.crop !== 'rotten' && it.state !== 'carried') {
        it.crop = 'rotten';
        this.burst(it.x, it.y, '#9b7bb5', 4);
      }
      it.cd = Math.max(0, it.cd - dt);
      if (it.noSuck) it.noSuck = Math.max(0, it.noSuck - dt);
      if (it.state === 'orbit' || it.state === 'carried') continue;
      if (it.state === 'suck') {
        const b = it.target;
        if (!this.buildings.includes(b)) { it.state = 'ground'; continue; }
        const tx = center(b.x), ty = center(b.y);
        const d = Math.hypot(tx - it.x, ty - it.y);
        if (d < 8) { b.store.push(it.crop); this.removeItem(it); continue; }
        it.x += (tx - it.x) / d * 200 * dt; it.y += (ty - it.y) / d * 200 * dt;
        continue;
      }
      const tx = tileOf(it.x), ty = tileOf(it.y);
      const here = this.inBounds(tx, ty) ? this.bAt[ty][tx] : null;
      let onConveyor = false;
      if (here && CONVEYORS[here.type] && this.powered) {
        const d = DIRS[here.dir];
        const sp = CONVEYORS[here.type] * TILE;
        it.vx = d.x * sp; it.vy = d.y * sp;
        if (d.x) it.y += (center(ty) - it.y) * Math.min(1, 10 * dt); else it.x += (center(tx) - it.x) * Math.min(1, 10 * dt);
        onConveyor = true;
      } else if (here && CONVEYORS[here.type]) {
        it.vx = 0; it.vy = 0;
      } else {
        const f = Math.max(0, 1 - 3.5 * dt);
        it.vx *= f; it.vy *= f;
      }
      it.onConveyor = onConveyor;
      if (storm && !onConveyor) { it.vx += this.weather.wind.x * 160 * dt; it.vy += this.weather.wind.y * 160 * dt; }
      // 移動と衝突
      let nx = it.x + it.vx * dt, ny = it.y + it.vy * dt;
      if (this.itemBlocked(nx, it.y)) { nx = it.x; it.vx = 0; }
      if (this.itemBlocked(nx, ny)) { ny = it.y; it.vy = 0; }
      it.x = clamp(nx, 6, W - 6); it.y = clamp(ny, 6, H - 6);
      const key = `${tileOf(it.x)},${tileOf(it.y)}`;
      if (key !== it.lastTile) {
        it.lastTile = key;
        this.itemEnter(it);
      }
    }
    this.items = this.items.filter((it) => !it.dead);
  }

  itemBlocked(x, y) {
    const tx = tileOf(x), ty = tileOf(y);
    if (!this.inBounds(tx, ty)) return true;
    const b = this.bAt[ty][tx];
    return !!(b && BLOCKS_ITEM.has(b.type));
  }

  itemEnter(it) {
    const tx = tileOf(it.x), ty = tileOf(it.y);
    const b = this.bAt[ty]?.[tx];
    if (!b) return;
    const cx = center(tx), cy = center(ty);
    switch (b.type) {
      case 'box': this.deliver(it.crop, cx, cy); this.removeItem(it); break;
      case 'biomass': b.fuel += this.fuelOf(it.crop); this.removeItem(it); this.burst(cx, cy, '#ff9a3c', 4); break;
      case 'wireless':
        if (this.power >= 2) {
          this.power -= 2;
          const box = this.nearest('box', cx, cy);
          this.deliver(it.crop, box ? center(box.x) : cx, box ? center(box.y) : cy);
          this.removeItem(it);
          this.burst(cx, cy, '#7fd4ff', 6);
        }
        break;
      case 'board':
        if (!it.cut) {
          it.cut = true;
          this.spawnItem(it.crop, it.x, it.y, { vx: it.vx, vy: it.vy, cut: true, lastTile: it.lastTile });
          this.sfx('cut');
        }
        break;
      case 'collector':
        if (!it.noSuck && b.store.length < 30) { b.store.push(it.crop); this.removeItem(it); }
        break;
      case 'warp':
        if (b.pair && it.cd <= 0) {
          it.x = center(b.pair.x); it.y = center(b.pair.y);
          it.cd = 0.6;
          it.lastTile = `${b.pair.x},${b.pair.y}`;
          this.burst(it.x, it.y, '#b48cff', 5);
        }
        break;
      default: break;
    }
  }

  updateDrones(dt) {
    for (const d of this.drones) {
      d.bob += dt * 6;
      const speed = TILE * (this.powered ? 3.6 : 1.2);
      if (!d.dest) {
        if (d.carry.length >= DRONE_CAP) d.dest = this.droneDest(d);
        else {
          if (!d.target || d.target.dead || d.target.state !== 'ground') d.target = this.droneTarget(d);
          if (d.target) {
            if (this.flyTo(d, d.target.x, d.target.y, speed, dt)) {
              d.carry.push(d.target.crop);
              this.removeItem(d.target);
              d.target = null;
            }
          } else if (d.carry.length) d.dest = this.droneDest(d);
          else this.flyTo(d, center(d.station.x), center(d.station.y) - 10, speed, dt);
        }
      }
      if (d.dest) {
        if (!this.buildings.includes(d.dest)) { d.dest = null; continue; }
        if (this.flyTo(d, center(d.dest.x), center(d.dest.y), speed, dt)) {
          const dest = d.dest;
          // ガンビットでは行き先に合う作物だけ降ろし、残りは次の行き先へ運ぶ
          const keep = [];
          for (const c of d.carry) {
            if (this.droneMode === 'gambit' && d.carry.length && this.droneDestFor(c, d) !== dest) { keep.push(c); continue; }
            if (dest.type === 'box') this.deliver(c, center(dest.x), center(dest.y));
            else if (dest.type === 'biomass') dest.fuel += this.fuelOf(c);
            else if (dest.type === 'collector') dest.store.push(c);
          }
          d.carry = keep;
          d.dest = keep.length ? this.droneDest(d) : null;
        }
      }
    }
  }

  droneTarget(d) {
    const taken = new Set(this.drones.filter((o) => o !== d && o.target).map((o) => o.target));
    let best = null, bd = Infinity;
    for (const it of this.items) {
      if (it.dead || it.state !== 'ground' || it.onConveyor || taken.has(it)) continue;
      const dist = (it.x - d.x) ** 2 + (it.y - d.y) ** 2;
      if (dist < bd) { bd = dist; best = it; }
    }
    return best;
  }

  droneDest(d) {
    if (this.droneMode === 'gambit') return this.droneDestFor(d.carry[0], d);
    const type = this.droneMode === 'burn' ? 'biomass' : this.droneMode === 'store' ? 'collector' : 'box';
    return this.nearest(type, d.x, d.y) || this.nearest('box', d.x, d.y);
  }

  // ガンビット: 上から順に条件を調べて、最初に当てはまった行動の行き先を返す
  gambitAction(crop) {
    for (const g of this.gambits) {
      const ok = g.if === 'any'
        || (g.if === 'rotten' && crop === 'rotten')
        || (g.if === 'quota' && crop === this.quota.crop)
        || (g.if === 'seasonal' && crop === this.seasonal)
        || (g.if === 'lowpower' && this.tech.energy > 0 && this.power < this.powerCap() * 0.3);
      if (ok) return g.then;
    }
    return 'deliver';
  }

  droneDestFor(crop, d) {
    const act = this.gambitAction(crop);
    const type = act === 'burn' ? 'biomass' : act === 'store' ? 'collector' : 'box';
    return this.nearest(type, d.x, d.y) || this.nearest('box', d.x, d.y);
  }

  flyTo(d, tx, ty, speed, dt) {
    const dist = Math.hypot(tx - d.x, ty - d.y);
    if (dist < 6) return true;
    const s = Math.min(dist, speed * dt);
    d.x += (tx - d.x) / dist * s;
    d.y += (ty - d.y) / dist * s;
    return false;
  }

  updateWeather(dt) {
    const w = this.weather;
    w.flash = Math.max(0, w.flash - dt);
    w.timer -= dt;
    if (w.phase === 'clear' && w.timer <= 0) {
      const r = this.farmRect();
      w.kind = Math.random() < 0.6 ? 'hail' : 'storm';
      w.cx = rand(r.x, r.x + r.w); w.cy = rand(r.y, r.y + r.h);
      w.r = 2.5 + Math.min(3, this.quotaIndex * 0.3);
      const a = pick(DIRS); w.wind = { x: a.x, y: a.y };
      w.phase = 'warning'; w.timer = 5;
      this.say(w.kind === 'hail' ? '雹の予報。パイロンで守るか、急いで収穫を。' : '嵐が近づいています。地面の作物が流されます。');
      this.sfx('warn');
    } else if (w.phase === 'warning' && w.timer <= 0) {
      w.phase = 'active'; w.timer = w.kind === 'hail' ? 8 : 10; w.tick = 0;
    } else if (w.phase === 'active') {
      w.tick -= dt;
      if (w.kind === 'hail' && Math.random() < dt * 30) {
        const a = rand(0, Math.PI * 2), rr = Math.sqrt(Math.random()) * w.r;
        this.hail.push({ x: (w.cx + Math.cos(a) * rr) * TILE, y: (w.cy + Math.sin(a) * rr) * TILE, h: 120, life: 1 });
      }
      if (w.kind === 'storm' && Math.random() < dt * 0.6) w.flash = 0.15;
      if (w.tick <= 0) {
        w.tick = 1;
        this.damageCrops();
      }
      if (w.timer <= 0) { w.phase = 'clear'; w.timer = rand(22, 40) * (this.bossIs('monsoon') ? 0.5 : 1); this.say('天候が回復しました。'); }
    }
    for (const h of this.hail) { h.h -= dt * 400; if (h.h <= 0) h.life -= dt * 3; }
    this.hail = this.hail.filter((h) => h.life > 0);
  }

  damageCrops() {
    const w = this.weather;
    let lost = 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = this.tiles[y][x];
        if (!t.crop) continue;
        const inArea = w.kind === 'storm' || (x + 0.5 - w.cx) ** 2 + (y + 0.5 - w.cy) ** 2 <= w.r * w.r;
        if (!inArea) continue;
        if (this.isProtected(x, y)) continue;
        // 嵐はノルマが進むほど強くなる（最初は弱い）
        const chance = (w.kind === 'hail' ? 0.3 : Math.min(0.06, 0.02 + 0.008 * this.quotaIndex)) * this.weatherDamageMult();
        if (Math.random() < chance) {
          this.burst(center(x), center(y), CROPS[t.crop.kind].color, 5);
          t.crop = null;
          lost++;
        }
      }
    }
    if (lost) { this.sfx('hit'); this.floater(w.cx * TILE, w.cy * TILE, `作物 -${lost}`, '#ff8080'); }
  }

  updateCombo(dt) {
    if (this.combo > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        if (this.combo >= 3) this.say(`コンボ ${this.combo} で途切れました`);
        this.combo = 0;
        setCombo(0);
      }
    }
  }

  updateEffects(dt) {
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt; p.life -= dt; }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const f of this.floaters) { f.y -= 30 * dt; f.life -= dt; }
    if (this.banner) this.banner.life -= dt;
    if (this.calcPop) this.calcPop.life -= dt;
    this.floaters = this.floaters.filter((f) => f.life > 0);
  }

  checkQuota() {
    const q = this.quota;
    if (q.have >= q.need) {
      this.endOfDay();
      const bonus = Math.round(this.quotaRemaining() * 0.5);
      this.coins += bonus;
      this.quotasCleared++;
      for (const p of this.players) { p.maxHunger += p.sick; p.sick = 0; }
      this.say(`ノルマ達成！ 残り時間ボーナス +${bonus} コイン`);
      if (q.boss) {
        this.coins += 40;
        this.rerollCost = 0;
        this.say(`ボス「${BOSSES[q.boss].name}」を突破！ +40 コイン、市場の品替え1回無料`);
      }
      this.sfx('quota');
      this.state = 'upgrade';
      this.upgradeOffers = this.makeOffers();
      return;
    }
    if (this.t >= q.end) {
      this.state = 'over';
      this.say('ノルマ未達。ラン終了。');
      this.sfx('fail');
    }
  }

  // ---- アップグレード（ノルマ達成時に3択） ---------------------------------

  makeOffers() {
    const offers = [];
    const tech = (key, label) => {
      const next = this.tech[key] + 1;
      const names = TECH[key];
      const idx = key === 'energy' ? next : next - 1;
      if (idx >= names.length) return;
      if (key === 'transport' && next >= 3 && this.tech.energy < 1) return;
      offers.push({ id: key, weight: 3, title: `${label}: ${names[idx]}`, desc: techDesc(key, next), apply: () => { this.tech[key] = next; } });
    };
    tech('collect', '回収');
    tech('transport', '輸送');
    tech('deliver', '納品');
    tech('energy', 'エネルギー');
    if (this.tech.farm < FARM_TIERS.length - 1) {
      const f = FARM_TIERS[this.tech.farm + 1];
      offers.push({ id: 'farm', weight: 3, title: `農地拡張: ${f.name}`, desc: `耕せる範囲が ${f.w}×${f.h} マスに広がる`, apply: () => { this.tech.farm++; } });
    }
    const locked = CROP_ORDER.filter((c) => !this.crops.includes(c));
    if (locked.length) {
      const c = locked[0];
      offers.push({ id: 'crop', weight: 2, title: `新しい作物: ${CROPS[c].name}`, desc: `成長${CROPS[c].grow}秒・空腹回復${CROPS[c].food}・燃料${CROPS[c].fuel}・価値${CROPS[c].value}`, apply: () => { this.crops.push(c); } });
    }
    if (!this.unlocks.pylon && this.quotaIndex >= 0) offers.push({ id: 'pylon', weight: 2, title: '天候防御パイロン', desc: '範囲内の雹や嵐を無効化する設置物を解放', apply: () => { this.unlocks.pylon = true; } });
    if (!this.unlocks.board) offers.push({ id: 'board', weight: 1, title: 'まな板', desc: '作物を2倍にする加工台を解放', apply: () => { this.unlocks.board = true; } });
    if (!this.unlocks.sprinkler && this.quotaIndex >= 1) offers.push({ id: 'sprinkler', weight: 2, title: 'スプリンクラー', desc: '半径2マスの作物の成長を1.4倍にする設置物を解放（電力を使う）', apply: () => { this.unlocks.sprinkler = true; } });
    if (!this.unlocks.harvester && this.quotaIndex >= 3) offers.push({ id: 'harvester', weight: 3, title: '自動収穫機', desc: '半径2マスの作物を収穫して植え直す機械を解放（電力を使う）', apply: () => { this.unlocks.harvester = true; } });
    if (this.charmSlots < 6) offers.push({ id: 'charmslot', weight: 1, title: 'お守りの枠 +1', desc: `持てるお守りが ${this.charmSlots + 1} 個になる`, apply: () => { this.charmSlots++; } });
    if (!this.unlocks.warp && this.quotaIndex >= 2) offers.push({ id: 'warp', weight: 1, title: 'ワープゲート', desc: '2点間を瞬間移動するゲートを解放', apply: () => { this.unlocks.warp = true; } });
    const sc = pick(this.crops);
    const slot = Math.random() < 0.5
      ? { type: 'growth', crop: sc, mult: 1.5, label: `${CROPS[sc].name}の成長速度 +50%` }
      : { type: 'deliver', crop: sc, mult: 1.5, label: `${CROPS[sc].name}の納品量 +50%` };
    offers.push({ id: 'slot', weight: 2, title: `倍率スロット`, desc: slot.label, apply: () => { this.slots.push(slot); } });
    offers.push({ id: 'stomach', weight: 1, title: '胃袋拡張', desc: '最大空腹度 +25、全員の空腹度を全回復', apply: () => { this.maxHunger += 25; for (const p of this.players) { p.maxHunger += 25; p.hunger = p.maxHunger; } } });
    offers.push({ id: 'bag', weight: 1, title: '大きなカゴ', desc: '手持ちの上限 +6', apply: () => { this.invCap += 6; } });
    offers.push({ id: 'coins', weight: 1, title: '臨時収入', desc: '+80 コイン', apply: () => { this.coins += 80; } });
    offers.push({ id: 'combo', weight: 1, title: 'リズムキープ', desc: 'コンボの猶予 +1.5秒', apply: () => { this.comboWindow += 1.5; } });

    // 重み付きで3つ選ぶ。エネルギーが無い序盤は必ず候補に入れる
    const chosen = [];
    const energy = offers.find((o) => o.id === 'energy');
    if (this.tech.energy === 0 && energy) chosen.push(energy);
    const pool = offers.filter((o) => !chosen.includes(o));
    while (chosen.length < 3 && pool.length) {
      const total = pool.reduce((s, o) => s + o.weight, 0);
      let r = Math.random() * total;
      const i = pool.findIndex((o) => (r -= o.weight) <= 0);
      chosen.push(pool.splice(i < 0 ? 0 : i, 1)[0]);
    }
    return chosen;
  }

  chooseUpgrade(i) {
    if (this.state !== 'upgrade') return;
    const o = this.upgradeOffers[i];
    if (!o) return;
    o.apply();
    this.say(`アップグレード: ${o.title}`);
    this.sfx('build');
    // Balatro 風: アップグレードの後は市場でお守りを買える
    this.state = 'shop';
    this.rollShop();
  }

  // ---- 市場とお守り（Balatro） ----------------------------------------------

  charmPrice(k) {
    const c = CHARMS[k].cost * (this.pactOn('inflation') ? 1.3 : 1);
    return Math.ceil(this.discount ? c / 2 : c);
  }

  rollShop() {
    const pool = CHARM_KEYS.filter((k) => !this.has(k));
    this.shopOffers = [];
    while (this.shopOffers.length < 3 && pool.length) this.shopOffers.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }

  rerollShop() {
    if (this.state !== 'shop' || this.coins < this.rerollCost) return false;
    this.coins -= this.rerollCost;
    this.rerollCost = Math.max(5, this.rerollCost + 2);
    this.rollShop();
    this.sfx('select');
    return true;
  }

  addCharm(k) {
    this.charms.push(k);
    if (k === 'metronome') this.comboWindow += 3;
  }

  buyCharm(i) {
    const k = this.shopOffers[i];
    if (this.state !== 'shop' || !k || this.charms.length >= this.charmSlots) return false;
    const price = this.charmPrice(k);
    if (this.coins < price) return false;
    this.coins -= price;
    this.addCharm(k);
    this.shopOffers.splice(i, 1);
    this.say(`お守り「${CHARMS[k].name}」を買った`);
    this.sfx('deliver');
    return true;
  }

  sellCharm(k) {
    const i = this.charms.indexOf(k);
    if (i < 0) return false;
    this.charms.splice(i, 1);
    if (k === 'metronome') this.comboWindow -= 3;
    this.coins += Math.floor(CHARMS[k].cost / 2);
    this.sfx('till');
    return true;
  }

  leaveShop() {
    if (this.state !== 'shop') return;
    this.discount = false;
    this.rerollCost = 5;
    this.quotaIndex++;
    this.state = 'playing';
    this.startQuota();
  }

  giveUp() {
    if (this.state !== 'playing') return;
    this.state = 'over';
    this.say('ランを放棄しました。');
  }

  pactBonus() { return this.pacts.reduce((s, k) => s + PACTS[k].bonus, 0); }

  // 縛りを付けた分だけ持ち帰る種籾が増える
  metaReward() {
    const base = this.quotasCleared * 2 + Math.floor(this.totalDelivered / 15) + 1;
    return Math.round(base * (1 + this.pactBonus()));
  }

  // ---- オンライン同期（ホストの状態をゲストへ配る） ------------------------

  serialize() {
    const r1 = (v) => Math.round(v * 10) / 10;
    const tiles = [];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = this.tiles[y][x];
        let v = (t.soil ? 1 : 0) | (t.flower ? 2 : 0);
        if (t.crop) {
          v |= (SYNC_CROPS.indexOf(t.crop.kind) + 1) << 2;
          v |= (t.crop.ripe ? 1 : 0) << 6;
          v |= (t.crop.mut ? 1 : 0) << 7;
          v |= Math.min(15, Math.floor((t.crop.t / CROPS[t.crop.kind].grow) * 16)) << 8;
        }
        tiles.push(v);
      }
    }
    const events = this.netEvents.splice(0);
    return {
      t: r1(this.t), state: this.state, quotaIndex: this.quotaIndex, quotasCleared: this.quotasCleared,
      totalDelivered: this.totalDelivered, totalCoins: this.totalCoins, bestCombo: this.bestCombo,
      quota: { ...this.quota, have: r1(this.quota.have) }, coins: this.coins, power: r1(this.power),
      powered: this.powered, pylonPowered: this.pylonPowered, combo: this.combo, comboTimer: r1(this.comboTimer),
      comboWindow: this.comboWindow, tech: this.tech, unlocks: this.unlocks, crops: this.crops, slots: this.slots,
      invCap: this.invCap, droneMode: this.droneMode,
      trait: this.trait, pacts: this.pacts, charms: this.charms, charmSlots: this.charmSlots, boardCharges: this.boardCharges,
      oracle: this.oracle, banner: this.banner, discount: this.discount, dayIdx: this.dayIdx, shopOffers: this.shopOffers,
      rerollCost: this.rerollCost, seasonal: this.seasonal, crowsTomorrow: this.crowsTomorrow, calcPop: this.calcPop,
      crates: this.crates.map((c) => [c.x, c.y, r1(c.life)]),
      crows: this.crows.map((c) => [Math.round(c.x), Math.round(c.y), c.state, r1(c.flap || 0), c.tx ?? null]),
      weather: { phase: this.weather.phase, kind: this.weather.kind, timer: r1(this.weather.timer), cx: r1(this.weather.cx), cy: r1(this.weather.cy), r: this.weather.r, wind: this.weather.wind, flash: r1(this.weather.flash) },
      tiles,
      buildings: this.buildings.map((b) => [b.id, b.type, b.x, b.y, b.dir, b.store.length, (b.fuel > 0 || b.burn > 0) ? 1 : 0, b.pair ? b.pair.id : 0, r1(b.anim)]),
      items: this.items.map((it) => [it.id, SYNC_CROPS.indexOf(it.crop), Math.round(it.x), Math.round(it.y), it.state === 'ground' ? 0 : 1, it.cut ? 1 : 0, it.onConveyor ? 1 : 0, Math.round(it.age || 0)]),
      drones: this.drones.map((d) => [Math.round(d.x), Math.round(d.y), d.carry.length ? SYNC_CROPS.indexOf(d.carry[0]) : -1]),
      players: this.players.map((p) => ({ id: p.id, name: p.name, netId: p.netId, away: p.away, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, hunger: r1(p.hunger), maxHunger: p.maxHunger, sick: p.sick, inv: p.inv, moving: p.moving, seed: p.seed })),
      hail: this.hail.map((h) => [Math.round(h.x), Math.round(h.y), Math.round(h.h), r1(h.life)]),
      floaters: this.floaters.filter((f) => !f.net).map((f) => [Math.round(f.x), Math.round(f.y), f.text, f.color, r1(f.life)]),
      offers: this.state === 'upgrade' ? this.upgradeOffers.map((o) => ({ id: o.id, title: o.title, desc: o.desc })) : null,
      events,
    };
  }

  applySnapshot(s) {
    for (const k of ['t', 'state', 'quotaIndex', 'quotasCleared', 'totalDelivered', 'totalCoins', 'bestCombo', 'quota', 'coins', 'power', 'powered', 'pylonPowered', 'combo', 'comboTimer', 'comboWindow', 'tech', 'unlocks', 'crops', 'slots', 'invCap', 'droneMode', 'weather',
      'trait', 'pacts', 'charms', 'charmSlots', 'boardCharges', 'oracle', 'banner', 'discount', 'dayIdx', 'shopOffers',
      'rerollCost', 'seasonal', 'crowsTomorrow', 'calcPop']) this[k] = s[k];
    this.crates = s.crates.map(([x, y, life]) => ({ x, y, life }));
    const oldC = this.crows;
    this.crows = s.crows.map(([x, y, state, flap, tx], i) => {
      const c = oldC[i] || { x, y };
      Object.assign(c, { tx: tx, ty: c.ty, gx: x, gy: y, state, flap });
      return c;
    });
    s.tiles.forEach((v, i) => {
      const t = this.tiles[Math.floor(i / COLS)][i % COLS];
      t.soil = !!(v & 1); t.flower = !!(v & 2);
      const ci = (v >> 2) & 15;
      if (ci) {
        const kind = SYNC_CROPS[ci - 1];
        t.crop = { kind, ripe: !!((v >> 6) & 1), mut: !!((v >> 7) & 1), t: (((v >> 8) & 15) / 16) * CROPS[kind].grow };
      } else t.crop = null;
    });
    const oldB = new Map(this.buildings.map((b) => [b.id, b]));
    this.bAt = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.buildings = s.buildings.map(([id, type, x, y, dir, store, fire, pair, anim]) => {
      const b = oldB.get(id) || { id };
      Object.assign(b, { type, x, y, dir, store: new Array(store), fuel: fire, burn: 0, pairId: pair, anim });
      this.bAt[y][x] = b;
      return b;
    });
    const byId = new Map(this.buildings.map((b) => [b.id, b]));
    for (const b of this.buildings) b.pair = b.pairId ? byId.get(b.pairId) : null;
    const oldI = new Map(this.items.map((it) => [it.id, it]));
    this.items = s.items.map(([id, ci, x, y, st, cut, conv, age]) => {
      const it = oldI.get(id) || { id, x, y, age };
      if (Math.abs(it.age - age) > 1.5) it.age = age;
      Object.assign(it, { crop: SYNC_CROPS[ci], tx: x, ty: y, state: st === 0 ? 'ground' : 'orbit', cut: !!cut, onConveyor: !!conv });
      return it;
    });
    const oldD = this.drones;
    this.drones = s.drones.map(([x, y, c], i) => {
      const d = oldD[i] || { x, y, bob: 0 };
      Object.assign(d, { tx: x, ty: y, carry: c >= 0 ? [SYNC_CROPS[c]] : [] });
      return d;
    });
    s.players.forEach((sp) => {
      let p = this.players[sp.id];
      if (!p) { p = { ...sp, anim: 0, input: { up: false, down: false, left: false, right: false } }; this.players[sp.id] = p; }
      const { x, y, ...rest } = sp;
      Object.assign(p, rest, { tx: x, ty: y });
      if (p.x === undefined || Math.hypot(p.x - x, p.y - y) > TILE * 3) { p.x = x; p.y = y; }
    });
    this.players.length = s.players.length;
    this.hail = s.hail.map(([x, y, h, life]) => ({ x, y, h, life }));
    this.floaters = s.floaters.map(([x, y, text, color, life]) => ({ x, y, text, color, life, net: true }));
    this.upgradeOffers = s.offers;
    for (const e of s.events || []) playSfx(e);
    setCombo(this.combo);
  }

  // ゲスト側: スナップショット間を補間して滑らかに見せる
  smooth(dt) {
    const k = Math.min(1, dt * 14);
    const lerp = (o) => { if (o.tx !== undefined) { o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k; } };
    for (const p of this.players) { lerp(p); if (p.moving) p.anim += dt * 10; }
    for (const it of this.items) { lerp(it); it.age += dt; }
    for (const d of this.drones) { lerp(d); d.bob += dt * 6; }
    for (const c of this.crows) { if (c.gx !== undefined) { c.x += (c.gx - c.x) * k; c.y += (c.gy - c.y) * k; } c.flap += dt * 12; }
    if (this.banner) this.banner.life -= dt;
    if (this.calcPop) this.calcPop.life -= dt;
    this.t += dt;
    for (const f of this.floaters) { f.y -= 30 * dt; f.life -= dt; }
    for (const h of this.hail) { h.h -= dt * 400; if (h.h <= 0) h.life -= dt * 3; }
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt; p.life -= dt; }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  // ---- 描画 ----------------------------------------------------------------

  render(ctx, view) {
    ctx.imageSmoothingEnabled = false;
    const fr = this.farmRect();
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = this.tiles[y][x];
        const px = x * TILE, py = y * TILE;
        if (t.crop && t.crop.ripe && CROPS[t.crop.kind].field) {
          drawTile(ctx, CROPS[t.crop.kind].field, px, py, TILE);
        } else if (t.soil) {
          drawTile(ctx, 'soil', px, py, TILE);
        } else {
          drawTile(ctx, t.flower ? 'grassFlower' : 'grass', px, py, TILE);
        }
        if (t.crop && !(t.crop.ripe && CROPS[t.crop.kind].field)) {
          if (t.crop.ripe) {
            drawSprite(ctx, itemSpriteKey(t.crop.kind), px + 4, py + 2, TILE - 8, TILE - 8);
          } else {
            drawSprout(ctx, px, py, TILE, t.crop.t / CROPS[t.crop.kind].grow, t.crop.kind);
          }
        }
        if (t.crop && t.crop.mut) {
          ctx.fillStyle = `rgba(125,255,90,${0.18 + 0.08 * Math.sin(this.t * 6 + x)})`;
          ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
        }
        if (t.crop && t.crop.ripe) {
          const s = Math.sin(this.t * 4 + x + y) * 2;
          ctx.fillStyle = '#fff';
          ctx.fillRect(px + TILE - 7, py + 3 + s, 3, 3);
          if (t.crop.kind === this.seasonal) {
            ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
            ctx.fillStyle = '#000a'; ctx.fillText('旬', px + 3, py + 12);
            ctx.fillStyle = '#ffe066'; ctx.fillText('旬', px + 2, py + 11);
          }
        }
      }
    }
    // 農地の境界
    ctx.save();
    ctx.strokeStyle = '#fff6';
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(fr.x * TILE + 1, fr.y * TILE + 1, fr.w * TILE - 2, fr.h * TILE - 2);
    ctx.restore();

    // パイロンの範囲
    for (const b of this.buildings) {
      if (b.type !== 'pylon') continue;
      ctx.fillStyle = this.pylonPowered ? (this.weather.phase === 'active' ? '#7fd4ff33' : '#7fd4ff14') : '#ff505014';
      ctx.beginPath(); ctx.arc(center(b.x), center(b.y), TILE * 3.08, 0, Math.PI * 2); ctx.fill();
    }

    // スプリンクラーと自動収穫機の範囲
    for (const b of this.buildings) {
      if (b.type !== 'sprinkler' && b.type !== 'harvester') continue;
      ctx.fillStyle = !this.powered ? '#ff505010' : b.type === 'sprinkler' ? '#7fd4ff12' : '#ffb74d12';
      ctx.fillRect((b.x - 2) * TILE, (b.y - 2) * TILE, TILE * 5, TILE * 5);
    }

    for (const b of this.buildings) this.drawBuilding(ctx, b);

    // 補給物資
    for (const c of this.crates) {
      const px = c.x * TILE, py = c.y * TILE;
      const blink = c.life < 8 && Math.sin(this.t * 12) > 0;
      if (blink) continue;
      ctx.fillStyle = '#0004'; ctx.fillRect(px + 6, py + 34, 28, 4);
      drawSprite(ctx, 'crate', px + 5, py + 10, 30, 26);
      // パラシュート
      const sway = Math.sin(this.t * 2 + c.x) * 2;
      ctx.fillStyle = '#e8e8e8';
      ctx.beginPath(); ctx.arc(px + 20 + sway, py + 2, 12, Math.PI, 0); ctx.fill();
      ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px + 8 + sway, py + 2); ctx.lineTo(px + 8, py + 12); ctx.moveTo(px + 32 + sway, py + 2); ctx.lineTo(px + 32, py + 12); ctx.stroke();
    }

    // 天候の予告エリア
    const w = this.weather;
    if (w.kind === 'hail' && w.phase !== 'clear') {
      ctx.save();
      ctx.fillStyle = w.phase === 'warning' ? `rgba(255,60,60,${0.12 + 0.1 * Math.sin(this.t * 10)})` : 'rgba(200,220,255,0.18)';
      ctx.beginPath(); ctx.arc(w.cx * TILE, w.cy * TILE, w.r * TILE, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // アイテム
    for (const it of this.items) {
      const bob = it.state === 'ground' && !it.onConveyor ? Math.sin(it.age * 5 + it.id) * 1.5 : 0;
      const s = it.state === 'orbit' ? 20 : 24;
      if (it.state === 'ground') { ctx.fillStyle = '#0003'; ctx.fillRect(it.x - 8, it.y + 7, 16, 3); }
      drawSprite(ctx, itemSpriteKey(it.crop), it.x - s / 2, it.y - s / 2 + bob, s, s);
      // もうすぐ腐る作物は紫に点滅する
      if (it.crop !== 'rotten' && it.age > this.rotTime() - 10 && Math.sin(this.t * 10) > 0) {
        ctx.fillStyle = '#9b7bb588'; ctx.fillRect(it.x - 7, it.y - 7, 14, 14);
      }
      if (it.cut) { ctx.fillStyle = '#9fe870'; ctx.fillRect(it.x + 6, it.y - 10, 3, 3); }
    }

    // プレイヤー
    for (const p of this.players) {
      if (p.away) continue;
      const ft = this.facingTile(p);
      if (this.inBounds(ft.x, ft.y)) {
        ctx.strokeStyle = PLAYER_COLORS[p.id];
        ctx.lineWidth = 2;
        ctx.strokeRect(ft.x * TILE + 2, ft.y * TILE + 2, TILE - 4, TILE - 4);
      }
      ctx.fillStyle = '#0004';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 14, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
      const hop = p.moving ? Math.abs(Math.sin(p.anim)) * 3 : 0;
      ctx.save();
      if (p.dir === 2) { ctx.translate(p.x, 0); ctx.scale(-1, 1); ctx.translate(-p.x, 0); }
      drawSprite(ctx, `player${p.id + 1}`, p.x - 18, p.y - 30 - hop, 36, 44);
      ctx.restore();
      if (this.players.length > 1) {
        ctx.fillStyle = PLAYER_COLORS[p.id];
        ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(p.name, p.x, p.y - 34 - hop);
      }
      if (p.inv.length) {
        // 背負っている作物
        for (let i = 0; i < Math.min(4, p.inv.length); i++) drawSprite(ctx, itemSpriteKey(p.inv[p.inv.length - 1 - i]), p.x + 8 + i * 3, p.y - 26 - i * 5, 14, 14);
      }
    }

    // ドローン
    for (const d of this.drones) {
      const y = d.y - 18 + Math.sin(d.bob) * 3;
      ctx.fillStyle = '#0003'; ctx.fillRect(d.x - 7, d.y + 4, 14, 3);
      ctx.fillStyle = '#5d6673'; ctx.fillRect(d.x - 9, y - 4, 18, 8);
      ctx.fillStyle = '#7fd4ff'; ctx.fillRect(d.x - 3, y - 2, 6, 4);
      ctx.fillStyle = '#cfd6de';
      const rp = Math.sin(this.t * 40) > 0 ? 8 : 4;
      ctx.fillRect(d.x - 12, y - 7, rp, 2); ctx.fillRect(d.x + 12 - rp, y - 7, rp, 2);
      if (d.carry.length) drawSprite(ctx, itemSpriteKey(d.carry[0]), d.x - 6, y + 3, 12, 12);
    }

    // カラス
    for (const c of this.crows) {
      const hop = c.state === 'peck' ? Math.abs(Math.sin(c.flap)) * 3 : Math.sin(c.flap) * 4;
      const fly = c.state !== 'peck';
      if (fly) { ctx.fillStyle = '#0003'; ctx.fillRect(c.x - 8, c.y + 14, 16, 3); }
      ctx.save();
      const left = c.state === 'leave' ? c.x < W / 2 : c.tx != null && center(c.tx) < c.x;
      if (!left) { ctx.translate(c.x, 0); ctx.scale(-1, 1); ctx.translate(-c.x, 0); }
      drawSprite(ctx, 'crow', c.x - 14, c.y - 18 - (fly ? 10 : 0) - hop, 28, 28);
      ctx.restore();
    }

    // 雹と嵐
    for (const h of this.hail) {
      ctx.globalAlpha = Math.max(0, h.life);
      drawSprite(ctx, 'hailstone', h.x - 5, h.y - h.h - 5, 10, 10);
      ctx.globalAlpha = 1;
    }
    if (w.kind === 'storm' && w.phase === 'active') {
      ctx.fillStyle = 'rgba(20,30,50,0.28)'; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = 'rgba(180,200,255,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 80; i++) {
        const x = (i * 97 + this.t * 600 * (1 + w.wind.x * 0.5)) % W;
        const y = (i * 53 + this.t * 700) % H;
        ctx.moveTo(x, y); ctx.lineTo(x + w.wind.x * 10 - 3, y + 14);
      }
      ctx.stroke();
      if (w.flash > 0) { ctx.fillStyle = `rgba(255,255,255,${w.flash * 3})`; ctx.fillRect(0, 0, W, H); }
    } else if (w.kind === 'storm' && w.phase === 'warning') {
      ctx.fillStyle = `rgba(20,30,50,${0.1 + 0.05 * Math.sin(this.t * 8)})`; ctx.fillRect(0, 0, W, H);
    }

    for (const p of this.particles) { ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, p.size, p.size); }
    ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
    for (const f of this.floaters) {
      ctx.globalAlpha = Math.min(1, f.life * 2);
      ctx.fillStyle = '#000a'; ctx.fillText(f.text, f.x + 1, f.y + 1);
      ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;

    // 神託のお告げ
    if (this.banner && this.banner.life > 0) {
      const a = Math.min(1, this.banner.life);
      ctx.globalAlpha = a;
      ctx.fillStyle = this.banner.good ? 'rgba(40,36,10,0.85)' : 'rgba(40,10,10,0.85)';
      ctx.fillRect(W / 2 - 280, 64, 560, 72);
      ctx.strokeStyle = this.banner.good ? '#ffe066' : '#ff7b7b'; ctx.lineWidth = 2;
      ctx.strokeRect(W / 2 - 280, 64, 560, 72);
      // 神託を告げる神さま（祝福）と死神（呪い）
      drawSprite(ctx, this.banner.good ? 'oracle_good' : 'oracle_bad', W / 2 - 274, 68, 64, 64);
      ctx.textAlign = 'center';
      ctx.fillStyle = this.banner.good ? '#ffe066' : '#ff9a9a'; ctx.font = 'bold 20px sans-serif';
      ctx.fillText(this.banner.title, W / 2 + 30, 94);
      ctx.fillStyle = '#fff'; ctx.font = '14px sans-serif';
      ctx.fillText(this.banner.desc, W / 2 + 30, 118);
      ctx.globalAlpha = 1;
    }

    // 納品の計算（Balatro 風の「基本 × 倍率」）
    if (this.calcPop && this.calcPop.life > 0) {
      const c = this.calcPop;
      const a = Math.min(1, c.life * 2);
      const mult = c.base ? c.total / c.base : 0;
      const bw = 250, bh = c.hand ? 70 : 50;
      const bx = clamp(c.x - bw / 2, 4, W - bw - 4), by = clamp(c.y - bh - 20 + (1 - a) * 10, 4, H - bh - 4);
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(20,20,30,0.92)'; ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, bh);
      ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = '#3aa0ff'; ctx.fillRect(bx + 8, by + 8, 70, 26);
      ctx.fillStyle = '#ff4d4d'; ctx.fillRect(bx + 98, by + 8, 70, 26);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${c.base}`, bx + 43, by + 27);
      ctx.fillText('×', bx + 88, by + 27);
      ctx.fillText(`${mult.toFixed(2)}`, bx + 133, by + 27);
      ctx.fillStyle = '#ffe066'; ctx.fillText(`= +${c.total}`, bx + 208, by + 27);
      ctx.font = '11px sans-serif'; ctx.fillStyle = '#ccc';
      ctx.fillText(`${c.n}個  コンボ ×${c.combo.toFixed(2)}${c.rotten ? `  腐り ${c.rotten}個は0` : ''}`, bx + bw / 2, by + 46);
      if (c.hand) { ctx.fillStyle = '#ffd23f'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(`役「${c.hand.name}」 +${c.extra.toFixed(2)}`, bx + bw / 2, by + 62); }
      ctx.globalAlpha = 1;
    }

    // 建築カーソル
    if (view && view.cursor) {
      const { x, y, tool, dir } = view.cursor;
      if (this.inBounds(x, y) && tool) {
        let ok = true;
        if (tool === 'demolish') ok = !!this.bAt[y][x];
        else if (tool === 'move') ok = view.movingBox ? !this.bAt[y][x] : this.bAt[y][x]?.type === 'box';
        else ok = this.canPlace(tool, x, y) && this.coins >= this.buildCost(tool);
        ctx.fillStyle = ok ? '#7fff7f44' : '#ff505055';
        ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
        if (BUILDINGS[tool]) {
          ctx.globalAlpha = 0.6;
          this.drawBuilding(ctx, { type: tool, x, y, dir, anim: 0, store: [], fuel: 0, burn: 0 });
          ctx.globalAlpha = 1;
          if (tool === 'pylon' || tool === 'collector') {
            ctx.strokeStyle = '#fff8'; ctx.beginPath(); ctx.arc(center(x), center(y), TILE * 3.08, 0, Math.PI * 2); ctx.stroke();
          }
          if (tool === 'sprinkler' || tool === 'harvester' || tool === 'kakashi') {
            ctx.strokeStyle = '#fff8'; ctx.strokeRect((x - 2) * TILE, (y - 2) * TILE, TILE * 5, TILE * 5);
          }
        }
      }
    }
  }

  drawBuilding(ctx, b) {
    const px = b.x * TILE, py = b.y * TILE, cx = px + TILE / 2, cy = py + TILE / 2;
    const d = DIRS[b.dir] || DIRS[0];
    const r = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(px + x, py + y, w, h); };
    const arrow = (col) => {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(d.y, d.x));
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-4, -7); ctx.lineTo(-4, 7); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    switch (b.type) {
      case 'box': {
        const tier = Math.min(3, this.tech.deliver);
        drawSprite(ctx, `box${tier}`, px + 2, py + 2, TILE - 4, TILE - 4);
        break;
      }
      case 'terminal':
        r(6, 4, 28, 22, '#222'); r(9, 7, 22, 16, '#0b2'); r(16, 26, 8, 6, '#444'); r(8, 32, 24, 4, '#333');
        ctx.fillStyle = '#0f4'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
        ctx.fillText(Math.sin(this.t * 6) > 0 ? '>_' : '>', px + 11, py + 18);
        break;
      case 'wall': drawTile(ctx, 'wall', px, py, TILE); break;
      case 'fan': {
        r(4, 4, 32, 32, '#d9dee5'); r(6, 6, 28, 28, '#9aa4b1');
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(b.anim * 20);
        ctx.fillStyle = '#eef2f6'; for (let i = 0; i < 3; i++) { ctx.rotate(Math.PI * 2 / 3); ctx.fillRect(-2, -12, 4, 12); }
        ctx.restore();
        arrow('#3a6ea5');
        break;
      }
      case 'belt':
      case 'pipe': {
        const pipe = b.type === 'pipe';
        r(0, 0, TILE, TILE, pipe ? '#53606e' : '#3b3b3b');
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(d.y, d.x));
        if (pipe) {
          ctx.fillStyle = '#8fa3b8'; ctx.fillRect(-20, -12, 40, 24);
          ctx.fillStyle = '#6c8096'; ctx.fillRect(-20, -12, 40, 4); ctx.fillRect(-20, 8, 40, 4);
          const o = (b.anim * 40) % 20;
          ctx.fillStyle = '#b6c6d6'; for (let i = -1; i < 2; i++) ctx.fillRect(-20 + o + i * 20, -8, 3, 16);
        } else {
          ctx.fillStyle = '#5a5a5a'; ctx.fillRect(-20, -14, 40, 28);
          const o = (b.anim * TILE) % 10;
          ctx.fillStyle = '#7a7a7a'; for (let i = -3; i < 3; i++) ctx.fillRect(-20 + o + i * 10, -14, 3, 28);
          // 歯車
          ctx.fillStyle = '#c9a227'; ctx.beginPath(); ctx.arc(-14, -14, 5, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#3b3b3b'; ctx.beginPath(); ctx.arc(-14, -14, 2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        if (!this.powered) { ctx.fillStyle = '#ff5050'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('⚡', cx, py + 12); }
        break;
      }
      case 'wireless':
        r(10, 18, 20, 18, '#4a5568'); r(18, 4, 4, 16, '#a0aec0');
        ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = 2;
        for (let i = 1; i <= 2; i++) { ctx.beginPath(); ctx.arc(cx, py + 6, 5 * i + (this.t * 6 % 4), Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); }
        break;
      case 'bike': {
        ctx.strokeStyle = '#333'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(px + 11, py + 28, 7, 0, Math.PI * 2); ctx.arc(px + 29, py + 28, 7, 0, Math.PI * 2); ctx.stroke();
        r(11, 18, 18, 3, '#d64545'); r(26, 10, 3, 10, '#d64545'); r(10, 12, 8, 3, '#333');
        ctx.save(); ctx.translate(px + 20, py + 28); ctx.rotate(b.anim * 1.2); ctx.fillStyle = '#ffe066'; ctx.fillRect(-1, -6, 2, 12); ctx.restore();
        r(30, 2, 8, 8, '#2d3748'); r(32, 4, 4, 4, this.power > 0 ? '#ffe066' : '#666');
        break;
      }
      case 'biomass':
        r(6, 8, 28, 28, '#6b4b2a'); r(10, 12, 20, 16, '#2a1a10');
        if (b.fuel > 0 || b.burn > 0) { r(12, 18 + Math.sin(this.t * 12) * 2, 16, 10, '#ff7a1a'); r(15, 20, 10, 6, '#ffd23f'); }
        r(26, 0, 6, 10, '#555');
        break;
      case 'fusion': {
        r(2, 2, 36, 36, '#2d3748'); r(4, 4, 32, 32, '#1a202c');
        ctx.save(); ctx.translate(cx, cy);
        ctx.strokeStyle = '#7fd4ff'; ctx.lineWidth = 2;
        ctx.rotate(b.anim * 2); ctx.beginPath(); ctx.ellipse(0, 0, 13, 5, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.rotate(Math.PI / 3); ctx.beginPath(); ctx.ellipse(0, 0, 13, 5, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 3 + Math.sin(this.t * 8), 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        break;
      }
      case 'pylon':
        r(16, 8, 8, 28, '#8a96a3'); r(12, 32, 16, 6, '#5d6673'); r(13, 2, 14, 8, this.pylonPowered ? '#7fd4ff' : '#666');
        break;
      case 'collector':
        r(4, 4, 32, 32, '#2f855a'); r(8, 8, 24, 24, '#276749');
        ctx.strokeStyle = '#9ae6b4'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(cx, cy, 6 + (this.t * 8 % 6), 0, Math.PI * 2); ctx.stroke();
        arrow('#f6e05e');
        if (b.store.length) { ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'right'; ctx.fillText(b.store.length, px + 36, py + 36); }
        break;
      case 'drone':
        r(4, 20, 32, 16, '#4a5568'); r(8, 24, 24, 8, '#2d3748'); r(14, 26, 12, 4, '#7fd4ff');
        r(18, 6, 4, 14, '#a0aec0');
        break;
      case 'board':
        r(4, 10, 32, 22, '#c8a165'); r(6, 12, 28, 18, '#ddb97c'); r(26, 6, 3, 14, '#bbb'); r(25, 18, 5, 6, '#333');
        break;
      case 'sprinkler': {
        r(16, 14, 8, 22, '#5d6673'); r(12, 32, 16, 6, '#3d4653'); r(13, 8, 14, 8, '#7fd4ff');
        if (this.powered) {
          ctx.fillStyle = '#bfe9ff';
          for (let i = 0; i < 6; i++) {
            const a = this.t * 4 + i * (Math.PI / 3);
            ctx.fillRect(cx + Math.cos(a) * 14 - 1, py + 10 + Math.sin(a) * 6 - 1, 3, 3);
          }
        }
        break;
      }
      case 'harvester':
        drawSprite(ctx, 'harvester_bot', px + 2, py + 6, TILE - 4, TILE - 8);
        ctx.save(); ctx.translate(cx, py + 6); ctx.rotate((b.anim || 0) * 0.8 + (this.powered ? this.t * 3 : 0));
        ctx.fillStyle = '#ffd23f'; for (let i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.fillRect(-1, -8, 2, 8); }
        ctx.restore();
        if (!this.powered) { ctx.fillStyle = '#ff5050'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('⚡', cx, py + 12); }
        break;
      case 'kakashi':
        r(18, 10, 4, 28, '#7a5230'); r(6, 16, 28, 4, '#7a5230');
        r(10, 18, 20, 12, '#c94f3d'); r(14, 20, 12, 8, '#e0c060');
        r(13, 2, 14, 11, '#f2d9a0'); r(10, 2, 20, 4, '#b8862b'); r(15, 7, 2, 2, '#333'); r(23, 7, 2, 2, '#333');
        break;
      case 'warp': {
        const col = b.pair ? '#b48cff' : '#777';
        ctx.save(); ctx.translate(cx, cy);
        ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.beginPath(); ctx.ellipse(0, 0, 15, 17, 0, 0, Math.PI * 2); ctx.stroke();
        if (b.pair) { ctx.fillStyle = '#b48cff55'; ctx.rotate(this.t * 3); ctx.fillRect(-6, -6, 12, 12); }
        ctx.restore();
        break;
      }
      default: r(4, 4, 32, 32, '#888');
    }
  }
}

function techDesc(key, tier) {
  const t = {
    collect: { 2: '歩くだけで足元の作物を拾う。拾う時の空腹度消費が減る', 3: '周囲の作物が回転しながら集まってくる（空腹度消費なし）', 4: '固定回収装置を建てられる', 5: '自律回収ドローンの基地を建てられる' },
    transport: { 2: '扇風機と壁で作物を吹き飛ばして運べる', 3: '歯車駆動のベルトコンベアを建てられる（電力を使う）', 4: '高速なパイプを建てられる', 5: '作物を納品ボックスへ直送する無線転送機を建てられる' },
    deliver: { 2: '納品ボックスを好きな場所へ移動できる', 3: '納品ボックスを最大3つまで置ける' },
    energy: { 1: '人力発電機を建てられる（空腹度で電力を作る）', 2: '作物を燃やすバイオマス発電機を建てられる', 3: '食料不要の核融合炉を建てられる' },
  };
  return (t[key] && t[key][tier]) || '';
}
