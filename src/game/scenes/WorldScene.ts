import Phaser from 'phaser';
import type { GameState } from '../../types/GameState';
import { getGameState } from '../../core/GameState';
import { DataStore } from '../../systems/DataStore';
import { GameLoop } from '../GameLoop';
import { SenseOverlay } from '../../ui/SenseOverlay';
import { seededRand } from '../../core/MathUtils';
import { Analytics } from '../../systems/AnalyticsSystem';
import { playerRadius } from '../../systems/RunState';
import * as Organ from '../../systems/OrganSystem';

/** 颜色解析缓存（十六进制串 → int，避免每帧每实体解析字符串） */
const colorCache = new Map<string, number>();
function colInt(hex: string): number {
  let c = colorCache.get(hex);
  if (c === undefined) {
    c = Phaser.Display.Color.HexStringToColor(hex).color;
    colorCache.set(hex, c);
  }
  return c;
}

/**
 * 世界场景（GDD 4.2 WorldScene / T2）：
 * Phaser 负责渲染与镜头跟随，逻辑全部在 Systems；每帧驱动 GameLoop。
 * 渲染分两层：
 *   静态层（地图斑块/地形/分区）烘焙进 RenderTexture，仅纪元推进或新血统重启时重建；
 *   动态层（水体氛围/实体/玩家/灾害）每帧按相机视野剔除绘制。
 */
export class WorldScene extends Phaser.Scene {
  G!: GameState;
  gfx!: Phaser.GameObjects.Graphics;
  /** 静态背景烘焙层（2400×1800 一次成图） */
  staticTex: Phaser.GameObjects.RenderTexture | null = null;
  private builtEra = -1;
  private builtSeed = -1;
  /** 水体氛围：浮游微粒（确定性分布 + 时间漂移） */
  private plankton: { x: number; y: number; r: number; a: number; ph: number; sp: number; amp: number; c: number }[] = [];
  /** 水体氛围：顶部漏下的体积光柱 */
  private shafts: { x: number; w: number; len: number; ph: number }[] = [];

  constructor() {
    super('world');
  }

  init(): void {
    this.G = getGameState();
    this.builtEra = -1;
    this.builtSeed = -1;
  }

  create(): void {
    const G = this.G;
    this.cameras.main.setBounds(0, 0, G.world.w, G.world.h);
    this.cameras.main.setBackgroundColor(DataStore.era(G.eraIndex).palette.bg);
    this.gfx = this.add.graphics();
    this.cameras.main.centerOn(G.player.x, G.player.y);
  }

  update(_time: number, delta: number): void {
    const G = this.G;
    const dt = delta / 1000;

    // 单帧异常不杀渲染循环（降级为跳过该帧模拟）
    try {
      GameLoop.update(G, dt);
    } catch (e) {
      console.error('[sim]', e);
    }

    // 纪元推进 / 新血统重启（seed 变化）：重建静态层与氛围粒子
    if (G.eraIndex !== this.builtEra || G.seed !== this.builtSeed) {
      this.rebuildStatic();
    }

    this.drawWorld();
    this.cameras.main.centerOn(G.player.x, G.player.y);
    // 回写相机真实状态（边界钳制后的滚动位置），供五感叠层锚定玩家屏幕位置
    const cam = this.cameras.main;
    G.camera.x = cam.scrollX;
    G.camera.y = cam.scrollY;
    G.camera.zoom = cam.zoom;
    SenseOverlay.render(G, dt);
    Analytics.trackFps(G, this.game.loop.actualFps);
  }

