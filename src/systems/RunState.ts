import type { GameState, Player, FlowNode, Pipe, DiffConfig } from '../types/GameState';
import { DataStore } from './DataStore';
import { Logistics } from './LogisticsSystem';
import { Ev, bus } from '../core/EventBus';

/** 全局平衡常量（调参集中于此） */
export const CONST = {
  BASE_SPEED: 62,
  SPEED_PER_MOD: 6,       // 每个 speedMod 点的加成（2 点 = +12；避免两件器官速度翻倍）
  BASE_HP: 30,
  HP_PER_VOL: 6,          // 生命 = 30 + 体积×6（BalanceProbe：开局 90，寒武纪全配 264）
  TRUNK_HP_BONUS: 15,
  BMR_BASE: 0.55,
  BMR_PER_VOL: 0.026,     // 体积代谢成本（v0.6 下调：寒武纪全配 33 体积 → BMR ≈ 1.41）
  P_BASE: 2.0,             // 无物流网时的原始渗透吸收产出
  P_PER_PATH: 1.1,        // 每 1 点消化道吞吐提供的产出（吞吐 8→24 时 P = 10.8→28.4）
  /** 代谢类器官强化对产出的加成（GDD 2.3 百分比语义）：每级 +12% 产出 */
  META_UP_PCT: 0.12,
  /** 消化效率基准（食物→能量转化率，GDD 2.3.2 范围 0.1~1.0） */
  DIGEST_EFF_BASE: 0.35,
  DIGEST_RATE_BASE: 1.0,   // 消化速率基准（能量/秒）
  DIGEST_RATE_PER_PATH: 0.25, // 每点消化吞吐额外提供的消化速率（高吞吐 = 消化更快）
  /** 胃满溢出：直接按消化效率折算成能量，不再静默堵死（v0.5） */
  STOMACH_OVERFLOW_EFF: 0.5,
  /** 每单位摄入营养转化为生长储备的比例（v0.5：经济线不依赖能量溢出）
   *  标定：标准难度 15 分钟 ≈ 12 件太古宙器官（均价 6.7⬢），见 BalanceProbe.economyReport */
  GROWTH_PER_FOOD: 0.04,
  GROWTH_PER_KILL: 4,       // 击杀中立/捕食者的储备奖励
  PROTEIN_GROWTH_MULT: 2.2, // 蛋白质储备倍率（高价值掉落）
  SENSE_DRAIN: 0.1,
  SENSE_DRAIN_PER_PERCEPT: 0.02,
  MOVE_DRAIN_PER_SPEED: 0.34 / 62,
  BURST_BASE: 20,
  BURST_PER_GRANULE: 15,
  BURST_CHARGE: 1.4,
  BUFFER_BASE: 30,
  BASE_NODE_CAP: 8,        // 管道基础吞吐（太古宙）
  PIPE_CAP_PER_ERA: 4,    // 每纪元管道基础容量 +4（管网随物种复杂度自然升级）
  /** 当前纪元的管道基础吞吐 */
  pipeCapOf(eraIndex: number): number {
    return CONST.BASE_NODE_CAP + CONST.PIPE_CAP_PER_ERA * eraIndex;
  },
  PIPE_UP_COST: 6,         // 扩容基础价（随管长增加）
  REMOVE_REFUND: 0.3,      // GDD 3.3：移除返还 30% 生长储备
  UP_MAX_LEVEL: 5,         // 模块强化等级上限
  UP_COST_RATIO: 0.6,      // 强化费用 = 模块原价 × 0.6 × 当前等级
  UP_REFUND: 0.8,          // 拆除模块返还强化投入的 80%
  INNATE_UP_COST: 8,       // 先天器官强化的折算原价（本身 growthCost=0）
  EAT_RADIUS_BASE: 26,
  EAT_RADIUS_PER_MOUTH: 7,
  /** 进食判定须覆盖玩家可见体型（WorldScene 用同一公式绘制，两者不得漂移） */
  PLAYER_DRAW_BASE: 10,
  PLAYER_DRAW_K: 2.2,
  EAT_RADIUS_MIN: 30,
  ATTACK_BASE: 6,          // 基础撕咬（起始形态约 4 次撕咬击杀中立，见 BalanceProbe 审计）
  ATTACK_CD: 1.0,
  VISION_BASE: 100,
  VISION_PER_PERCEPT: 12,
  GROW_VOL_PER_ENERGY: 0.012,   //（已停用：v0.4 起体积不随进食增长，保留仅为数据兼容）
  MAX_VOL_PER_UP: 1,        // 防御/躯干类强化每级提升的体积上限（强化细胞壁/骨骼 = 扩仓）
  VISION_MEMORY_TIME: 1.5, // 观察解锁所需累计注视秒数
  AGGRO_RANGE: 170,        // 捕食者索敌范围
  DROP_AGGRO: 340,         // 脱战距离（超出即放弃追击）
  CHASE_GIVEUP: 6,         // 追击超时（秒，咬不到就放弃）
  // —— 冲刺（空格）——
  DASH_COST: 12,           // 单次冲刺消耗爆发池
  DASH_TIME: 0.35,         // 冲刺持续秒数
  DASH_SPEED_MULT: 2.2,    // 冲刺速度倍率
  // —— 世界/生态维护 ——
  WORLD_W: 2400,           // 世界宽（px）
  WORLD_H: 1800,           // 世界高（px）
  MAINTAIN_RADIUS: 900,    // 玩家周边生态维护区半径
  SPAWN_DENSITY: 0.45,     // 维护区目标密度（相对纪元基准）
  ENT_CAP: 260,            // 实体软上限（超出优先回收远处食物）
  FOOD_CULL_DIST: 1600,    // 超出该距离的食物被回收
  PROTEIN_TTL: 22,         // 蛋白质掉落物存留秒数
  // —— 嗅觉（GDD 2.1.3：可视圈缘气味弧——只给方位与浓度，不给坐标）——
  SMELL_RANGE: 420,        // 嗅觉半径（px，世界坐标）
  SMELL_ARC_HALF: 0.12,    // 气味弧半角（rad，≈±7°）
  SMELL_AIM_JITTER: 0.2,   // 方位确定性抖动（rad，≈±11°，模糊方位）
  // —— 时间节奏 ——
  DEATH_DELAY_MS: 350,     // 死亡到结算面板的延迟（演出）
  // —— 继承比例（GDD 3.6）——
  MEMORY_INHERIT: 0.6,     // 血统记忆继承 60%（以子代重启 / 存档共用）
};

