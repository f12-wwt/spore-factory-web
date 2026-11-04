import type { GameState } from '../types/GameState';
import { CONST } from '../systems/RunState';
import * as Organ from '../systems/OrganSystem';
import { dist, clamp, angleTo } from '../core/MathUtils';

/**
 * 五感叠层（GDD 3.4 / T6）——独立 2D canvas 覆盖在 Phaser 画布上：
 * 视觉=视野圈外纯黑迷雾 / 嗅觉=圈缘气味弧（方向+浓度） / 听觉=威胁方向边缘脉冲 / 触觉=受击红晕与温度色带。
 * 视野圈外不呈现任何生物画面——感知只通过气味弧、听觉脉冲与触觉反馈获得。
 */
export const SenseOverlay = {
  cv: null as HTMLCanvasElement | null,
  ctx: null as CanvasRenderingContext2D | null,

  init(): void {
    this.cv = document.getElementById('sense-overlay') as HTMLCanvasElement;
    this.ctx = this.cv.getContext('2d')!;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  },

  resize(): void {
    if (!this.cv) return;
    this.cv.width = window.innerWidth;
    this.cv.height = window.innerHeight;
  },

  visionOf(G: GameState): number {
    // v0.7：环境影响视野（海藻森林 -20%，深海沟 -50%）
    const envMult = G.env?.visionMult ?? 1;
    // v0.8：感知类协同加成（如"猎手""神经感知"组合）
    const synVision = Organ.synergyTotals(G.player.modules).vision;
    return (CONST.VISION_BASE + CONST.VISION_PER_PERCEPT * G.player.perceptionTotal + synVision) * envMult;
  },

  render(G: GameState, _dt: number): void {
    const ctx = this.ctx;
    if (!ctx || this.cv!.width === 0 || (G.mode !== 'playing')) return;
    const W = this.cv!.width, H = this.cv!.height;
    const P = G.player;

    // 相机真实状态（含世界边缘钳制）→ 玩家在屏幕上的实际位置
    const zoom = G.camera.zoom || 1;
    const psx = (P.x - G.camera.x) * zoom;
    const psy = (P.y - G.camera.y) * zoom;

    ctx.clearRect(0, 0, W, H);

    /* —— 视觉：视野圈外纯黑迷雾（锚定玩家屏幕位置）——
     * 全遮蔽：圈外生物/地形一概不可见（感知交给气味弧与听觉） */
    const vision = this.visionOf(G);
    const r = vision * zoom;
    ctx.save();
    ctx.fillStyle = '#020609';
    ctx.globalAlpha = 1;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    const grad = ctx.createRadialGradient(psx, psy, r * 0.55, psx, psy, r);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(psx, psy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    /* —— 嗅觉：可视圈边缘的气味弧（GDD 2.1.3 距离平方衰减）——
     * 视距外生物 → 圈缘一段圆弧：方位=弧心（按实体 id 确定性抖动，不逐帧闪烁），
     * 粗细/亮度=浓度（1 −(d/range)²），颜色=类型。
     * 只给"方向 + 浓度"、不落坐标，多目标也不会像粒子那样糊成一片。 */
    const range = CONST.SMELL_RANGE;
    ctx.lineCap = 'round';
    for (const e of G.ents) {
      if (e.aiState === 'dead') continue;
      const d = dist(e.x, e.y, P.x, P.y);
      if (d < vision || d > range) continue; // 只报视距外、嗅觉范围内的目标
      const s = 1 - (d / range) ** 2;        // 距离平方衰减 → 浓度
      const mem = G.memories.get(e.speciesId);
      const rgb = e.kind === 'predator' ? '255,107,107'
        : e.kind === 'food' || e.kind === 'protein' ? '111,224,138'
        : mem?.unlocked ? '120,200,255' : '255,209,102';
      const jit = ((e.id * 2654435761) % 1000) / 1000 - 0.5; // 稳定方位抖动（±SMELL_AIM_JITTER）
      const ang = angleTo(P.x, P.y, e.x, e.y) + jit * 2 * CONST.SMELL_AIM_JITTER;
      const pulse = 0.85 + 0.15 * Math.sin(G.timeS * 4 + e.id); // 轻微脉动便于辨识
      ctx.strokeStyle = `rgba(${rgb},${((0.15 + 0.6 * s) * pulse).toFixed(3)})`;
      ctx.lineWidth = 1.5 + 5 * s;           // 浓 → 粗
      ctx.beginPath();
      ctx.arc(psx, psy, r, ang - CONST.SMELL_ARC_HALF, ang + CONST.SMELL_ARC_HALF);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';

    /* —— 听觉：威胁方向边缘脉冲（红=灾害/捕食者） —— */
    const threats: { x: number; y: number; kind: string }[] = [];
    for (const e of G.ents) {
      if (e.kind === 'predator' && e.aiState !== 'dead' && dist(e.x, e.y, G.player.x, G.player.y) < 460) {
        threats.push({ x: e.x, y: e.y, kind: 'pred' });
      }
    }
    for (const h of G.disasters) {
      if (h.phase !== 'recover') threats.push({ x: h.x || G.player.x, y: h.y || G.player.y, kind: 'disaster' });
    }
    const pulse = 0.4 + 0.35 * Math.sin(G.timeS * 6);
    for (const t of threats) {
      const a = Math.atan2(t.y - G.player.y, t.x - G.player.x);
      const ex = psx + Math.cos(a) * (Math.min(W, H) / 2 - 26);
      const ey = psy + Math.sin(a) * (Math.min(W, H) / 2 - 26);
      ctx.fillStyle = t.kind === 'disaster' ? `rgba(255,120,60,${pulse})` : `rgba(255,107,107,${pulse * 0.8})`;
      ctx.beginPath();
      ctx.arc(ex, ey, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    /* —— 触觉：受击红晕 / 濒死脉冲 / 热泉温度色带 —— */
    if (P.hitFlash > 0) {
      const a = P.hitFlash * 1.4;
      const g = ctx.createRadialGradient(psx, psy, Math.min(W, H) * 0.3, psx, psy, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,30,30,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (P.hp < P.hpMax * 0.25) {
      const a = 0.16 + 0.12 * Math.sin(G.timeS * 5);
      const g = ctx.createRadialGradient(psx, psy, Math.min(W, H) * 0.34, psx, psy, Math.max(W, H) * 0.7);
      g.addColorStop(0, 'rgba(255,0,0,0)');
      g.addColorStop(1, `rgba(255,60,60,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    for (const h of G.disasters) {
      if (h.radius > 0 && h.phase !== 'recover') {
        const d = dist(h.x, h.y, P.x, P.y);
        if (d < h.radius + 300) {
          const a = clamp(1 - d / (h.radius + 300), 0, 1) * 0.5;
          const ang = Math.atan2(h.y - P.y, h.x - P.x);
          const ex = psx + Math.cos(ang) * (Math.min(W, H) / 2 - 10);
          const ey = psy + Math.sin(ang) * (Math.min(W, H) / 2 - 10);
          const g = ctx.createRadialGradient(ex, ey, 4, ex, ey, 190);
          g.addColorStop(0, `rgba(255,140,40,${a})`);
          g.addColorStop(1, 'rgba(255,140,40,0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, W, H);
        }
      }
    }

    /* —— 全局灾害色调（氧化=黄绿雾 / 酸化=紫雾） —— */
    for (const h of G.disasters) {
      if (h.phase === 'burst' && h.radius === 0) {
        const col = h.defId === 'great_oxidation' ? '154, 205, 50' : '190, 120, 255';
        ctx.fillStyle = `rgba(${col}, ${0.10 + 0.05 * Math.sin(G.timeS * 3)})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
  },
};