  /** 静态层烘焙：地图斑块 + 地形 + 分区一次画进 RenderTexture（不占每帧开销） */
  rebuildStatic(): void {
    const G = this.G;
    const era = DataStore.era(G.eraIndex);
    this.builtEra = G.eraIndex;
    this.builtSeed = G.seed;

    // 氛围粒子随 seed/纪元重建（确定性分布，同 seed 同布局）
    const prng = seededRand(G.seed + 7);
    this.plankton = [];
    for (let i = 0; i < 72; i++) {
      this.plankton.push({
        x: prng() * G.world.w,
        y: prng() * G.world.h,
        r: 0.8 + prng() * 1.4,
        a: 0.07 + prng() * 0.15,
        ph: prng() * Math.PI * 2,
        sp: 0.15 + prng() * 0.5,
        amp: 12 + prng() * 30,
        c: prng() > 0.4 ? colInt('#ffffff') : colInt(era.palette.accent),
      });
    }
    const srng = seededRand(G.seed + 13);
    this.shafts = [];
    for (let i = 0; i < 7; i++) {
      this.shafts.push({
        x: srng() * G.world.w,
        w: 60 + srng() * 110,
        len: 320 + srng() * 320,
        ph: srng() * Math.PI * 2,
      });
    }

    if (this.staticTex) {
      this.staticTex.destroy();
      this.staticTex = null;
    }
    const rt = this.add.renderTexture(0, 0, G.world.w, G.world.h).setOrigin(0, 0);
    rt.setDepth(-2);
    const g = this.make.graphics({ x: 0, y: 0 });

    // 地图斑块（生物群落，同 seed 同布局）：双层柔和叠加出体积感
    const rng = seededRand(G.seed);
    for (let i = 0; i < 46; i++) {
      const x = rng() * G.world.w;
      const y = rng() * G.world.h;
      const r = 60 + rng() * 160;
      const c = rng() > 0.5 ? colInt(era.palette.bgAlt) : colInt(era.palette.accent);
      g.fillStyle(c, 0.11);
      g.fillCircle(x, y, r);
      g.fillStyle(c, 0.07);
      g.fillCircle(x, y, r * 0.62);
    }

    // 地形斑块（平原/丘陵/深海）
    const terrainRng = seededRand(G.seed + 1);
    for (let i = 0; i < 8; i++) {
      let tType: 'flat' | 'hill' | 'deepwater' = 'flat';
      if (i >= 6) tType = 'deepwater';
      else if (i === 5 || i === 3) tType = 'hill';
      const x = terrainRng() * G.world.w;
      const y = terrainRng() * G.world.h;
      const r = 80 + terrainRng() * 240;
      if (tType === 'hill') {
        g.fillStyle(colInt(era.palette.bgAlt), 0.18);
        g.fillCircle(x, y, r * 0.85);
        g.fillStyle(colInt('#ffffff'), 0.04);
        g.fillCircle(x - r * 0.12, y - r * 0.12, r * 0.5); // 顶部受光高光
        g.lineStyle(2.2, colInt('#ffffff'), 0.4);
        g.strokeCircle(x, y, r * 0.85);
      } else if (tType === 'deepwater') {
        g.fillStyle(colInt('#101830'), 0.62);
        g.fillCircle(x, y, r * 0.9);
        g.fillStyle(colInt('#080d1d'), 0.5);
        g.fillCircle(x, y, r * 0.52); // 深渊核心更暗
        g.lineStyle(2, colInt('#4fc3f7'), 0.35);
        g.strokeCircle(x, y, r * 1.12);
        g.lineStyle(1, colInt('#4fc3f7'), 0.16);
        g.strokeCircle(x, y, r * 1.32);
      } else {
        g.fillStyle(colInt(era.palette.bgAlt), 0.22);
        g.fillCircle(x, y, r);
      }
    }

    // 环境分区（半透明色块 + 双边界环）
    const zones = DataStore.zonesForEra(G.eraIndex);
    for (const z of zones) {
      const zx = z.x * G.world.w;
      const zy = z.y * G.world.h;
      const zc = colInt(z.color);
      g.fillStyle(zc, 0.07);
      g.fillCircle(zx, zy, z.radius);
      g.lineStyle(1.6, zc, 0.3);
      g.strokeCircle(zx, zy, z.radius);
      g.lineStyle(0.8, zc, 0.15);
      g.strokeCircle(zx, zy, z.radius * 0.86);
    }

    rt.draw(g);
    g.destroy();
    this.staticTex = rt;
  }

