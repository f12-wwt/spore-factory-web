import type { GameState } from '../types/GameState';
import { DataStore } from '../systems/DataStore';
import { Ev, bus } from '../core/EventBus';
import { fmtTime } from '../core/MathUtils';
import { CombatDepth } from '../systems/CombatDepth';
import { SKILLS } from '../types/Combat';

/** HUD（GDD UI/HUD / T15）：纪元、时钟、代数、三条资源条、代谢压力表、灾害横幅 */
export const HUD = {
  G: null as GameState | null,

  init(G: GameState): void {
    this.G = G;
    bus.on(Ev.HUD_DIRTY, () => this.render());
    document.getElementById('btn-editor')!.onclick = () => bus.emit(Ev.EDITOR_OPEN, {});
    document.getElementById('btn-memory')!.onclick = () => bus.emit(Ev.MEMORY_PANEL_OPEN);
    document.getElementById('btn-era')!.onclick = () => bus.emit(Ev.ERA_PANEL_OPEN);
    document.getElementById('btn-pause')!.onclick = () => {
      G.paused = !G.paused;
      this.render();
    };
  },

  render(): void {
    const G = this.G!;
    if (G.mode !== 'playing' && G.mode !== 'editing') return;
    const era = DataStore.era(G.eraIndex);
    const m = G.player.metab;
    const P = G.player;

    document.getElementById('hud-era')!.textContent =
      `${era.name} · ${era.en} · ${G.diff?.label ?? '⚖️ 标准'}`;
    document.getElementById('hud-clock')!.textContent = `⏱ ${fmtTime(G.timeS)}`;
    document.getElementById('hud-gen')!.textContent = `第 ${P.generation} 代`;
    (document.getElementById('btn-pause') as HTMLElement).textContent = G.paused ? '▶' : '⏸';

    // 生命条（受击/回血/濒死一目了然）
    const hpPct = Math.max(0, Math.min(100, P.hp / P.hpMax * 100));
    (document.getElementById('bar-hp') as HTMLElement).style.width = `${hpPct}%`;
    document.getElementById('val-hp')!.textContent =
      `${Math.max(0, Math.round(P.hp))}/${Math.round(P.hpMax)}`;
    const ePct = Math.max(0, Math.min(100, m.currentEnergy / m.maxEnergy * 100));
    const bPct = Math.max(0, Math.min(100, m.burstPool / m.maxBurstPool * 100));
    const gPct = Math.max(0, Math.min(100, m.growthReserve / 100 * 100));
    (document.getElementById('bar-energy') as HTMLElement).style.width = `${ePct}%`;
    (document.getElementById('bar-burst') as HTMLElement).style.width = `${bPct}%`;
    (document.getElementById('bar-growth') as HTMLElement).style.width = `${gPct}%`;
    document.getElementById('val-energy')!.textContent =
      `${Math.round(m.currentEnergy)}/${Math.round(m.maxEnergy)}`;
    document.getElementById('val-burst')!.textContent =
      `${Math.round(m.burstPool)}/${Math.round(m.maxBurstPool)}`;
    document.getElementById('val-growth')!.textContent = `${Math.round(m.growthReserve)}`;

    const pr = document.getElementById('pressure')!;
    const pct = Math.round(m.pressure * 100);
    const eff = Math.round(m.tier.ratio * 100);
    pr.textContent =
      `代谢压力 ${Number.isFinite(pct) ? pct : '∞'}% · 器官效率 ${eff}%` +
      `${m.tier.label !== '健康' ? ` · ${m.tier.label}` : ''}`;
    pr.className =
      m.pressure > 1 ? 'p-bad' : m.pressure > 0.8 ? 'p-warn' : 'p-ok';

    // v0.7：环境区域提示
    const envEl = document.getElementById('hud-env');
    if (envEl) {
      const z = G.env?.zone;
      if (z) {
        const parts: string[] = [z.name];
        if (z.mods.bmrMult && z.mods.bmrMult !== 1) parts.push(`代谢×${z.mods.bmrMult.toFixed(1)}`);
        if (z.mods.outputMult && z.mods.outputMult !== 1) parts.push(`产出×${z.mods.outputMult.toFixed(1)}`);
        if (z.mods.toxicDps) parts.push(`☠ ${z.mods.toxicDps}/s`);
        if (z.mods.visionMult && z.mods.visionMult !== 1) parts.push(`视野×${z.mods.visionMult.toFixed(1)}`);
        envEl.textContent = parts.join(' · ');
        envEl.classList.remove('hidden');
      } else {
        envEl.classList.add('hidden');
      }
    }

    // v0.8：技能栏
    const skillBar = document.getElementById('skill-bar')!;
    skillBar.innerHTML = '';
    for (const s of SKILLS) {
      const can = CombatDepth.canUse(G, s.id);
      const cd = CombatDepth.skillCooldown(s.id);
      const div = document.createElement('div');
      div.className = `skill-slot ${can.ok ? 'ready' : cd > 0 ? 'cooling' : 'locked'}`;
      const cost = s.energyCost > 0 ? `能量${s.energyCost}` : s.burstCost > 0 ? `爆发${s.burstCost}` : '免费';
      div.innerHTML = `
        <span class="sk-key">${s.key}</span>
        <span class="sk-name" title="${s.desc}">${s.name}</span>
        <span class="sk-cost">${cost}</span>
        ${cd > 0 ? `<div class="sk-cd">${cd.toFixed(1)}s</div>` : ''}
      `;
      skillBar.appendChild(div);
    }

    // v0.8：状态效果显示
    const statusDiv = document.getElementById('hud-status')!;
    statusDiv.innerHTML = '';
    for (const eff of CombatDepth.playerStatuses()) {
      const icon = document.createElement('span');
      icon.className = 'status-icon';
      const label = eff.kind === 'poison' ? '☠ 中毒'
        : eff.kind === 'harden' ? '🛡 硬化'
        : eff.kind === 'stun' ? '⚡ 眩晕'
        : eff.kind === 'slow' ? '🐢 减速'
        : eff.kind;
      icon.textContent = `${label} ${eff.t.toFixed(1)}s`;
      statusDiv.appendChild(icon);
    }

    // v0.8：协同提示（在编辑器中显示）
    if (G.mode === 'editing') {
      const editorWrap = document.getElementById('editor-wrap');
      if (editorWrap) {
        let synergyDiv = document.getElementById('editor-synergies');
        if (!synergyDiv) {
          synergyDiv = document.createElement('div');
          synergyDiv.id = 'editor-synergies';
          synergyDiv.style.cssText = 'margin-top:8px;padding:8px;background:rgba(255,215,0,0.1);border:1px solid var(--accent);border-radius:6px;font-size:12px;color:var(--accent)';
          editorWrap.appendChild(synergyDiv);
        }
        const synergies = CombatDepth.synergies(G);
        synergyDiv.innerHTML = synergies.length > 0
          ? `🔗 ${synergies.join(' · ')}`
          : '🔗 暂无协同加成（同类别装备 ≥2 件器官可触发）';
      }
    }

    // 灾害横幅
    const banner = document.getElementById('disaster-banner')!;
    const h = G.disasters[0];
    if (h) {
      const def = DataStore.disaster(h.defId);
      const names: Record<string, string> = {
        hydrothermal_vent: '海底热泉', great_oxidation: '大氧化事件', ocean_acidification: '海洋酸化',
      };
      if (h.phase === 'warning') {
        const left = Math.max(0, Math.ceil(def.warningTime - h.t));
        banner.textContent = `⚠️ ${names[def.id] ?? def.id} 将在 ${left}s 后爆发 —— ${def.survivalStrategy}`;
      } else if (h.phase === 'burst') {
        banner.textContent = `☄ ${names[def.id] ?? def.id} 爆发中！`;
      } else {
        banner.textContent = `🌤 ${names[def.id] ?? def.id} 平息中…`;
      }
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  },
};
