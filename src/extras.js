// 他のゲームから取り入れた要素のデータ定義
// - お守り・市場・納品の役・ボスノルマ: Balatro
// - 神託（毎朝のランダムな祝福と呪い）: ゴッドフィールド
// - 特性・放射能で巨大化する作物・補給物資: Fallout
// - スプリンクラー・自動収穫機・混植ボーナス（施設の効果範囲と隣接効果）: シムシティ
// - 縛り（難しくするほど持ち帰る種籾が増える）: Hades の Heat / Forza の難易度ボーナス
// - 腐った作物と胃病み（食べると最大空腹度が減る）: Fallout の放射能
// - 毎日の旬の作物: ペルソナの曜日ごとのイベント
// - 前日に予告されるカラスの襲来とかかし: ペルソナの天気予報 + タワーディフェンス
// - ドローンの行動ルール（条件 → 行動の優先リスト）: FF12 のガンビット
import { CROPS } from './data.js';

// お守り（Balatro のジョーカー）。市場でコインで買い、最大 charmSlots 個まで持てる
export const CHARMS = {
  earlybird: { name: '早起き鳥',       cost: 30, desc: '各ノルマの1日目は作物の成長が1.5倍' },
  crow:      { name: '欲張りなカラス', cost: 35, desc: '手持ちが満杯のまま納品すると、その納品の倍率 +0.5' },
  allin:     { name: '一点張り',       cost: 40, desc: 'ノルマ対象の作物の納品倍率 ×1.25' },
  omnivore:  { name: '雑食家',         cost: 25, desc: '食べたときの空腹度回復が1.5倍' },
  scarecrow: { name: '守り神のかかし', cost: 30, desc: '雹・嵐・イナゴの被害が半分、カラスがついばむのに2倍かかる' },
  hoe:       { name: '黄金のクワ',     cost: 35, desc: '耕す・植えるで空腹度を使わない' },
  piggy:     { name: '貯金箱',         cost: 25, desc: '毎日の終わりに所持コイン10枚ごとに1枚の利息（最大10）' },
  alchemist: { name: '錬金術師',       cost: 30, desc: '燃やした作物の燃料が2倍' },
  metronome: { name: 'メトロノーム',   cost: 30, desc: 'コンボの猶予 +3秒' },
  goddess:   { name: '豊作の女神像',   cost: 40, desc: '収穫のたび20%で収穫数 +1' },
  bulkorder: { name: '大口注文',       cost: 45, desc: '納品の役の倍率が1.5倍' },
  companion: { name: 'コンパニオンプランツ', cost: 25, desc: '混植ボーナスが2倍（+40%）' },
  leadsuit:  { name: '鉛のスーツ',     cost: 30, desc: '放射能で巨大化する範囲が2マス広がる' },
  scavenger: { name: 'スカベンジャー', cost: 25, desc: '補給物資が2倍の頻度で落ちてくる' },
  investor:  { name: '株主',           cost: 40, desc: '所持コイン25枚ごとに納品倍率 +0.05（最大 +0.5）' },
  rancher:   { name: '朝ごはん',       cost: 20, desc: '毎朝、全員の空腹度が25回復する' },
};
export const CHARM_KEYS = Object.keys(CHARMS);

// 納品の役（Balatro のポーカーハンド）。手持ちをまとめて納品したときの中身で決まる
// counts: 作物ごとの個数（多い順）
export function deliveryHand(crops) {
  if (crops.length < 3) return null;
  const tally = {};
  for (const c of crops) tally[c] = (tally[c] || 0) + 1;
  const counts = Object.values(tally).sort((a, b) => b - a);
  const kinds = counts.length;
  if (kinds >= 5) return { name: '五穀豊穣', mult: 0.8 };
  if (counts[0] >= 12) return { name: '大豊作', mult: 0.6 };
  if (kinds >= 4) return { name: '八百屋の店先', mult: 0.5 };
  if (counts[0] >= 3 && counts[1] >= 3) return { name: 'ダブル収穫', mult: 0.45 };
  if (counts[0] >= 8) return { name: '豊作', mult: 0.4 };
  if (counts[0] >= 3 && counts[1] >= 2) return { name: 'フルハウス', mult: 0.3 };
  if (kinds >= 3) return { name: '盛り合わせ', mult: 0.2 };
  if (counts[0] >= 5) return { name: '束ね売り', mult: 0.15 };
  return null;
}

