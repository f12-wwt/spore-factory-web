import type { GameState, PressureTier } from '../types/GameState';
import { DataStore } from './DataStore';
import { Logistics } from './LogisticsSystem';
import * as Organ from './OrganSystem';
import { CONST } from './RunState';
import { clamp } from '../core/MathUtils';
import { Ev, bus } from '../core/EventBus';

/**
 * 代谢系统（GDD 3.2 / T3）——双轨制：
 *   P = 消化效率 × 吞吐系数（×温度系数由灾害在伤害端体现）
 *   R = Σ 器官.residentDrain
 *   E变化 = P − BMR − 移动 − 感知 − R
 *   代谢压力 = R / P → 四档压力表
 */

/** GDD 3.2 代谢压力表（导出供单元测试）
 *  v0.6：阈值放宽至 90% / 110% / 130%——正常构筑稳在健康区，
 *  只有真正贪装或缺代谢器官时才告警，避免"装几个器官就变红字"。
 *  ratio/chargeMod/speedMod 为「保留比例」：1 = 100%、0.6 = 60%（按 GDD 百分比语义展示） */
export function pressureTier(pressure: number): PressureTier {
  if (pressure > 1.3) return { ratio: 0.3, chargeMod: 0, speedMod: 0.75, label: '红色警告' };
  if (pressure > 1.1) return { ratio: 0.6, chargeMod: 0.3, speedMod: 0.8, label: '橙色警告' };
  if (pressure > 0.9) return { ratio: 0.85, chargeMod: 0.7, speedMod: 1, label: '黄色警告' };
  return { ratio: 1, chargeMod: 1, speedMod: 1, label: '健康' };
}

/** 代谢压力档位的中文描述（百分比语义，供 UI 显示） */
export function pressureDesc(tier: PressureTier): string {
  return `器官效率 ${Math.round(tier.ratio * 100)}% · 充能 ${Math.round(tier.chargeMod * 100)}% · 速度 ${Math.round(tier.speedMod * 100)}%`;
}

/** 护甲减伤（GDD 3.8：减伤 = 护甲 / (护甲 + 50)，导出供单元测试） */
export function armorReduction(armor: number): number {
  return armor / (armor + 50);
}

