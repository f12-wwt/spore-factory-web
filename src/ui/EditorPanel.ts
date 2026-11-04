import type { GameState, Player, FlowNode } from '../types/GameState';
import { DataStore } from '../systems/DataStore';
import type { ModuleDef, ModuleSlot } from '../types/Module';
import { Metab, pressureTier } from '../systems/MetabolismSystem';
import { Stage } from '../systems/StageSystem';
import { Logistics, LAYERS, layerColor, layerUnlocked } from '../systems/LogisticsSystem';
import * as Organ from '../systems/OrganSystem';
import type { Anatomy } from './Anatomy';
import { anchorOf, spread } from './Anatomy';
import { CONST, upgradeSpentOf, upgradeCostOf } from '../systems/RunState';
import { Analytics } from '../systems/AnalyticsSystem';
import { Ev, bus } from '../core/EventBus';
import { pointSegDist, seededRand } from '../core/MathUtils';
import { esc } from '../core/escape';

/**
 * 生物编辑器（GDD 3.3 / T7/T8）：
 * 形态页 = 外部模块（安装扣生长储备 / 卸载返还 30%，均保存时结算）；
 * 物流页 = 内部节点连线（吞吐=最宽路径、瓶颈高亮、扩容/拆除）。
 * 纪元推进会话（里程碑已满）解锁下一纪元模块库；装关键模块保存即推进。
 */