// ボスノルマ（Balatro のボスブラインド）。3つ目ごとのノルマに付く縛り。前のノルマのうちに予告される
export const BOSSES = {
  drought:  { name: '干ばつ',     desc: '作物の成長が0.7倍' },
  tax:      { name: '重税',       desc: '納品で得るコインが半分' },
  monsoon:  { name: '嵐の季節',   desc: '悪天候が2倍の頻度で来る' },
  picky:    { name: '偏食',       desc: '食べたときの回復が半分' },
  single:   { name: '単品勝負',   desc: '納品の役が成立しない' },
  heavy:    { name: '重い足取り', desc: '移動と運搬の空腹度消費が2倍' },
};
export const BOSS_KEYS = Object.keys(BOSSES);

// 神託（ゴッドフィールド）。毎朝1枚引かれ、その日の間だけ効果がある
export const ORACLES = {
  rain:     { name: '恵みの雨',     good: true,  desc: '畑の作物がすべて8秒分育つ' },
  harvest:  { name: '豊穣の神',     good: true,  desc: '今日は収穫のたび30%で収穫数 +1' },
  gold:     { name: '黄金の雨',     good: true,  desc: 'コイン +30' },
  bless:    { name: '女神の祝福',   good: true,  desc: '全員の空腹度が全回復' },
  merchant: { name: '旅の商人',     good: true,  desc: '次の市場のお守りが半額' },
  wind:     { name: '追い風',       good: true,  desc: '今日は移動の空腹度消費がなし' },
  locust:   { name: 'イナゴの群れ', good: false, desc: '育っている作物が6株食べられる' },
  fatigue:  { name: '疲労',         good: false, desc: '今日は手作業の空腹度消費が1.3倍' },
  slump:    { name: '相場の暴落',   good: false, desc: '今日は納品で得るコインが0.6倍' },
  calm:     { name: '静寂',         good: true,  desc: '何も起きない、穏やかな一日' },
};
export const GOOD_ORACLES = Object.keys(ORACLES).filter((k) => ORACLES[k].good);
export const BAD_ORACLES = Object.keys(ORACLES).filter((k) => !ORACLES[k].good);

// 特性（Fallout の Trait）。ランの開始時に1つ選ぶ。長所と短所がセット
export const TRAITS = {
  none:     { name: '特性なし',     desc: '長所も短所もない' },
  glutton:  { name: '大食い',       desc: '最大空腹度 +40 / 食べたときの回復 0.75倍' },
  hasty:    { name: 'せっかち',     desc: '移動速度 1.25倍 / 移動の空腹度消費 1.5倍' },
  merchant: { name: '商売上手',     desc: 'コイン獲得 1.5倍 / ノルマの必要数 1.1倍' },
  devout:   { name: '信心深い',     desc: '神託の祝福が出やすい（60%→85%） / 悪天候の被害 1.25倍' },
  tinkerer: { name: '機械いじり',   desc: '建物が2割引 / 最大空腹度 -20' },
};
export const TRAIT_KEYS = Object.keys(TRAITS);

// 補給物資（Fallout のスカベンジ）の中身
export function rollSupply(rand, crops) {
  const r = rand();
  if (r < 0.4) return { kind: 'coins', amount: 15 + Math.floor(rand() * 26) };
  if (r < 0.75) {
    const c = crops[Math.floor(rand() * crops.length)];
    return { kind: 'food', crop: c, amount: 3 };
  }
  if (r < 0.9) return { kind: 'power', amount: 40 };
  return { kind: 'charm' };
}

// 縛り（Hades の Heat）。タイトルで選ぶ。付けた分だけラン終了時の種籾が増える
export const PACTS = {
  famine:    { name: '飢饉',           bonus: 0.3,  desc: '最大空腹度 -30' },
  stormy:    { name: '荒天',           bonus: 0.25, desc: '悪天候が1つ目のノルマから来る' },
  rotting:   { name: '早腐れ',         bonus: 0.2,  desc: '地面の作物が2倍の速さで腐る' },
  crows:     { name: 'カラスの縄張り', bonus: 0.3,  desc: 'カラスの群れが毎日来る' },
  inflation: { name: '物価高',         bonus: 0.2,  desc: 'お守りと建物の値段が1.3倍' },
};
export const PACT_KEYS = Object.keys(PACTS);

export const ROT_TIME = 45; // 地面に落ちた作物が腐るまでの秒数

// ドローンのガンビット（FF12）。上から順に条件を調べ、最初に当てはまった行動をとる
export const GAMBIT_CONDS = {
  rotten:   '腐った作物',
  quota:    'ノルマ対象の作物',
  seasonal: '旬の作物',
  lowpower: '電力が3割未満',
  any:      'どの作物でも',
};
export const GAMBIT_ACTIONS = { deliver: '納品', burn: '燃やす', store: '保管' };
export const DEFAULT_GAMBITS = [
  { if: 'rotten', then: 'burn' },
  { if: 'lowpower', then: 'burn' },
  { if: 'any', then: 'deliver' },
];

export const cropName = (c) => CROPS[c]?.name || c;