  drawWorld(): void {
    const G = this.G;
    const g = this.gfx;
    g.clear();
    const t = G.timeS;

    // 相机世界视野 + padding（剔除屏外绘制）
    const wv = this.cameras.main.worldView;
    const pad = 260;
    const left = wv.x - pad, right = wv.right + pad;
    const top = wv.y - pad, bottom = wv.bottom + pad;

    // —— 水体氛围 1：顶部漏光（稀疏体积光柱，缓慢摇曳）——
    for (const s of this.shafts) {
      if (s.x + s.w < left || s.x - s.w > right) continue;
      const sway = Math.sin(t * 0.22 + s.ph) * 26;
      const alpha = 0.028 + 0.018 * Math.sin(t * 0.4 + s.ph);
      if (alpha <= 0.004) continue;
      g.fillStyle(0xdff6ff, alpha);
      g.fillPoints([
        { x: s.x - s.w * 0.3, y: 0 },
        { x: s.x + s.w * 0.3, y: 0 },
        { x: s.x + s.w * 0.75 + sway, y: s.len },
        { x: s.x - s.w * 0.75 + sway, y: s.len },
      ], true);
    }

    // —— 水体氛围 2：浮游微粒（缓慢往返漂移）——
    for (const p of this.plankton) {
      const px = p.x + Math.sin(t * p.sp + p.ph) * p.amp;
      const py = p.y + Math.cos(t * p.sp * 0.8 + p.ph * 1.7) * p.amp * 0.7;
      if (px < left || px > right || py < top || py > bottom) continue;
      g.fillStyle(p.c, p.a);
      g.fillCircle(px, py, p.r);
    }

    // —— 实体 ——
    for (const e of G.ents) {
      if (e.aiState === 'dead' && e.kind !== 'corpse') continue;
      if (e.x < left || e.x > right || e.y < top || e.y > bottom) continue;
      const def = DataStore.species(e.speciesId);
      const mem = G.memories.get(e.speciesId);
      const known = mem?.unlocked === true;
      // 蛋白质掉落物：粉红肉块 + 呼吸脉动（独立渲染）
      if (e.kind === 'protein') {
        const pulse = 1 + 0.12 * Math.sin(G.timeS * 5 + e.id);
        g.fillStyle(0xf4a3b5, 0.95);
        g.fillCircle(e.x, e.y, e.radius * pulse);
        g.fillStyle(0xc96f80, 0.9);
        g.fillCircle(e.x + 1.5, e.y + 1.5, e.radius * 0.45 * pulse);
        g.lineStyle(1.2, 0xfff0f3, 0.5 + 0.3 * Math.sin(G.timeS * 5));
        g.strokeCircle(e.x, e.y, e.radius * pulse + 2.5);
        continue;
      }

      const wob = Math.sin(e.wobble) * (e.kind === 'food' ? 1.5 : 0.8);
      const ey = e.y + wob;
      if (e.kind === 'corpse') {
        g.fillStyle(0x8a94a0, 0.5);
        g.fillCircle(e.x, ey, e.radius * 0.8);
        g.lineStyle(1, 0xaab4c0, 0.2);
        g.strokeCircle(e.x, ey, e.radius * 0.9);
      } else if (!known) {
        // 未识别物种：金色轮廓 + 内部未知纹理（保留"未知的诱惑"读法）
        g.fillStyle(0xffd166, 0.16);
        g.fillCircle(e.x, ey, e.radius + 3);
        g.lineStyle(1.4, 0xffd166, 0.85);
        g.strokeCircle(e.x, ey, e.radius + 3);
        g.fillStyle(0xffd166, 0.5);
        g.fillCircle(e.x - e.radius * 0.3, ey - e.radius * 0.15, 1.4);
        g.fillCircle(e.x + e.radius * 0.25, ey + e.radius * 0.3, 1.1);
        g.fillCircle(e.x + e.radius * 0.1, ey - e.radius * 0.45, 1.0);
      } else {
        const base = colInt(def.color);
        // 游动尾迹（食物不画）
        const v = Math.hypot(e.vx, e.vy);
        if (v > 6 && e.kind !== 'food') {
          g.lineStyle(2, base, 0.22);
          g.lineBetween(e.x, ey, e.x - e.vx * 0.09, ey - e.vy * 0.09);
        }
        if (e.kind === 'food') {
          // 食物：脉动 + 受光高光
          const pulse = 1 + 0.07 * Math.sin(G.timeS * 3.4 + e.id);
          g.fillStyle(base, 0.95);
          g.fillCircle(e.x, ey, e.radius * pulse);
          g.fillStyle(0xffffff, 0.35);
          g.fillCircle(e.x - e.radius * 0.3, ey - e.radius * 0.34, e.radius * 0.24);
        } else if (e.kind === 'predator') {
          g.fillStyle(base, 0.92);
          g.fillCircle(e.x, ey, e.radius);
          // 朝向红瞳眼点（凶感辨识）
          const ang = Math.atan2(e.vy, e.vx);
          const er = Math.max(1.6, e.radius * 0.14);
          g.fillStyle(0xffe1e1, 0.9);
          g.fillCircle(e.x + Math.cos(ang - 0.5) * e.radius * 0.55, ey + Math.sin(ang - 0.5) * e.radius * 0.55, er);
          g.fillCircle(e.x + Math.cos(ang + 0.5) * e.radius * 0.55, ey + Math.sin(ang + 0.5) * e.radius * 0.55, er);
          g.fillStyle(0xa01515, 0.95);
          g.fillCircle(e.x + Math.cos(ang - 0.5) * e.radius * 0.62, ey + Math.sin(ang - 0.5) * e.radius * 0.62, er * 0.5);
          g.fillCircle(e.x + Math.cos(ang + 0.5) * e.radius * 0.62, ey + Math.sin(ang + 0.5) * e.radius * 0.62, er * 0.5);
          g.lineStyle(1.2, 0xffffff, 0.22);
          g.strokeCircle(e.x, ey, e.radius);
        } else {
          g.fillStyle(base, 0.92);
          g.fillCircle(e.x, ey, e.radius);
          g.fillStyle(0xffffff, 0.28);
          g.fillCircle(e.x - e.radius * 0.3, ey - e.radius * 0.32, e.radius * 0.26);
          g.lineStyle(1.2, 0xffffff, 0.22);
          g.strokeCircle(e.x, ey, e.radius);
        }
      }
      if (e.hitFlash > 0) {
        g.lineStyle(2.4, 0xffffff, e.hitFlash * 3);
        g.strokeCircle(e.x, e.y, e.radius + 2);
      }
      if (known && mem && mem.dangerLevel >= 6 && e.kind !== 'corpse') {
        g.lineStyle(1.6, 0xff6b6b, 0.8);
        g.strokeCircle(e.x, ey, e.radius + 5);
      }
      // 受伤生物头顶血条（满血不显示）
      if (e.kind !== 'corpse' && e.hp < e.hpMax) {
        const bw = Math.max(18, e.radius * 2);
        const bx = e.x - bw / 2;
        const by = ey - e.radius - 9;
        g.fillStyle(0x101820, 0.75);
        g.fillRect(bx - 1, by - 1, bw + 2, 5);
        const pct = Math.max(0, e.hp / e.hpMax);
        g.fillStyle(e.kind === 'predator' ? 0xff5d5d : e.kind === 'food' ? 0x6fe08a : 0x56c9f0, 0.95);
        g.fillRect(bx, by, bw * pct, 3);
      }
    }

    // —— 灾害 ——
    for (const h of G.disasters) {
      const def = DataStore.disaster(h.defId);
      if (def.radius > 0) {
        if (h.phase === 'warning') {
          g.lineStyle(2.5, 0xff9f43, 0.4 + 0.3 * Math.sin(G.timeS * 8));
          g.strokeCircle(h.x, h.y, h.radius);
        } else if (h.phase === 'burst') {
          g.fillStyle(0xff6b35, 0.30);
          g.fillCircle(h.x, h.y, h.radius * (0.75 + 0.1 * Math.sin(G.timeS * 9)));
          for (let i = 0; i < 7; i++) {
            const a = G.timeS * 2 + i;
            g.fillStyle(0xffd166, 0.7);
            g.fillCircle(h.x + Math.cos(a) * 24, h.y + Math.sin(a * 1.7) * 24 - (G.timeS * 40 % 90), 5);
          }
        }
      }
    }

    // —— 玩家（器官级可视化，与编辑器预览保持一致）——
    this.drawPlayer(g, t);
  }

