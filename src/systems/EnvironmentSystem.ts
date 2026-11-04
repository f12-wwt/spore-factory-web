import type { GameState } from '../types/GameState';
import type { ZoneDef, ZoneMods, EnvState } from '../types/Zone';
import { DataStore } from './DataStore';
import { dist } from '../core/MathUtils';

/**
 * 环境系统（v0.7）：世界由不同环境特征的区域组成，玩家所处位置决定代谢与战斗参数。
 *
 * 设计意图：
 *   - 让"去哪里"成为策略选择——热泉区高代谢高产出但缺氧，冷泉区节能但有毒
 *   - 给感知系统（感光点/复眼）一个探索回报：看到环境变化才能提前规划路线
 *   - 给光合器官一个"阳光区"加成，鼓励在富氧表层/浅水区活动
 *   - 洋流区域提供免费推力（对齐方向时加速），引导玩家顺势移动
 *
 * 区域边界用平滑过渡（soft edge）：靠近边界时效果渐变，不产生突兀的数值跳变。
 */

/** 默认环境（无区域覆盖的开放水域） */
const NEUTRAL: ZoneMods = {
  bmrMult: 1,
  outputMult: 1,
  photosynthMult: 1,
  toxicDps: 0,
  currentBoost: 0,
  visionMult: 1,
  foodMult: 1,
  predatorMult: 1,
};

/**
 * 边界软过渡系数（0~1）：
 *   0 = 区域外（效果为中性值）
 *   1 = 区域中心（效果为区域完整值）
 *  在 radius × 0.7 到 radius 之间线性过渡，radius × 0.7 以内为 1。
 */
function edgeFactor(d: number, radius: number): number {
  if (d <= radius * 0.7) return 1;
  if (d >= radius) return 0;
  return 1 - (d - radius * 0.7) / (radius * 0.3);
}

/** 只保留 mods 里声明了的键（未声明的保持中性值） */
function applyMods(base: ZoneMods, mods: Partial<ZoneMods>, factor: number): void {
  for (const [k, v] of Object.entries(mods)) {
    if (v === undefined) continue;
    const key = k as keyof ZoneMods;
    const neutral = NEUTRAL[key];
    base[key] = neutral + (v - neutral) * factor;
  }
}

export const Env = {
  /** 计算玩家当前所处环境（每帧调用，代价极低：3 个区域 × 1 次 dist） */
  compute(G: GameState): EnvState {
    const zones = DataStore.zonesForEra(G.eraIndex);
    const P = G.player;

    // 以中性值为基底，逐区域叠加（多个区域重叠时取效果最强的那个）
    const result: ZoneMods = { ...NEUTRAL };
    let bestZone: ZoneDef | null = null;
    let bestFactor = 0;

    for (const z of zones) {
      const zx = z.x * G.world.w;
      const zy = z.y * G.world.h;
      const d = dist(P.x, P.y, zx, zy);
      const f = edgeFactor(d, z.radius);
      if (f <= 0) continue;
      if (f > bestFactor) { bestFactor = f; bestZone = z; }
      applyMods(result, z.mods, f);
    }

    // 毒性区域需要有氧酶/外骨骼才安全
    if (result.toxicDps > 0 && P.modules.includes('aerogenase')) {
      result.toxicDps *= 0.3; // 有氧酶中和 70% 毒性
    }

    return {
      zone: bestZone,
      ...result,
    };
  },

  /** 毒性伤害（在 Metab.tick 里调用，返回每秒伤害） */
  toxicDps(env: EnvState): number {
    return env.toxicDps;
  },

  /** 洋流推力方向（返回单位向量或 null） */
  currentDir(env: EnvState): { x: number; y: number } | null {
    if (env.currentBoost <= 0.05 || !env.zone) return null;
    // 洋流方向：从区域中心向外辐射（简单模型）
    return null; // TODO: 后续版本加入洋流向量
  },
};
