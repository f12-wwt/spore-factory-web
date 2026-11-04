import type { GameState } from '../types/GameState';
import { DataStore } from '../systems/DataStore';
import { Run } from '../systems/RunState';
import { Analytics } from '../systems/AnalyticsSystem';
import { SaveSystem } from '../systems/SaveSystem';
import { esc } from '../core/escape';

/** 菜单/死亡/通关/纪元过场（GDD T15 UI） */
export const Screens = {
  G: null as GameState | null,

  init(G: GameState): void {
    this.G = G;
    // 菜单/死亡按钮由 Setup（开局设置）接管：先经过初始状态配置
  },

  showMenu(): void {
    const G = this.G!;
    G.mode = 'menu';
    const save = SaveSystem.load();
    const bl = document.getElementById('bloodline-info')!;
    bl.textContent = save.generation > 0 || save.memories.length
      ? `🧬 血统：第 ${save.generation} 代 · 遗传记忆 ${save.memories.length} 种 · 血统快照 ${save.snapshots.length} 条`
      : '🧬 首个个体——你的血统将从这里开始';
    document.getElementById('menu')!.classList.remove('hidden');
    document.getElementById('death')!.classList.add('hidden');
    document.getElementById('hud')!.classList.add('hidden');
  },

  hideMenu(): void {
    document.getElementById('menu')!.classList.add('hidden');
    document.getElementById('death')!.classList.add('hidden');
    document.getElementById('era-splash')!.classList.add('hidden');
    document.getElementById('hud')!.classList.remove('hidden');
  },

  /** 死亡结算：血统快照入库 + 验证指标面板（GDD 文件 8） */
  showDeath(reason: string): void {
    const G = this.G!;
    const era = DataStore.era(G.eraIndex);
    const mods = G.player.modules.map(id => DataStore.module(id).name);
    const snapshot = DataStore.makeSnapshot({
      eraName: era.name,
      morphology: { 模块: mods.join('、') || '基础形态', 体积: String(Math.round(G.player.bodyVol)), 代数: String(G.player.generation) },
      networkSummary: `节点 ${G.player.nodes.length} · 管线 ${G.player.pipes.length} · 消化效率 ${Math.round(G.player.metab.digestionEfficiency * 100)}%`,
      cognitionTags: [...G.memories.values()].filter(m => m.unlocked).map(m => m.name),
      aggression: G.player.modules.some(id => DataStore.module(id).attackMod > 0) ? 0.7 : 0.2,
      predation: Run.speciesPredated.size / 10,
      historicalScore: Run.survivedS / 10 + G.eraIndex * 50 + Run.eatenCount * 0.5 + Run.speciesPredated.size * 15,
      strategyTag: Run.speciesPredated.size >= 3 ? '霸主' : Run.eatenCount >= 30 ? '滤食' : '生存',
    });
    const save = SaveSystem.commitDeath(G, snapshot);

    document.getElementById('death-title')!.textContent = reason;
    document.getElementById('death-sub')!.textContent =
      `血统延续至第 ${save.generation} 代 · 记忆 ${save.memories.length} 种遗传`;
    const stats = [
      ['存活时长', `${Math.round(Run.survivedS)}s`],
      ['抵达纪元', era.name],
      ['进食次数', String(Run.eatenCount)],
      ['捕食物种', `${Run.speciesPredated.size} 种`],
      ['解锁记忆', `${[...G.memories.values()].filter(m => m.unlocked).length} 种`],
      ['体积峰值', String(Math.round(Run.maxVolume))],
    ];
    document.getElementById('death-stats')!.innerHTML =
      stats.map(([k, v]) => `<div class="k">${esc(k)}</div><div>${esc(v)}</div>`).join('');
    document.getElementById('death-analytics')!.innerHTML =
      '<div class="k" style="grid-column:1/3;margin-top:6px">—— 验证指标（GDD 文件 8）——</div>' +
      Analytics.summary(G).map(({ label, value }) => `<div class="k">${esc(label)}</div><div>${esc(value)}</div>`).join('');
    document.getElementById('hud')!.classList.add('hidden');
    document.getElementById('death')!.classList.remove('hidden');
  },

  /**
   * 三纪元闭环通关结算（v0.7）：
   * 评分 = 存活时间 + 纪元进度 + 物种收集 + 记忆库 + 体积成长 + 构筑深度
   * 血统记忆 60% 遗传给下一代（与死亡结算相同机制，但有专属胜利画面）。
   */
  showVictory(): void {
    const G = this.G!;
    const unlockedMems = [...G.memories.values()].filter(m => m.unlocked);

    // 评分分解（每项独立展示，让玩家知道"哪里做得好"）
    const scoreParts: [string, number][] = [
      ['存活时间', Math.round(Run.survivedS * 0.5)],
      ['三纪元通关', 150],
      ['捕食物种', Run.speciesPredated.size * 20],
      ['品尝物种', Run.speciesTasted.size * 10],
      ['解锁记忆', unlockedMems.length * 12],
      ['体积成长', Math.round(Run.maxVolume * 3)],
      ['代谢崩溃', -G.analytics.metabolicCrashCount * 5],
    ];
    const totalScore = scoreParts.reduce((s, [, v]) => s + v, 0);

    // 血统快照入库（与死亡结算共用机制）
    const era = DataStore.era(G.eraIndex);
    const mods = G.player.modules.map(id => DataStore.module(id).name);
    const snapshot = DataStore.makeSnapshot({
      eraName: era.name,
      morphology: { 模块: mods.join('、'), 体积: String(Math.round(G.player.bodyVol)), 代数: String(G.player.generation) },
      networkSummary: `节点 ${G.player.nodes.length} · 管线 ${G.player.pipes.length} · 消化效率 ${Math.round(G.player.metab.digestionEfficiency * 100)}%`,
      cognitionTags: unlockedMems.map(m => m.name),
      aggression: 0.8,
      predation: Run.speciesPredated.size / 10,
      historicalScore: totalScore,
      strategyTag: '霸主',
    });
    const save = SaveSystem.commitDeath(G, snapshot);

    document.getElementById('victory-score')!.innerHTML =
      `${totalScore} <small>分</small>`;
    document.getElementById('victory-breakdown')!.innerHTML =
      scoreParts.map(([k, v]) =>
        `<div class="k">${esc(k)}</div><div style="color:${v >= 0 ? 'var(--good)' : 'var(--warn)'}">${v >= 0 ? '+' : ''}${esc(v)}</div>`
      ).join('');
    document.getElementById('victory-stats')!.innerHTML = [
      ['存活时长', `${Math.round(Run.survivedS)}s`],
      ['捕食物种', `${Run.speciesPredated.size} 种`],
      ['解锁记忆', `${unlockedMems.length} 种`],
      ['体积峰值', String(Math.round(Run.maxVolume))],
      ['血统代数', `第 ${save.generation} 代`],
      ['遗传记忆', `${save.memories.length} 种`],
    ].map(([k, v]) => `<div class="k">${esc(k)}</div><div>${esc(v)}</div>`).join('');
    document.getElementById('hud')!.classList.add('hidden');
    document.getElementById('victory')!.classList.remove('hidden');
  },

  /** 纪元过场演出 */
  eraSplash(nextEra: { name: string; en: string; transitionEvent: string }): void {
    document.getElementById('splash-era')!.textContent = nextEra.name;
    document.getElementById('splash-event')!.textContent = nextEra.transitionEvent;
    document.getElementById('splash-inherit')!.textContent =
      '继承：记忆 100% · 网络 80% · 体积 60% · 储备 50%';
    const el = document.getElementById('era-splash')!;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2400);
  },
};
