import type { GameState, Entity } from '../types/GameState';
import type { StatusEffect, StatusKind } from '../types/Combat';
import { SKILLS } from '../types/Combat';
import { DataStore } from './DataStore';
import * as Organ from './OrganSystem';
import { armorReduction } from './MetabolismSystem';
import { playerRadius } from './RunState';
import { Ev, bus } from '../core/EventBus';
import { dist, clamp } from '../core/MathUtils';

/**
 * 战斗深度系统（v0.8）：
 *   技能释放 · 状态效果驱动 · 器宫协同加成 · 敌人特殊攻击
 *
 * 设计原则：
 *   - 技能与器官绑定（没有对应器官 = 无法使用），让构筑直接决定战斗风格
 *   - 状态效果有上限（毒最多 3 层），避免数值失控
 *   - 协同加成是"奖励"而非"必需"，正常不叠协同也能通关
 */

/** 毒素喷射的扇形角度（弧度） */
const TOXIN_CONE = Math.PI / 3; // 60°
/** 毒素喷射距离 */
const TOXIN_RANGE = 120;
/** 猛冲距离 */
const LUNGE_DIST = 200;

/** 玩家技能冷却状态 */
const skillCd: Record<string, number> = {};

/** 玩家当前状态效果 */
const playerStatuses: StatusEffect[] = [];

