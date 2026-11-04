import type { GameState } from '../types/GameState';
import { DataStore } from './DataStore';
import { Run, CONST } from './RunState';
import { MemorySys } from './MemorySystem';
import { Metab } from './MetabolismSystem';
import { Logistics } from './LogisticsSystem';
import { Ev, bus } from '../core/EventBus';
import { Analytics } from './AnalyticsSystem';

/**
 * 纪元系统（GDD 3.7 / T12）：
 * 多条件里程碑（存活/能量/记忆数/食物种数/捕食种数/体积/模块/灾害幸存）
 * → 全部达成 → 自动弹编辑器（孢子式）→ 装关键模块保存 → 过渡继承 → 新纪元。
 */
export const Stage = {
  /** 单个里程碑是否达成 */
  met(G: GameState, m: import('../types/Era').Milestone): boolean {
    switch (m.type) {
      case 'survive': return Run.eraSurvivedS >= m.value;
      case 'energy': return G.player.metab.currentEnergy >= m.value || Run.peakEnergy >= m.value;
      case 'memoryCount': return MemorySys.count(G) >= m.value;
      case 'foodTypes': return Run.speciesTasted.size >= m.value;
      case 'predation': return Run.speciesPredated.size >= m.value;
      case 'volume': return G.player.bodyVol >= m.value;
      case 'module': return G.player.modules.includes(m.target ?? '');
      case 'disasterSurvived': return Run.disastersSurvived.has(m.target ?? '');
      default: return false;
    }
  },

  /** 每秒检查里程碑（闩锁：达成后不因数值回落而撤销） */
  check(G: GameState): void {
    const era = DataStore.era(G.eraIndex);
    let all = true;
    era.milestones.forEach((m, i) => {
      if (!G.milestoneDone[i] && this.met(G, m)) {
        G.milestoneDone[i] = true;
        bus.emit(Ev.TOAST, { text: `✅ 纪元目标达成：${m.desc}`, kind: 'good' });
      }
      if (!G.milestoneDone[i]) all = false;
    });

    if (all && !G.evoSession && !G.evoPrompted) {
      G.evoSession = true;
      bus.emit(Ev.ERA_MILESTONE_READY, era);
      bus.emit(Ev.TOAST, {
        text: `🧬 纪元目标全部达成！编辑器已解锁【${DataStore.eraAt(G.eraIndex + 1)?.name ?? '终局'}】模块——完成关键进化推进纪元`,
        kind: 'good',
      });
      bus.emit(Ev.EDITOR_OPEN, { milestone: true });
    }
  },

  /** 保存编辑器时判定：能否推进纪元 */
  canAdvance(G: GameState): boolean {
    const era = DataStore.era(G.eraIndex);
    if (!G.evoSession) return false;
    if (era.keyModule) return G.player.modules.includes(era.keyModule);
    // 无关键模块的纪元由条件判定（太古宙：代谢效率 ≥ 50%）
    return G.player.metab.digestionEfficiency >= 0.5;
  },

  /** 纪元过渡（GDD 3.6 继承表：记忆100% / 网络80% / 体积60% / 储备50%） */
  advance(G: GameState): void {
    const era = DataStore.era(G.eraIndex);
    const P = G.player;

    // 末纪元完成关键进化 → 三纪元闭环通关（GDD M1 终局）
    if (!DataStore.eraAt(era.order + 1)) {
      G.evoSession = false;
      G.evoPrompted = true;
      bus.emit(Ev.RUN_COMPLETE, era);
      return;
    }

    // 网络 80%：随机 20% 管线降级一档（下限 1）
    const degrade = Math.max(1, Math.floor(P.pipes.length * 0.2));
    const idxs = P.pipes.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, degrade);
    for (const i of idxs) {
      P.pipes[i].level = Math.max(1, P.pipes[i].level - 1);
      P.pipes[i].cap = P.pipes[i].level * 8;
    }

    // 体积 60% / 储备 50%
    P.growthVol *= era.inherit.volume;
    P.metab.growthReserve *= era.inherit.growth;
    P.digestBuffer = 0;
    P.metab.currentEnergy = Math.min(P.metab.maxEnergy, P.metab.currentEnergy + 30);

    MemorySys.onEraTransition(G);
    Metab.recompute(G);

    G.eraIndex = era.order + 1;
    const next = DataStore.era(G.eraIndex);
    // 管网随纪元自然升级：所有管线的基础容量抬到新纪元基准（扩容等级保留）
    const eraCap = CONST.pipeCapOf(G.eraIndex);
    for (const pipe of G.player.pipes) {
      pipe.cap = Math.max(pipe.cap, eraCap);
    }
    Logistics.autoWire(G.player);
    Metab.recompute(G);
    G.milestoneDone = next.milestones.map(() => false);
    G.evoSession = false;
    G.evoPrompted = false;
    G.disasters = [];
    G.disastersFiredThisEra = 0;
    G.nextDisasterAt = 60;
    Run.eraSurvivedS = 0;

    Analytics.onEraTransition(G);
    bus.emit(Ev.ERA_ADVANCED, next);
    bus.emit(Ev.TOAST, { text: `🧬 进入 ${next.name}！${next.transitionEvent}`, kind: 'good' });
  },
};
