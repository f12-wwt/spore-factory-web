import type { MemoryEntry } from './Memory';
import type { SpeciesSnapshot } from './Snapshot';
import type { FlowLayer } from './Module';
import type { EnvState } from './Zone';

export type GameMode = 'boot' | 'menu' | 'playing' | 'editing' | 'dead' | 'eraSplash';

/** 物流管道（GDD 3.3：连接节点，有长度、吞吐、延迟） */
export interface Pipe {
  a: string;
  b: string;
  level: number;      // 扩容等级（1 基础）
  cap: number;        // 吞吐 = base * level
}

/** 物流节点实例 */
export interface FlowNode {
  id: string;
  type: 'source' | 'process' | 'storage' | 'sink';
  /** 所属物流层（分层 UI + 按层解锁；旧存档缺省按 type 推断） */
  layer: FlowLayer;
  x: number;
  y: number;
  rate: number;         // 处理/存储能力
  moduleId?: string;    // 来源模块（卸载模块时移除）
  /** 由模块自动接入系统（不再需要玩家手拉管线） */
  auto?: boolean;
}

/** 实体种类（GDD：食物、中立、捕食者 3 种 AI + 掉落物） */
export type EntityKind = 'food' | 'neutral' | 'predator' | 'corpse' | 'offspring' | 'protein';

export interface Entity {
  id: number;
  kind: EntityKind;
  speciesId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  hp: number;
  hpMax: number;
  armor: number;
  attack: number;
  nutrition: number;
  dangerLevel: number;
  speed: number;
  /** AI 状态机（GDD 3.8：巡逻/觅食/逃跑/攻击） */
  aiState: 'patrol' | 'forage' | 'flee' | 'attack' | 'dead';
  aiTimer: number;
  attackCd?: number;
  targetKind?: 'player' | 'ent';
  targetId?: number;
  /** 追击累计时长（咬不到目标就放弃） */
  chaseT?: number;
  /** 脱战平静冷却（放弃追击后短暂不索敌） */
  calmT?: number;
  /** 存活倒计时（秒）：仅掉落物使用；到期即回收（AI 行为计时走 aiTimer） */
  ttl?: number;
  hitFlash: number;
  wobble: number;
}

/** 开局可调初始状态（GDD 2.1 玩家行为节奏 + 难度预设） */
export interface DiffConfig {
  label: string;
  preset: string;
  foodMult: number;     // 食物密度倍率
  hazardMult: number;   // 灾害频率倍率（越大越频繁）
  predMult: number;     // 敌对生物密度倍率
  predPower: number;    // 敌对生物强度倍率
  growthMult: number;   // 生长速度倍率
  startGrowth: number;  // 初始生长储备
}

/** 灾害实例（GDD 3.9：预警→爆发→恢复） */
export interface Disaster {
  defId: string;
  phase: 'warning' | 'burst' | 'recover';
  t: number;          // 当前阶段已持续时间
  x: number;
  y: number;
  radius: number;
  done?: boolean;     // 恢复期结束标记（帧末清除）
}

/** 代谢压力等级（GDD 3.2 压力表） */
export interface PressureTier {
  ratio: number;        // 器官效率
  chargeMod: number;    // 爆发池充能倍率（1 正常）
  speedMod: number;     // 速度倍率
  label: '健康' | '黄色警告' | '橙色警告' | '红色警告';
}

export interface MetabolismStats {
  currentEnergy: number;
  maxEnergy: number;
  burstPool: number;
  maxBurstPool: number;
  growthReserve: number;
  residentLoad: number;      // R = Σ 器官 residentDrain
  metabolicOutput: number;   // P
  digestionEfficiency: number;
  pressure: number;          // R / P
  tier: PressureTier;
  bmr: number;
}