export const Editor = {
  G: null as GameState | null,
  tab: 'morph' as 'morph' | 'network',
  /** 待应用修改（保存才生效） */
  pend: {
    modules: [] as string[],
    modLevels: {} as Record<string, number>,
    nodes: [] as FlowNode[],
    pipes: [] as Player['pipes'],
    spent: 0,
    upSpent: 0,
    refund: 0,
  },
  selNode: null as string | null,
  selPipe: -1,
  /** 节点布局是否需要重算（仅器官增删时置 true，避免每帧重排） */
  layoutDirty: true,
  /** 组件选中（右栏"组件属性"面板） */
  selComp: null as string | null,
  selCompFrom: 'installed' as 'installed' | 'library',
  /** 预览动画（形态页打开期间运行） */
  previewOn: false,
  previewRaf: 0 as number,
  /** 物流页动画：rAF 持续重绘，营造"体内物流沙盘"的流动感 */
  netAnimOn: false,
  netRaf: 0 as number,
  netTime: 0,
  lastNetTs: 0,
  hoverNode: null as string | null,
  hoverPipe: -1,
  mouse: { x: -9999, y: -9999 } as { x: number; y: number },
  /** 物流画布逻辑分辨率（物理像素 = 逻辑 × DPR，避免 CSS 拉伸模糊） */
  NET_W: 1100,
  NET_H: 640,
  netDpr: 1,
  /** 中枢节点：能量池（全网水库）、肌肉（运动终点）、大脑（神经终点） */
  isCore(id: string): boolean {
    return id === 'energy' || id === 'muscle' || id === 'brain';
  },

  init(G: GameState): void {
    this.G = G;
    bus.on(Ev.EDITOR_OPEN, () => this.show());
    document.getElementById('ed-close')!.onclick = () => this.close(false);
    document.getElementById('ed-cancel')!.onclick = () => this.close(false);
    document.getElementById('ed-save')!.onclick = () => this.close(true);
    document.getElementById('tab-morph')!.onclick = () => this.switchTab('morph');
    document.getElementById('tab-network')!.onclick = () => this.switchTab('network');

    const cv = document.getElementById('net-canvas') as HTMLCanvasElement;
    // DPI 适配：物理像素按 devicePixelRatio 放大，绘制走逻辑坐标（1100×640）
    this.netDpr = Math.min(2.5, window.devicePixelRatio || 1);
    cv.width = this.NET_W * this.netDpr;
    cv.height = this.NET_H * this.netDpr;
    cv.onclick = e => this.onNetClick(e);
    cv.onmousemove = e => this.onNetMove(e);
    cv.onmouseleave = () => {
      this.hoverNode = null;
      this.hoverPipe = -1;
      this.mouse.x = -9999;
      this.mouse.y = -9999;
    };
    document.getElementById('pipe-up')!.onclick = () => this.upgradePipe();
    document.getElementById('pipe-del')!.onclick = () => this.removePipe();
  },

  show(): void {
    const G = this.G!;
    if (G.mode !== 'playing') return;
    G.mode = 'editing';
    const P = G.player;
    this.pend = {
      modules: [...P.modules],
      modLevels: { ...P.modLevels },
      nodes: P.nodes.map(n => ({ ...n })),
      pipes: P.pipes.map(l => ({ ...l })),
      spent: 0,
      upSpent: 0,
      refund: 0,
    };
    this.selNode = null;
    this.selPipe = -1;
    this.layoutDirty = true;
    this.selComp = G.player.modules[0] ?? null;
    this.selCompFrom = 'installed';
    Analytics.onFirstEdit(G);
    document.getElementById('editor')!.classList.remove('hidden');
    document.getElementById('net-pipeops')!.classList.add('hidden');
    this.switchTab('morph');
  },

  close(apply: boolean): void {
    const G = this.G!;
    this.stopPreview();
    this.stopNetAnim();
    document.getElementById('editor')!.classList.add('hidden');
    if (apply) this.apply();
    G.mode = 'playing';
    Metab.recompute(G);
    bus.emit(Ev.HUD_DIRTY);
  },

  /** 保存：结算储备账目 → 应用 → 判定纪元推进 */
  apply(): void {
    const G = this.G!;
    const P = G.player;
    P.modules = [...this.pend.modules];
    P.modLevels = { ...this.pend.modLevels };
    P.nodes = this.pend.nodes.map(n => ({ ...n }));
    P.pipes = this.pend.pipes.map(l => ({ ...l }));
    // 兜底：已安装器官必须连入所属层（补回被手动拆掉的自动线；幂等）
    Logistics.autoWire(P);
    P.metab.growthReserve = Math.max(0, P.metab.growthReserve - this.pend.spent - this.pend.upSpent + this.pend.refund);
    Metab.recompute(G);
    P.metab.burstPool = Math.min(P.metab.burstPool, P.metab.maxBurstPool);

    if (G.evoSession) {
      if (Stage.canAdvance(G)) {
        Stage.advance(G);
      } else {
        // 未完成关键进化：形态照常保存（已装的模块都是玩家的），留守本纪元
        const era = DataStore.era(G.eraIndex);
        const goal = era.keyModule ? `安装【${DataStore.module(era.keyModule).name}】` : era.transitionEvent;
        bus.emit(Ev.TOAST, { text: `🧬 形态已保存。完成关键进化（${goal}）即可进入下一纪元`, kind: 'good' });
      }
    }
  },

  switchTab(t: 'morph' | 'network'): void {
    this.tab = t;
    document.getElementById('tab-morph')!.classList.toggle('active', t === 'morph');
    document.getElementById('tab-network')!.classList.toggle('active', t === 'network');
    document.getElementById('ed-morph')!.classList.toggle('hidden', t !== 'morph');
    document.getElementById('ed-network')!.classList.toggle('hidden', t !== 'network');
    if (t === 'morph') {
      this.stopNetAnim();
      this.renderMorph();
      this.startPreview();
    } else {
      this.stopPreview();
      this.renderNetwork();
      this.startNetAnim();
    }
  },

  available(): number {
    const G = this.G!;
    return G.player.metab.growthReserve - this.pend.spent - this.pend.upSpent + this.pend.refund;
  },

  /** 模块强化：Lv 上限内花费储备提升等级，效果按类别不同（保存时结算） */
  upgradeOne(id: string): void {
    const m = DataStore.module(id);
    const lv = this.pend.modLevels[id] ?? 1;
    if (lv >= CONST.UP_MAX_LEVEL) {
      bus.emit(Ev.TOAST, { text: `${m.name} 已达强化上限 Lv${CONST.UP_MAX_LEVEL}`, kind: 'warn' });
      return;
    }
    const cost = upgradeCostOf(m.growthCost, lv);
    if (this.available() < cost) {
      bus.emit(Ev.TOAST, { text: `储备不足（强化需 ${cost}）`, kind: 'warn' });
      return;
    }
    this.pend.upSpent += cost;
    this.pend.modLevels[id] = lv + 1;
    // 同步待应用节点吞吐（物流页即时预览强化效果）
    for (const n of this.pend.nodes) {
      if (!n.moduleId) continue;
      const mm = DataStore.module(n.moduleId);
      if (!mm.node) continue;
      n.rate = DataStore.effStats(mm, this.pend.modLevels[n.moduleId] ?? 1).nodeRate;
    }
    const es = DataStore.effStats(m, lv + 1);
    const esOld = DataStore.effStats(m, lv);
    const delta: string[] = [];
    if (es.volume > esOld.volume) delta.push(`体积+${(es.volume - esOld.volume).toFixed(1)}`);
    if (m.category === 'defense' || m.category === 'trunk') delta.push(`体积上限+${CONST.MAX_VOL_PER_UP}`);
    if (es.armorMod > esOld.armorMod) delta.push(`护甲+${es.armorMod - esOld.armorMod}`);
    if (es.speedMod > esOld.speedMod) delta.push(`速度+${es.speedMod - esOld.speedMod}`);
    if (es.perceptionMod > esOld.perceptionMod) delta.push(`感知+${es.perceptionMod - esOld.perceptionMod}`);
    if (es.attackMod > esOld.attackMod) delta.push(`攻击+${es.attackMod - esOld.attackMod}`);
    if (es.nodeRate > esOld.nodeRate) delta.push(`处理量${esOld.nodeRate}→${es.nodeRate}`);
    bus.emit(Ev.TOAST, { text: `⬆ ${m.name} 强化至 Lv${lv + 1}（保存后生效）：${delta.join(' · ') || '效果提升'} · 常驻消耗↑`, kind: 'good' });
    this.selComp = id;
    this.selCompFrom = 'installed';
    this.layoutDirty = true;
    this.renderMorph();
  },

  /** 强化预览文案（按钮 title） */
  upPreview(id: string): string {
    const m = DataStore.module(id);
    const lv = this.pend.modLevels[id] ?? 1;
    if (lv >= CONST.UP_MAX_LEVEL) return `已达上限 Lv${CONST.UP_MAX_LEVEL}；卸载重装会清空强化`;
    const next = DataStore.effStats(m, lv + 1);
    const parts: string[] = [];
    if (next.volume > m.volume) parts.push('体积↑');
    if (m.category === 'defense' || m.category === 'trunk') parts.push(`体积上限+${CONST.MAX_VOL_PER_UP}`);
    if (m.armorMod > 0) parts.push(`护甲→${next.armorMod}`);
    if (m.speedMod > 0) parts.push(`速度→${next.speedMod}`);
    if (m.perceptionMod > 0) parts.push(`感知→${next.perceptionMod}`);
    if (m.attackMod > 0) parts.push(`攻击→${next.attackMod}`);
    if (m.node) parts.push(`处理量→${next.nodeRate}`);
    if (m.category === 'metabolism') parts.push(`代谢产出+${Math.round(CONST.META_UP_PCT * 100)}%`);
    parts.push('常驻消耗↑');
    return `强化至 Lv${lv + 1}：${parts.join(' · ')}（${upgradeCostOf(m.growthCost, lv)}⬢）`;
  },

  renderHead(): void {
    const G = this.G!;
    const era = DataStore.era(G.eraIndex);
    const P = G.player;
    const modVol = this.pend.modules.reduce((s, id) =>
      s + DataStore.effStats(DataStore.module(id), this.pend.modLevels[id] ?? 1).volume, 0);
    document.getElementById('ed-growth')!.textContent = `储备 ${Math.round(this.available())}`;
    const cap = Metab.volumeCap(G);
    document.getElementById('ed-vol')!.textContent =
      `体积 ${4 + modVol + Math.round(P.growthVol)}/${cap}` +
      (P.maxVolumeBonus > 0 ? `（强化 +${P.maxVolumeBonus}）` : '');
    const chip = document.getElementById('ed-goal')!;
    if (G.evoSession) {
      chip.textContent = era.keyModule
        ? `🎯 关键进化：安装【${DataStore.module(era.keyModule).name}】 → ${DataStore.eraAt(G.eraIndex + 1)?.name ?? '终局通关'}`
        : `🎯 保存即推进（${era.transitionEvent}）`;
      chip.className = 'chip warn';
    } else {
      chip.textContent = `纪元目标 ${G.milestoneDone.filter(Boolean).length}/${era.milestones.length}，达成后解锁下一纪元模块`;
      chip.className = 'chip';
    }
    const m = P.metab;
    const pr = document.getElementById('ed-pressure')!;
    pr.textContent = `代谢压力 ${Number.isFinite(m.pressure) ? Math.round(m.pressure * 100) : '∞'}%（${m.tier.label}）`;
    pr.className = `chip ${m.pressure > 1 ? 'bad' : m.pressure > 0.8 ? 'warn' : 'good'}`;
  },

  /* ---------------- 形态页 ---------------- */

  eraOk(m: ModuleDef): boolean {
    const G = this.G!;
    return m.era <= G.eraIndex || (G.evoSession && m.era === G.eraIndex + 1);
  },

  memOk(m: ModuleDef): boolean {
    const G = this.G!;
    if (!m.requiresMemory) return true;
    return !!G.memories.get(m.requiresMemory)?.unlocked;
  },

  /** 形态页总渲染：已安装 / 组件库 / 预览 / 当前属性 / 组件详情 */
  renderMorph(): void {
    this.renderInstalled();
    this.renderLibrary();
    this.renderStats();
    this.renderDetail();
    this.drawPreview(performance.now() / 1000);
    this.renderHead();
  },

  /* ---------------- 左栏：已安装 + 组件库 ---------------- */

  renderInstalled(): void {
    const inst = document.getElementById('ed-installed')!;
    const counts = new Map<string, number>();
    for (const id of this.pend.modules) counts.set(id, (counts.get(id) || 0) + 1);
    // v0.6：被高阶槽位件覆盖的器官标灰（先天件常驻体内但属性不生效）
    const activeSet = new Set(Organ.activeModules(this.pend.modules));
    const chips = [...counts.entries()].map(([id, n]) => {
      const m = DataStore.module(id);
      const lv = this.pend.modLevels[id] ?? 1;
      const lvBadge = lv > 1 ? `<b class="lv">Lv${lv}</b>` : '';
      const upBtn = `<span class="up" data-up="${id}" title="${esc(this.upPreview(id))}">⬆${lv >= CONST.UP_MAX_LEVEL ? 'MAX' : upgradeCostOf(m.growthCost, lv)}</span>`;
      const sel = this.selComp === id ? ' selected' : '';
      const shadow = activeSet.has(id) ? '' : ' shadowed';
      const shadowTip = activeSet.has(id)
        ? ''
        : ` title="被${Organ.SLOT_CN[m.slot!] ?? '更高阶器官'}覆盖，属性暂不生效"`;
      const rmBtn = m.builtIn
        ? `<span class="rm innate" title="先天器官：无法卸载">🧬</span>`
        : `<span class="rm" data-rm="${id}" title="卸载（返还 30% 购置 + 80% 强化投入）">✕</span>`;
      return `<span class="mod-chip${sel}${shadow}" data-sel="${esc(id)}"${shadowTip}><span class="p-ico">${iconOf(id)}</span>${esc(m.name)}${n > 1 ? ` ×${n}` : ''}${lvBadge}${upBtn}${rmBtn}</span>`;
    }).join('');
    inst.innerHTML = `<span class="lib-title">已安装（点选看属性）：</span>${chips || '（基础形态）'}`;

    // 地形分类标签和列表
    const terDiv = document.createElement('div');
    terDiv.className = 'ter-div';
    terDiv.textContent = '地形模块：';
    inst.appendChild(terDiv);

    const terrList = document.createElement('div');
    terrList.className = 'terr-list';
    
    // 构建地形芯片 HTML（仅已安装的地形）
    let terrHtml = `<span class="terr-label">当前地形物种：</span>`;
    
    for (const tid of this.pend.modules) {
      if (!tid.startsWith('terra_')) continue;
      const mTerraId = tid.replace('terra_', '');
      
      // 检查模块是否存在（terrain modules should always exist）
      let tmDef: ModuleDef | undefined;
      try {
        tmDef = DataStore.module(mTerraId);
      } catch {}

      const nT = counts.get(tid) || 0;
      
      // 地形模块：不显示强化按钮，只展示卸载按钮
      terrHtml += `<span class="mod-chip" data-sel="${esc(tid)}"><span class="p-ico">${iconOf(tid)}</span>${esc(tmDef ? tmDef.name : '???')}${nT > 1 ? ` ×${nT}` : ''}<span class="rm terr" data-rm="${esc(tid)}" title="卸载">✕</span></span>`;
    }
    
    // 如果没有任何已安装地形，只显示添加按钮
    if (!terrHtml.includes('当前')) {
      terrHtml = `<button class="btn-ter add" data-add-terra>＋ 添加新物种（terra_ 格式）</button>`;
    }

    terrList.innerHTML = terrHtml;

    // 绑定删除事件到所有 terrain rm buttons
    terrList.querySelectorAll('[data-rm]').forEach(el => {
      el.addEventListener('click', e => { 
        const tid = (el as HTMLElement).dataset.rm!;
        e.stopPropagation();
        this.removeTerraModule(tid);
      });
    });

    // 添加按钮事件绑定（默认添加 terra_plain）
    const addBtns = document.querySelectorAll('[data-add-terra]');
    addBtns.forEach(el => {
      el.addEventListener('click', () => this.addTerraModule('terra_plain'));
    });

    inst.querySelectorAll('[data-up]').forEach(el => {
      el.addEventListener('click', e => { e.stopPropagation(); this.upgradeOne((el as HTMLElement).dataset.up!); });
    });
  },

  renderLibrary(): void {
    const G = this.G!;
    const lib = document.getElementById('ed-library')!;
    const sections: string[] = [];
    for (let eo = G.eraIndex; eo < DataStore.eras.length; eo++) {
      const era = DataStore.era(eo);
      const isCurrent = eo === G.eraIndex;
      const unlocked = isCurrent || (eo === G.eraIndex + 1 && G.evoSession);
      const title = unlocked
        ? `${esc(era.name)}组件${isCurrent ? '' : ' 🎯 进化会话解锁'}`
        : `${esc(era.name)}组件 🔒`;
      const cells = DataStore.modules.filter(m => m.era === eo).map(m => {
        if (!unlocked) {
          return `<div class="lib-part unknown locked" data-future="1" title="???：达成里程碑并完成关键进化后解锁">` +
            `<span class="p-icon">❓</span><span class="p-name">???</span></div>`;
        }
        const memOk = this.memOk(m);
        const lv = this.pend.modLevels[m.id] ?? 1;
        const sel = this.selComp === m.id ? ' selected' : '';
        const lock = memOk ? '' : ' locked';
        const tip = [
          `${m.name}${lv > 1 ? ` Lv${lv}` : ''}`,
          `体积+${m.volume} · 常驻 ${m.residentDrain}/s${m.node ? ` · 物流节点（${LAYER_CN[Logistics.layerOf({ layer: m.node.layer, type: m.node.type })]}）` : ''}${m.keyTo ? ' · 🎯关键进化' : ''}`,
          m.desc,
          m.builtIn ? '天生自带，无法购买/卸载' : `⬢${m.growthCost} 生长储备`,
        ].join('\n');
        return `<div class="lib-part${sel}${lock}${m.builtIn ? ' innate' : ''}" data-id="${esc(m.id)}" title="${esc(tip)}">` +
          `<span class="p-icon">${iconOf(m.id)}</span>` +
          `<span class="p-name">${esc(m.name)}${m.keyTo ? '🎯' : ''}${m.builtIn ? '🧬' : (memOk ? '' : '🔒')}</span></div>`;
      }).join('');
      sections.push(`<div class="lib-section"><div class="lib-title">${esc(title)}</div><div class="lib-grid parts">${cells}</div></div>`);
    }
    lib.innerHTML = sections.join('');
    lib.querySelectorAll('[data-id]').forEach(el => {
      el.addEventListener('click', () => this.select((el as HTMLElement).dataset.id!, 'library'));
    });
    lib.querySelectorAll('[data-future]').forEach(el => {
      el.addEventListener('click', () =>
        bus.emit(Ev.TOAST, { text: '未来纪元组件——达成里程碑并完成关键进化后解锁', kind: 'info' }));
    });
  },

  select(id: string, from: 'installed' | 'library'): void {
    this.selComp = id;
    this.selCompFrom = from;
    this.renderInstalled();
    this.renderLibrary();
    this.renderDetail();
  },

  /* ---------------- 右栏：当前属性 + 组件详情 ---------------- */

  /** 当前属性：按待保存状态（pend）计算，与已保存状态对比显示 ▲▼ 增减 */
  renderStats(): void {
    const G = this.G!;
    const pend = this.pend;
    // v0.6：统计只按生效件（被高阶槽位件覆盖的器官不参与）
    const act = Organ.activeModules(pend.modules);
    const eff = act.map(id => DataStore.effStats(DataStore.module(id), pend.modLevels[id] ?? 1));
    const vol = 4 + eff.reduce((s, e) => s + e.volume, 0) + Math.round(G.player.growthVol);
    const cap = Metab.volumeCap(G);
    const trunkN = act.filter(id => DataStore.module(id).category === 'trunk').length;
    const hpMax = CONST.BASE_HP + vol * CONST.HP_PER_VOL + trunkN * CONST.TRUNK_HP_BONUS;
    const armor = eff.reduce((s, e) => s + e.armorMod, 0);
    const speed = CONST.BASE_SPEED + CONST.SPEED_PER_MOD * eff.reduce((s, e) => s + e.speedMod, 0);
    const attack = CONST.ATTACK_BASE + eff.reduce((s, e) => s + e.attackMod, 0);
    const percep = eff.reduce((s, e) => s + e.perceptionMod, 0);
    const vision = CONST.VISION_BASE + CONST.VISION_PER_PERCEPT * percep;
    const drain = eff.reduce((s, e) => s + e.residentDrain, 0);
    const svc = Logistics.services({ nodes: pend.nodes, pipes: pend.pipes });
    // 代谢类器官强化对 P 的独立贡献（v0.5）
    const metaUp = act.reduce((s, id) => {
      if (DataStore.module(id).category !== 'metabolism') return s;
      return s + CONST.META_UP_PCT * ((pend.modLevels[id] ?? 1) - 1);
    }, 0);
    const output = (CONST.P_BASE + CONST.P_PER_PATH * svc.digestCap) * (1 + metaUp);
    const capacity = CONST.BUFFER_BASE + pend.nodes
      .filter(n => n.type === 'process').reduce((s, n) => s + n.rate, 0);
    const rate = (CONST.DIGEST_RATE_BASE + CONST.DIGEST_RATE_PER_PATH * capacity) * svc.digestionEfficiency;
    const pressure = output > 0 ? drain / output : Infinity;
    const burst = CONST.BURST_BASE + act.reduce(
      (s, id) => (id !== 'granule' ? s : s + 15 + 5 * ((pend.modLevels[id] ?? 1) - 1)), 0);

    const P = G.player;
    const fmtPct = (p: number): string => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '∞%');
    // [标签, 显示值, 待保存数值, 已保存数值]（NaN = 不显示增减）
    const rows: [string, string, number, number][] = [
      ['生命上限', `${Math.round(hpMax)}`, hpMax, P.hpMax],
      ['护甲', `${Math.round(armor)}`, armor, P.armorTotal],
      ['速度', `${Math.round(speed)}`, speed, P.speedTotal],
      ['攻击', `${Math.round(attack)}`, attack, P.attackTotal],
      ['视野范围', `${Math.round(vision)}`, vision, CONST.VISION_BASE + CONST.VISION_PER_PERCEPT * P.perceptionTotal],
      ['代谢产出 P', output.toFixed(1) + (metaUp > 0 ? ` (强化+${Math.round(metaUp * 100)}%)` : ''), output, P.metab.metabolicOutput],
      ['常驻消耗 R', drain.toFixed(2), drain, P.metab.residentLoad],
      ['消化效率', fmtPct(svc.digestionEfficiency), svc.digestionEfficiency * 100, P.metab.digestionEfficiency * 100],
      ['胃容量', `${Math.round(capacity)}`, capacity, P.digestCap],
      ['消化速率', `${rate.toFixed(2)}/s`, rate, P.digestRate],
      ['爆发上限', `${burst}`, burst, P.metab.maxBurstPool],
      ['器官效率', `${Math.round(pressureTier(pressure).ratio * 100)}%`, NaN, NaN],
      ['代谢压力', fmtPct(pressure), NaN, NaN],
    ];
    const html = rows.map(([k, v, pv, sv]) => {
      let delta = '';
      if (Number.isFinite(pv) && Math.abs(pv - sv) > 0.01) {
        const up = pv > sv;
        const diff = Math.abs(pv - sv);
        delta = `<span class="s-d ${up ? 'up' : 'down'}">${up ? '▲' : '▼'}${diff >= 10 ? Math.round(diff) : diff.toFixed(1)}</span>`;
      }
      return `<div class="stat-row"><span class="s-k">${esc(k)}</span><span class="s-v"><b>${esc(v)}</b>${delta}</span></div>`;
    }).join('');
    const volRow = `<div class="stat-row"><span class="s-k">体积 / 上限</span><span class="s-v"><b>${vol}/${cap}</b>` +
      `${P.maxVolumeBonus > 0 ? `<span class="s-d up">强化+${P.maxVolumeBonus}</span>` : ''}</span></div>`;
    document.getElementById('ed-stats')!.innerHTML = volRow + html;
    document.getElementById('ed-preview-info')!.textContent =
      `体积 ${vol}/${cap} · 器官 ${pend.modules.length} 件 · 管线 ${pend.pipes.length} 条`;
  },

  /** 组件详情：选中组件的属性、锁定原因与操作按钮 */
  renderDetail(): void {
    const el = document.getElementById('ed-comp')!;
    const G = this.G!;
    const id = this.selComp;
    if (!id) {
      el.innerHTML = '<div class="cd-desc">点击左侧组件库或已安装芯片，在此查看属性并操作。</div>';
      return;
    }
    const m = DataStore.module(id);
    const lv = this.pend.modLevels[id] ?? 1;
    const es = DataStore.effStats(m, lv);
    const installed = this.pend.modules.includes(id);
    const eraOk = this.eraOk(m);
    const memOk = this.memOk(m);
    const cap = Metab.volumeCap(G);

    const stats: string[] = [];
    if (es.volume) stats.push(`体积+${es.volume}`);
    if (m.category === 'defense' || m.category === 'trunk') stats.push(`体积上限+${(lv - 1) * CONST.MAX_VOL_PER_UP}`);
    if (es.armorMod) stats.push(`护甲+${es.armorMod}`);
    if (es.speedMod) stats.push(`速度${es.speedMod > 0 ? '+' : ''}${es.speedMod}`);
    if (es.perceptionMod) stats.push(`感知+${es.perceptionMod}`);
    if (es.attackMod) stats.push(`攻击+${es.attackMod}`);
    if (m.node) stats.push(`处理量+${es.nodeRate}`);
    if (m.category === 'metabolism' && lv > 1) stats.push(`代谢产出+${Math.round((lv - 1) * CONST.META_UP_PCT * 100)}%`);
    stats.push(`常驻 ${es.residentDrain.toFixed(2)}/s`);

    const locks: string[] = [];
    if (!eraOk) locks.push('🔒 属于未来纪元——达成里程碑并完成关键进化后解锁');
    if (!memOk) locks.push(`🔎 认知解锁：${m.memoryHint ?? '需先解锁对应记忆'}`);
    if (!installed) {
      if (this.available() < m.growthCost) {
        locks.push(`储备不足（需 ⬳${m.growthCost}，现有 ${Math.round(this.available())}）`);
      }
      const modVol = Organ.activeModules(this.pend.modules).reduce((s, x) =>
        s + DataStore.effStats(DataStore.module(x), this.pend.modLevels[x] ?? 1).volume, 0);
      if (4 + modVol + es.volume + G.player.growthVol > cap) {
        locks.push(`体积超限（上限 ${cap}，可强化防御/躯干类器官扩仓）`);
      }
    }

    // 互斥锁：同槽位已有更高位次的器官
    const verdict = Organ.checkInstall(id, this.pend.modules);
    if (!installed && !verdict.ok) {
      const blocker = DataStore.module(verdict.blocker);
      locks.push(`🚫 ${m.slot ? Organ.SLOT_CN[m.slot] : '该槽位'}已被【${blocker.name}】占据（位次更高，不能退步装）`);
    }
    // 上位替代提示：装上会顶掉谁
    if (!installed && verdict.ok && verdict.replaced.length > 0 && m.slot) {
      locks.push(`⬆ 将上位替代【${verdict.replaced.map(x => DataStore.module(x).name).join(' + ')}】（同属${Organ.SLOT_CN[m.slot]}）`);
    }

    const count = this.pend.modules.filter(x => x === id).length;
    const upCost = upgradeCostOf(m.growthCost, lv);
    const actions = installed
      ? `<button data-cd-up ${lv >= CONST.UP_MAX_LEVEL ? 'disabled' : ''}>⬆ 强化 ${lv >= CONST.UP_MAX_LEVEL ? 'MAX' : `⬢${upCost}`}</button>` +
        (m.builtIn
          ? `<button class="danger" disabled>🧬 先天器官 · 不可卸载</button>`
          : `<button class="danger" data-cd-rm>✕ 卸载（返还 ⬳${Math.round(m.growthCost * CONST.REMOVE_REFUND)}）</button>`)
      : (m.builtIn
        ? `<button class="primary" disabled>🧬 先天器官 · 与生俱来</button>`
        : `<button class="primary" data-cd-add>＋ 安装 ⬳${m.growthCost}</button>`);

    el.innerHTML = `
      <div class="cd-head">${iconOf(id)} ${esc(m.name)}${m.builtIn ? ' <span class="cd-innate">🧬 先天</span>' : ''}
        <span class="cd-lv">${installed ? `已安装 ×${count}${lv > 1 ? ` · Lv${lv}` : ''}` : '未安装'}</span></div>
      <div class="cd-cat">${esc(CATEGORY_NAME[m.category] ?? m.category)} · ${esc(DataStore.era(m.era).name)}${m.keyTo ? ' · 🎯 关键进化组件' : ''}${m.node ? ` · 物流：${LAYER_CN[Logistics.layerOf({ layer: m.node.layer, type: m.node.type })]}` : ''}</div>
      ${m.slot ? `<div class="cd-chain">${this.chainHtml(m.slot, id)}</div>` : '<div class="cd-chain none">可叠加件（不占功能槽位）</div>'}
      <div class="cd-stats">${esc(stats.join(' · '))} · ${m.builtIn ? '天生自带' : `⬳${m.growthCost} 购置`}</div>
      <div class="cd-desc">${esc(m.desc)}</div>
      ${locks.map(t => `<div class="cd-lock">${esc(t)}</div>`).join('')}
      <div class="cd-actions">${actions}</div>`;

    el.querySelector('[data-cd-add]')?.addEventListener('click', () => this.installOne(id));
    el.querySelector('[data-cd-rm]')?.addEventListener('click', () => this.removeOne(id));
    el.querySelector('[data-cd-up]')?.addEventListener('click', () => this.upgradeOne(id));
  },

  /* ---------------- 中栏：生物预览（程序化 + 轻动画） ---------------- */

  /** 槽位替代链：口沟 → 基础口器 → 尖牙（当前件高亮，已装打勾） */
  chainHtml(slot: ModuleSlot, curId: string): string {
    const chain = Organ.slotChain(slot);
    const parts = chain.map((c) => {
      const owned = this.pend.modules.includes(c.id);
      const cls = c.id === curId ? 'cur' : owned ? 'owned' : '';
      return `<span class="lnk ${cls}">${owned ? '✓ ' : ''}${c.name}</span>`;
    });
    return `<b>${Organ.SLOT_CN[slot]}</b>（同槽互斥，装高位顶低位）<span class="chain">${parts.join('<i>→</i>')}</span>`;
  },

  startPreview(): void {
    if (this.previewOn) return;
    this.previewOn = true;
    const tick = (): void => {
      if (!this.previewOn) return;
      this.drawPreview(performance.now() / 1000);
      this.previewRaf = requestAnimationFrame(tick);
    };
    this.previewRaf = requestAnimationFrame(tick);
  },

  stopPreview(): void {
    this.previewOn = false;
    cancelAnimationFrame(this.previewRaf);
  },

  /** 物流页动画：持续重绘流动的管线粒子与呼吸节点（打开期间运行，离开页签/关闭即停） */
  startNetAnim(): void {
    if (this.netAnimOn) return;
    this.netAnimOn = true;
    this.lastNetTs = 0;
    const tick = (ts: number): void => {
      if (!this.netAnimOn) return;
      const dt = this.lastNetTs > 0 ? Math.min(0.05, (ts - this.lastNetTs) / 1000) : 0.016;
      this.lastNetTs = ts;
      this.netTime += dt;
      this.drawNetwork(this.netTime);
      this.netRaf = requestAnimationFrame(tick);
    };
    this.netRaf = requestAnimationFrame(tick);
  },

  stopNetAnim(): void {
    this.netAnimOn = false;
    cancelAnimationFrame(this.netRaf);
  },

  /** 生物预览：体积决定体型，已安装器官决定外观（尾/刺/甲/眼/口/核心） */
  drawPreview(t: number): void {
    const cv = document.getElementById('ed-preview') as HTMLCanvasElement | null;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const G = this.G!;
    const pend = this.pend;
    // v0.6：预览只画生效件（不会同时画口沟+口器+尖牙）
    const act = Organ.activeModules(pend.modules);
    const counts = new Map<string, number>();
    for (const id of act) counts.set(id, (counts.get(id) || 0) + 1);
    const n = (id: string): number => counts.get(id) ?? 0;
    const eff = act.map(id => DataStore.effStats(DataStore.module(id), pend.modLevels[id] ?? 1));
    const vol = 4 + eff.reduce((s, e) => s + e.volume, 0) + Math.round(G.player.growthVol);
    const armor = eff.reduce((s, e) => s + e.armorMod, 0);

    const W = cv.width, H = cv.height;
    const cx = W / 2, cy = H / 2;
    const PI = Math.PI;
    const R = 24 + Math.sqrt(Math.max(1, vol)) * 6;
    const py = cy + Math.sin(t * 1.6) * 5;

    ctx.clearRect(0, 0, W, H);

    // 展台（孢子式）
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + R + 44, R * 1.6, R * 0.42, 0, 0, PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,200,255,0.18)';
    ctx.stroke();

    // 尾部鞭毛（摆动）
    const flag = n('flagellum');
    if (flag > 0) {
      const len = 46 + flag * 10;
      ctx.strokeStyle = '#ffd18a';
      ctx.lineWidth = 2 + flag * 0.8;
      ctx.beginPath();
      ctx.moveTo(cx - R + 6, py);
      for (let i = 1; i <= 20; i++) {
        const k = i / 20;
        ctx.lineTo(cx - R + 6 - len * k, py + Math.sin(t * 5 - k * 4) * 14 * k);
      }
      ctx.stroke();
    }

    // 纤毛丛（短毛，嘴部留空）
    const cilia = n('cilia_cluster');
    if (cilia > 0) {
      ctx.strokeStyle = 'rgba(255,243,196,0.75)';
      ctx.lineWidth = 1.5;
      const cnt = 14 + cilia * 4;
      for (let i = 0; i < cnt; i++) {
        const a = (i / cnt) * PI * 2;
        if (Math.cos(a) > 0.75) continue;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * R, py + Math.sin(a) * R);
        ctx.lineTo(cx + Math.cos(a) * (R + 7), py + Math.sin(a) * (R + 7));
        ctx.stroke();
      }
    }

    // 骨针触突（背侧长刺）
    const spikes = n('spike_cilia');
    if (spikes > 0) {
      ctx.strokeStyle = '#dff2ff';
      ctx.lineWidth = 1.8;
      const cnt = 5 + spikes * 2;
      for (let i = 0; i < cnt; i++) {
        const a = PI * 0.45 + (i / (cnt - 1)) * PI * 1.1;
        const extra = 9 + spikes * 3;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (R + 3), py + Math.sin(a) * (R + 3));
        ctx.lineTo(cx + Math.cos(a) * (R + 3 + extra), py + Math.sin(a) * (R + 3 + extra));
        ctx.stroke();
      }
    }

    // 身体
    const grad = ctx.createRadialGradient(cx - R * 0.3, py - R * 0.35, R * 0.15, cx, py, R);
    grad.addColorStop(0, '#fff3c4');
    grad.addColorStop(1, '#eeb24a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, py, R, 0, PI * 2);
    ctx.fill();

    // 细胞质斑点（与物流页底座一致的"活着"质感）
    const cyto = seededRand(7);
    for (let i = 0; i < 6; i++) {
      const ca = cyto() * PI * 2;
      const crr = cyto() * R * 0.62;
      const cr2 = 1.5 + cyto() * 2.5;
      ctx.fillStyle = 'rgba(160,104,28,0.14)';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ca) * crr, py + Math.sin(ca) * crr, cr2, 0, PI * 2);
      ctx.fill();
    }

    // 多细胞聚合（外凸细胞团）
    const multi = n('multicell_agg');
    if (multi > 0) {
      ctx.fillStyle = '#e8c06a';
      const bumps = 3 + multi * 2;
      for (let i = 0; i < bumps; i++) {
        const a = PI * 0.5 + (i / bumps) * PI * 1.6;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R * 0.92, py + Math.sin(a) * R * 0.92, 6 + multi, 0, PI * 2);
        ctx.fill();
      }
    }

    // 细胞壁（浅色分段硬壳）
    if (n('cell_wall') > 0) {
      ctx.strokeStyle = 'rgba(232,217,168,0.9)';
      ctx.lineWidth = 4;
      ctx.setLineDash([10, 7]);
      ctx.beginPath();
      ctx.arc(cx, py, R + 5, 0, PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 外骨骼（厚重甲环）
    if (n('exoskeleton') > 0) {
      ctx.strokeStyle = 'rgba(199,210,222,0.95)';
      ctx.lineWidth = 6;
      ctx.setLineDash([16, 8]);
      ctx.beginPath();
      ctx.arc(cx, py, R + 8, 0, PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 三叶虫甲片（背侧分段甲板）
    if (n('trilo_plate') > 0) {
      ctx.strokeStyle = 'rgba(185,166,126,0.95)';
      ctx.lineWidth = 5;
      const plates = 3 + n('trilo_plate');
      for (let i = 0; i < plates; i++) {
        const a0 = PI * 0.6 + (i / plates) * PI * 0.8;
        ctx.beginPath();
        ctx.arc(cx, py, R + 4, a0, a0 + (PI * 0.8 / plates) * 0.6);
        ctx.stroke();
      }
    }
    // 尾刺
    if (n('tail_spine') > 0) {
      ctx.fillStyle = '#e8f4ff';
      ctx.beginPath();
      ctx.moveTo(cx - R - 2, py - 5);
      ctx.lineTo(cx - R - 16 - n('tail_spine') * 4, py);
      ctx.lineTo(cx - R - 2, py + 5);
      ctx.closePath();
      ctx.fill();
    }

    // 护甲光环
    if (armor > 0) {
      ctx.strokeStyle = `rgba(154,209,255,${Math.min(0.95, 0.4 + armor / 40)})`;
      ctx.lineWidth = 1 + Math.min(4, armor / 9);
      ctx.beginPath();
      ctx.arc(cx, py, R + 2, 0, PI * 2);
      ctx.stroke();
    }

    // 细胞膜（先天：贴着体型的一层薄膜）
    if (n('cell_membrane') > 0) {
      ctx.strokeStyle = 'rgba(180,232,255,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, py, R + 1.5, 0, PI * 2);
      ctx.stroke();
    }

    // 口沟（先天：斜向的口沟槽）+ 基础口器（开口）
    if (n('oral_groove') > 0) {
      ctx.strokeStyle = 'rgba(120,255,180,0.55)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.28, py - R * 0.5);
      ctx.quadraticCurveTo(cx + R * 0.92, py - R * 0.34, cx + R * 1.02, py - R * 0.04);
      ctx.stroke();
      // 纤毛摆动
      for (let i = 0; i < 5; i++) {
        const k = i / 4;
        const gx = cx + R * (0.3 + k * 0.66);
        const gy = py - R * (0.48 - k * 0.42);
        ctx.beginPath();
        ctx.moveTo(gx, gy);
        ctx.lineTo(gx + Math.sin(t * 6 + i) * 3, gy + 5);
        ctx.stroke();
      }
    }

    // 细胞核（先天：体内深色核仁）
    if (n('nucleus') > 0) {
      const nx = cx - R * 0.22, ny = py + R * 0.12;
      ctx.fillStyle = 'rgba(90,70,160,0.9)';
      ctx.beginPath();
      ctx.arc(nx, ny, R * 0.2, 0, PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,180,255,0.6)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(nx, ny, R * 0.2, 0, PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,240,200,0.85)';
      ctx.beginPath();
      ctx.arc(nx + R * 0.06, ny - R * 0.05, R * 0.07, 0, PI * 2);
      ctx.fill();
    }

    // 胞肛（先天：后端废物出口）
    if (n('anal_pore') > 0) {
      ctx.fillStyle = 'rgba(120,90,60,0.9)';
      ctx.beginPath();
      ctx.ellipse(cx - R * 0.96, py + R * 0.3, 4.5, 3.2, 0, 0, PI * 2);
      ctx.fill();
    }

    // 口器（前端开口）+ 尖牙
    const mouths = n('mouth_basic');
    if (mouths > 0) {
      const mw = Math.min(0.9, 0.35 + mouths * 0.18);
      ctx.fillStyle = '#241207';
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.55, py - R * mw * 0.5);
      ctx.quadraticCurveTo(cx + R * 1.06, py, cx + R * 0.55, py + R * mw * 0.5);
      ctx.closePath();
      ctx.fill();
      const fang = n('fang');
      if (fang > 0) {
        ctx.fillStyle = '#ffffff';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cx + R * 0.9, py + s * R * mw * 0.26);
          ctx.lineTo(cx + R * 0.6, py + s * (R * mw * 0.3 + 6 + fang * 2));
          ctx.lineTo(cx + R * 0.66, py + s * R * mw * 0.06);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // 眼（感光点 / 复眼）
    const eye = (x: number, y: number, rr: number): void => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, PI * 2);
      ctx.fill();
      ctx.fillStyle = '#10202c';
      ctx.beginPath();
      ctx.arc(x + rr * 0.25, y, rr * 0.45, 0, PI * 2);
      ctx.fill();
    };
    if (n('photospot') > 0) eye(cx + R * 0.45, py - R * 0.34, 5 + Math.min(3, n('photospot')));
    const ce = n('compound_eye');
    if (ce > 0) {
      const eyes = 2 + ce * 2;
      for (let i = 0; i < eyes; i++) eye(cx + R * 0.18 + (i - (eyes - 1) / 2) * 9, py - R * 0.62, 3.2);
    }

    // 物流器官核心（内视彩色点）
    const nodeColor: Record<string, string> = { source: '#6fe08a', process: '#56c9f0', storage: '#7ef0d0', sink: '#c792ea' };
    const organNodes = pend.nodes.filter(x => x.moduleId);
    organNodes.forEach((x, i) => {
      const a = -PI * 0.65 + (i / Math.max(1, organNodes.length)) * PI * 1.3;
      ctx.fillStyle = nodeColor[x.type] ?? '#9ad1ff';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * R * 0.45, py + Math.sin(a) * R * 0.45, 5.5, 0, PI * 2);
      ctx.fill();
    });

    // 光合器（顶侧绿点脉动）
    const ph = n('photosynth');
    if (ph > 0) {
      ctx.fillStyle = `rgba(111,224,138,${0.6 + 0.3 * Math.sin(t * 3)})`;
      const dots = 2 + ph * 2;
      for (let i = 0; i < dots; i++) {
        const a = PI * 1.2 + (i / dots) * PI * 0.6;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R * 0.72, py + Math.sin(a) * R * 0.72, 3.4, 0, PI * 2);
        ctx.fill();
      }
    }
    // 储能颗粒
    const gr = n('granule');
    if (gr > 0) {
      ctx.fillStyle = 'rgba(86,201,240,0.9)';
      for (let i = 0; i < gr * 2; i++) {
        const a = PI * 0.75 + i * 0.8;
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * R * 0.5, py + Math.sin(a) * R * 0.5, 3, 0, PI * 2);
        ctx.fill();
      }
    }
    // 神经网 / 神经节（中心辉光）
    if (n('nerve_net') > 0 || n('ganglion') > 0) {
      const glow = ctx.createRadialGradient(cx, py, 2, cx, py, R * 0.5);
      glow.addColorStop(0, 'rgba(199,146,234,0.35)');
      glow.addColorStop(1, 'rgba(199,146,234,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, py, R * 0.5, 0, PI * 2);
      ctx.fill();
    }

    // 选中组件标注（预览底部）
    if (this.selComp) {
      const m = DataStore.module(this.selComp);
      const lv = this.pend.modLevels[this.selComp] ?? 1;
      ctx.fillStyle = '#cfe6f5';
      ctx.font = '13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${iconOf(m.id)} ${m.name}${lv > 1 ? ` Lv${lv}` : ''}`, cx, H - 12);
      ctx.textAlign = 'left';
    }
  },

  installOne(id: string): void {
    const G = this.G!;
    const m = DataStore.module(id);
    const era = DataStore.era(G.eraIndex);
    if (m.builtIn) { bus.emit(Ev.TOAST, { text: '先天器官：与生俱来，无法安装', kind: 'info' }); return; }
    if (!this.eraOk(m)) { bus.emit(Ev.TOAST, { text: '该模块属于未来纪元', kind: 'warn' }); return; }
    if (!this.memOk(m)) { bus.emit(Ev.TOAST, { text: `🔎 认知不足：${m.memoryHint ?? '需先解锁对应记忆'}`, kind: 'warn' }); return; }
    if (this.pend.modules.includes(id) && !m.slot) {
      bus.emit(Ev.TOAST, { text: `【${m.name}】已安装（可叠加件，同种不能重复安装）`, kind: 'info' });
      return;
    }

    // —— 上位替代：同槽位装更强器官，自动顶掉低阶（v0.6）——
    const verdict = Organ.checkInstall(id, this.pend.modules);
    if (!verdict.ok) {
      const blocker = DataStore.module(verdict.blocker);
      bus.emit(Ev.TOAST, {
        text: m.slot
          ? `❌ ${Organ.SLOT_CN[m.slot]}已被【${blocker.name}】占据（位次更高，不能退步）`
          : '该模块已安装',
        kind: 'warn',
      });
      return;
    }

    const es = DataStore.effStats(m, 1);
    const modVol = Organ.activeModules(this.pend.modules).reduce((s, x) =>
      s + DataStore.effStats(DataStore.module(x), this.pend.modLevels[x] ?? 1).volume, 0);
    if (4 + modVol + es.volume + G.player.growthVol > Metab.volumeCap(G)) {
      bus.emit(Ev.TOAST, { text: `体积超限（${era.name} 上限 ${Metab.volumeCap(G)}，可强化防御/躯干类器官扩仓）`, kind: 'warn' });
      return;
    }
    if (this.available() < m.growthCost) {
      bus.emit(Ev.TOAST, { text: `生长储备不足（需 ${m.growthCost}）`, kind: 'warn' });
      return;
    }

    // 顶替：移除低阶器官（返还其投入），再装新的
    if (verdict.replaced.length > 0) {
      const names: string[] = [];
      for (const oldId of verdict.replaced) {
        const old = DataStore.module(oldId);
        names.push(old.name);
        Organ.detach(oldId, this.pend.modules, this.pend.nodes, this.pend.pipes);
        const oldLv = this.pend.modLevels[oldId] ?? 1;
        this.pend.refund += old.growthCost * CONST.REMOVE_REFUND
          + upgradeSpentOf(old.growthCost, oldLv) * CONST.UP_REFUND;
        delete this.pend.modLevels[oldId];
      }
      bus.emit(Ev.TOAST, {
        text: `⬆ 上位替代：${names.join(' + ')} → ${m.name}（${Organ.SLOT_CN[m.slot!]}，已返还部分投入）`,
        kind: 'good',
      });
    }

    this.pend.spent += m.growthCost;
    this.pend.modules.push(id);
    if (this.pend.modLevels[id] == null) this.pend.modLevels[id] = 1; // 新类型从 Lv1 起
    if (m.node) {
      const t = m.node.type;
      const layer = Logistics.layerOf({ layer: m.node.layer, type: t });
      const a = this.anatomy();
      const pos = anchorOf(id, id, layer, a);
      const node = Logistics.makeNode(`n_${m.id}_${this.pend.nodes.length}`, id, pos.x, pos.y);
      this.pend.nodes.push(node);
      this.layoutNodes(); // 统一重排：顶替后口器节点要落在同一解剖位
      // 自动接入所属层主干：安装即通电，玩家只管加支线/扩容
      const added = Logistics.autoWire(this.pend);
      bus.emit(Ev.TOAST, {
        text: `新物流节点【${m.name}】已自动接入${LAYER_CN[layer]}（${LAYERS.find(l => l.id === layer)?.name}）${added > 1 ? ` · 新增 ${added} 条管线` : ''}`,
        kind: 'good',
      });
    }
    if (m.keyTo) {
      bus.emit(Ev.TOAST, { text: `✅ 关键模块【${m.name}】已安装——保存并退出即推进纪元`, kind: 'good' });
    }
    this.selComp = id;
    this.selCompFrom = 'installed';
    this.layoutDirty = true;
    this.renderMorph();
  },

  removeOne(id: string): void {
    const idx = this.pend.modules.lastIndexOf(id);
    if (idx < 0) return;
    const m = DataStore.module(id);
    if (m.builtIn) {
      bus.emit(Ev.TOAST, { text: `【${m.name}】是先天器官，无法卸载`, kind: 'warn' });
      return;
    }

    // 删除模块
    this.pend.modules.splice(idx, 1);
    
    // 移除关联节点和管线
    const nodeIdx = this.pend.nodes.findIndex(n => n.moduleId === m.id);
    if (nodeIdx >= 0) {
      const nid = this.pend.nodes[nodeIdx].id;
      this.pend.nodes.splice(nodeIdx, 1);
      this.pend.pipes = this.pend.pipes.filter(l => l.a !== nid && l.b !== nid);
    }

    // 计算返还：统一公式（30% 购置 + 80% 强化投入）
    const lv = this.pend.modLevels[id] ?? 1;
    let refundAmount = m.growthCost * CONST.REMOVE_REFUND
      + upgradeSpentOf(m.growthCost, lv) * CONST.UP_REFUND;

    // 地形模块：使用物种定义重新计算（plain/hill/deepwater）
    if (id.startsWith('terra_')) {
      const tm = DataStore.module(id.replace('terra_', ''));
      if (tm && !tm.builtIn) {
        refundAmount = tm.growthCost * CONST.REMOVE_REFUND + upgradeSpentOf(tm.growthCost, 1) * CONST.UP_REFUND;
      } else {
        // 先天地形（如 terra_plain）：无强化，只用基础购置费
        refundAmount = m.growthCost * CONST.REMOVE_REFUND;
      }
    }

    this.pend.refund += refundAmount;

    // 删除 modLevels 记录
    delete this.pend.modLevels[id];

    // 设置选中状态（地形显示为 library）
    if (id.startsWith('terra_')) {
      this.selComp = id;
      this.selCompFrom = 'library';
    } else {
      this.selComp = null;
      this.selCompFrom = 'installed';
    }

    // 重新渲染已安装列表（显示删除按钮）
    this.renderInstalled();
  },


