import { newRun, CONST, playerRadius, DIFF_PRESETS } from './RunState';
import { Metab } from './MetabolismSystem';
import { Logistics } from './LogisticsSystem';
import { DataStore } from './DataStore';
import type { GameState } from '../types/GameState';

/**
 * 平衡探针（BalanceProbe）——数值调参的唯一观测口径。
 *
 * 设计原则：
 *  1. 所有"平衡结论"必须来自本探针的真实计算，不靠直觉估计。
 *  2. 每个维度输出**比率**（如 击杀所需秒数、TTK、压力%）而非裸值，
 *     因为裸值随纪元变化无意义，比率才反映"手感"。
 *  3. 提供 preset 形态库，覆盖各纪元的典型/极端构筑。
 */

/** 预设形态：覆盖各纪元的典型构筑与极端构筑 */
export interface BuildPreset {
  id: string;
  name: string;
  era: number;
  modules: string[];
  /** 强化等级表（未列出者为 1） */
  levels?: Record<string, number>;
}

export const BUILDS: BuildPreset[] = [
  { id: 'start', name: '开局·草履虫', era: 0, modules: [] },
  { id: 'start_motor', name: '开局+运动', era: 0, modules: ['flagellum', 'cilia_cluster'] },
  { id: 'start_sense', name: '开局+感官', era: 0, modules: ['chemohair', 'photospot'] },
  { id: 'full_era0', name: '太古宙全配', era: 0, modules: ['flagellum', 'cilia_cluster', 'chemohair', 'photospot', 'granule', 'mouth_basic', 'primitive_stomach', 'energy_pool', 'muscle_hub'] },
  { id: 'full_era0_up', name: '太古宙全配+强化', era: 0, modules: ['flagellum', 'cilia_cluster', 'chemohair', 'photospot', 'granule', 'mouth_basic', 'primitive_stomach', 'energy_pool', 'muscle_hub'], levels: { primitive_stomach: 5, energy_pool: 5, mouth_basic: 5 } },
  { id: 'era1_full', name: '元古宙全配', era: 1, modules: ['multicell_agg', 'primitive_heart', 'enzymatic_gland', 'nerve_net', 'aerogenase', 'cell_wall', 'photosynth', 'spike_cilia', 'primitive_stomach', 'energy_pool', 'flagellum'] },
  { id: 'era2_full', name: '寒武纪全配', era: 2, modules: ['exoskeleton', 'muscle_fiber', 'ganglion', 'gill', 'trilo_plate', 'tail_spine', 'fang', 'aerogenase', 'energy_pool', 'true_gut', 'flagellum'] },
  { id: 'era2_full_up', name: '寒武纪全配+强化', era: 2, modules: ['exoskeleton', 'muscle_fiber', 'ganglion', 'gill', 'trilo_plate', 'tail_spine', 'fang', 'aerogenase', 'energy_pool', 'true_gut', 'flagellum'], levels: { exoskeleton: 5, muscle_fiber: 5, fang: 5, aerogenase: 5, true_gut: 5 } },
  // 贪装：吃满体积、堆大量可叠加代谢件——吞吐涨得慢，常驻消耗却线性上涨
  { id: 'bloat', name: '贪装·无强化', era: 1, modules: ['primitive_heart', 'primitive_heart', 'primitive_heart', 'enzymatic_gland', 'enzymatic_gland', 'enzymatic_gland', 'aerogenase', 'aerogenase', 'aerogenase', 'aerogenase', 'photosynth', 'photosynth', 'primitive_stomach', 'primitive_stomach', 'primitive_stomach', 'muscle_hub', 'muscle_hub', 'muscle_hub', 'energy_pool', 'energy_pool', 'spike_cilia', 'spike_cilia', 'trilo_plate'] },
];

