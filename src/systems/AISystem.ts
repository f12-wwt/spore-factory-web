import type { GameState, Entity } from '../types/GameState';
import { DataStore } from './DataStore';
import { World } from './WorldSystem';
import { CONST } from './RunState';
import { dist, dist2, angleTo, rand } from '../core/MathUtils';

/**
 * AI 系统（GDD 3.8 / T10）：状态机代替行为树——巡逻/觅食/逃跑/攻击。
 * 捕食者：有限索敌（索敌范围 CONST.AGGRO）、追击超时放弃（CONST.CHASE_GIVEUP）、
 * 脱战后进入平静冷却（calmT）不再锁定玩家；残血逃跑。
 * 性能：感知用平方距离比较（免开方），目标查找走 id→实体 Map（O(1)）。
 */
export const AISys = {
  update(G: GameState, dt: number): void {
    const byId = indexById(G);
    for (const e of G.ents) {
      if (e.aiState === 'dead' || e.kind === 'protein') continue;
      e.aiTimer -= dt;
      e.wobble += dt * 3;
      const def = DataStore.species(e.speciesId);

      // 感知最近威胁与猎物（平方距离比较，最后才开方）
      let threat: Entity | null = null;
      let prey: Entity | null = null;
      let threatD2 = Infinity, preyD2 = Infinity;
      const isPred = e.kind === 'predator';
      const threatSense2 = 180 * 180;
      for (const o of G.ents) {
        if (o === e || o.aiState === 'dead') continue;
        const d2 = dist2(e.x, e.y, o.x, o.y);
        if (isPred) {
          if ((o.kind === 'neutral' || o.kind === 'food') && d2 < preyD2) { prey = o; preyD2 = d2; }
        } else if (o.kind === 'predator' && d2 < threatSense2 && d2 < threatD2) { threat = o; threatD2 = d2; }
      }
      const pd = dist(e.x, e.y, G.player.x, G.player.y);
      if (!isPred && pd < 120 && G.player.hitFlash > 0) { threatD2 = Math.min(threatD2, pd * pd); }
      const preyD = Number.isFinite(preyD2) ? Math.sqrt(preyD2) : Infinity;

      if (isPred) {
        // 捕食者：有限索敌 + 追击超时 + 平静冷却
        e.calmT = Math.max(0, (e.calmT ?? 0) - dt);
        const chasePlayer = e.targetKind === 'player';
        const targetD = chasePlayer ? pd : preyD;

        if (e.hp < e.hpMax * 0.25) {
          e.aiState = 'flee';
          e.chaseT = 0;
        } else if (e.calmT > 0) {
          // 脱战冷却：不索敌
          e.chaseT = 0;
          e.targetKind = undefined;
          if (e.aiTimer > 0) e.aiState = 'forage';
          else { e.aiTimer = rand(2, 5); e.aiState = 'patrol'; }
        } else if (e.aiState === 'attack') {
          // 追击中：目标跑出脱战距离，或追了太久没咬到 → 放弃并进入平静
          const biting = targetD < e.radius + 22;
          e.chaseT = biting ? 0 : (e.chaseT ?? 0) + dt;
          if (targetD > CONST.DROP_AGGRO || e.chaseT > CONST.CHASE_GIVEUP) {
            e.chaseT = 0;
            e.calmT = rand(6, 10);
            e.targetKind = undefined;
            e.targetId = undefined;
            e.aiState = 'patrol';
          }
          // 保持当前目标不漂移
        } else if (Math.min(pd, preyD) < CONST.AGGRO_RANGE) {
          // 索敌：就近锁定（玩家或中立/食物）
          if (pd <= preyD) { e.targetKind = 'player'; e.targetId = undefined; }
          else if (prey) { e.targetKind = 'ent'; e.targetId = prey.id; }
          e.chaseT = 0;
          e.aiState = 'attack';
        } else {
          if (e.aiTimer > 0) e.aiState = 'forage';
          else { e.aiTimer = rand(2, 5); e.aiState = 'patrol'; }
        }
      } else {
        if (threatD2 < 110 * 110) e.aiState = 'flee';
        else if (e.kind === 'neutral' && e.hp < e.hpMax * 0.6 && e.hitFlash > 0) e.aiState = 'flee';
        else e.aiState = 'forage';
      }

      // 行为执行
      let tx = e.x, ty = e.y, spd = def.speed;
      switch (e.aiState) {
        case 'flee': {
          const src = threat ?? { x: G.player.x, y: G.player.y };
          const a = angleTo(src.x, src.y, e.x, e.y);
          tx = e.x + Math.cos(a) * 100; ty = e.y + Math.sin(a) * 100;
          spd = def.speed * 1.35;
          break;
        }
        case 'attack': {
          if (e.targetKind === 'player') { tx = G.player.x; ty = G.player.y; }
          else {
            const locked = e.targetId !== undefined ? byId.get(e.targetId) : undefined;
            if (locked && locked.aiState !== 'dead') { tx = locked.x; ty = locked.y; }
            else { e.aiState = 'patrol'; e.targetKind = undefined; }
          }
          spd = def.speed * 1.2;
          break;
        }
        case 'forage': {
          if (isPred) { tx = e.x + Math.cos(e.wobble) * 60; ty = e.y + Math.sin(e.wobble * 0.7) * 60; }
          else { tx = e.x + Math.cos(e.wobble * 0.5) * 40; ty = e.y + Math.sin(e.wobble * 0.4) * 40; }
          break;
        }
        default: { // patrol
          tx = e.x + Math.cos(e.wobble * 0.35 + e.id) * 50;
          ty = e.y + Math.sin(e.wobble * 0.3 + e.id * 1.7) * 50;
          spd = def.speed * 0.55;
        }
      }

      const a = angleTo(e.x, e.y, tx, ty);
      e.vx += (Math.cos(a) * spd - e.vx) * Math.min(1, dt * 2.5);
      e.vy += (Math.sin(a) * spd - e.vy) * Math.min(1, dt * 2.5);
      e.x = Math.max(30, Math.min(G.world.w - 30, e.x + e.vx * dt));
      e.y = Math.max(30, Math.min(G.world.h - 30, e.y + e.vy * dt));
      e.hitFlash = Math.max(0, e.hitFlash - dt);
    }
  },

  /** AI 攻击结算（捕食者→玩家/中立） */
  resolveAttacks(G: GameState, dt: number, hurtPlayer: (dmg: number, fx: number, fy: number) => void): void {
    const byId = indexById(G);
    for (const e of G.ents) {
      if (e.aiState !== 'attack') continue;
      e.attackCd = (e.attackCd ?? 0) - dt;
      if (e.attackCd > 0) continue;
      const def = DataStore.species(e.speciesId);
      if (e.targetKind === 'player') {
        const d = dist(e.x, e.y, G.player.x, G.player.y);
        if (d < e.radius + 16) {
          e.attackCd = rand(1.2, 2.0);
          hurtPlayer(def.attack, e.x, e.y);
        }
      } else {
        const prey = e.targetId !== undefined ? byId.get(e.targetId) : undefined;
        if (prey && prey.aiState !== 'dead' && dist(e.x, e.y, prey.x, prey.y) < e.radius + prey.radius + 6) {
          e.attackCd = rand(1.2, 2.0);
          prey.hp -= def.attack * (1 - prey.armor / (prey.armor + 50));
          prey.hitFlash = 0.25;
          if (prey.hp <= 0) {
            prey.hp = 0;
            prey.aiState = 'dead';
            // 击杀掉落蛋白质（与玩家击杀同规则）
            if (prey.kind === 'predator' || prey.kind === 'neutral') {
              G.ents.push(World.makeProtein(G, DataStore.species(prey.speciesId), prey.x, prey.y));
            }
          }
        }
      }
    }
  },
};

/** id → 实体索引（目标查找 O(1)，每帧构建一次 O(N)） */
function indexById(G: GameState): Map<number, Entity> {
  const m = new Map<number, Entity>();
  for (const o of G.ents) m.set(o.id, o);
  return m;
}
