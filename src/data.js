// ゲームの定数とデータ定義

export const TILE = 40;
export const COLS = 24;
export const ROWS = 15;
export const DAY_LENGTH = 40; // 1日の長さ（秒）
export const DAYS_PER_QUOTA = 3;

// DOT ILLUST (https://dot-illust.net/) の素材。実行時にブラウザが直接読み込み、
// 読み込めない場合は sprites.js の代替ドット絵で描画する。
export const DOT_ILLUST_BASE = 'https://dot-illust.net/wp-content/themes/dotillust/assets/dl/';
export const DOT_ILLUST = {
  grass: 'maptile_sogen_01',
  grassFlower: 'maptile_sogen_hana_01',
  soil: 'maptile_tsuchi_01',
  soilTilled: 'maptile_tsuchi_02',
  field_ninjin: 'maptile_tsuchi_01_ninjin',
  field_daikon: 'maptile_tsuchi_01_daikon',
  field_kabu: 'maptile_tsuchi_01_shirokabu',
  item_ninjin: 'ninjin',
  item_daikon: 'daikon',
  item_tomato: 'tomato',
  item_corn: 'tomorokoshi_goldencorn',
  item_kabocha: 'kabocha',
  player1: 'character_murabito_young_man_green',
  player2: 'character_murabito_young_woman_green',
  player3: 'character_murabito_young_man_blue',
  player4: 'character_murabito_young_man_orange',
  box1: 'treasure_bronze',
  box2: 'treasure_silver',
  box3: 'treasure_gold',
  wall: 'maptile_renga_gray_01',
  weather_sunny: 'weather_sunny',
  weather_hail: 'weather_snow_heavy',
  weather_storm: 'weather_thunderstorm',
  hailstone: 'ishi_kori',
  battery: 'kandenchi_01_yellow',
};

// 作物。grow=成熟までの秒数, food=食べた時の空腹回復, fuel=燃やした時の燃料, value=納品時のコイン
export const CROPS = {
  ninjin:  { name: 'ニンジン',     grow: 16, food: 10, fuel: 1, value: 3,  yield: 1, field: 'field_ninjin', color: '#f08a24' },
  kabu:    { name: 'カブ',         grow: 12, food: 7,  fuel: 1, value: 2,  yield: 1, field: 'field_kabu',   color: '#f4f1e6' },
  tomato:  { name: 'トマト',       grow: 24, food: 9,  fuel: 1, value: 3,  yield: 2, color: '#e3342f' },
  daikon:  { name: 'ダイコン',     grow: 30, food: 18, fuel: 2, value: 6,  yield: 1, field: 'field_daikon', color: '#eeeeee' },
  corn:    { name: 'トウモロコシ', grow: 34, food: 12, fuel: 4, value: 5,  yield: 2, color: '#f6c945' },
  kabocha: { name: 'カボチャ',     grow: 50, food: 30, fuel: 3, value: 14, yield: 1, color: '#2f7d3a' },
};
export const CROP_ORDER = ['ninjin', 'kabu', 'tomato', 'daikon', 'corn', 'kabocha'];

// 空腹度（＝行動力）の消費量
export const HUNGER_COST = {
  till: 3, plant: 1, harvest: 1, pickup: 0.5, deliver: 0.5, pump: 2, cut: 1,
  movePerTile: 0.12, carryPerTilePerItem: 0.02,
};

// 農地の規模（庭の畑 → 大規模農業）
export const FARM_TIERS = [
  { name: '庭の畑',     w: 5,  h: 4 },
  { name: '畑',         w: 8,  h: 6 },
  { name: '大きな畑',   w: 12, h: 8 },
  { name: '農園',       w: 16, h: 10 },
  { name: '大規模農業', w: 19, h: 12 },
];
export const FARM_ORIGIN = { x: 1, y: 2 };