/** 单个形态的完整数值画像 */
export interface Profile {
  era: number;
  eraName: string;
  build: string;
  // —— 形态 ——
  vol: number;
  volCap: number;
  radius: number;
  // —— 生存 ——
  hpMax: number;
  armor: number;
  /** 护甲减伤百分比 */
  armorCut: number;
  // —— 战斗 ——
  attack: number;
  /** 攻击间隔秒数 */
  atkCd: number;
  /** 每秒伤害（无护甲目标） */
  dps: number;
  /** 击杀该纪元中立生物所需秒数 */
  ttkNeutral: number;
  /** 击杀该纪元捕食者所需秒数 */
  ttkPredator: number;
  /** 承受该纪元捕食者攻击到死所需秒数（含无敌帧） */
  survivePredator: number;
  // —— 移动 ——
  speed: number;
  moveDrain: number;
  vision: number;
  // —— 代谢 ——
  output: number;
  drain: number;
  pressure: number;
  tierLabel: string;
  /** 静止不吃可持续秒数 */
  starveTime: number;
  /** 满能量可维持静止秒数（不吃，靠消化缓存） */
  digestBuffer: number;
  /** 回满能量所需秒数（吃饱后消化缓存全满） */
  refillTime: number;
  // —— 物流 ——
  digestCap: number;
  digestEff: number;
  digestRate: number;
  // —— 经济 ——
  growthReserve: number;
  /** 装满该形态还需多少生长储备（下一件器官平均成本） */
  avgModuleCost: number;
}

/** 构造一个装配好的运行态（等价于玩家在编辑器里装完这些器官） */
export function buildState(p: BuildPreset): GameState {
  const G = newRun();
  // 从太古宙逐步推进到目标纪元：每一纪元管网自然升级（玩家真实经历的过程）
  for (let e = 0; e <= p.era; e++) {
    G.eraIndex = e;
    const eraCap = CONST.pipeCapOf(e);
    for (const pipe of G.player.pipes) pipe.cap = Math.max(pipe.cap, eraCap);
  }
  // 探针忽略记忆/纪元解锁限制（评估的是纯数值平衡，不是解锁节奏）
  for (const id of p.modules) {
    const req = DataStore.module(id).requiresMemory;
    if (!req) continue;
    G.memories.set(req, { ...DataStore.memoryOf(req), unlocked: true, interactionCount: 1 });
  }
  G.player.modules.push(...p.modules);
  for (const [id, lv] of Object.entries(p.levels ?? {})) {
    G.player.modLevels[id] = lv;
  }
  // 安装器官 → 自动接入物流（编辑器 installOne 的同一路径）
  for (const id of p.modules) {
    const m = DataStore.module(id);
    if (!m.node) continue;
    if (G.player.nodes.some(n => n.moduleId === id)) continue;
    G.player.nodes.push(Logistics.makeNode(`n_${id}`, id, 300, 200));
  }
  Logistics.autoWire({ ...G.player, eraIndex: G.eraIndex });
  Metab.recompute(G);
  G.mode = 'playing';
  return G;
}

/** 采集单个形态的完整画像 */
export function profile(p: BuildPreset): Profile {
  const G = buildState(p);
  const P = G.player;
  const m = P.metab;

  // 攻击侧
  const dps = P.attackTotal / CONST.ATTACK_CD;
  const neutral = DataStore.speciesList.find(s => s.era === p.era && s.type === 'neutral');
  const predator = DataStore.speciesList.find(s => s.era === p.era && s.type === 'predator');
  // 击杀耗时 = 目标 HP / 实际 DPS（考虑目标护甲减伤）
  const effDmg = (armor: number): number =>
    P.attackTotal * (1 - armor / (armor + 50));
  const ttkNeutral = neutral ? neutral.hp / (effDmg(neutral.armor) / CONST.ATTACK_CD) : 0;
  const ttkPredator = predator ? predator.hp / (effDmg(predator.armor) / CONST.ATTACK_CD) : 0;
  // 承受捕食者攻击到死：捕食者 DPS × 玩家减伤 / 玩家 HP
  const hurtDmg = predator ? predator.attack * (1 - P.armorTotal / (P.armorTotal + 50)) : 0;
  const survivePredator = hurtDmg > 0 ? P.hpMax / hurtDmg : Infinity;

  // 代谢：静止不吃能撑多久（能量耗尽 = 饿死）
  const starveTime = m.metabolicOutput - P.totalDrain < 0
    ? m.maxEnergy / (P.totalDrain - m.metabolicOutput)
    : Infinity;
  // 消化缓存排空时间
  const refillTime = P.digestRate > 0 ? P.digestCap / P.digestRate : Infinity;
  const svc = Logistics.services(P);

  const avgCost = p.modules.length
    ? p.modules.reduce((s, id) => s + DataStore.module(id).growthCost, 0) / p.modules.length
    : CONST.INNATE_UP_COST;

  return {
    era: p.era,
    eraName: DataStore.era(p.era).name,
    build: p.name,
    vol: P.bodyVol,
    volCap: Metab.volumeCap(G),
    radius: playerRadius(P.bodyVol),
    hpMax: P.hpMax,
    armor: P.armorTotal,
    armorCut: P.armorTotal / (P.armorTotal + 50),
    attack: P.attackTotal,
    atkCd: CONST.ATTACK_CD,
    dps,
    ttkNeutral, ttkPredator, survivePredator,
    speed: P.speedTotal,
    moveDrain: CONST.MOVE_DRAIN_PER_SPEED * P.speedTotal,
    vision: CONST.VISION_BASE + CONST.VISION_PER_PERCEPT * P.perceptionTotal,
    output: m.metabolicOutput,
    drain: P.totalDrain,
    pressure: m.pressure,
    tierLabel: m.tier.label,
    starveTime,
    digestBuffer: P.digestCap,
    refillTime,
    digestCap: svc.digestCap,
    digestEff: svc.digestionEfficiency,
    digestRate: P.digestRate,
    growthReserve: m.growthReserve,
    avgModuleCost: avgCost,
  };
}

