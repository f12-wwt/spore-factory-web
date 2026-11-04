import type { GameState, Entity } from '../types/GameState';
import { DataStore } from './DataStore';
import type { SpeciesDef } from './DataStore';
import * as Organ from './OrganSystem';
import { CombatDepth } from './CombatDepth';
import { MemorySys } from './MemorySystem';
import { CONST, Run, playerRadius } from './RunState';
import { dist, dist2, rand, randInt, clamp, angleTo } from '../core/MathUtils';
import { Ev, bus } from '../core/EventBus';

/**
 * 世界系统（T2/T4）：实体生成与维护、玩家移动、进食与味觉。
 */
export const World = {
  /** 按当前纪元生成实体（受开局设置：食物密度 / 敌对密度） */
  spawnInitial(G: GameState): void {
    const era = DataStore.era(G.eraIndex);
    const pool = DataStore.speciesList.filter(s => s.era === G.eraIndex);
    const byType = pickByType(pool);
    const nFood = Math.round(era.spawn.food * G.diff.foodMult);
    const nPred = Math.round(era.spawn.predator * G.diff.predMult);
    for (let i = 0; i < nFood; i++) push(G, byType.food);
    for (let i = 0; i < era.spawn.neutral; i++) push(G, byType.neutral);
    for (let i = 0; i < nPred; i++) push(G, byType.predator);
  },

  /** 纪元过渡后按新纪元刷新生态 */
  repopulate(G: GameState): void {
    G.ents = G.ents.filter(e => e.kind === 'food'); // 保留残存食物，其余换代
    this.spawnInitial(G);
  },

  makeEnt(G: GameState, def: SpeciesDef): Entity {
    const x = rand(60, G.world.w - 60);
    const y = rand(60, G.world.h - 60);
    // 敌对生物强度倍率（开局设置）
    const pp = def.type === 'predator' ? G.diff.predPower : 1;
    return {
      id: G.nextEntId++,
      kind: def.type,
      speciesId: def.id,
      x, y, vx: 0, vy: 0,
      radius: def.radius,
      hp: def.hp * pp, hpMax: def.hp * pp,
      armor: def.armor * pp,
      attack: def.attack * pp,
      nutrition: def.nutrition,
      dangerLevel: def.dangerLevel,
      speed: def.speed * (1 + (pp - 1) * 0.3),
      aiState: 'patrol',
      aiTimer: rand(1, 4),
      hitFlash: 0,
      wobble: rand(0, Math.PI * 2),
    };
  },

  /**
   * 蛋白质掉落物（击杀敌对/中立生物生成）：
   * 拾取后直接转化大量能量、爆发储能与消化原料；存留 22 秒。
   */
  makeProtein(G: GameState, def: SpeciesDef, x: number, y: number): Entity {
    return {
      id: G.nextEntId++,
      kind: 'protein',
      speciesId: def.id,
      x: clamp(x, 30, G.world.w - 30),
      y: clamp(y, 30, G.world.h - 30),
      vx: 0, vy: 0,
      radius: 7 + def.nutrition * 0.08,
      hp: 1, hpMax: 1,
      armor: 0,
      attack: 0,
      nutrition: def.nutrition,
      dangerLevel: def.dangerLevel,
      speed: 0,
      aiState: 'patrol',
      aiTimer: 0,
      ttl: CONST.PROTEIN_TTL, // 存留时间（秒，帧长无关）
      hitFlash: 0,
      wobble: rand(0, Math.PI * 2),
    };
  },

  /**
   * 活跃区维护刷新（玩家周边保持生态密度；受开局设置影响）。
   * 单次遍历完成：掉落物 TTL 衰减、死亡实体回收、区内计数；
   * TTL 用真实 dt（帧率无关），死亡实体（被击杀的中立/敌对）立即回收防止堆积。
   */
  maintain(G: GameState, dt: number): void {
    const era = DataStore.era(G.eraIndex);
    const R = CONST.MAINTAIN_RADIUS;
    const r2 = R * R;
    const far2 = CONST.FOOD_CULL_DIST * CONST.FOOD_CULL_DIST;
    const P = G.player;

    const counts: Record<'food' | 'neutral' | 'predator', number> = { food: 0, neutral: 0, predator: 0 };
    G.ents = G.ents.filter(e => {
      if (e.aiState === 'dead') return false;           // 尸体/被拾取掉落物：立即回收
      if (e.ttl !== undefined) {                        // 掉落物存留倒计时
        e.ttl -= dt;
        if (e.ttl <= 0) return false;
      }
      const d2 = dist2(e.x, e.y, P.x, P.y);
      if (e.kind === 'food' || e.kind === 'neutral' || e.kind === 'predator') {
        if (d2 < r2) counts[e.kind]++;
        if (G.ents.length > CONST.ENT_CAP && e.kind === 'food' && d2 > far2) return false; // 世界边缘回收
      }
      return true;
    });

    // 补充生成（每类型每帧至多一只，视野外环带）
    // v0.7：环境影响密度（浅水礁食物×1.5、深海沟捕食者×1.5）
    const pool = DataStore.speciesList.filter(s => s.era === G.eraIndex);
    const byType = pickByType(pool);
    const env = G.env;
    const mult: Record<string, number> = {
      food: G.diff.foodMult * (env?.foodMult ?? 1),
      neutral: 1,
      predator: G.diff.predMult * (env?.predatorMult ?? 1),
    };
    const kinds: [keyof typeof counts, number][] = [
      ['food', era.spawn.food], ['neutral', era.spawn.neutral], ['predator', era.spawn.predator],
    ];
    for (const [t, target] of kinds) {
      const want = Math.round(target * CONST.SPAWN_DENSITY * (mult[t] ?? 1));
      if (counts[t] >= want) continue;
      const defs = byType[t];
      const e = this.makeEnt(G, defs[randInt(0, defs.length - 1)]);
      // 在玩家视野外生成
      const a = rand(0, Math.PI * 2);
      e.x = clamp(P.x + Math.cos(a) * rand(R * 0.7, R), 40, G.world.w - 40);
      e.y = clamp(P.y + Math.sin(a) * rand(R * 0.7, R), 40, G.world.h - 40);
      G.ents.push(e);
    }
  },

  /** 玩家移动（T2） */
  updatePlayer(G: GameState, dt: number, speedMod: number): void {
    const P = G.player;
    const i = G.input;
    let dx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
    let dy = (i.down ? 1 : 0) - (i.up ? 1 : 0);
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const spd = P.speedTotal * speedMod * CombatDepth.slowMult(); // v0.8：减速状态
    // 平滑加速
    P.vx += (dx * spd - P.vx) * Math.min(1, dt * 8);
    P.vy += (dy * spd - P.vy) * Math.min(1, dt * 8);
    P.x = clamp(P.x + P.vx * dt, 20, G.world.w - 20);
    P.y = clamp(P.y + P.vy * dt, 20, G.world.h - 20);
    if (dx || dy) P.facing = angleTo(P.x, P.y, P.x + dx, P.y + dy);
    P.invulnT = Math.max(0, P.invulnT - dt);
    P.hitFlash = Math.max(0, P.hitFlash - dt);
  },

  /** 进食（T4）：接触食物/尸体 → 消化缓存；蛋白质 → 直接转化能量+爆发储能；首次品尝 → 味觉卡 + 记忆
   进食半径 = 口器给定的摄食范围与玩家可见体型取较大者——"看起来吃到了就必须真吃到" */
  updateEating(G: GameState): void {
    const P = G.player;
    // v0.6：只算生效口器（被高阶覆盖的先天口沟不重复计入进食范围）
    const mouths = Organ.activeModules(P.modules)
      .filter(id => DataStore.module(id).category === 'mouth').length;
    const mouthReach = CONST.EAT_RADIUS_BASE + CONST.EAT_RADIUS_PER_MOUTH * mouths;
    const bodyReach = playerRadius(P.bodyVol);
    const reach = Math.max(mouthReach, bodyReach, CONST.EAT_RADIUS_MIN);
    for (const e of G.ents) {
      if (e.aiState === 'dead' || (e.kind !== 'food' && e.kind !== 'corpse' && e.kind !== 'protein')) continue;
      if (dist(P.x, P.y, e.x, e.y) < e.radius + reach) {
        // 蛋白质拾取：不进消化道，直接转化大量能量与储能（GDD 用户需求）
        if (e.kind === 'protein') {
          const m = P.metab;
          const energy = Math.round(e.nutrition * 0.6);
          const burst = 8 + Math.round(e.dangerLevel * 0.5);
          const store = Math.round(e.nutrition * 0.5);
          m.currentEnergy = Math.min(m.maxEnergy, m.currentEnergy + energy);
          m.burstPool = Math.min(m.maxBurstPool, m.burstPool + burst);
          // 消化道装不下的部分直接即时转化（v0.5：掉落物不因胃满而浪费）
          const room = P.digestCap - P.digestBuffer;
          const kept = Math.min(store, Math.max(0, room));
          P.digestBuffer += kept;
          const instant = (store - kept) * CONST.STOMACH_OVERFLOW_EFF;
          m.currentEnergy = Math.min(m.maxEnergy, m.currentEnergy + instant);
          // 蛋白质也是器官购置金的重要来源
          m.growthReserve += e.nutrition * CONST.GROWTH_PER_FOOD * CONST.PROTEIN_GROWTH_MULT * (G.diff?.growthMult ?? 1);
          e.aiState = 'dead'; // 已拾取：下帧维护立即回收
          bus.emit(Ev.TOAST, {
            text: `🥩 蛋白质（${DataStore.species(e.speciesId).name}）：能量+${energy} · 爆发+${burst} · 储备原料+${kept}${kept < store ? `（另有 ${Math.round(instant)} 直接转化）` : ''}`,
            kind: 'good',
          });
          bus.emit(Ev.HUD_DIRTY);
          continue;
        }
        // 摄入转化率 = 基础 35% + 消化效率的 65%（GDD 2.3.2：转化率 0.1~1.0）
        const intakeEff = CONST.DIGEST_EFF_BASE + (1 - CONST.DIGEST_EFF_BASE) * P.metab.digestionEfficiency;
        const take = Math.min(e.nutrition, e.nutrition * intakeEff);
        const room = P.digestCap - P.digestBuffer;
        // v0.5：胃满不再静默丢弃——溢出部分直接按消化效率折算成能量（边吃边消化）。
        // 消化道吞吐不足的惩罚体现在"只有一部分能即时转化"，而不是完全吃不到。
        const overflowNow = Math.max(0, take - room);
        const stored = Math.min(take, room);
        const m = P.metab;
        P.digestBuffer += stored;
        e.nutrition -= take;
        // 进食即长肉：每口食物都产出少量生长储备（器官购置金）。
        // v0.5：经济线不再依赖能量溢出——吃饱后也能持续攒钱改装。
        const growMult = G.diff?.growthMult ?? 1;
        m.growthReserve += take * CONST.GROWTH_PER_FOOD * growMult;
        if (overflowNow > 0) {
          const instant = overflowNow * CONST.STOMACH_OVERFLOW_EFF * P.metab.digestionEfficiency;
          m.currentEnergy = Math.min(m.maxEnergy, m.currentEnergy + instant);
          m.burstPool = Math.min(m.maxBurstPool, m.burstPool + instant * 0.25);
          // 边沿提示：胃在硬塞，消化道吞吐跟不上——告诉玩家可行的出路
          if (!G._digestFullWarned) {
            G._digestFullWarned = true;
            bus.emit(Ev.TOAST, {
              text: '⚠️ 消化道跟不上了！溢出只能部分即时转化——装【原始胃】扩容 / 装【肌节】疏通运动层 / 强化代谢类器官提速',
              kind: 'warn',
            });
          }
        } else if (G._digestFullWarned) {
          G._digestFullWarned = false;
        }
        Run.eatenCount++;
        if (e.nutrition <= 1) {
          e.aiState = 'dead';
          e.kind = 'corpse'; // 本帧渲染为残骸，下帧维护回收
        }
        // 味觉：首次品尝弹物质分析卡
        const first = !G.memories.get(e.speciesId)?.unlocked;
        MemorySys.noteTaste(G, e.speciesId);
        if (first) {
          bus.emit(Ev.TASTE_CARD, DataStore.species(e.speciesId));
        }
        bus.emit(Ev.HUD_DIRTY);
      }
    }
  },
};

/** 按物种类型分桶（生成时复用，避免每帧重复过滤） */
function pickByType(pool: SpeciesDef[]): Record<'food' | 'neutral' | 'predator', SpeciesDef[]> {
  const out: Record<'food' | 'neutral' | 'predator', SpeciesDef[]> = { food: [], neutral: [], predator: [] };
  for (const s of pool) out[s.type].push(s);
  return out;
}

/** 投放一只（空池跳过——数据校验会先失败，这里是兜底） */
function push(G: GameState, defs: SpeciesDef[]): void {
  if (!defs.length) return;
  G.ents.push(World.makeEnt(G, defs[randInt(0, defs.length - 1)]));
}
