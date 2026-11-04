import { setGameState } from './core/GameState';
import type { GameState } from './types/GameState';
import { newRun, Run, CONST } from './systems/RunState';
import { SaveSystem } from './systems/SaveSystem';
import { DataStore } from './systems/DataStore';
import { Metab } from './systems/MetabolismSystem';
import { MemorySys } from './systems/MemorySystem';
import { Stage } from './systems/StageSystem';
import { DisasterSys } from './systems/DisasterSystem';
import { World } from './systems/WorldSystem';
import { Combat } from './systems/CombatSystem';
import { CombatDepth } from './systems/CombatDepth';
import { GameLoop } from './game/GameLoop';
import { Ev, bus } from './core/EventBus';
import { Toast } from './ui/Toast';
import { HUD } from './ui/HUD';
import { Editor } from './ui/EditorPanel';
import { MemoryPanel } from './ui/MemoryPanel';
import { EraPanel } from './ui/EraPanel';
import { Screens } from './ui/Screens';
import { Setup } from './ui/Setup';
import { SenseOverlay } from './ui/SenseOverlay';
import { esc } from './core/escape';

/**
 * Phaser 延迟装配（代码分包）：
 * 菜单 DOM 先渲染，引擎与世界场景在空闲时预取；点"开始进化"时确保就绪。
 * 首屏不再同步解析 1.5MB 的 Phaser 主包。
 */
let phaserBoot: Promise<void> | null = null;
function ensurePhaser(): Promise<void> {
  if (!phaserBoot) {
    phaserBoot = (async () => {
      const [{ default: Phaser }, { WorldScene }] = await Promise.all([
        import('phaser'),
        import('./game/scenes/WorldScene'),
      ]);
      new Phaser.Game({
        type: Phaser.AUTO,
        parent: 'game-root',
        backgroundColor: '#05090f',
        scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
        scene: [WorldScene],
      });
    })();
  }
  return phaserBoot;
}

/**
 * 装配入口（GDD 4.3 main.ts）：
 * 血统读档 → 新局状态 → DOM UI → 事件接线 → Phaser（延迟）。
 */
function boot(): void {
  const save = SaveSystem.load();
  const G: GameState = newRun(save.memories, save.generation);
  setGameState(G);

  Toast.init();
  HUD.init(G);
  Editor.init(G);
  MemoryPanel.init(G);
  EraPanel.init(G);
  Screens.init(G);
  Setup.init(G);
  SenseOverlay.init();

  let deathHandled = false;
  bus.on(Ev.PLAYER_DIED, () => {
    if (deathHandled) return;
    deathHandled = true;
    G.mode = 'dead';
    window.setTimeout(() => {
      Screens.showDeath('💀 个体死亡');
      deathHandled = false;
    }, CONST.DEATH_DELAY_MS);
  });

  bus.on(Ev.MENU_START, () => {
    void (async () => {
      try {
        await ensurePhaser(); // 菜单期间已预取，通常瞬间就绪
      } catch (e) {
        console.error('[boot] Phaser 加载失败', e);
        Toast.show('游戏引擎加载失败，请刷新页面重试', 'bad');
        return;
      }
      const s = SaveSystem.load();
      const keepDiff = G.diff;                 // 开局设置跨代保留
      const fresh = newRun(s.memories, s.generation);
      Object.assign(G, fresh); // 就地替换内容，保持全局引用稳定
      G.diff = keepDiff;
      Screens.hideMenu();
      GameLoop.startRun(G);
    })();
  });

  // 三纪元闭环通关（寒武纪装上外骨骼并保存）
  bus.on(Ev.RUN_COMPLETE, () => {
    G.mode = 'dead';
    Screens.showVictory();
  });

  bus.on(Ev.ERA_ADVANCED, next => {
    World.repopulate(G);
    Screens.eraSplash(next);
  });

  bus.on(Ev.TASTE_CARD, def => {
    const card = document.getElementById('taste-card')!;
    const danger = def.dangerLevel >= 6 ? '高危' : def.dangerLevel >= 3 ? '有风险' : '安全';
    card.innerHTML = `<div class="t-name">👅 味觉分析：${esc(def.name)}</div>
      <div class="t-line">营养 ~${esc(def.nutrition)} · 危险等级 ${esc(def.dangerLevel)}/10（${danger}）</div>
      <div class="t-line">已写入记忆库</div>`;
    card.classList.remove('hidden');
    window.setTimeout(() => card.classList.add('hidden'), 3000);
  });

  // 键盘输入
  const KEYMAP: Record<string, keyof GameState['input']> = {
    w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down',
    a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right',
  };
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (KEYMAP[k]) G.input[KEYMAP[k]] = true;
    if (k === 'tab') {
      e.preventDefault();
      if (G.mode === 'playing') bus.emit(Ev.EDITOR_OPEN, {});
      else if (G.mode === 'editing') Editor.close(true);
    }
    if (k === ' ' && G.mode === 'playing') {
      e.preventDefault();
      if (G.player.metab.burstPool >= CONST.DASH_COST) {
        G.player.metab.burstPool -= CONST.DASH_COST;
        G.dashT = CONST.DASH_TIME;
      }
    }
    // v0.8：技能按键（Q=毒素喷射, E=硬化, R=猛冲）
    if (G.mode === 'playing') {
      if (k === 'q') CombatDepth.activate(G, 'toxin_spray');
      if (k === 'e') CombatDepth.activate(G, 'harden');
      if (k === 'r') CombatDepth.activate(G, 'lunge');
    }
    if (k === 'escape') {
      if (G.mode === 'editing') Editor.close(false);
      MemoryPanel.hide();
      EraPanel.hide();
    }
  });
  window.addEventListener('keyup', e => {
    const k = e.key.toLowerCase();
    if (KEYMAP[k]) G.input[KEYMAP[k]] = false;
  });

  Screens.showMenu();

  // 菜单渲染后空闲预取 Phaser（分包加载，首屏不被引擎阻塞）
  window.setTimeout(() => { void ensurePhaser(); }, 600);

  // 开发/验证桥：仅在 Vite 开发服务器下挂载，生产构建会被静态消除。
  // 暴露到生产环境等于把游戏状态、存档与事件总线交给任意同源脚本（作弊 / 篡改 / 注入面）。
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).SFW = {
      G, Run, DataStore, SaveSystem, Metab, MemorySys, Stage, GameLoop,
      DisasterSys, World, Combat, Editor, bus, Ev,
    };
  }

  // rAF 停摆/渲染循环死亡兜底：>250ms 无帧时按真实时间分步驱动模拟
  // （覆盖两种情况：后台标签页节流、以及某帧异常杀掉 Phaser 循环后维持可玩）
  let lastRafAt = performance.now();
  const rafPulse = (): void => {
    lastRafAt = performance.now();
    requestAnimationFrame(rafPulse);
  };
  requestAnimationFrame(rafPulse);
  window.setInterval(() => {
    if (G.mode !== 'playing' || G.paused) return;
    const gap = performance.now() - lastRafAt;
    if (gap > 250) {
      let remain = Math.min(gap / 1000, 1.0);
      while (remain > 0) {
        const step = Math.min(0.033, remain);
        try {
          GameLoop.update(G, step);
        } catch { /* 降级：跳过坏帧 */ }
        remain -= step;
      }
    }
  }, 120);
}

window.addEventListener('DOMContentLoaded', boot);