/** 添加地形模块（新物种）：ID 格式 terra_plain/terra_hill/terra_deepwater */
addTerraModule(id: string): void {
    const m = DataStore.module(id);
    if (!m) {
      bus.emit(Ev.TOAST, { text: `【${id}】不存在`, kind: 'warn' });
      return;
    }
    if (this.eraOk(m)) {
      this.installOne(id); // 复用通用安装逻辑
    } else {
      bus.emit(Ev.TOAST, { text: '该模块属于未来纪元', kind: 'warn' });
    }
  },

  /** 移除地形模块：直接调用 removeOne（已包含完整返还计算） */
  removeTerraModule(id: string): void {
    // 复用通用删除逻辑（已包含所有返还计算和状态更新）
    this.removeOne(id);
    
    // 重新渲染以反映变化
    this.renderInstalled();
  },

  /* ---------------- 物流页 ---------------- */

  /** 当前物种的解剖坐标系（体积 → 半径，中心在画布中心） */
  anatomy(): Anatomy {
    const G = this.G!;
    const act = Organ.activeModules(this.pend.modules);
    const vol = 4 + act.reduce((s, id) =>
      s + DataStore.effStats(DataStore.module(id), this.pend.modLevels[id] ?? 1).volume, 0)
      + Math.round(G.player.growthVol);
    // 体积 10 → R≈96；体积 60 → R≈189（1100×640 画布内占比 59%，留出标注与前向空间）
    const radius = Math.max(96, Math.min(210, 26 + Math.sqrt(Math.max(1, vol)) * 21));
    return {
      cx: this.NET_W / 2,
      cy: this.NET_H / 2,
      radius,
      facingX: 1,
      facingY: 0,
    };
  },

  /**
   * 把所有节点摆到解剖位（物流页与安装新器官共用）。
   * 隐退节点不摆也不画——它们已被高阶器官替代，不再是体内结构的一部分。
   */
  layoutNodes(): void {
    const a = this.anatomy();
    const live = Organ.liveNodeIds(this.pend.nodes);
    const used = new Map<string, number>();
    for (const n of this.pend.nodes) {
      if (!live.has(n.id)) continue;               // 隐退：不显示
      const p = anchorOf(n.id, n.moduleId, Logistics.layerOf(n), a);
      const key = `${Math.round(p.x / 4)}_${Math.round(p.y / 4)}`;
      const idx = used.get(key) ?? 0;
      used.set(key, idx + 1);
      const s = spread(p, idx, 26);
      n.x = s.x;
      n.y = s.y;
    }
  },

  /** 物流页：更新 DOM 服务面板 + 立即重绘一帧（后续帧由物流动画循环驱动） */
  renderNetwork(): void {
    const G = this.G!;
    if (this.layoutDirty) { this.layoutNodes(); this.layoutDirty = false; }
    const liveIds = Organ.liveNodeIds(this.pend.nodes);
    const svc = Logistics.services({ nodes: this.pend.nodes, pipes: this.pend.pipes });
    const flows = Logistics.layerFlows({ nodes: this.pend.nodes, pipes: this.pend.pipes });
    const bn = svc.bottleneck;

    // —— 分层服务面板（DOM，仅状态变化时更新）——
    const bar = (id: string): string => {
      const f = flows[id as keyof typeof flows];
      const ns = this.pend.nodes.filter(n => liveIds.has(n.id) && Logistics.layerOf(n) === id).length;
      const pct = Number.isFinite(f) ? Math.round(f * 100) : 100;
      const col = layerColor(id as never);
      const unlocked = layerUnlocked(G.eraIndex, id as never);
      return `<div class="ns-row${unlocked ? '' : ' locked'}"><span class="ns-k" style="color:${col}">${LAYER_CN[id]}${unlocked ? '' : ' 🔒'}</span>` +
        `<span class="ns-bar"><i style="width:${Math.min(100, pct)}%;background:${col}"></i></span>` +
        `<span class="ns-v">${Number.isFinite(f) ? `${pct}%` : '∞'} · ${ns}节点</span></div>`;
    };
    const nb = (id: string): string => {
      const n = this.pend.nodes.find(x => x.id === id);
      return n ? zhNodeName(n) : id;
    };
    const metaUpNow = Organ.activeModules(this.pend.modules).reduce((s, id) => {
      if (DataStore.module(id).category !== 'metabolism') return s;
      return s + CONST.META_UP_PCT * ((this.pend.modLevels[id] ?? 1) - 1);
    }, 0);
    const outNow = (CONST.P_BASE + CONST.P_PER_PATH * svc.digestCap) * (1 + metaUpNow);
    document.getElementById('net-stats')!.innerHTML =
      `<div class="ns-title">物流系统 · ${LAYERS.filter(l => layerUnlocked(G.eraIndex, l.id)).length}/${LAYERS.length} 层已解锁` +
      `<span class="ns-hint">安装器官即自动接入所属层</span></div>` +
      LAYERS.map(l => bar(l.id)).join('') +
      `<div class="ns-foot">消化吞吐 <b>${Math.round(svc.digestCap)}</b> · 代谢产出 <b>${outNow.toFixed(1)}</b>` +
      `${metaUpNow > 0 ? `<b> (强化+${Math.round(metaUpNow * 100)}%)</b>` : ''}` +
      ` · 运动实现 <b>${Math.round(svc.muscleReal * 100)}%</b>` +
      ` · 脑供能 <b>${Math.round(svc.brainEff * 100)}%</b>` +
      (bn ? ` · <span style="color:#ff9f43">瓶颈 ${esc(nb(bn.a))}—${esc(nb(bn.b))}</span>` : '') +
      `</div><div class="ns-foot dim">线宽 = 吞吐等级 · 亮点 = 物流流动 · 悬停/点选管线或节点查看、扩容、拆除</div>`;
    this.renderHead();
    this.drawNetwork(this.netTime);
  },

  /**
   * 物流画布逐帧绘制（"体内物流沙盘"）：
   * 贝塞尔管线 + 流动粒子 + 呼吸节点 + 待连线虚线，由物流页动画循环每帧驱动。
   */
  drawNetwork(t: number): void {
    const G = this.G!;
    const cv = document.getElementById('net-canvas') as HTMLCanvasElement | null;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    // DPI 适配：绘制统一走逻辑坐标（NET_W × NET_H），物理像素由 setTransform 承担
    ctx.setTransform(this.netDpr, 0, 0, this.netDpr, 0, 0);
    ctx.clearRect(0, 0, this.NET_W, this.NET_H);
    const liveIds = Organ.liveNodeIds(this.pend.nodes);
    const svc = Logistics.services({ nodes: this.pend.nodes, pipes: this.pend.pipes });
    const flows = Logistics.layerFlows({ nodes: this.pend.nodes, pipes: this.pend.pipes });
    const a = this.anatomy();
    const bn = svc.bottleneck;

    // —— 物种本体底座（呼吸动画）+ 左上角层卡图例 ——
    this.drawBodyBase(ctx, a, t);
    this.drawLayerRim(ctx, a, liveIds, flows, bn, t);

    // —— 管线：分级显示（自动接入=层色淡虚线·无粒子，手动支线=亮蓝实线·粒子，瓶颈=橙色脉动·徽章）——
    // 隐退节点的管线直接跳过：被高阶器官替代的结构不在体内，不该显示
    this.pend.pipes.forEach((l, i) => {
      const na = this.pend.nodes.find(n => n.id === l.a);
      const mb = this.pend.nodes.find(n => n.id === l.b);
      if (!na || !mb) return;
      if (!liveIds.has(l.a) || !liveIds.has(l.b)) return;
      const isBn = !!bn && ((bn.a === l.a && bn.b === l.b) || (bn.a === l.b && bn.b === l.a));
      const sel = i === this.selPipe;
      const hov = i === this.hoverPipe && !sel;
      const auto = !!na.auto && !!mb.auto;
      const { cx, cy } = pipeCtrl(na, mb);
      const baseCol = sel ? '#ffd166' : isBn ? '#ff9f43' : auto ? layerColor(Logistics.layerOf(na)) : '#78c8ff';
      // 自动线是"结构背景"：淡虚线，只有被玩家选中/悬停时才亮起来
      const baseAlpha = sel ? 0.95 : isBn ? 0.85 : hov ? 0.85 : auto ? 0.3 : 0.6;
      ctx.strokeStyle = hexA(baseCol, baseAlpha);
      ctx.lineWidth = 1.5 + l.level * 1.7 + (hov ? 0.8 : 0);
      ctx.setLineDash(isBn ? [6, 5] : (auto && !sel) ? [4, 4] : []);
      if (sel || hov || isBn) ctx.lineDashOffset = -t * 14;
      ctx.beginPath();
      ctx.moveTo(na.x, na.y);
      ctx.quadraticCurveTo(cx, cy, mb.x, mb.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      // 流动粒子：仅手动线 / 选中 / 悬停 / 瓶颈显示（自动结构线保持安静，画面不糊）
      // 数量/速度随吞吐等级，流向按管线哈希稳定（避免每帧抖动）
      if (!auto || sel || hov || isBn) {
        const dir = hash01(`${l.a}|${l.b}`) < 0.5 ? 1 : -1;
        const dots = Math.min(8, 2 + Math.floor(l.cap / 5));
        const speed = 0.09 + l.level * 0.028;
        ctx.fillStyle = isBn ? 'rgba(255,179,107,0.95)' : hexA(baseCol, 0.9);
        for (let k = 0; k < dots; k++) {
          let u = (t * speed + k / dots) % 1;
          if (dir < 0) u = 1 - u;
          const p = qPoint(na.x, na.y, cx, cy, mb.x, mb.y, u);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.7 + l.level * 0.25, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 吞吐徽章：只在选中 / 悬停 / 瓶颈链路显示，平时靠线宽表达（画面不糊）
      if (sel || hov || isBn) {
        const m = qPoint(na.x, na.y, cx, cy, mb.x, mb.y, 0.5);
        const label = isBn ? `瓶颈 ⇄${l.cap}` : `⇄${l.cap}`;
        ctx.font = 'bold 9px sans-serif';
        const w = ctx.measureText(label).width + 8;
        roundRect(ctx, m.x - w / 2, m.y - 7.5, w, 13, 6);
        ctx.fillStyle = 'rgba(4,16,26,0.82)';
        ctx.fill();
        ctx.strokeStyle = hexA(baseCol, 0.55);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(222,240,255,0.95)';
        ctx.textAlign = 'center';
        ctx.fillText(label, m.x, m.y + 2.5);
        ctx.textAlign = 'left';
      }
    });

    // —— 选中节点：待连线虚线（跟随鼠标，虚线流动提示接线方向）——
    if (this.selNode && this.mouse.x > -9000) {
      const sn = this.pend.nodes.find(n => n.id === this.selNode);
      if (sn) {
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 6]);
        ctx.lineDashOffset = -t * 20;
        ctx.beginPath();
        ctx.moveTo(sn.x, sn.y);
        ctx.lineTo(this.mouse.x, this.mouse.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.arc(this.mouse.x, this.mouse.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // —— 节点：类型形状化 + 呼吸渐变 + 中枢辉光 + 名字徽章（隐退节点完全不绘制）——
    for (const nd of this.pend.nodes) {
      if (!liveIds.has(nd.id)) continue;
      const col = layerColor(Logistics.layerOf(nd));
      const locked = !layerUnlocked(G.eraIndex, Logistics.layerOf(nd));
      const name = zhNodeName(nd);
      const sel = this.selNode === nd.id;
      const hov = this.hoverNode === nd.id && !sel;
      const core = this.isCore(nd.id);
      // 中枢节点（能量池/肌肉/大脑）更大、带辉光；普通节点按类型形状化
      const r = (core ? 17 : 13) * (1 + 0.035 * Math.sin(t * 2.2 + hash01(nd.id) * 6.28));
      const grad = ctx.createRadialGradient(nd.x - r * 0.35, nd.y - r * 0.4, r * 0.12, nd.x, nd.y, r);
      if (locked) {
        grad.addColorStop(0, hexA(col, 0.5));
        grad.addColorStop(1, hexA(col, 0.16));
      } else {
        grad.addColorStop(0, mixWhite(col, 0.35));
        grad.addColorStop(1, col);
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hexA(col, locked ? 0.5 : 0.95);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, r, 0, Math.PI * 2);
      ctx.stroke();
      if (nd.auto) {
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 1.1;
        ctx.setLineDash([3, 4]);
        ctx.lineDashOffset = -t * 8;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r + 3.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }
      // 中枢辉光（全网水库/运动终点/神经终点：让"心"一眼可辨）
      if (core) {
        const glow = ctx.createRadialGradient(nd.x, nd.y, r * 0.4, nd.x, nd.y, r * 2.4);
        glow.addColorStop(0, hexA(col, 0.30 + 0.12 * Math.sin(t * 2.6 + hash01(nd.id) * 6.28)));
        glow.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sel || hov) {
        ctx.strokeStyle = sel ? '#ffffff' : 'rgba(255,255,255,0.55)';
        ctx.lineWidth = sel ? 2.2 : 1.3;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r + 5 + (sel ? Math.sin(t * 4) * 1.2 : 0), 0, Math.PI * 2);
        ctx.stroke();
      }
      // 圆内类型符号（入口/处理/水库/终端）+ 短名
      this.drawNodeTypeMark(ctx, nd, r, t);
      ctx.fillStyle = locked ? 'rgba(230,244,255,0.75)' : '#04121a';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(name.length <= (core ? 4 : 2) ? name : name.slice(0, core ? 3 : 2), nd.x, nd.y + 3.5);
      // 名字徽章：中枢常驻；其余节点只在选中/悬停时显示（画面不糊）
      if (sel || hov || core) {
        const tag = (sel || hov)
          ? `${name} · 吞吐 ${this.nodeFlowOf(nd)}/${nd.rate}`
          : `${name} · 吞吐 ${this.nodeFlowOf(nd)}`;
        ctx.font = '9px sans-serif';
        const tw = ctx.measureText(tag).width + 7;
        const ty = nd.y + r + 10;
        roundRect(ctx, nd.x - tw / 2, ty - 7, tw, 12.5, 5);
        ctx.fillStyle = sel || hov ? 'rgba(8,26,38,0.92)' : 'rgba(4,16,26,0.6)';
        ctx.fill();
        ctx.fillStyle = 'rgba(205,230,250,0.9)';
        ctx.fillText(tag, nd.x, ty + 2.5);
        ctx.textAlign = 'left';
      }
    }

    // —— 节点类型图例（右下角，说明形状语义）——
    this.drawTypeLegend(ctx, t);
  },

  /** 节点实际拿到多少流量（悬停详情用）：能量池=全网消化吞吐，其余=energy→该节点的最宽路径 */
  nodeFlowOf(nd: FlowNode): number {
    if (nd.id === 'energy') {
      return Logistics.services({ nodes: this.pend.nodes, pipes: this.pend.pipes }).digestCap;
    }
    return Logistics.widest({ nodes: this.pend.nodes, pipes: this.pend.pipes }, 'energy', nd.id);
  },

  /** 圆内类型符号：入口=朝外三角、处理=旋转方点、水库=容量横条、终端=实心方（随节点半径缩放） */
  drawNodeTypeMark(ctx: CanvasRenderingContext2D, nd: FlowNode, r: number, t: number): void {
    const s = r / 13; // 符号随节点半径缩放（中枢节点更大）
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    const x = nd.x, y = nd.y;
    if (nd.type === 'source') {
      ctx.beginPath();
      ctx.moveTo(x + 2 * s, y - 4 * s);
      ctx.lineTo(x + 2 * s, y + 4 * s);
      ctx.lineTo(x + 8 * s, y);
      ctx.closePath();
      ctx.fill();
    } else if (nd.type === 'process') {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(t * 1.4 + hash01(nd.id) * 6.28);
      ctx.fillRect(-3.5 * s, -3.5 * s, 7 * s, 7 * s);
      ctx.restore();
    } else if (nd.type === 'storage') {
      ctx.fillRect(x - 5 * s, y - 2.2 * s, 10 * s, 4.4 * s);
      ctx.fillRect(x - 3 * s, y - 6.2 * s, 6 * s, 2.4 * s);
      ctx.fillRect(x - 3 * s, y + 3.8 * s, 6 * s, 2.4 * s);
    } else {
      ctx.fillRect(x - 3.4 * s, y - 3.4 * s, 6.8 * s, 6.8 * s);
    }
  },

  /** 节点类型图例（右下角）：入口/处理/水库/终端 的形状语义说明 */
  drawTypeLegend(ctx: CanvasRenderingContext2D, t: number): void {
    const items: { label: string; type: FlowNode['type'] }[] = [
      { label: '入口', type: 'source' },
      { label: '处理', type: 'process' },
      { label: '水库', type: 'storage' },
      { label: '终端', type: 'sink' },
    ];
    const x0 = this.NET_W - 176, y0 = this.NET_H - 48;
    const rowH = 19, cardH = items.length * rowH + 14;
    roundRect(ctx, x0, y0, 166, cardH, 8);
    ctx.fillStyle = 'rgba(4,14,22,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,190,230,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
    let y = y0 + 18;
    for (const it of items) {
      const ix = x0 + 14, iy = y - 2.5;
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      if (it.type === 'source') {
        ctx.beginPath();
        ctx.moveTo(ix, iy - 4);
        ctx.lineTo(ix, iy + 4);
        ctx.lineTo(ix + 6, iy);
        ctx.closePath();
        ctx.fill();
      } else if (it.type === 'process') {
        ctx.save();
        ctx.translate(ix, iy);
        ctx.rotate(t * 1.4);
        ctx.fillRect(-3, -3, 6, 6);
        ctx.restore();
      } else if (it.type === 'storage') {
        ctx.fillRect(ix - 4, iy - 2, 8, 3.4);
        ctx.fillRect(ix - 2.4, iy - 5, 4.8, 2);
        ctx.fillRect(ix - 2.4, iy + 3, 4.8, 2);
      } else {
        ctx.fillRect(ix - 2.6, iy - 2.6, 5.2, 5.2);
      }
      ctx.fillStyle = 'rgba(190,215,235,0.8)';
      ctx.textAlign = 'left';
      ctx.fillText(it.label, x0 + 32, y + 1);
      y += rowH;
    }
    ctx.restore();
  },

  /** 物流画布悬停：高亮最近节点/管线，同步鼠标位置（选中节点时显示待连线虚线） */
  onNetMove(e: MouseEvent): void {
    const cv = document.getElementById('net-canvas') as HTMLCanvasElement;
    const rect = cv.getBoundingClientRect();
    // 事件坐标统一换算到逻辑坐标（与绘制坐标系一致）
    const x = (e.clientX - rect.left) * (this.NET_W / rect.width);
    const y = (e.clientY - rect.top) * (this.NET_H / rect.height);
    this.mouse.x = x;
    this.mouse.y = y;
    const live = Organ.liveNodeIds(this.pend.nodes);
    const hit = this.pend.nodes.find(n => live.has(n.id) && Math.hypot(n.x - x, n.y - y) <= 18);
    this.hoverNode = hit ? hit.id : null;
    this.hoverPipe = -1;
    if (!hit) {
      let best = 9;
      this.pend.pipes.forEach((l, i) => {
        if (!live.has(l.a) || !live.has(l.b)) return;
        const na = this.pend.nodes.find(n => n.id === l.a);
        const mb = this.pend.nodes.find(n => n.id === l.b);
        if (!na || !mb) return;
        const d = pipeDist(x, y, na, mb);
        if (d < best) { best = d; this.hoverPipe = i; }
      });
    }
    cv.style.cursor = hit || this.hoverPipe >= 0 ? 'pointer' : this.selNode ? 'crosshair' : 'default';
  },

  /**
   * 物种本体底座（v0.6）：物流页的"地图"就是这坨生物自己。
   *
   * 俯视朝向屏幕右方（+x 为正前方），因此：
   *   前方 = 右（口器在此）· 背侧 = 上（脑/神经在此）· 腹侧 = 下 · 尾部 = 左
   * 外骨骼/细胞壁会加硬壳，鞭毛/纤毛会长出尾部，形态与形态页保持一致。
   */
  drawBodyBase(ctx: CanvasRenderingContext2D, a: Anatomy, t: number): void {
    // 轻微呼吸（半径 ±1.2%），让"地图就是生物自己"这一点活起来
    const R = a.radius * (1 + 0.012 * Math.sin(t * 1.25));
    const act = Organ.activeModules(this.pend.modules);
    const has = (id: string): boolean => act.includes(id);
    const wall = has('cell_wall') || has('exoskeleton') || has('trilo_plate');
    const multi = has('multicell_agg');

    ctx.save();
    // 外层柔光（让底座从深色背景里浮起来）
    const halo = ctx.createRadialGradient(a.cx, a.cy, R * 0.5, a.cx, a.cy, R * 1.5);
    halo.addColorStop(0, 'rgba(255,226,160,0.10)');
    halo.addColorStop(1, 'rgba(255,226,160,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(a.cx, a.cy, R * 1.5, 0, Math.PI * 2);
    ctx.fill();

    // 尾部鞭毛（画在身体下方）
    if (has('flagellum')) {
      ctx.strokeStyle = 'rgba(255,209,138,0.85)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(a.cx - R * 0.92, a.cy);
      ctx.quadraticCurveTo(a.cx - R * 1.25, a.cy - R * 0.16, a.cx - R * 1.42, a.cy);
      ctx.stroke();
    }
    // 纤毛丛：体后缘一圈短毛（前方给口器让位）
    if (has('cilia_cluster')) {
      ctx.strokeStyle = 'rgba(255,243,196,0.5)';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 26; i++) {
        const ang = (i / 26) * Math.PI * 2;
        if (Math.abs(Math.cos(ang)) > 0.8) continue;
        ctx.beginPath();
        ctx.moveTo(a.cx + Math.cos(ang) * R, a.cy + Math.sin(ang) * R);
        ctx.lineTo(a.cx + Math.cos(ang) * (R + 8), a.cy + Math.sin(ang) * (R + 8));
        ctx.stroke();
      }
    }

    // 躯体本体
    const body = ctx.createRadialGradient(
      a.cx - R * 0.25, a.cy - R * 0.3, R * 0.1, a.cx, a.cy, R);
    if (wall) {
      body.addColorStop(0, 'rgba(206,226,240,0.95)');
      body.addColorStop(1, 'rgba(128,158,182,0.9)');
    } else {
      body.addColorStop(0, 'rgba(255,236,186,0.92)');
      body.addColorStop(1, 'rgba(226,168,86,0.82)');
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    if (multi) {
      // 多细胞聚合：轮廓带外凸细胞团
      const bumps = 7;
      for (let i = 0; i <= bumps * 8; i++) {
        const ang = (i / (bumps * 8)) * Math.PI * 2;
        const wob = 1 + Math.sin(ang * bumps) * 0.055;
        const px = a.cx + Math.cos(ang) * R * wob;
        const py = a.cy + Math.sin(ang) * R * wob;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(a.cx, a.cy, R, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.strokeStyle = wall ? 'rgba(232,244,255,0.85)' : 'rgba(255,214,140,0.7)';
    ctx.lineWidth = wall ? 2.4 : 1.6;
    ctx.stroke();

    // 细胞质细胞器（确定性分布的低透明斑点，近大远小两层，让底座有"活着"的质感）
    const orng = seededRand(7);
    for (let i = 0; i < 12; i++) {
      const ang = orng() * Math.PI * 2;
      const rr = orng() * R * 0.72;
      const big = i % 3 === 0;
      const cr = (big ? 4.5 : 2.6) + orng() * (big ? 5 : 3);
      ctx.fillStyle = wall
        ? (big ? 'rgba(96,120,140,0.12)' : 'rgba(96,120,140,0.07)')
        : (big ? 'rgba(160,104,28,0.12)' : 'rgba(160,104,28,0.07)');
      ctx.beginPath();
      ctx.arc(a.cx + Math.cos(ang) * rr, a.cy + Math.sin(ang) * rr, cr, 0, Math.PI * 2);
      ctx.fill();
    }
    // 细胞膜光泽：身体外缘一层柔光（让"这张地图"从深色底里浮起）
    ctx.strokeStyle = wall ? 'rgba(220,240,255,0.10)' : 'rgba(255,224,160,0.10)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(a.cx, a.cy, R + 2, 0, Math.PI * 2);
    ctx.stroke();

    // 朝向箭头（正前方 = 屏幕右方）
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.6;
    const ax = a.cx + R * 1.12, ay = a.cy;
    ctx.beginPath();
    ctx.moveTo(a.cx + R * 1.02, ay);
    ctx.lineTo(ax, ay);
    ctx.moveTo(ax - 7, ay - 5);
    ctx.lineTo(ax, ay);
    ctx.lineTo(ax - 7, ay + 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('前方', a.cx + R * 1.24, ay + 3);

    // 方位提示：俯视下上=背侧（神经）、下=腹侧（消化）
    ctx.font = '9px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(200,220,240,0.45)';
    ctx.fillText('背侧 · 神经', a.cx, a.cy - R * 1.14);
    ctx.fillText('腹侧 · 消化', a.cx, a.cy + R * 1.14);
    ctx.textAlign = 'left';
    ctx.restore();
  },

  /** 左上角层卡图例：层色胶囊 + 层名（瓶颈层 ⚠）+ 流量条（呼吸微光）+ 节点数 */
  drawLayerRim(
    ctx: CanvasRenderingContext2D,
    _a: Anatomy,
    liveIds: ReadonlySet<string>,
    flows: Record<string, number>,
    bn: { a: string; b: string; cap: number } | null,
    t: number,
  ): void {
    const G = this.G!;
    const bnNode = bn
      ? this.pend.nodes.find(n => n.id === bn.a) ?? this.pend.nodes.find(n => n.id === bn.b)
      : undefined;
    const bnLayerId = bnNode ? Logistics.layerOf(bnNode) : null;
    const items = LAYERS
      .map(L => ({ L, count: this.pend.nodes.filter(n => liveIds.has(n.id) && Logistics.layerOf(n) === L.id).length }))
      .filter(it => it.count > 0);
    if (items.length === 0) return;
    ctx.save();
    ctx.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
    const x0 = 10, y0 = 12, rowH = 20, cardW = 150;
    const cardH = items.length * rowH + 10;
    roundRect(ctx, x0, y0, cardW, cardH, 9);
    ctx.fillStyle = 'rgba(4,14,22,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,190,230,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
    let y = y0 + 17;
    for (const { L, count } of items) {
      const col = layerColor(L.id);
      const unlocked = layerUnlocked(G.eraIndex, L.id);
      const f = flows[L.id];
      const pct = Number.isFinite(f) ? Math.round(f * 100) : 100;
      // 层色胶囊
      ctx.fillStyle = hexA(col, unlocked ? 0.95 : 0.3);
      roundRect(ctx, x0 + 9, y - 5.5, 6, 11, 3);
      ctx.fill();
      // 层名（瓶颈所在层带 ⚠）
      ctx.fillStyle = hexA(col, unlocked ? 0.95 : 0.4);
      ctx.textAlign = 'left';
      ctx.fillText(`${bnLayerId === L.id ? '⚠' : ''}${L.short}`, x0 + 22, y + 3.5);
      // 流量条（轻微呼吸）
      const barW = 44;
      const bx = x0 + 52, by = y - 3;
      roundRect(ctx, bx, by, barW, 6, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fill();
      if (unlocked) {
        const glow = 0.68 + 0.28 * Math.sin(t * 2.4 + bx);
        ctx.fillStyle = hexA(col, glow);
        roundRect(ctx, bx, by, Math.max(3, barW * Math.min(1, pct / 100)), 6, 3);
        ctx.fill();
      }
      // 节点数
      ctx.fillStyle = 'rgba(190,215,235,0.65)';
      ctx.fillText(`${count}节点`, x0 + 104, y + 3.5);
      y += rowH;
    }
    ctx.restore();
  },

  onNetClick(e: MouseEvent): void {
    const cv = document.getElementById('net-canvas') as HTMLCanvasElement;
    const rect = cv.getBoundingClientRect();
    // 事件坐标统一换算到逻辑坐标（与绘制坐标系一致）
    const x = (e.clientX - rect.left) * (this.NET_W / rect.width);
    const y = (e.clientY - rect.top) * (this.NET_H / rect.height);
    const live = Organ.liveNodeIds(this.pend.nodes);

    // 隐退节点不显示也不可点选（否则会出现"看不见却能连线的幽灵器官"）
    const hit = this.pend.nodes.find(n =>
      live.has(n.id) && Math.hypot(n.x - x, n.y - y) <= 18);
    if (hit) {
      if (this.selNode && this.selNode !== hit.id) {
        const from = this.pend.nodes.find(n => n.id === this.selNode)!;
        const err = Logistics.connect(this.pend, this.selNode, hit.id);
        if (err) bus.emit(Ev.TOAST, { text: err, kind: 'warn' });
        else bus.emit(Ev.TOAST, { text: `管线接通：${zhNodeName(from)} → ${zhNodeName(hit)}`, kind: 'good' });
        this.selNode = null;
      } else {
        this.selNode = hit.id;
      }
      this.selPipe = -1;
    } else {
      let picked = -1, best = 10;
      this.pend.pipes.forEach((l, i) => {
        if (!live.has(l.a) || !live.has(l.b)) return;
        const na = this.pend.nodes.find(n => n.id === l.a);
        const mb = this.pend.nodes.find(n => n.id === l.b);
        if (!na || !mb) return;
        const d = pipeDist(x, y, na, mb);
        if (d < best) { best = d; picked = i; }
      });
      this.selPipe = picked;
      this.selNode = null;
      document.getElementById('net-pipeops')!.classList.toggle('hidden', picked < 0);
    }
    this.renderNetwork();
  },

  upgradePipe(): void {
    const l = this.pend.pipes[this.selPipe];
    if (!l) return;
    if (l.level >= CONST.UP_MAX_LEVEL) {
      bus.emit(Ev.TOAST, { text: `管线已满级（Lv${CONST.UP_MAX_LEVEL}）`, kind: 'warn' });
      return;
    }
    const cost = Logistics.upgradeCost(this.pend, l.a, l.b);
    if (this.available() < cost) {
      bus.emit(Ev.TOAST, { text: `储备不足（扩容需 ${cost}）`, kind: 'warn' });
      return;
    }
    const before = l.cap;
    this.pend.spent += cost;
    Logistics.upgradePipe(this.pend, l.a, l.b);
    this.renderNetwork();
    if (l.cap > before) {
      bus.emit(Ev.TOAST, { text: `管线扩容：吞吐 ${before} → ${l.cap}`, kind: 'good' });
    }
  },

  removePipe(): void {
    if (this.selPipe < 0) return;
    const l = this.pend.pipes[this.selPipe];
    Logistics.disconnect(this.pend, l.a, l.b);
    this.selPipe = -1;
    document.getElementById('net-pipeops')!.classList.add('hidden');
    this.renderNetwork();
  },
};

/** 物流层中文名 */
const LAYER_CN: Record<string, string> = {
  digest: '消化层', circulation: '循环层', nerve: '神经层', motor: '运动层',
};

/** 组件图标（组件库/芯片/详情共用） */
const MODULE_ICON: Record<string, string> = {
  cytoplasm: '🟡', cell_membrane: '🫧', nucleus: '🔮', oral_groove: '👄', anal_pore: '🕳️',
  mouth_basic: '👄', primitive_stomach: '🫃', energy_pool: '💧',
  flagellum: '〰️', chemohair: '👃', granule: '🔵', spike_cilia: '🔱',
  photospot: '💡', cilia_cluster: '🌾', cell_wall: '🧱', primitive_heart: '❤️',
  multicell_agg: '🧫', photosynth: '🌿', aerogenase: '💨', nerve_net: '🕸️',
  compound_eye: '🔎', exoskeleton: '🛡️', fang: '🦷', muscle_fiber: '💪',
  gill: '🌀', trilo_plate: '🪲', ganglion: '🧠', tail_spine: '🗡️',
  muscle_hub: '🦵',
};
function iconOf(id: string): string {
  return MODULE_ICON[id] ?? '📦';
}

/** 类别中文名 */
const CATEGORY_NAME: Record<string, string> = {
  trunk: '躯干', mouth: '口器', metabolism: '代谢',
  movement: '移动', sense: '感官', defense: '防御', head: '神经',
};

/** zhNodeName 等函数沿用 core/escape.ts 中的统一 esc()，避免多处实现不一致 */

function zhNodeName(n: { id: string; moduleId?: string }): string {
  const base: Record<string, string> = { stomach: '胃', energy: '能量池', muscle: '肌肉', brain: '大脑' };
  if (base[n.id]) return base[n.id];
  if (n.moduleId) return DataStore.module(n.moduleId).name;
  return '节点';
}

/** #rrggbb + alpha → rgba()（物流页按层着色） */
function hexA(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** 颜色向白色混合（节点高光渐变用） */
function mixWhite(hex: string, k: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgb(${Math.round(r + (255 - r) * k)},${Math.round(g + (255 - g) * k)},${Math.round(b + (255 - b) * k)})`;
}

/** 字符串稳定哈希 → [0,1)（管线流向 / 节点呼吸相位） */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** 二次贝塞尔取点 */
function qPoint(
  ax: number, ay: number, cx: number, cy: number, bx: number, by: number, u: number,
): { x: number; y: number } {
  const v = 1 - u;
  return {
    x: v * v * ax + 2 * v * u * cx + u * u * bx,
    y: v * v * ay + 2 * v * u * cy + u * u * by,
  };
}

/** 管线控制点：中点法向偏移，弧向由节点 id 哈希稳定（同一条线每帧弯曲方向一致） */
function pipeCtrl(
  na: { x: number; y: number; id: string }, nb: { x: number; y: number; id: string },
): { cx: number; cy: number } {
  const mx = (na.x + nb.x) / 2;
  const my = (na.y + nb.y) / 2;
  const dx = nb.x - na.x;
  const dy = nb.y - na.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(24, len * 0.12) * (hash01(`${na.id}>${nb.id}`) < 0.5 ? -1 : 1);
  return { cx: mx - (dy / len) * off, cy: my + (dx / len) * off };
}

/** 点到管线（贝塞尔曲线）的最短距离：采样 12 段折线取最小值 */
function pipeDist(
  x: number, y: number,
  na: { x: number; y: number; id: string }, nb: { x: number; y: number; id: string },
): number {
  const c = pipeCtrl(na, nb);
  let best = Infinity;
  let px = na.x;
  let py = na.y;
  for (let i = 1; i <= 12; i++) {
    const p = qPoint(na.x, na.y, c.cx, c.cy, nb.x, nb.y, i / 12);
    best = Math.min(best, pointSegDist(x, y, px, py, p.x, p.y));
    px = p.x;
    py = p.y;
  }
  return best;
}

/** 圆角矩形路径（管线徽章 / 名字牌 / 图例卡片） */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