/** 难度预设（开局设置界面） */
export const DIFF_PRESETS: Record<string, DiffConfig> = {
  easy:   { label: '🌿 温和', preset: 'easy',   foodMult: 1.6, hazardMult: 0.4, predMult: 0.4, predPower: 0.8, growthMult: 1.8, startGrowth: 25 },
  normal: { label: '⚖️ 标准', preset: 'normal', foodMult: 1.0, hazardMult: 1.0, predMult: 1.0, predPower: 1.0,  growthMult: 1.0, startGrowth: 0 },
  hard:   { label: '🔥 恶劣', preset: 'hard',   foodMult: 0.7, hazardMult: 1.7, predMult: 1.6, predPower: 1.2, growthMult: 0.62, startGrowth: 0 },
  hell:   { label: '💀 大灭绝', preset: 'hell', foodMult: 0.5, hazardMult: 2.4, predMult: 2.2, predPower: 1.45, growthMult: 0.42, startGrowth: 0 },
};

/** 玩家可见体型半径（绘制与进食判定共用，杜绝"看着吃到实际没吃到"） */
export function playerRadius(bodyVol: number): number {
  return CONST.PLAYER_DRAW_BASE + Math.sqrt(Math.max(1, bodyVol)) * CONST.PLAYER_DRAW_K;
}

/** 累计强化消耗（Lv1 → lv 的全部强化费用，供拆除返还计算） */
export function upgradeSpentOf(growthCost: number, lv: number): number {
  let sum = 0;
  for (let i = 1; i < lv; i++) sum += upgradeCostOf(growthCost, i);
  return sum;
}