/** 采集全部预设形态 */
export function profileAll(): Profile[] {
  return BUILDS.map(profile);
}

/** 平衡健康度检查：返回所有越界项（供 CI / 测试断言） */
export interface Issue {
  build: string;
  metric: string;
  value: number;
  rule: string;
  severity: 'warn' | 'bad';
}

export function audit(ps: Profile[] = profileAll()): Issue[] {
  const out: Issue[] = [];
  const add = (p: Profile, metric: string, value: number, rule: string, bad: boolean): void => {
    out.push({ build: p.build, metric, value, rule, severity: bad ? 'bad' : 'warn' });
  };
  for (const p of ps) {
    // 1. 代谢压力：正常构筑应健康，贪装应告警
    if (p.build === '贪装·无强化') {
      if (p.pressure < 1.05) add(p, 'pressure', p.pressure, '贪装形态压力应 >105%（需强化才有出路）', true);
    } else if (p.pressure > 0.95) {
      add(p, 'pressure', p.pressure, '正常构筑压力应 ≤95%（v0.6 放宽阈值）', true);
    }
    if (p.build !== '贪装·无强化' && p.pressure < 0.12) {
      add(p, 'pressure', p.pressure, '压力过低=产出过剩，代谢失去张力', false);
    }

    // 2. 饿死时间：正常构筑必须能撑过一轮觅食（60s+）
    if (p.build !== '贪装·无强化' && Number.isFinite(p.starveTime) && p.starveTime < 60) {
      add(p, 'starveTime', p.starveTime, '正常构筑静止应 ≥60s 才会饿死', true);
    }

    // 3. 战斗：击杀中立不应超过 6 次撕咬（≈6s）
    if (p.ttkNeutral > 6.5) add(p, 'ttkNeutral', p.ttkNeutral, '击杀中立 ≤6.5s', true);
    if (p.ttkNeutral < 0.8) add(p, 'ttkNeutral', p.ttkNeutral, '击杀中立 ≥0.8s（不应秒杀）', false);
    // 对捕食者：应有悬念但非无解（6~35s）
    if (p.ttkPredator > 35) add(p, 'ttkPredator', p.ttkPredator, '击杀捕食者 ≤35s（否则不可行）', false);
    if (p.ttkPredator < 2.5) add(p, 'ttkPredator', p.ttkPredator, '击杀捕食者 ≥2.5s（不应秒杀）', false);
    // 4. 生存：静站硬抗捕食者的秒数。
      // 实战中玩家会逃跑且有 0.5s 无敌帧，理论值只是上界；
      // 因此上界放宽到 18s（超过说明"站桩也能赢"，威胁感不足）。
      if (Number.isFinite(p.survivePredator)) {
        if (p.survivePredator < 2.5) {
          add(p, 'survivePredator', p.survivePredator, '面对捕食者应能存活 ≥2.5s', true);
        }
        if (p.survivePredator > 18) {
          add(p, 'survivePredator', p.survivePredator, '静站硬抗捕食者应 ≤18s（逃跑是正解）', false);
        }
      }

    // 5. 体积：不得超过上限
    if (p.vol > p.volCap) add(p, 'volume', p.vol, `体积 ${p.vol} > 上限 ${p.volCap}`, true);

    // 6. 强化必须有意义：强化版 P 应显著高于未强化版
    const base = ps.find(x => x.build.replace('+强化', '') === p.build);
    if (p.build.includes('+强化') && base) {
      if (p.output <= base.output * 1.15) {
        add(p, 'upgradeGain', p.output / base.output, '强化后产出应 ≥1.15×（强化必须有意义）', true);
      }
    }

    // 7. 消化缓存不应长期溢出堵塞
    if (p.refillTime > 45) add(p, 'refillTime', p.refillTime, '消化缓存排空 ≤45s', false);
  }
  return out;
}