// 技術ツリー（仕様書の3系統 + エネルギー）
export const TECH = {
  collect: ['手作業', '効率的な手作業', '周辺自動回収', '固定回収装置', '自律回収ドローン'],
  transport: ['手作業', '扇風機と壁', 'ベルトコンベア', 'パイプ', '無線転送'],
  deliver: ['小さな納品ボックス', '移動できる納品ボックス', '複数の納品ボックス'],
  energy: ['なし', '人力発電', 'バイオマス発電', '核融合'],
};

// 建物。req は解放条件、power は毎秒の消費電力
export const BUILDINGS = {
  wall:      { name: '壁',               cost: 4,   req: { transport: 2 }, desc: '作物を止める。扇風機の風と組み合わせて経路を作る' },
  fan:       { name: '扇風機',           cost: 12,  req: { transport: 2 }, rotate: true, desc: '向いている方向5マスの作物を吹き飛ばす' },
  belt:      { name: 'ベルトコンベア',   cost: 6,   req: { transport: 3 }, rotate: true, power: 0.04, desc: '歯車駆動。電力で作物を運ぶ' },
  pipe:      { name: 'パイプ',           cost: 12,  req: { transport: 4 }, rotate: true, power: 0.06, desc: '高速で作物を運ぶ' },
  wireless:  { name: '無線転送機',       cost: 60,  req: { transport: 5 }, desc: '入った作物を電力2で納品ボックスへ直送' },
  bike:      { name: '人力発電機',       cost: 15,  req: { energy: 1 }, desc: '向かってアクションで発電（空腹度を消費）' },
  biomass:   { name: 'バイオマス発電機', cost: 35,  req: { energy: 2 }, desc: '作物を燃やして発電する' },
  fusion:    { name: '核融合炉',         cost: 220, req: { energy: 3 }, desc: '食料なしで大量に発電する' },
  pylon:     { name: '天候防御パイロン', cost: 30,  req: { unlock: 'pylon' }, desc: '半径3マスの雹・嵐を防ぐ（悪天候中に電力を使う）' },
  collector: { name: '固定回収装置',     cost: 40,  req: { collect: 4 }, rotate: true, power: 0.15, desc: '半径3マスの作物を吸い込み、向いている方向へ出す' },
  drone:     { name: 'ドローン基地',     cost: 80,  req: { collect: 5 }, power: 0.25, desc: '自律回収ドローンが作物を集めて運ぶ（端末で制御）' },
  board:     { name: 'まな板',           cost: 25,  req: { unlock: 'board' }, desc: '作物を2倍にする加工台（1個につき1回）' },
  warp:      { name: 'ワープゲート',     cost: 45,  req: { unlock: 'warp' }, desc: '2つ1組。人も作物も瞬間移動' },
  box:       { name: '納品ボックス',     cost: 50,  req: { deliver: 3 }, desc: '追加の納品ボックス（最大3つ）' },
};
export const BUILD_ORDER = ['wall', 'fan', 'belt', 'pipe', 'wireless', 'bike', 'biomass', 'fusion', 'pylon', 'collector', 'drone', 'board', 'warp', 'box'];

export const DIRS = [
  { x: 1, y: 0, name: '→' },
  { x: 0, y: 1, name: '↓' },
  { x: -1, y: 0, name: '←' },
  { x: 0, y: -1, name: '↑' },
];

// メタ進行（ラン終了後に持ち帰る「種籾」で買う永続強化）
export const META_PERKS = {
  stomach:   { name: '大きな胃袋',   desc: '最大空腹度 +20',            max: 3, cost: [4, 8, 14] },
  coins:     { name: '貯金',         desc: '初期コイン +40',            max: 3, cost: [3, 6, 10] },
  handy:     { name: '慣れた手つき', desc: '回収ティア2から開始',       max: 1, cost: [8] },
  garden:    { name: '広い庭',       desc: '農地「畑」から開始',        max: 1, cost: [12] },
  bike:      { name: '自転車',       desc: '人力発電を解放して開始',    max: 1, cost: [8] },
  rhythm:    { name: 'リズム感',     desc: 'コンボ猶予 +1秒',           max: 2, cost: [6, 12] },
};