/** 单级强化价：先天器官（growthCost=0）按固定价折算，否则按模块原价比例 */
export function upgradeCostOf(growthCost: number, lv: number): number {
  const base = growthCost > 0 ? growthCost : CONST.INNATE_UP_COST;
  return Math.round(base * CONST.UP_COST_RATIO * lv);
}

/**
 * 基础物流节点（GDD 3.3：口沟/胞肛 消化层 → 胃 → 能量池 → 肌肉/大脑）。
 * 草履虫级单体：只有消化层 + 运动出口，循环/神经层要等器官装出来才出现。
 * 先天口沟就是消化层源（v0.6：不再有独立的 'mouth' 占位节点）。
 */
export const BASE_NODES: FlowNode[] = [
  { id: 'n_oral_groove', type: 'source', layer: 'digest', x: 300, y: 70, rate: 8, moduleId: 'oral_groove', auto: true },
  { id: 'stomach', type: 'process', layer: 'digest', x: 160, y: 150, rate: 4 },
  { id: 'energy', type: 'storage', layer: 'digest', x: 70, y: 215, rate: 8 },
  { id: 'muscle', type: 'sink', layer: 'motor', x: 250, y: 215, rate: 6 },
  { id: 'brain', type: 'sink', layer: 'nerve', x: 160, y: 285, rate: 2 },
];

export const BASE_PIPES: Pipe[] = [
  { a: 'n_oral_groove', b: 'stomach', level: 1, cap: CONST.BASE_NODE_CAP },
  { a: 'stomach', b: 'energy', level: 1, cap: CONST.BASE_NODE_CAP },
  { a: 'energy', b: 'muscle', level: 1, cap: CONST.BASE_NODE_CAP },
  { a: 'energy', b: 'brain', level: 1, cap: CONST.BASE_NODE_CAP },
];

/** 先天器官自带的物流节点（胞肛=消化层废物出口，细胞核=神经层种子；口沟已在 BASE_NODES 中） */
function builtInNodes(): FlowNode[] {
  return [
    { id: 'n_anal_pore', type: 'sink', layer: 'digest', x: 300, y: 300, rate: 4, moduleId: 'anal_pore', auto: true },
    { id: 'n_nucleus', type: 'sink', layer: 'nerve', x: 40, y: 285, rate: 4, moduleId: 'nucleus', auto: true },
  ];
}

/** 先天器官（草履虫级起始形态）：自带且不可卸载 */
const BUILT_IN_MODULES = ['cytoplasm', 'cell_membrane', 'nucleus', 'oral_groove', 'anal_pore'];

export function makePlayer(_eraOrder: number, x: number, y: number): Player {
  // 体积 = 4 + Σ先天器官体积（与 Metab.recompute 同公式，避免开局被钳制）
  const startVol = 4 + BUILT_IN_MODULES.reduce(
    (s, id) => s + DataStore.module(id).volume, 0);
  const hpMax = CONST.BASE_HP + startVol * CONST.HP_PER_VOL;
  const p: Player = {
    x, y, vx: 0, vy: 0, facing: 0,
    generation: 0,
    bodyVol: startVol,
    growthVol: 0,
    hp: hpMax,
    hpMax,
    modules: [...BUILT_IN_MODULES],
    modLevels: Object.fromEntries(BUILT_IN_MODULES.map(id => [id, 1])),
    nodes: [...BASE_NODES, ...builtInNodes()],
    // 先天器官管线：口沟→胃（已在 BASE_PIPES），胞肛→能量池、细胞核→大脑
    // 其余由 Logistics.autoWire 统一铺（见 newRun 末尾）
    pipes: [
      ...BASE_PIPES.map(l => ({ ...l })),
      { a: 'n_anal_pore', b: 'energy', level: 1, cap: CONST.BASE_NODE_CAP },
      { a: 'n_nucleus', b: 'brain', level: 1, cap: CONST.BASE_NODE_CAP },
    ],
    metab: {
      currentEnergy: 40, maxEnergy: 80, burstPool: 10, maxBurstPool: CONST.BURST_BASE,
      growthReserve: 0, residentLoad: 0, metabolicOutput: 0, digestionEfficiency: 0,
      pressure: 0,
      tier: { ratio: 1, chargeMod: 1, speedMod: 1, label: '健康' },
      bmr: 0,
    },
    digestBuffer: 0,
    digestCap: CONST.BUFFER_BASE,
    digestRate: CONST.DIGEST_RATE_BASE,
    maxVolumeBonus: 0,
    totalDrain: 0,
    metaUpTotal: 0,
    armorTotal: 0,
    speedTotal: CONST.BASE_SPEED,
    attackTotal: CONST.ATTACK_BASE,
    perceptionTotal: 0,
    attackCd: 0,
    invulnT: 0,
    hitFlash: 0,
    lowHpWarned: false,
  };
  return p;
}