/** 生成可读报表 */
export function report(ps: Profile[] = profileAll(), issues = audit(ps)): string {
  const f = (n: number, d = 1): string => (Number.isFinite(n) ? n.toFixed(d) : '∞');
  const L: string[] = [];
  L.push('═'.repeat(118));
  L.push('孢子工厂冒险 · 平衡报表'.padEnd(60) + `探针：${ps.length} 种形态`);
  L.push('═'.repeat(118));
  L.push('');
  L.push('【代谢】');
  L.push('形态'.padEnd(20) + 'E  体积'.padEnd(11) + '产出P'.padEnd(9) + '总消耗'.padEnd(9) + '压力'.padEnd(8) + '档位'.padEnd(10) + '饿死'.padEnd(8) + '胃容'.padEnd(8) + '消化速率');
  for (const p of ps) {
    L.push(
      p.build.padEnd(18) + ` E${p.era} ` +
      `${p.vol}/${p.volCap}`.padEnd(9) +
      f(p.output, 2).padEnd(9) +
      f(p.drain, 2).padEnd(9) +
      `${(p.pressure * 100).toFixed(0)}%`.padEnd(8) +
      p.tierLabel.padEnd(10) +
      `${f(p.starveTime, 0)}s`.padEnd(8) +
      String(Math.round(p.digestBuffer)).padEnd(8) +
      f(p.digestRate, 2),
    );
  }
  L.push('');
  L.push('【战斗】');
  L.push('形态'.padEnd(20) + 'HP'.padEnd(9) + '护甲'.padEnd(9) + '减伤'.padEnd(8) + '攻击'.padEnd(8) + 'DPS'.padEnd(9) + '杀中立'.padEnd(9) + '杀捕食'.padEnd(9) + '抗捕食'.padEnd(9) + '速度');
  for (const p of ps) {
    L.push(
      p.build.padEnd(18) + ' ' +
      String(Math.round(p.hpMax)).padEnd(9) +
      String(Math.round(p.armor)).padEnd(9) +
      `${(p.armorCut * 100).toFixed(0)}%`.padEnd(8) +
      String(Math.round(p.attack)).padEnd(8) +
      f(p.dps, 1).padEnd(9) +
      `${f(p.ttkNeutral, 1)}s`.padEnd(9) +
      `${f(p.ttkPredator, 1)}s`.padEnd(9) +
      `${f(p.survivePredator, 1)}s`.padEnd(9) +
      f(p.speed, 0),
    );
  }
  L.push('');
  L.push('【生态对照】');
  L.push('纪元'.padEnd(12) + '物种'.padEnd(14) + 'HP'.padEnd(7) + '护甲'.padEnd(7) + '攻击'.padEnd(7) + '速度'.padEnd(7) + '营养');
  for (const s of DataStore.speciesList) {
    L.push(
      DataStore.era(s.era).name.padEnd(12) +
      s.name.padEnd(14) +
      String(s.hp).padEnd(7) +
      String(s.armor).padEnd(7) +
      String(s.attack).padEnd(7) +
      String(s.speed).padEnd(7) +
      String(s.nutrition),
    );
  }
  L.push('');
  if (issues.length === 0) {
    L.push('✅ 平衡审计：全部通过');
  } else {
    L.push(`⚠️ 平衡审计：${issues.length} 项待确认`);
    for (const i of issues) {
      L.push(`  [${i.severity === 'bad' ? '严重' : '提示'}] ${i.build} · ${i.metric} = ${f(i.value, 2)} —— ${i.rule}`);
    }
  }
  L.push('');
  return L.join('\n');
}