export const Metab = {
  /** 重算玩家全部衍生属性（安装/卸载/强化/纪元过渡后调用） */
  recompute(G: GameState): void {
    const P = G.player;

    // v0.6 上位替代：同槽位只计最高位次那一件，低阶被"覆盖"（先天器官仍在体内，
    // 但不再叠加属性——否则口沟+口器+尖牙会三重叠加，体积与消耗双双失控）。
    const active = Organ.activeModules(P.modules);
    const mods = active.map(id => DataStore.module(id));
    const eff = active.map(id => DataStore.effStats(DataStore.module(id), P.modLevels[id] ?? 1));

    // 强化同步模块物流节点吞吐
    for (const n of P.nodes) {
      if (!n.moduleId) continue;
      const m = DataStore.module(n.moduleId);
      if (!m.node) continue;
      const es = DataStore.effStats(m, P.modLevels[n.moduleId] ?? 1);
      n.rate = es.nodeRate;
    }

    // 体积 = 基础 + 模块体积（含强化增重）；v0.4 起不随进食自然增长
    const modVol = eff.reduce((s, e) => s + e.volume, 0);
    const era = DataStore.era(G.eraIndex);

    // 体积上限加成：防御/躯干类器官强化每级 +MAX_VOL_PER_UP（强化细胞壁/骨骼 = 扩仓）
    // 只统计生效件：被高阶覆盖的低阶器官不占体积上限
    P.maxVolumeBonus = active.reduce((s, id) => {
      const cat = DataStore.module(id).category;
      if (cat !== 'defense' && cat !== 'trunk') return s;
      return s + ((P.modLevels[id] ?? 1) - 1) * CONST.MAX_VOL_PER_UP;
    }, 0);
    P.bodyVol = clamp(4 + modVol + (P.growthVol || 0), era.volumeMin, era.volumeMax + P.maxVolumeBonus);

    // 感知汇总（视野范围与感知消耗共用缓存，避免每帧 reduce 模块表）
    // 注意：必须用 eff（强化后值），否则感官器官强化不会增加视野
    P.perceptionTotal = eff.reduce((s, e) => s + e.perceptionMod, 0);

    P.metab.maxEnergy = 80 + P.nodes.filter(n => n.type === 'storage').reduce((s, n) => s + n.rate, 0) * 1.2;
    P.metab.maxBurstPool = CONST.BURST_BASE
      + P.modules.reduce((s, id) => {
        if (id !== 'granule') return s;
        return s + 15 + 5 * ((P.modLevels[id] ?? 1) - 1);
      }, 0);
    P.metab.burstPool = clamp(P.metab.burstPool, 0, P.metab.maxBurstPool);

    P.metab.bmr = CONST.BMR_BASE + CONST.BMR_PER_VOL * P.bodyVol;
    P.metab.residentLoad = eff.reduce((s, e) => s + e.residentDrain, 0);

    const svc = Logistics.services(P);
    P.metab.digestionEfficiency = svc.digestionEfficiency;

    // 代谢类器官强化 → 产出百分比加成（GDD 2.3 百分比语义：每级 +12%）
    P.metaUpTotal = active.reduce((s, id) => {
      const m = DataStore.module(id);
      if (m.category !== 'metabolism') return s;
      return s + CONST.META_UP_PCT * ((P.modLevels[id] ?? 1) - 1);
    }, 0);
    // P = (基础 + 吞吐贡献) × (1 + 强化百分比加成)
    P.metab.metabolicOutput =
      (CONST.P_BASE + CONST.P_PER_PATH * svc.digestCap) * (1 + P.metaUpTotal);

    // 消化缓存容量 = 基础 + 处理节点（含强化后的处理量）
    P.digestCap = CONST.BUFFER_BASE + P.nodes.filter(n => n.type === 'process').reduce((s, n) => s + n.rate, 0);
    // 消化速率 = 基准 + 处理容量贡献（装处理器官 = 胃排空更快，胃满不再是死路）
    P.digestRate = (CONST.DIGEST_RATE_BASE + CONST.DIGEST_RATE_PER_PATH * P.digestCap)
      * svc.digestionEfficiency;

    // 编辑态预估压力：静止状态（不含移动）的真实消耗；运行期由 update 用含移动的 totalDrain 刷新
    const idleDrain = P.metab.bmr + CONST.SENSE_DRAIN + CONST.SENSE_DRAIN_PER_PERCEPT * P.perceptionTotal
      + P.metab.residentLoad;
    P.totalDrain = idleDrain;
    P.metab.pressure = P.metab.metabolicOutput > 0 ? idleDrain / P.metab.metabolicOutput : Infinity;
    P.metab.tier = pressureTier(P.metab.pressure);

    // 汇总攻击 / 护甲 / 速度（GDD 3.8 生命公式在下方）
    // v0.8：器官协同加成（同类别多器官触发奖励）
    const syn = Organ.synergyTotals(P.modules);
    P.attackTotal = CONST.ATTACK_BASE + eff.reduce((s, e) => s + e.attackMod, 0) + syn.attack;
    P.armorTotal = eff.reduce((s, e) => s + e.armorMod, 0) + syn.armor;
    P.speedTotal = (CONST.BASE_SPEED + CONST.SPEED_PER_MOD * eff.reduce((s, e) => s + e.speedMod, 0) + syn.speed)
      * P.metab.tier.speedMod;

    // 生命 = 体积×10 + 躯干加成（GDD 3.8）
    const hpMax = CONST.BASE_HP + P.bodyVol * CONST.HP_PER_VOL
      + mods.filter(m => m.category === 'trunk').length * CONST.TRUNK_HP_BONUS;
    P.hpMax = hpMax;
    P.hp = clamp(P.hp, 0, hpMax);
  },

  /** 当前体积上限 = 纪元上限 + 防御/躯干类强化加成（编辑器显示/安装校验/钳制共用） */
  volumeCap(G: GameState): number {
    return DataStore.era(G.eraIndex).volumeMax + G.player.maxVolumeBonus;
  },

  /** 每帧代谢结算 */
  update(G: GameState, dt: number): void {
    const P = G.player;
    const m = P.metab;
    const tier = m.tier;

    // 移动消耗与速度
    const speed = Math.hypot(P.vx, P.vy);
    const moving = speed > 5 ? 1 : 0;
    const moveDrain = CONST.MOVE_DRAIN_PER_SPEED * speed;
    const senseDrain = CONST.SENSE_DRAIN + CONST.SENSE_DRAIN_PER_PERCEPT * P.perceptionTotal;

    // 消化：缓存 → 能量（速率随消化道吞吐提升；器官效率受压力影响）
    // v0.7：环境倍率影响消化速率（低温区消化变慢）
    const envRate = G.env?.outputMult ?? 1;
    const digestRate = P.digestRate * tier.ratio * envRate;
    const digested = Math.min(P.digestBuffer, digestRate * dt);
    P.digestBuffer -= digested;
    const room = m.maxEnergy - m.currentEnergy;
    const gained = Math.min(digested, Math.max(0, room));
    m.currentEnergy += gained;

    // 溢出 → 生长储备（受开局"生长速度"倍率）。
    // v0.4：体积不再随进食增长——体积只由已安装器官决定，上限靠强化/进化提升。
    const overflow = digested - gained;
    if (overflow > 0) {
      m.growthReserve += overflow * 0.5 * (G.diff?.growthMult ?? 1);
    }

    // 体积逐帧同步（器官增删/强化变化 → 体积里程碑/生命上限即时生效）
    {
      const era = DataStore.era(G.eraIndex);
      P.bodyVol = clamp(4 + modVolOf(P) + (P.growthVol || 0), era.volumeMin, era.volumeMax + P.maxVolumeBonus);
    }

    // 常驻支出：BMR × 环境倍率 + 移动 + 感知 + R（R 不可恢复，只能编辑态卸载）
    // v0.7：热泉区 BMR ×1.5，冷泉区 ×0.6
    const envBmr = G.env?.bmrMult ?? 1;
    const drain = m.bmr * envBmr + moveDrain * moving + senseDrain + m.residentLoad;
    P.totalDrain = drain;
    m.pressure = m.metabolicOutput > 0 ? drain / m.metabolicOutput : Infinity;
    m.tier = pressureTier(m.pressure);
    m.currentEnergy -= drain * dt;

    // 爆发池充能（压力表：充能受惩罚；光合器加成随强化等级与环境光照提升）
    const photoLv = P.modules.includes('photosynth') ? (P.modLevels.photosynth ?? 1) : 0;
    const photoBase = photoLv ? 0.6 + 0.2 * (photoLv - 1) : 0;
    const photoBonus = photoBase * (G.env?.photosynthMult ?? 1);
    m.burstPool = clamp(m.burstPool + (CONST.BURST_CHARGE * tier.chargeMod + photoBonus) * dt, 0, m.maxBurstPool);

    // 能量归零 → 生命扣减（濒死机制）
    if (m.currentEnergy <= 0) {
      m.currentEnergy = 0;
      P.hp -= 4 * dt;
    }

    // 压力崩溃埋点（GDD T16：代谢崩溃率 20%~40% 属策略范畴）
    if (m.pressure > 1 && tier.label === '红色警告' && !G._crashLatched) {
      G._crashLatched = true;
      G.analytics.metabolicCrashCount++;
      if (G.analytics.crashAt === null) G.analytics.crashAt = G.timeS;
      bus.emit(Ev.METABOLIC_CRASH);
      bus.emit(Ev.TOAST, { text: '⚠️ 代谢崩溃！器官效率骤降，请立即减负', kind: 'bad' });
    } else if (m.pressure <= 1.1) {
      G._crashLatched = false;
    }

    // 峰值统计（能量里程碑在 StageSystem 中判定）
  },
};

/** 模块总体积（含强化增重：防御/躯干类每级 +0.5）
 *  v0.6：只统计生效件，被高阶槽位覆盖的低阶器官不计体积 */
function modVolOf(P: import('../types/GameState').Player): number {
  return Organ.activeModules(P.modules).reduce((s, id) =>
    s + DataStore.effStats(DataStore.module(id), P.modLevels[id] ?? 1).volume, 0);
}
