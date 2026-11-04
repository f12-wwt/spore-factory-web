import type { GameState, Disaster } from '../types/GameState';
import { DataStore } from './DataStore';
import { Run } from './RunState';
import { rand, dist, clamp } from '../core/MathUtils';
import { Ev, bus } from '../core/EventBus';

/**
 * 灾害系统（GDD 3.9 / T13）：预警 → 爆发 → 恢复。
 * 热泉（太古宙·区域）、大氧化（元古宙·脚本化全局）、海洋酸化（寒武纪·随机全局）。
 */
export const DisasterSys = {
  update(G: GameState, dt: number): void {
    // 触发调度
    G.nextDisasterAt -= dt;
    const era = DataStore.era(G.eraIndex);
    const eraDisasters = era.disasters.map(id => DataStore.disaster(id));

    if (G.nextDisasterAt <= 0 && G.disasters.length === 0) {
      // 元古宙：大氧化为脚本化事件——进入纪元 150s 后必发（里程碑需要幸存它）
      const scripted = eraDisasters.find(d => d.trigger === 'scripted');
      if (scripted && G.disastersFiredThisEra === 0 && !Run.disastersSurvived.has(scripted.id)) {
        this.trigger(G, scripted.id);
      } else {
        const randoms = eraDisasters.filter(d => d.trigger === 'random');
        if (randoms.length) {
          this.trigger(G, randoms[randInt(0, randoms.length - 1)].id);
        }
        // 无随机灾害时也不空转：延迟复查（受开局"灾害频率"影响）
        G.nextDisasterAt = rand(60, 100) / (G.diff?.hazardMult || 1);
      }
    }

    // 阶段推进与结算
    for (const h of G.disasters) {
      const def = DataStore.disaster(h.defId);
      h.t += dt;
      if (h.phase === 'warning' && h.t >= def.warningTime) {
        h.phase = 'burst';
        h.t = 0;
        bus.emit(Ev.DISASTER_BURST, h);
        bus.emit(Ev.TOAST, { text: `☄ ${name(def.id)} 爆发！${def.survivalStrategy}`, kind: 'bad' });
      } else if (h.phase === 'burst' && h.t >= def.duration) {
        h.phase = 'recover';
        h.t = 0;
        Run.disastersSurvived.add(h.defId);
        bus.emit(Ev.DISASTER_END, h);
        bus.emit(Ev.TOAST, { text: `🌤 ${name(def.id)} 平息，生态缓慢恢复`, kind: 'good' });
      } else if (h.phase === 'recover' && h.t >= def.recover) {
        h.phase = 'warning'; // 占位，随后过滤
        h.t = 0;
        h.done = true;
      }

      // 伤害结算（爆发期）
      if (h.phase === 'burst') {
        const P = G.player;
        const countered = (def.counterModules ?? []).some(mid => P.modules.includes(mid));
        if (def.zoneDps > 0) {
          const d = dist(P.x, P.y, h.x, h.y);
          if (d < h.radius) {
            Combat_hurt(G, def.zoneDps * dt);
          }
        }
        if (def.globalDps > 0) {
          let dps = def.globalDps;
          if (countered) dps *= 0.12; // 克服器官：免疫级减免
          Combat_hurt(G, dps * dt);
        }
      }
    }
    G.disasters = G.disasters.filter(h => !h.done);
  },

  trigger(G: GameState, defId: string): void {
    const def = DataStore.disaster(defId);
    const h: Disaster = {
      defId,
      phase: 'warning',
      t: 0,
      x: 0,
      y: 0,
      radius: def.radius,
      done: false,
    };
    if (def.radius > 0) {
      // 区域灾害：在玩家附近生成喷口
      const a = rand(0, Math.PI * 2);
      h.x = clamp(G.player.x + Math.cos(a) * rand(180, 420), 60, G.world.w - 60);
      h.y = clamp(G.player.y + Math.sin(a) * rand(180, 420), 60, G.world.h - 60);
    }
    G.disasters.push(h);
    G.disastersFiredThisEra++;
    G.nextDisasterAt = (def.warningTime + def.duration + def.recover + rand(50, 90)) / (G.diff?.hazardMult || 1);
    bus.emit(Ev.DISASTER_WARN, h);
    bus.emit(Ev.TOAST, {
      text: `⚠️ ${name(defId)} 预警：${Math.round(def.warningTime)} 秒后爆发！${def.survivalStrategy}`,
      kind: 'warn',
    });
  },
};

function Combat_hurt(G: GameState, dmg: number): void {
  // 灾害伤害绕过无敌帧（环境伤害），但有甲仍按护甲公式减免（酸蚀）
  G.player.hp -= dmg;
  G.player.hitFlash = Math.max(G.player.hitFlash, 0.15);
  if (G.player.hp <= 0) {
    G.player.hp = 0;
    bus.emit(Ev.PLAYER_DIED);
  }
}

function name(id: string): string {
  const map: Record<string, string> = {
    hydrothermal_vent: '海底热泉',
    great_oxidation: '大氧化事件',
    ocean_acidification: '海洋酸化',
  };
  return map[id] ?? id;
}

function randInt(lo: number, hi: number): number {
  return Math.floor(rand(lo, hi + 1));
}