/** 经济探针：模拟"标准觅食节奏"下 15 分钟能积累多少生长储备 */
export function economyReport(): string {
  const L: string[] = [];
  L.push('【经济】觅食节奏模拟（每 15 秒吃 1 口标准食物 + 每 45 秒击杀 1 只中立）');
  L.push('难度'.padEnd(12) + '食物营养'.padEnd(12) + '15分钟储备'.padEnd(14) + '可购器官'.padEnd(14) + '纪元模块均价');
  const food = DataStore.speciesList.find(s => s.type === 'food')!;
  for (const d of Object.values(DIFF_PRESETS)) {
    // 900s / 15s = 60 口食物；900/45 = 20 次击杀
    const foodGain = 60 * food.nutrition * CONST.GROWTH_PER_FOOD * d.growthMult;
    const killGain = 20 * CONST.GROWTH_PER_KILL;
    const total = foodGain + killGain;
    // 该纪元模块平均价
    const era = DataStore.era(0);
    const mods = DataStore.modules.filter(m => m.era === era.order && m.growthCost > 0);
    const avg = mods.reduce((s, m) => s + m.growthCost, 0) / Math.max(1, mods.length);
    L.push(
      d.label.padEnd(12) +
      String(food.nutrition).padEnd(12) +
      `${total.toFixed(0)}⬢`.padEnd(14) +
      `${(total / avg).toFixed(1)} 件`.padEnd(14) +
      `${avg.toFixed(1)}⬢`,
    );
  }
  L.push('');
  L.push('【强化经济】把储备投入强化的收益（单个太古宙器官 Lv1→Lv5）');
  L.push('难度'.padEnd(12) + '15分钟储备'.padEnd(14) + '强化到Lv5'.padEnd(14) + '可强化器官'.padEnd(14) + '产出增益');
  const upCost5 = (m: ModuleDefLike): number => {
    let s = 0;
    for (let i = 1; i < CONST.UP_MAX_LEVEL; i++) s += Math.round(m.growthCost * CONST.UP_COST_RATIO * i);
    return s;
  };
  const stomachUp = upCost5(DataStore.module('primitive_stomach'));
  const baseP = CONST.P_BASE + CONST.P_PER_PATH * 8;      // 吞吐 8（原始胃）
  const upP = baseP * (1 + CONST.META_UP_PCT * (CONST.UP_MAX_LEVEL - 1));
  for (const d of Object.values(DIFF_PRESETS)) {
    const total = 60 * food.nutrition * CONST.GROWTH_PER_FOOD * d.growthMult + 20 * CONST.GROWTH_PER_KILL;
    L.push(
      d.label.padEnd(12) +
      `${total.toFixed(0)}⬢`.padEnd(14) +
      `${stomachUp}⬢`.padEnd(14) +
      `${(total / stomachUp).toFixed(2)} 件`.padEnd(14) +
      `P ${baseP.toFixed(1)}→${upP.toFixed(1)} (+${Math.round((upP / baseP - 1) * 100)}%)`,
    );
  }
  L.push('');
  L.push('解读：强化一件器官到满是长期投资（约等于一个纪元周期的全部收入），');
  L.push('      因此玩家每个纪元应主要做"1 件新器官 + 部分强化"，而非一次强化满。');
  L.push('');
  return L.join('\n');
}

/** 内部类型别名（避免在报表函数里展开完整 ModuleDef） */
interface ModuleDefLike { growthCost: number }

/** 难度预设下的开局生存时长（评估难度梯度）
 *  注意：难度通过**食物密度**（foodMult）生效，不改营养值；
 *  因此这里估算"平均觅食间隔" = 维护区面积 / 食物密度，再折算可支撑的游走时长。 */
export function difficultyReport(): string {
  const L: string[] = [];
  const R = CONST.MAINTAIN_RADIUS;
  const area = Math.PI * R * R;
  L.push('【难度预设】难度通过食物密度/灾害频率/捕食者密度生效（不改营养值）');
  L.push('预设'.padEnd(12) + '食物密度'.padEnd(12) + '食物数'.padEnd(10) +
    '单人占地'.padEnd(12) + '灾害间隔'.padEnd(12) + '捕食者'.padEnd(10) + '初始储备');
  for (const d of Object.values(DIFF_PRESETS)) {
    const G = newRun();
    G.diff = d;
    const era = DataStore.era(0);
    const nFood = Math.round(era.spawn.food * d.foodMult);
    const nPred = Math.round(era.spawn.predator * d.predMult);
    const perHead = area / Math.max(1, nFood);
    const firstDisaster = 75 / d.hazardMult;
    L.push(
      d.label.padEnd(12) +
      `${d.foodMult}×`.padEnd(12) +
      String(nFood).padEnd(10) +
      `${perHead.toFixed(0)}px²`.padEnd(12) +
      `${firstDisaster.toFixed(0)}s`.padEnd(12) +
      String(nPred).padEnd(10) +
      String(d.startGrowth),
    );
  }
  L.push('');
  L.push('解读：食物密度决定觅食效率（密度越高越容易吃饱），灾害间隔与捕食者密度决定威胁。');
  L.push('');
  return L.join('\n');
}