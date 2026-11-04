import type { GameState } from '../types/GameState';
import { DataStore } from '../systems/DataStore';
import { Ev, bus } from '../core/EventBus';

/** 纪元目标面板（GDD 3.7 / T15）：里程碑清单 + 过渡事件 + 继承预告 */
export const EraPanel = {
  G: null as GameState | null,

  init(G: GameState): void {
    this.G = G;
    bus.on(Ev.ERA_PANEL_OPEN, () => this.show());
    document.getElementById('era-close')!.onclick = () => this.hide();
  },

  show(): void {
    const G = this.G!;
    const era = DataStore.era(G.eraIndex);
    const body = document.getElementById('era-body')!;
    const rows = era.milestones.map((m, i) => {
      const done = G.milestoneDone[i];
      return `<div class="ms ${done ? 'done' : ''}">
        <span class="dot">${done ? '✅' : '⬜'}</span>
        <span class="ms-desc">${m.desc}</span>
      </div>`;
    }).join('');
    const key = era.keyModule
      ? `<div class="ms"><span class="dot">🎯</span><span class="ms-desc">关键进化：安装【${DataStore.module(era.keyModule).name}】并保存 → ${DataStore.era(G.eraIndex + 1)?.name ?? '终局'}</span></div>`
      : `<div class="ms"><span class="dot">🎯</span><span class="ms-desc">过渡条件：${era.transitionEvent}</span></div>`;
    body.innerHTML = `
      <h3>${era.name} · ${era.en}</h3>
      ${rows}${key}
      <div class="inherit-note">纪元过渡继承（GDD 3.6）：记忆 100% · 物流网络 80% · 体积 60% · 生长储备 50%。</div>`;
    document.getElementById('era-panel')!.classList.remove('hidden');
  },

  hide(): void {
    document.getElementById('era-panel')!.classList.add('hidden');
  },
};
