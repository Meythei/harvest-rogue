// 農場管理端末（HackNet 風のコンソール）
import { CROPS, TECH, FARM_TIERS, BUILDINGS } from './data.js';
import { setAudioEnabled, isAudioEnabled } from './audio.js';

const HELP = [
  'help                  コマンド一覧',
  'status                農場の状態',
  'quota                 現在のノルマ',
  'tech                  技術ツリーの進行度',
  'power                 電力の収支',
  'weather               天気予報',
  'drone                 ドローンの状態',
  'drone mode <m>        ドローンの運び先 (deliver | burn | store)',
  'seed <作物>           植える作物を変更 (例: seed tomato)',
  'crops                 作物の一覧',
  'log                   最近のログ',
  'sound on|off          サウンド',
  'giveup                このランを諦めて終了',
  'clear                 画面を消す',
  'exit                  端末を閉じる',
];

export function runCommand(game, line, playerIndex = 0) {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const out = [];
  const g = game;
  switch ((cmd || '').toLowerCase()) {
    case '': break;
    case 'help': out.push(...HELP); break;
    case 'status': {
      const fr = FARM_TIERS[g.tech.farm];
      out.push(`農地     : ${fr.name} (${fr.w}x${fr.h})`);
      out.push(`コイン   : ${g.coins}`);
      out.push(`電力     : ${g.power.toFixed(0)} / ${g.powerCap()}`);
      out.push(`コンボ   : ${g.combo} (倍率 x${g.comboMult().toFixed(2)} / 上限 ${g.comboCap()})`);
      g.players.forEach((p) => out.push(`P${p.id + 1}       : 空腹度 ${p.hunger.toFixed(0)}/${p.maxHunger} 手持ち ${p.inv.length}/${g.invCap}`));
      const ground = g.items.filter((i) => i.state === 'ground').length;
      out.push(`地面の作物: ${ground}`);
      break;
    }
    case 'quota': {
      const q = g.quota;
      out.push(`ノルマ #${g.quotaIndex + 1}: ${CROPS[q.crop].name} ${Math.floor(q.have)}/${q.need}`);
      out.push(`残り時間: ${g.quotaRemaining().toFixed(0)} 秒 (${g.quotaDay()}日目)`);
      break;
    }
    case 'tech':
      out.push(`回収   : ${TECH.collect[g.tech.collect - 1]} (${g.tech.collect}/${TECH.collect.length})`);
      out.push(`輸送   : ${TECH.transport[g.tech.transport - 1]} (${g.tech.transport}/${TECH.transport.length})`);
      out.push(`納品   : ${TECH.deliver[g.tech.deliver - 1]} (${g.tech.deliver}/${TECH.deliver.length})`);
      out.push(`電力   : ${TECH.energy[g.tech.energy]} (${g.tech.energy}/${TECH.energy.length - 1})`);
      out.push(`解放   : ${Object.entries(g.unlocks).filter(([, v]) => v).map(([k]) => BUILDINGS[k].name).join(', ') || 'なし'}`);
      if (g.slots.length) out.push(`倍率スロット: ${g.slots.map((s) => s.label).join(' / ')}`);
      break;
    case 'power': {
      const use = g.buildings.reduce((s, b) => s + (BUILDINGS[b.type]?.power || 0), 0);
      const fusion = g.buildings.filter((b) => b.type === 'fusion').length * 6;
      const bio = g.buildings.filter((b) => b.type === 'biomass');
      out.push(`蓄電: ${g.power.toFixed(1)} / ${g.powerCap()}  ${g.powered ? '[ONLINE]' : '[OFFLINE]'}`);
      out.push(`消費: ${use.toFixed(2)}/秒 (+パイロンは悪天候中 1.2/秒)`);
      out.push(`核融合: +${fusion}/秒  バイオマス燃料: ${bio.map((b) => b.fuel).join(', ') || 'なし'}`);
      break;
    }
    case 'weather': {
      const w = g.weather;
      if (w.phase === 'clear') out.push(w.timer > 999 ? '快晴。このノルマ期間は安定しています。' : `晴れ。次の変化まで約 ${Math.max(0, w.timer).toFixed(0)} 秒`);
      else out.push(`${w.kind === 'hail' ? '雹' : '嵐'} ${w.phase === 'warning' ? '接近中' : '発生中'} (${w.timer.toFixed(0)}秒)`);
      break;
    }
    case 'drone':
      if (args[0] === 'mode') {
        const m = args[1];
        if (!['deliver', 'burn', 'store'].includes(m)) { out.push('usage: drone mode deliver|burn|store'); break; }
        g.droneMode = m;
        out.push(`ドローンの運び先を ${m} に設定しました`);
      } else {
        out.push(`ドローン: ${g.drones.length} 機 / モード ${g.droneMode}`);
        g.drones.forEach((d, i) => out.push(`  #${i + 1} 積載 ${d.carry.length}  ${d.dest ? '→ ' + BUILDINGS[d.dest.type]?.name : d.target ? '回収中' : '待機'}`));
      }
      break;
    case 'seed': {
      const c = args[0];
      if (!c || !CROPS[c]) { out.push(`usage: seed <${g.crops.join('|')}>`); break; }
      if (!g.crops.includes(c)) { out.push(`${CROPS[c].name} はまだ解放されていません`); break; }
      if (g.players[playerIndex]) g.players[playerIndex].seed = c;
      out.push(`植える作物: ${CROPS[c].name}`);
      break;
    }
    case 'crops':
      for (const c of g.crops) {
        const k = CROPS[c];
        out.push(`${c.padEnd(8)} ${k.name}  成長${k.grow}s 空腹+${k.food} 燃料${k.fuel} 価値${k.value} 収量${k.yield}`);
      }
      break;
    case 'log': g.log.slice(-12).forEach((l) => out.push(`[${l.t.toFixed(0).padStart(4)}] ${l.msg}`)); break;
    case 'sound':
      if (args[0] === 'on' || args[0] === 'off') setAudioEnabled(args[0] === 'on');
      out.push(`サウンド: ${isAudioEnabled() ? 'on' : 'off'}`);
      break;
    case 'giveup': g.giveUp(); return { exit: true, lines: [] };
    case 'clear': return { clear: true, lines: [] };
    case 'exit': return { exit: true, lines: [] };
    default: out.push(`command not found: ${cmd}  ('help' で一覧)`);
  }
  return { lines: out };
}
