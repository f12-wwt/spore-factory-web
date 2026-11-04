import type { GameState } from '../types/GameState';

/**
 * 埋点系统（GDD T16 / 文件 8 验证指标）：
 * 首次编辑、首次纪元过渡、代谢崩溃率、编辑频率、核心闭环完成率、FPS。
 */
export const Analytics = {
  onFirstEdit(G: GameState): void {
    if (G.analytics.firstEditAt === null) {
      G.analytics.firstEditAt = Math.round(G.timeS);
    }
    G.analytics.editCount++;
    G.analytics.editsPerEra[G.eraIndex] = (G.analytics.editsPerEra[G.eraIndex] || 0) + 1;
  },

  onEraTransition(G: GameState): void {
    if (G.analytics.firstEraTransitionAt === null) {
      G.analytics.firstEraTransitionAt = Math.round(G.timeS);
    }
  },

  /** 核心闭环：吃 → 长 → 编辑 → 纪元推进 全部发生 */
  checkLoop(G: GameState): void {
    const a = G.analytics;
    if (!a.loopCompleted && a.firstEditAt !== null && a.firstEraTransitionAt !== null) {
      a.loopCompleted = true;
    }
  },

  trackFps(G: GameState, fps: number): void {
    G.analytics.fps = Math.round(fps);
  },

  /** 验证指标摘要（死亡/结算面板显示） */
  summary(G: GameState): { label: string; value: string }[] {
    const a = G.analytics;
    return [
      { label: '首次编辑', value: a.firstEditAt === null ? '未发生' : `${a.firstEditAt}s` },
      { label: '首次纪元过渡', value: a.firstEraTransitionAt === null ? '未发生' : `${a.firstEraTransitionAt}s` },
      { label: '编辑次数', value: `${a.editCount}（本纪元 ${a.editsPerEra[G.eraIndex] || 0}）` },
      { label: '代谢崩溃', value: `${a.metabolicCrashCount} 次` },
      { label: '核心闭环', value: a.loopCompleted ? '✅ 完整跑通' : '进行中' },
      { label: 'FPS', value: `${a.fps}` },
    ];
  },
};