/** 新开一局（血统记忆由 SaveSystem 注回） */
export function newRun(inheritedMemoryIds: string[] = [], generation = 0): GameState {
  const era = DataStore.era(0);
  const w = CONST.WORLD_W, h = CONST.WORLD_H;
  const st: GameState = {
    mode: 'menu',
    timeS: 0,
    eraIndex: 0,
    world: { w, h },
    player: makePlayer(0, w / 2, h / 2),
    ents: [],
    nextEntId: 1,
    memories: new Map(),
    disasters: [],
    nextDisasterAt: 75,
    disastersFiredThisEra: 0,
    milestoneDone: era.milestones.map(() => false),
    evoSession: false,
    evoPrompted: false,
    bloodline: { memories: [], generation, snapshots: [] },
    analytics: {
      runStartAt: Date.now(),
      firstEditAt: null,
      firstEraTransitionAt: null,
      editCount: 0,
      editsPerEra: [0, 0, 0],
      metabolicCrashCount: 0,
      crashAt: null,
      loopCompleted: false,
      fps: 60,
    },
    paused: false,
    diff: { ...DIFF_PRESETS.normal },
    camera: { x: w / 2, y: h / 2, zoom: 1 },
    input: { up: false, down: false, left: false, right: false },
    seed: (Math.random() * 0xffffffff) >>> 0,
    _crashLatched: false,
    _digestFullWarned: false,
    lastHitFrom: null,
    observeT: new Map(),
    dashT: 0,
    env: {
      zone: null, bmrMult: 1, outputMult: 1, photosynthMult: 1,
      toxicDps: 0, currentBoost: 0, visionMult: 1, foodMult: 1, predatorMult: 1,
    },
  };

  // 血统记忆 60% 继承（GDD 3.6 繁殖行 / 血统延续）
  const inherited = inheritedMemoryIds.slice(0, Math.ceil(inheritedMemoryIds.length * CONST.MEMORY_INHERIT));
  for (const sid of inherited) {
    st.memories.set(sid, { ...DataStore.memoryOf(sid), unlocked: true, interactionCount: 1 });
  }
  st.player.generation = generation;
  // 先天器官按层自动接入物流主干（幂等；确保拆过的管线能被补回）
  Logistics.autoWire(st.player);
  bus.emit(Ev.HUD_DIRTY);
  return st;
}

/** 局内运行统计（存活/进食/捕食等，结算与里程碑共用） */
export const Run = {
  survivedS: 0,
  eraSurvivedS: 0,
  eatenCount: 0,
  peakEnergy: 0,
  maxVolume: 4,
  speciesTasted: new Set<string>(),
  speciesPredated: new Set<string>(),
  disastersSurvived: new Set<string>(),

  reset() {
    this.survivedS = 0;
    this.eraSurvivedS = 0;
    this.eatenCount = 0;
    this.peakEnergy = 0;
    this.maxVolume = 4;
    this.speciesTasted.clear();
    this.speciesPredated.clear();
    this.disastersSurvived.clear();
  },
};