/** 埋点数据（GDD T16 / 文件 8 验证指标） */
export interface Analytics {
  runStartAt: number;          // 本局开始（performance.now 基准由调用方换算）
  firstEditAt: number | null;  // 首次打开编辑器（局内秒）
  firstEraTransitionAt: number | null;
  editCount: number;           // 编辑会话次数
  editsPerEra: number[];
  metabolicCrashCount: number; // 代谢崩溃（压力 >130%，红色警告）次数
  crashAt: number | null;
  loopCompleted: boolean;      // 完成一次 吃→长→编辑→纪元 完整循环
  fps: number;
}

/** 运行时玩家 */
export interface Player {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  generation: number;       // 繁殖代数
  bodyVol: number;          // 体积（继承/生长变化）
  growthVol: number;        // 生长体积（历史字段：v0.4 起不再随进食自然增长）
  hp: number;
  hpMax: number;
  modules: string[];        // 已安装模块 id（可叠加，同类占对应槽位）
  /** 模块强化等级（id → Lv，1 = 未强化；卸载重装清零） */
  modLevels: Record<string, number>;
  nodes: FlowNode[];
  pipes: Pipe[];
  metab: MetabolismStats;
  digestBuffer: number;     // 胃中待消化原料
  digestCap: number;        // 消化缓存容量
  digestRate: number;       // 消化速率（能量/秒）：基准 + 吞吐贡献，受压力效率折扣
  maxVolumeBonus: number;   // 体积上限加成（防御/躯干类强化累积，每级 +MAX_VOL_PER_UP）
  /** 当前总消耗 = BMR + 移动 + 感知 + R（与实际扣能量完全一致，代谢压力 = totalDrain / P） */
  totalDrain: number;
  metaUpTotal: number;      // 代谢类器官强化的产出加成（小数，0.12 = +12%；Σ META_UP_PCT × 强化级数）
  armorTotal: number;       // Σ 护甲（含模块）
  speedTotal: number;       // 当前实际速度 px/s
  attackTotal: number;      // Σ 攻击
  perceptionTotal: number;  // Σ 感知（recompute 缓存，供视野/感知消耗复用）
  attackCd: number;
  invulnT: number;          // 受击无敌帧
  hitFlash: number;
  lowHpWarned: boolean;     // 濒死提示
}

export interface GameState {
  mode: GameMode;
  timeS: number;           // 局内累计秒
  eraIndex: number;
  world: { w: number; h: number };
  player: Player;
  ents: Entity[];
  nextEntId: number;
  memories: Map<string, MemoryEntry>;
  disasters: Disaster[];
  nextDisasterAt: number;
  disastersFiredThisEra: number;
  /** 里程碑达成缓存（编辑器/HUD 读取） */
  milestoneDone: boolean[];
  /** 纪元推进会话：里程碑已满，编辑器解锁下一纪元模块 */
  evoSession: boolean;
  evoPrompted: boolean;
  /** 血统：上一代的记忆（死亡后 60% 继承进下一局） */
  bloodline: { memories: string[]; generation: number; snapshots: SpeciesSnapshot[] };
  analytics: Analytics;
  paused: boolean;
  /** 开局初始状态（设置界面可调，跨重启保留） */
  diff: DiffConfig;
  /** 相机真实滚动/缩放（WorldScene 每帧回写，五感叠层据此锚定） */
  camera: { x: number; y: number; zoom: number };
  input: { up: boolean; down: boolean; left: boolean; right: boolean };
  seed: number;
  /** 代谢崩溃边沿锁（避免重复埋点） */
  _crashLatched: boolean;
  /** 胃满提示边沿锁（避免每帧刷屏） */
  _digestFullWarned: boolean;
  /** 最近一次受击来源（触觉方向显示） */
  lastHitFrom: { x: number; y: number } | null;
  /** 观察计数：speciesId → 累计注视秒 */
  observeT: Map<string, number>;
  /** 冲刺剩余时间（爆发池技能） */
  dashT: number;
  /** 当前环境状态（v0.7：由 EnvironmentSystem 每帧更新） */
  env: EnvState;
}
