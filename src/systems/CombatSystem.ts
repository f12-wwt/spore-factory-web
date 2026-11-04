import type { GameState, Entity } from '../types/GameState';
import { DataStore } from './DataStore';
import * as Organ from './OrganSystem';
import { CombatDepth } from './CombatDepth';
import { MemorySys } from './MemorySystem';
import { armorReduction } from './MetabolismSystem';
import { Run, playerRadius, CONST } from './RunState';
import { World } from './WorldSystem';
import { Ev, bus } from '../core/EventBus';
import { dist, clamp } from '../core/MathUtils';

/**
 * 战斗系统（GDD 3.8 / T11）：
 * 生命 = 体积×10 + 躯干加成；护甲减伤 = 护甲/(护甲+50)；攻击冷却 1~2 秒。
 * 击杀敌对/中立生物掉落蛋白质（拾取获得大量能量与爆发储能）。
 */
export const Combat = {
  /** 攻击者对目标造成一次伤害（含护甲公式），返回实际伤害 */
  strike(G: GameState, attacker: { attack: number; attackCd?: number; x: number; y: number }, target: Entity): number {
    const dmg = attacker.attack * (1 - armorReduction(target.armor));
    target.hp -= dmg;
    target.hitFlash = 0.25;
    MemorySys.interact(G, target.speciesId);
    if (target.hp <= 0 && target.aiState !== 'dead') {
      this.kill(G, target);
    }
    return dmg;
  },

  kill(G: GameState, target: Entity): void {
    target.aiState = 'dead';
    const def = DataStore.species(target.speciesId);
    // 敌对/中立击杀 → 掉落蛋白质（拾取物：提供更多能量与储能）
    if (target.kind === 'predator' || target.kind === 'neutral') {
      G.ents.push(World.makeProtein(G, def, target.x, target.y));
    }
  },

  /** 玩家接触攻击（撕咬）——直接用 Metab 缓存的 attackTotal（含器官强化加成） */
  playerBite(G: GameState, dt: number): void {
    const P = G.player;
    P.attackCd = Math.max(0, P.attackCd - dt);
    if (P.attackCd > 0) return;
    const biteAtk = P.attackTotal;
    // 撕咬范围与绘制体型一致（看得到身体就咬得到），口器另给少量延伸
    // v0.6：只算生效口器（被高阶覆盖的先天口沟不重复计入撕咬范围）
    const mouths = Organ.activeModules(P.modules)
      .filter(id => DataStore.module(id).category === 'mouth').length;
    const biteReach = playerRadius(P.bodyVol) + mouths * 6;
    for (const e of G.ents) {
      if (e.aiState === 'dead' || e.kind === 'food' || e.kind === 'corpse' || e.kind === 'protein') continue;
      if (dist(P.x, P.y, e.x, e.y) < e.radius + biteReach) {
        P.attackCd = CONST.ATTACK_CD;
        const dmg = this.strike(G, { attack: biteAtk, x: P.x, y: P.y }, e);
        bus.emit(Ev.TOAST, e.hp <= 0
          ? { text: `⚔️ 击杀了${DataStore.species(e.speciesId).name}！`, kind: 'good' }
          : { text: `⚔️ 撕咬造成 ${Math.round(dmg)} 伤害`, kind: 'info' });
        if (e.hp <= 0) {
          Run.speciesPredated.add(e.speciesId);
          MemorySys.notePredation(G, e.speciesId);
          G.player.metab.growthReserve += CONST.GROWTH_PER_KILL;
        }
        return;
      }
    }
  },

  /** 玩家受击（含无敌帧与濒死检测；v0.8：硬化状态额外减伤） */
  hurtPlayer(G: GameState, rawDmg: number, fromX: number, fromY: number): void {
    const P = G.player;
    if (P.invulnT > 0) return;
    // v0.8：硬化状态 —— 护甲 +50% 且额外减伤 30%
    const hardenArmor = CombatDepth.hardenBonus();
    const effectiveArmor = (P.armorTotal || 0) + hardenArmor;
    const hardenDR = hardenArmor > 0 ? 0.3 : 0;
    const dmg = rawDmg * (1 - armorReduction(effectiveArmor)) * (1 - hardenDR);
    P.hp -= dmg;
    P.hitFlash = 0.3;
    P.invulnT = 0.5;
    G.lastHitFrom = { x: fromX, y: fromY };
    if (P.hp <= P.hpMax * 0.25 && !P.lowHpWarned) {
      P.lowHpWarned = true;
      bus.emit(Ev.TOAST, { text: '❤️ 濒死预警！立即逃离或进食回血', kind: 'bad' });
    }
    if (P.hp <= 0) {
      P.hp = 0;
      bus.emit(Ev.PLAYER_DIED);
    }
  },

  /** 回血：能量充足时缓慢恢复 */
  regen(G: GameState, dt: number): void {
    const P = G.player;
    if (P.metab.currentEnergy > P.metab.maxEnergy * 0.5 && P.hp < P.hpMax) {
      P.hp = clamp(P.hp + 1.2 * dt, 0, P.hpMax);
      if (P.hp > P.hpMax * 0.5) P.lowHpWarned = false;
    }
  },
};
