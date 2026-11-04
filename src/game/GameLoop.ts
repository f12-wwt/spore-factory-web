import type { GameState } from '../types/GameState';
import { Run } from '../systems/RunState';
import { Metab } from '../systems/MetabolismSystem';
import { World } from '../systems/WorldSystem';
import { AISys } from '../systems/AISystem';
import { Combat } from '../systems/CombatSystem';
import { DisasterSys } from '../systems/DisasterSystem';
import { Stage } from '../systems/StageSystem';
import { MemorySys } from '../systems/MemorySystem';
import { Env } from '../systems/EnvironmentSystem';
import { CombatDepth } from '../systems/CombatDepth';
import { CONST } from '../systems/RunState';
import { dist } from '../core/MathUtils';
import { Ev, bus } from '../core/EventBus';

/**
 * 主循环编排（GDD 4.2 Systems 编排）：
 * 每帧依次驱动 玩家/世界/AI/战斗/代谢/灾害/感知/纪元；编辑态暂停模拟。
 */
export const GameLoop = {
  startRun(G: GameState): void {
    Run.reset();
    Metab.recompute(G);
    G.player.metab.currentEnergy = Math.min(G.player.metab.maxEnergy, 45);
    G.player.metab.growthReserve = G.diff.startGrowth || 0; // 开局初始储备
    G.nextDisasterAt = 75 / (G.diff.hazardMult || 1);        // 首灾时间受灾害频率影响
    World.spawnInitial(G);
    G.mode = 'playing';
    bus.emit(Ev.HUD_DIRTY);
  },

  update(G: GameState, dtReal: number): void {
    if (G.mode !== 'playing' || G.paused) return;
    // 帧长钳制（后台恢复/断点不掉帧暴走）
    const dt = Math.min(0.05, dtReal);
    G.timeS += dt;
    Run.survivedS += dt;
    Run.eraSurvivedS += dt;

    // —— 感知消耗在代谢里按模块计；移动/世界/AI ——
    G.dashT = Math.max(0, G.dashT - dt);
    G.env = Env.compute(G); // v0.7：环境状态每帧更新
    World.updatePlayer(G, dt, G.dashT > 0 ? CONST.DASH_SPEED_MULT : 1);
    World.maintain(G, dt);
    AISys.update(G, dt);
    AISys.resolveAttacks(G, dt, (dmg, fx, fy) => Combat.hurtPlayer(G, dmg, fx, fy));
    World.updateEating(G);
    Metab.update(G, dt);
    Combat.playerBite(G, dt);
    Combat.regen(G, dt);
    CombatDepth.update(G, dt); // v0.8：技能冷却 + 状态效果驱动
    DisasterSys.update(G, dt);

    // v0.7：环境毒性伤害（有氧酶可中和 70%，已在 Env.compute 处理）
    if (G.env.toxicDps > 0) {
      G.player.hp -= G.env.toxicDps * dt;
      if (G.player.hp <= 0) {
        G.player.hp = 0;
        bus.emit(Ev.PLAYER_DIED);
      }
    }

    // 运行统计
    const m = G.player.metab;
    Run.peakEnergy = Math.max(Run.peakEnergy, m.currentEnergy);
    Run.maxVolume = Math.max(Run.maxVolume, G.player.bodyVol);

    // 观察解锁记忆（视觉范围内凝视 1.5s，GDD 3.5）
    this.observe(G, dt);

    // 里程碑检查（1s 节流）+ HUD 连续刷新（4Hz：灾害倒计时/压力表）
    this.stageAcc = (this.stageAcc || 0) + dt;
    this.hudAcc = (this.hudAcc || 0) + dt;
    if (this.stageAcc >= 1) {
      this.stageAcc = 0;
      Stage.check(G);
    }
    if (this.hudAcc >= 0.25) {
      this.hudAcc = 0;
      bus.emit(Ev.HUD_DIRTY);
    }
  },

  stageAcc: 0,
  hudAcc: 0,

  /** 观察：视野内未知生物凝视累计 → 解锁（GDD 3.5 进食/攻击/观察） */
  observe(G: GameState, dt: number): void {
    const P = G.player;
    const vision = CONST.VISION_BASE + CONST.VISION_PER_PERCEPT * P.perceptionTotal; // recompute 缓存
    for (const e of G.ents) {
      if (e.aiState === 'dead' || e.kind === 'corpse') continue;
      const mem = G.memories.get(e.speciesId);
      if (mem?.unlocked) continue;
      if (dist(P.x, P.y, e.x, e.y) < vision * 0.75) {
        const t = (G.observeT.get(e.speciesId) || 0) + dt;
        G.observeT.set(e.speciesId, t);
        if (t >= CONST.VISION_MEMORY_TIME) {
          MemorySys.interact(G, e.speciesId);
        }
      }
    }
  },
};
