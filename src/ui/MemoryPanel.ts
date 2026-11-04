import type { GameState } from '../types/GameState';
import { DataStore } from '../systems/DataStore';
import { Ev, bus } from '../core/EventBus';
import { esc } from '../core/escape';

/** 记忆库面板（GDD 3.5 / T5）：??? → 交互解锁 */
export const MemoryPanel = {
  G: null as GameState | null,

  init(G: GameState): void {
    this.G = G;
    bus.on(Ev.MEMORY_PANEL_OPEN, () => this.show());
    document.getElementById('mem-close')!.onclick = () => this.hide();
  },

  show(): void {
    const G = this.G!;
    const grid = document.getElementById('mem-grid')!;
    // 收录所有已交互 + 全物种图鉴占位
    const all = [...DataStore.speciesList.map(s => s.id)];
    grid.innerHTML = all.map(id => {
      const m = G.memories.get(id);
      const def = DataStore.species(id);
      if (!m?.unlocked) {
        return `<div class="mem-card unknown">
          <div class="m-name">？？？</div>
          <div class="m-line">首次接触于 ${esc(def.era <= G.eraIndex ? DataStore.era(def.era).name : '未知')}水域</div>
          <div class="m-line">进食 / 攻击 / 观察后解锁</div>
        </div>`;
      }
      const danger = m.dangerLevel >= 6 ? 'danger-high' : m.dangerLevel >= 3 ? 'danger-mid' : 'danger-low';
      return `<div class="mem-card">
        <div class="m-name">${esc(m.name)}</div>
        <div class="m-line">类型：${esc(typeName(def.type))} · 营养 ${esc(m.nutrition)}</div>
        <div class="m-line">危险等级：<span class="${danger}">${esc(m.dangerLevel)}/10</span></div>
        <div class="m-line">首次记录：${esc(m.firstEra)} · 互动 ${esc(m.interactionCount)} 次</div>
      </div>`;
    }).join('');
    document.getElementById('memory')!.classList.remove('hidden');
  },

  hide(): void {
    document.getElementById('memory')!.classList.add('hidden');
  },
};

function typeName(t: string): string {
  return { food: '食物', neutral: '中立', predator: '猎食者' }[t] ?? t;
}