export const CombatDepth = {
  /** 技能是否可用（器官满足 + 冷却就绪 + 资源足够） */
  canUse(G: GameState, skillId: string): { ok: boolean; reason: string } {
    const skill = SKILLS.find(s => s.id === skillId);
    if (!skill) return { ok: false, reason: '未知技能' };

    // 器官检查
    const act = Organ.activeModules(G.player.modules);
    const hasOrgan = skill.requires.some(r => act.includes(r));
    if (!hasOrgan) {
      return { ok: false, reason: `需要 ${skill.requires.map(r => DataStore.module(r).name).join('/')} 之一` };
    }
    // 冷却检查
    if ((skillCd[skillId] ?? 0) > 0) {
      return { ok: false, reason: `冷却中 ${(skillCd[skillId]).toFixed(1)}s` };
    }
    // 资源检查
    const m = G.player.metab;
    if (skill.energyCost > 0 && m.currentEnergy < skill.energyCost) {
      return { ok: false, reason: `能量不足（需 ${skill.energyCost}）` };
    }
    if (skill.burstCost > 0 && m.burstPool < skill.burstCost) {
      return { ok: false, reason: `爆发不足（需 ${skill.burstCost}）` };
    }
    return { ok: true, reason: '' };
  },

  /** 释放技能 */
  activate(G: GameState, skillId: string): boolean {
    const check = this.canUse(G, skillId);
    if (!check.ok) {
      bus.emit(Ev.TOAST, { text: check.reason, kind: 'warn' });
      return false;
    }
    const skill = SKILLS.find(s => s.id === skillId)!;
    const P = G.player;
    const m = P.metab;

    // 扣资源
    m.currentEnergy -= skill.energyCost;
    m.burstPool -= skill.burstCost;
    skillCd[skillId] = skill.cooldown;

    switch (skillId) {
      case 'toxin_spray': this.toxinSpray(G); break;
      case 'harden': this.harden(G); break;
      case 'lunge': this.lunge(G); break;
    }
    return true;
  },

  /** Q：毒素喷射 —— 前方扇形，造成伤害 + 中毒 */
  toxinSpray(G: GameState): void {
    const P = G.player;
    const baseDmg = P.attackTotal * 0.6;
    const facing = Math.atan2(P.vy || 0.001, P.vx || 1);
    let hitCount = 0;

    for (const e of G.ents) {
      if (e.aiState === 'dead' || e.kind === 'food' || e.kind === 'corpse' || e.kind === 'protein') continue;
      const d = dist(P.x, P.y, e.x, e.y);
      if (d > TOXIN_RANGE + e.radius) continue;
      const angleTo = Math.atan2(e.y - P.y, e.x - P.x);
      const angleDiff = Math.abs(normalizeAngle(angleTo - facing));
      if (angleDiff > TOXIN_CONE / 2) continue;

      // 伤害（无视护甲 50%：毒素穿透）
      const dmg = baseDmg * (1 - armorReduction(e.armor) * 0.5);
      e.hp -= dmg;
      e.hitFlash = 0.3;
      // 中毒（可叠 3 层）
      this.applyStatus(e, 'poison', 3, 2.0);
      hitCount++;
      if (e.hp <= 0) {
        e.aiState = 'dead';
        bus.emit(Ev.TOAST, { text: `☠ 毒素击杀了${DataStore.species(e.speciesId).name}！`, kind: 'good' });
      }
    }
    if (hitCount > 0) {
      bus.emit(Ev.TOAST, { text: `☠ 毒素喷射命中 ${hitCount} 个目标`, kind: 'good' });
    } else {
      bus.emit(Ev.TOAST, { text: '☠ 毒素喷射未命中', kind: 'info' });
    }
  },

  /** E：硬化 —— 护甲 +50%，受伤 -30% */
  harden(G: GameState): void {
    const P = G.player;
    this.applyPlayerStatus('harden', 3, P.armorTotal * 0.5);
    bus.emit(Ev.TOAST, { text: '🛡 硬化启动！护甲大幅提升', kind: 'good' });
  },

  /** R：猛冲 —— 向前冲刺，路径上敌人受 2× 攻击伤害 */
  lunge(G: GameState): void {
    const P = G.player;
    // 计算前方方向（基于当前速度或 facing）
    const dirX = P.vx !== 0 ? Math.sign(P.vx) : 1;
    const dirY = P.vy !== 0 ? Math.sign(P.vy) : 0;
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len, ny = dirY / len;

    // 瞬间位移
    P.x = clamp(P.x + nx * LUNGE_DIST, 20, G.world.w - 20);
    P.y = clamp(P.y + ny * LUNGE_DIST, 20, G.world.h - 20);

    // 路径伤害
    const lungeDmg = P.attackTotal * 2;
    let hitCount = 0;
    for (const e of G.ents) {
      if (e.aiState === 'dead' || e.kind === 'food' || e.kind === 'corpse' || e.kind === 'protein') continue;
      const d = dist(P.x, P.y, e.x, e.y);
      if (d > playerRadius(P.bodyVol) + e.radius + 10) continue;
      const dmg = lungeDmg * (1 - armorReduction(e.armor));
      e.hp -= dmg;
      e.hitFlash = 0.3;
      hitCount++;
      if (e.hp <= 0) {
        e.aiState = 'dead';
        bus.emit(Ev.TOAST, { text: `⚡ 猛冲击杀了${DataStore.species(e.speciesId).name}！`, kind: 'good' });
      }
    }
    if (hitCount > 0) {
      bus.emit(Ev.TOAST, { text: `⚡ 猛冲命中 ${hitCount} 个目标（${Math.round(lungeDmg)} 伤害/个）`, kind: 'good' });
    }
  },

  /** 给实体挂状态效果（同类型叠层，不同类型共存） */
  applyStatus(target: Entity, kind: StatusKind, duration: number, value: number): void {
    // Entity 类型上没有 statuses 字段——用 WeakMap 或直接扩展 Entity
    // 为简化，Entity 用一个运行时 Map 存储
    const statuses = getEntityStatuses(target);
    const existing = statuses.find(s => s.kind === kind);
    if (existing) {
      existing.t = Math.max(existing.t, duration);
      existing.value = Math.max(existing.value, value);
      existing.stacks = Math.min(existing.stacks + 1, 3);
    } else {
      statuses.push({ kind, t: duration, value, stacks: 1 });
    }
  },

  /** 给玩家挂状态效果 */
  applyPlayerStatus(kind: StatusKind, duration: number, value: number): void {
    const existing = playerStatuses.find(s => s.kind === kind);
    if (existing) {
      existing.t = Math.max(existing.t, duration);
      existing.value = Math.max(existing.value, value);
    } else {
      playerStatuses.push({ kind, t: duration, value, stacks: 1 });
    }
  },

  /** 每帧更新：技能冷却 + 状态效果驱动 */
  update(G: GameState, dt: number): void {
    // 技能冷却
    for (const id of Object.keys(skillCd)) {
      skillCd[id] = Math.max(0, skillCd[id] - dt);
    }

    // 玩家状态效果
    this.tickPlayerStatuses(G, dt);

    // 实体状态效果（中毒伤害等）
    for (const e of G.ents) {
      if (e.aiState === 'dead') continue;
      const statuses = getEntityStatuses(e);
      if (statuses.length === 0) continue;
      this.tickEntityStatuses(e, statuses, dt);
    }
  },

  /** 玩家状态效果结算 */
  tickPlayerStatuses(G: GameState, dt: number): void {
    const P = G.player;
    for (let i = playerStatuses.length - 1; i >= 0; i--) {
      const s = playerStatuses[i];
      s.t -= dt;
      if (s.t <= 0) {
        playerStatuses.splice(i, 1);
        continue;
      }
      if (s.kind === 'poison') {
        P.hp -= s.value * s.stacks * dt;
        if (P.hp <= 0) { P.hp = 0; bus.emit(Ev.PLAYER_DIED); }
      }
      // slow 和 harden 的效果在 hurtPlayer / updatePlayer 里读取
    }
  },

  /** 实体状态效果结算 */
  tickEntityStatuses(e: Entity, statuses: StatusEffect[], dt: number): void {
    for (let i = statuses.length - 1; i >= 0; i--) {
      const s = statuses[i];
      s.t -= dt;
      if (s.t <= 0) {
        statuses.splice(i, 1);
        continue;
      }
      if (s.kind === 'poison') {
        e.hp -= s.value * s.stacks * dt;
        if (e.hp <= 0) {
          e.aiState = 'dead';
          bus.emit(Ev.TOAST, { text: `☠ ${DataStore.species(e.speciesId).name} 毒发身亡`, kind: 'good' });
        }
      }
    }
  },

  /** 读取玩家硬化加成（hurtPlayer 里调用） */
  hardenBonus(): number {
    const h = playerStatuses.find(s => s.kind === 'harden');
    return h ? h.value : 0;
  },

  /** 读取玩家减速系数（updatePlayer 里调用） */
  slowMult(): number {
    const s = playerStatuses.find(s => s.kind === 'slow');
    return s ? Math.max(0.3, 1 - s.value) : 1;
  },

  /** 读取玩家当前状态列表（HUD 显示用） */
  playerStatuses(): readonly StatusEffect[] {
    return playerStatuses;
  },

  /** 技能冷却（HUD 显示用） */
  skillCooldown(id: string): number {
    return skillCd[id] ?? 0;
  },

  /** 器官协同加成（委托给 OrganSystem，避免循环依赖） */
  synergies(G: GameState): string[] {
    return Organ.synergyDescriptions(G.player.modules);
  },
};

// —— 实体状态效果的运行时存储（WeakMap 避免内存泄漏）——
const entityStatuses = new WeakMap<object, StatusEffect[]>();

function getEntityStatuses(target: object): StatusEffect[] {
  let arr = entityStatuses.get(target);
  if (!arr) {
    arr = [];
    entityStatuses.set(target, arr);
  }
  return arr;
}

/** 角度归一化到 [-π, π] */
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
