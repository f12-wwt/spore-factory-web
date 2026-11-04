/**
 * 环境分区（v0.7）：世界不再是均匀的空旷海域，而是由不同环境特征的区域组成。
 *
 * 每个区域有温度/氧气/光照/洋流/毒性五项参数，通过 `mods` 影响代谢与战斗：
 *   bmrMult      基础代谢倍率（冷区 <1，热区 >1）
 *   outputMult   代谢产出倍率（高氧 >1，低氧 <1）
 *   photosynthMult 光合器官产出倍率（高光照 >1）
 *   toxicDps     毒性每秒伤害（无对应防御时）
 *   currentBoost 洋流推力（对齐洋流方向时加速）
 *   visionMult   视野倍率（密林/浑浊 <1）
 *   foodMult     食物生成密度倍率
 *   predatorMult 捕食者生成密度倍率
 */
export interface ZoneDef {
  id: string;
  name: string;
  era: number;
  /** 相对世界坐标（0~1），运行时乘以世界宽高 */
  x: number;
  y: number;
  /** 区域半径（像素） */
  radius: number;
  /** 五项环境参数（0~1，temperature 0=极寒 2=极热） */
  temperature: number;
  oxygen: number;
  light: number;
  current: number;
  toxicity: number;
  /** 区域主色（渲染用） */
  color: string;
  desc: string;
  mods: Partial<ZoneMods>;
}

/** 环境对玩家的影响 */
export interface ZoneMods {
  bmrMult: number;
  outputMult: number;
  photosynthMult: number;
  toxicDps: number;
  currentBoost: number;
  visionMult: number;
  foodMult: number;
  predatorMult: number;
}

/** 玩家当前所处环境的计算结果 */
export interface EnvState {
  /** 所在区域（null = 无区域覆盖的开放水域） */
  zone: ZoneDef | null;
  /** 混合后的实际影响（区域边界处与开放水域按距离插值） */
  bmrMult: number;
  outputMult: number;
  photosynthMult: number;
  toxicDps: number;
  currentBoost: number;
  visionMult: number;
  foodMult: number;
  predatorMult: number;
}