  /**
   * 玩家：依据已安装器官程序化绘制（鞭毛/纤毛/骨针/甲壳/口器/眼点/核心），
   * 叠加游动残影与微光晕；器官集合与编辑器"生物预览"使用同一份 activeModules 事实。
   */
  drawPlayer(g: Phaser.GameObjects.Graphics, t: number): void {
    const G = this.G;
    const P = G.player;
    const pr = playerRadius(P.bodyVol);
    const counts = new Map<string, number>();
    for (const id of Organ.activeModules(P.modules)) counts.set(id, (counts.get(id) || 0) + 1);
    const n = (id: string): number => counts.get(id) ?? 0;
    const fx = Math.cos(P.facing);
    const fy = Math.sin(P.facing);

    // 环境微光晕（把玩家从深色水底里托出来）
    g.fillStyle(0xffd166, 0.04);
    g.fillCircle(P.x, P.y, pr * 2.1);
    g.fillStyle(0xffd166, 0.05);
    g.fillCircle(P.x, P.y, pr * 1.45);

    // 游动残影（速度感）
    const spd = Math.hypot(P.vx, P.vy);
    if (spd > 24) {
      const k = Math.min(1, spd / 90);
      g.fillStyle(0xffd166, 0.1 * k);
      g.fillCircle(P.x - P.vx * 0.045, P.y - P.vy * 0.045, pr * 0.85);
      g.fillStyle(0xffd166, 0.05 * k);
      g.fillCircle(P.x - P.vx * 0.09, P.y - P.vy * 0.09, pr * 0.68);
    }

    // 鞭毛：贝塞尔近似（尾端摆动）
    const flag = n('flagellum');
    if (flag > 0) {
      const len = pr * (1.1 + flag * 0.28);
      const pts: { x: number; y: number }[] = [];
      const segs = 14;
      for (let i = 0; i <= segs; i++) {
        const k = i / segs;
        const sway = Math.sin(t * 6.5 - k * 4.2) * (5 + flag * 2.2) * k;
        pts.push({
          x: P.x - fx * (pr * 0.7 + len * k) - fy * sway,
          y: P.y - fy * (pr * 0.7 + len * k) + fx * sway,
        });
      }
      g.lineStyle(2 + flag * 0.8, 0xffd18a, 0.9);
      g.strokePoints(pts, false);
    }

    // 纤毛丛（短毛摆动，前方给口器让位）
    const cilia = n('cilia_cluster');
    if (cilia > 0) {
      g.lineStyle(1.3, 0xfff3c4, 0.65);
      const cnt = 16 + cilia * 4;
      for (let i = 0; i < cnt; i++) {
        const a = (i / cnt) * Math.PI * 2;
        if (Math.cos(a - P.facing) > 0.72) continue;
        const wig = Math.sin(t * 7 + i * 1.7) * 2.4;
        const x1 = P.x + Math.cos(a) * pr;
        const y1 = P.y + Math.sin(a) * pr;
        g.lineBetween(x1, y1, x1 + Math.cos(a) * (6 + wig), y1 + Math.sin(a) * (6 + wig));
      }
    }

    // 骨针（背侧刺，随朝向旋转）
    const spikes = n('spike_cilia');
    if (spikes > 0) {
      g.lineStyle(1.8, 0xdff2ff, 0.85);
      const cnt = 5 + spikes * 2;
      for (let i = 0; i < cnt; i++) {
        const a = P.facing - Math.PI * 0.62 + (i / (cnt - 1)) * Math.PI * 1.24;
        const extra = 8 + spikes * 3;
        g.lineBetween(
          P.x + Math.cos(a) * (pr + 2), P.y + Math.sin(a) * (pr + 2),
          P.x + Math.cos(a) * (pr + 2 + extra), P.y + Math.sin(a) * (pr + 2 + extra),
        );
      }
    }

    // 身体（多层圆模拟径向渐变，内亮外暗）+ 底部暗影（从水底浮起感）
    g.fillStyle(0x101820, 0.35);
    g.fillCircle(P.x + 2, P.y + 4, pr * 0.96);
    g.fillStyle(0xe0a63e, 0.95);
    g.fillCircle(P.x, P.y, pr);
    g.fillStyle(0xffd166, 0.95);
    g.fillCircle(P.x, P.y, pr * 0.8);
    g.fillStyle(0xfff3c4, 0.78);
    g.fillCircle(P.x + fx * pr * 0.22, P.y + fy * pr * 0.22, pr * 0.5);

    // 细胞质斑点（确定性分布，随朝向偏移，增强"活细胞"质感）
    const cyto = seededRand(7);
    for (let i = 0; i < 5; i++) {
      const ca = cyto() * Math.PI * 2;
      const crr = cyto() * pr * 0.55;
      const cr2 = 1.2 + cyto() * 1.8;
      g.fillStyle(0xffe8b8, 0.18);
      g.fillCircle(P.x + Math.cos(ca) * crr, P.y + Math.sin(ca) * crr, cr2);
    }
    // 轮廓描边（把玩家从深色水底里勾出来）
    g.lineStyle(1.2, 0xffd166, 0.4);
    g.strokeCircle(P.x, P.y, pr + 0.5);

    // 多细胞聚合（外凸细胞团）
    const multi = n('multicell_agg');
    if (multi > 0) {
      g.fillStyle(0xe8c06a, 0.9);
      const bumps = 3 + multi * 2;
      for (let i = 0; i < bumps; i++) {
        const a = P.facing + Math.PI * 0.5 + (i / bumps) * Math.PI * 1.6;
        g.fillCircle(P.x + Math.cos(a) * pr * 0.9, P.y + Math.sin(a) * pr * 0.9, 4 + multi + pr * 0.08);
      }
    }

    // 细胞壁（分段硬壳，随朝向旋转）
    if (n('cell_wall') > 0) {
      g.lineStyle(3.6, 0xe8d9a8, 0.85);
      const segs = 12;
      for (let i = 0; i < segs; i++) {
        const a0 = P.facing + (i / segs) * Math.PI * 2;
        g.beginPath();
        g.arc(P.x, P.y, pr + 3.5, a0, a0 + (Math.PI * 2 / segs) * 0.62, false);
        g.strokePath();
      }
    }
    // 外骨骼（厚重甲环分段）
    if (n('exoskeleton') > 0) {
      g.lineStyle(5, 0xc7d2de, 0.95);
      const segs = 8;
      for (let i = 0; i < segs; i++) {
        const a0 = P.facing + (i / segs) * Math.PI * 2;
        g.beginPath();
        g.arc(P.x, P.y, pr + 5.5, a0, a0 + (Math.PI * 2 / segs) * 0.55, false);
        g.strokePath();
      }
    }
    // 三叶虫甲片（背侧分段甲板）
    const trilo = n('trilo_plate');
    if (trilo > 0) {
      g.lineStyle(4.4, 0xb9a67e, 0.95);
      const plates = 3 + trilo;
      for (let i = 0; i < plates; i++) {
        const a0 = P.facing - Math.PI * 0.42 + (i / plates) * Math.PI * 0.84;
        g.beginPath();
        g.arc(P.x, P.y, pr + 3, a0, a0 + (Math.PI * 0.84 / plates) * 0.6, false);
        g.strokePath();
      }
    }
    // 尾刺（后端三角，随朝向旋转）
    const tail = n('tail_spine');
    if (tail > 0) {
      const sp = 12 + tail * 3;
      g.fillStyle(0xe8f4ff, 0.95);
      g.fillPoints([
        { x: P.x - fx * (pr - 1) - fy * 4.5, y: P.y - fy * (pr - 1) + fx * 4.5 },
        { x: P.x - fx * (pr + sp), y: P.y - fy * (pr + sp) },
        { x: P.x - fx * (pr - 1) + fy * 4.5, y: P.y - fy * (pr - 1) - fx * 4.5 },
      ], true);
    }

    // 口器（前端开口扇形）+ 尖牙；无口器时画先天口沟
    const mouths = n('mouth_basic');
    if (mouths > 0) {
      const mw = Math.min(0.42, 0.2 + mouths * 0.09);
      g.fillStyle(0x241207, 0.92);
      g.beginPath();
      g.moveTo(P.x, P.y);
      g.arc(P.x, P.y, pr * 1.02, P.facing - mw, P.facing + mw, false);
      g.closePath();
      g.fillPath();
      const fang = n('fang');
      if (fang > 0) {
        g.fillStyle(0xffffff, 0.95);
        for (const s of [-1, 1]) {
          const len = 6 + fang * 2 + pr * 0.12;
          g.fillPoints([
            { x: P.x + Math.cos(P.facing + s * (mw + 0.06)) * (pr + 1), y: P.y + Math.sin(P.facing + s * (mw + 0.06)) * (pr + 1) },
            { x: P.x + Math.cos(P.facing + s * (mw + 0.2)) * (pr + len), y: P.y + Math.sin(P.facing + s * (mw + 0.2)) * (pr + len) },
            { x: P.x + Math.cos(P.facing + s * (mw + 0.34)) * (pr + 1), y: P.y + Math.sin(P.facing + s * (mw + 0.34)) * (pr + 1) },
          ], true);
        }
      }
    } else if (n('oral_groove') > 0) {
      g.lineStyle(2, 0x78ffb4, 0.5);
      g.beginPath();
      g.arc(P.x, P.y, pr * 0.72, P.facing - 0.5, P.facing + 0.28, false);
      g.strokePath();
    }

    // 细胞核（体内核仁）
    if (n('nucleus') > 0) {
      const nx = P.x - fx * pr * 0.2;
      const ny = P.y - fy * pr * 0.2;
      g.fillStyle(0x5a46a0, 0.9);
      g.fillCircle(nx, ny, pr * 0.2);
      g.lineStyle(1.2, 0xc8b4ff, 0.55);
      g.strokeCircle(nx, ny, pr * 0.2);
    }

    // 光合器（顶侧绿点脉动）
    const ph = n('photosynth');
    if (ph > 0) {
      g.fillStyle(0x6fe08a, 0.5 + 0.3 * Math.sin(t * 3));
      const dots = 2 + ph * 2;
      for (let i = 0; i < dots; i++) {
        const a = P.facing + Math.PI * 1.2 + (i / dots) * Math.PI * 0.6;
        g.fillCircle(P.x + Math.cos(a) * pr * 0.68, P.y + Math.sin(a) * pr * 0.68, 3);
      }
    }
    // 储能颗粒
    const gr = n('granule');
    if (gr > 0) {
      g.fillStyle(0x56c9f0, 0.85);
      for (let i = 0; i < gr * 2; i++) {
        const a = P.facing + Math.PI * 0.75 + i * 0.8;
        g.fillCircle(P.x + Math.cos(a) * pr * 0.46, P.y + Math.sin(a) * pr * 0.46, 2.6);
      }
    }
    // 神经网 / 神经节（内圈紫晕）
    if (n('nerve_net') > 0 || n('ganglion') > 0) {
      g.fillStyle(0xc792ea, 0.1);
      g.fillCircle(P.x, P.y, pr * 0.55);
      g.fillStyle(0xc792ea, 0.08);
      g.fillCircle(P.x, P.y, pr * 0.34);
    }

    // 眼点 / 复眼（前方两侧）
    if (n('photospot') > 0) {
      const ex = P.x + Math.cos(P.facing - 0.55) * pr * 0.6;
      const ey = P.y + Math.sin(P.facing - 0.55) * pr * 0.6;
      g.fillStyle(0xffffff, 0.95);
      g.fillCircle(ex, ey, 3.2);
      g.fillStyle(0x10202c, 0.95);
      g.fillCircle(ex + fx * 0.8, ey + fy * 0.8, 1.5);
    }
    const ce = n('compound_eye');
    if (ce > 0) {
      const eyes = 2 + ce * 2;
      for (let i = 0; i < eyes; i++) {
        const a = P.facing - 0.75 + (i / Math.max(1, eyes - 1)) * 1.5;
        const ex = P.x + Math.cos(a) * pr * 0.7;
        const ey = P.y + Math.sin(a) * pr * 0.7;
        g.fillStyle(0xffffff, 0.95);
        g.fillCircle(ex, ey, 2.4);
        g.fillStyle(0x10202c, 0.95);
        g.fillCircle(ex + fx, ey + fy, 1.1);
      }
    }

    // 细胞膜（先天薄膜）
    if (n('cell_membrane') > 0) {
      g.lineStyle(1.8, 0xb4e8ff, 0.45);
      g.strokeCircle(P.x, P.y, pr + 1.5);
    }

    // 护甲光环 / 无敌 / 受击
    if (P.armorTotal > 8) {
      g.lineStyle(2.2, 0x9ad1ff, 0.9);
      g.strokeCircle(P.x, P.y, pr + 3);
    }
    if (P.invulnT > 0) {
      g.lineStyle(1.6, 0xffffff, P.invulnT);
      g.strokeCircle(P.x, P.y, pr + 7);
    }
    if (P.hitFlash > 0) {
      g.lineStyle(3, 0xff4444, P.hitFlash * 3);
      g.strokeCircle(P.x, P.y, pr + 2);
    }
  }
}
