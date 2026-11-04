import type { Pipe, FlowNode } from '../types/GameState';
import type { FlowLayer } from '../types/Module';
import { CONST } from './RunState';
import { DataStore } from './DataStore';
import { liveNodeIds } from './OrganSystem';

/**
 * 物流系统（GDD 3.3 / T8）：按"层"组织的内部物流。
 *
 * 分层（层数 = 物种复杂度，随纪元/器官解锁）：
 *   消化层  摄食器官 → 原始胃 → 能量池     —— 单细胞即存在，决定代谢产出 P
 *   循环层  能量池 → 心泵/鳃 → 全身         —— 多细胞后出现，把养分铺开
 *   神经层  能量池 → 神经网 → 神经节(脑)    —— 脑化，感知与决策
 *   运动层  能量池 → 肌节 → 肌肉            —— 动力出口，决定运动实现率
 *
 * 管道有长度、吞吐（cap = 基础×level）；服务按"最宽简单路径"计算吞吐，最窄链路为瓶颈。
 * 安装带 node 的器官会自动连入所属层（autoWire），玩家仍可手动增删支线。
 */
export const LAYERS: { id: FlowLayer; name: string; short: string; desc: string; minEra: number }[] = [
  { id: 'digest', name: '消化系统', short: '消化', desc: '摄食 → 胃 → 能量池：决定代谢产出 P', minEra: 0 },
  { id: 'circulation', name: '循环系统', short: '循环', desc: '心泵/鳃把养分铺向全身：无循环则吞吐送不远', minEra: 1 },
  { id: 'nerve', name: '神经系统', short: '神经', desc: '信号分配与脑化：提升脑供能与感知', minEra: 2 },
  { id: 'motor', name: '运动系统', short: '运动', desc: '肌节把能量送到肌纤维：决定运动实现率', minEra: 0 },
];

const LAYER_COLOR: Record<FlowLayer, string> = {
  digest: '#6fe08a',
  circulation: '#ff9f43',
  nerve: '#c792ea',
  motor: '#56c9f0',
};

export function layerColor(l: FlowLayer): string {
  return LAYER_COLOR[l];
}

/** 层按 type 的兜底推断（基础节点/旧数据缺 layer 时） */
export function layerOf(n: { layer?: FlowLayer; type: FlowNode['type'] }): FlowLayer {
  if (n.layer) return n.layer;
  if (n.type === 'source') return 'digest';
  if (n.type === 'storage') return 'digest';
  return 'digest';
}

/** 该层是否已解锁（纪元达到 + 该层有节点） */
export function layerUnlocked(eraIndex: number, layer: FlowLayer): boolean {
  const def = LAYERS.find(l => l.id === layer);
  return def ? eraIndex >= def.minEra : false;
}

export const Logistics = {
  LAYERS,
  layerColor,
  layerOf,
  layerUnlocked,

  nodeOf(P: { nodes: FlowNode[] }, id: string): FlowNode | undefined {
    return P.nodes.find(n => n.id === id);
  },

  pipeBetween(P: { pipes: Pipe[] }, a: string, b: string): Pipe | undefined {
    return P.pipes.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  },

  pipeLen(P: { nodes: FlowNode[] }, a: string, b: string): number {
    const na = this.nodeOf(P, a), nb = this.nodeOf(P, b);
    if (!na || !nb) return 0;
    return Math.hypot(na.x - nb.x, na.y - nb.y);
  },

  /** 建线；返回错误信息或 null
   *  cap = 当前纪元的管道基准（管网随纪元升级，见 CONST.pipeCapOf） */
  connect(P: { nodes: FlowNode[]; pipes: Pipe[]; eraIndex?: number }, a: string, b: string): string | null {
    if (a === b) return '不能连接自身';
    // v0.6：隐退节点（被同槽高阶器官顶替）不再参与物流，不能接线
    const live = liveNodeIds(P.nodes);
    if (!live.has(a) || !live.has(b)) return '该节点已被更高阶器官替代，处于隐退状态';
    if (this.pipeBetween(P, a, b)) return '管线已存在';
    const deg = (id: string) => P.pipes.filter(l => l.a === id || l.b === id).length;
    if (deg(a) >= 4 || deg(b) >= 4) return '节点连接数已达上限（4）';
    P.pipes.push({ a, b, level: 1, cap: CONST.pipeCapOf(P.eraIndex ?? 0) });
    return null;
  },

  disconnect(P: { pipes: Pipe[] }, a: string, b: string): void {
    // 就地剔除：调用方可能传入 player 的浅拷贝（{...player}），
    // 重新赋值会写回副本，真实管线列表不会被清理。
    const keep = P.pipes.filter(l => !((l.a === a && l.b === b) || (l.a === b && l.b === a)));
    P.pipes.length = 0;
    P.pipes.push(...keep);
  },

  /** 扩容费用随管长增加（GDD：管道有长度） */
  upgradeCost(P: { nodes: FlowNode[] }, a: string, b: string): number {
    const len = this.pipeLen(P, a, b);
    return Math.round(CONST.PIPE_UP_COST + len / 30);
  },

  /** 管线扩容（仅吞吐）：cap = level × 当前纪元基准
   *  v0.6 修正：原先按 CONST.BASE_NODE_CAP 重算，进化到后期会把 16 砍回 8（反而降吞吐） */
  upgradePipe(P: { pipes: Pipe[]; eraIndex?: number }, a: string, b: string): boolean {
    const l = this.pipeBetween(P, a, b);
    if (!l || l.level >= CONST.UP_MAX_LEVEL) return false;
    l.level += 1;
    l.cap = l.level * CONST.pipeCapOf(P.eraIndex ?? 0);
    return true;
  },

  /** 最宽简单路径（DFS 防环）——物流网核心算法 */
  widest(P: { nodes: FlowNode[]; pipes: Pipe[] }, from: string, to: string): number {
    if (from === to) return Infinity;
    // v0.6：隐退节点（被同槽高阶器官顶替）既不是起点也不是中转，
    // 否则养分仍会"流经"已经让位的节点，替代就形同虚设
    const live = liveNodeIds(P.nodes);
    if (!live.has(from) || !live.has(to)) return 0;
    const adj = new Map<string, { to: string; cap: number }[]>();
    for (const l of P.pipes) {
      if (!live.has(l.a) || !live.has(l.b)) continue;
      if (!adj.has(l.a)) adj.set(l.a, []);
      if (!adj.has(l.b)) adj.set(l.b, []);
      adj.get(l.a)!.push({ to: l.b, cap: l.cap });
      adj.get(l.b)!.push({ to: l.a, cap: l.cap });
    }
    const visited = new Set<string>([from]);
    let best = 0;
    const dfs = (cur: string, minCap: number): void => {
      if (cur === to) {
        best = Math.max(best, minCap);
        return;
      }
      for (const e of adj.get(cur) ?? []) {
        if (visited.has(e.to)) continue;
        visited.add(e.to);
        dfs(e.to, Math.min(minCap, e.cap));
        visited.delete(e.to);
      }
    };
    dfs(from, Infinity);
    return best;
  },

  /**
   * 自动接入：新安装的器官节点按所属层挂到该层主干上。
   * 消化层：source → process → energy（水库）
   * 循环层：energy ↔ process（循环泵是养分中继，串联到下游层）
   * 神经层：process → sink（神经节=脑）
   * 运动层：sink → muscle（肌节→肌肉）
   * 幂等：已存在的边不重复添加；返回新增的边数。
   */
  autoWire(P: { nodes: FlowNode[]; pipes: Pipe[]; eraIndex?: number }): number {
    let added = 0;
    const eraCap = CONST.pipeCapOf(P.eraIndex ?? 0);
    const live = liveNodeIds(P.nodes);
    // v0.6：清掉挂在隐退节点上的旧支线（顶替前铺的线不再有效）。
    // 保留隐退节点本身，卸下高阶器官后它原位复活、由 autoWire 重新接线。
    // 就地剔除而非重新赋值：调用方可能传 player 的浅拷贝。
    {
      const keep = P.pipes.filter(l => live.has(l.a) && live.has(l.b));
      if (keep.length !== P.pipes.length) {
        P.pipes.length = 0;
        P.pipes.push(...keep);
      }
    }
    const link = (a: string, b: string): void => {
      if (a === b || !live.has(a) || !live.has(b)) return;
      if (!this.nodeOf(P, a) || !this.nodeOf(P, b)) return;
      if (this.pipeBetween(P, a, b)) return;
      P.pipes.push({ a, b, level: 1, cap: eraCap });
      added++;
    };
    const inLayer = (l: FlowLayer): FlowNode[] =>
      P.nodes.filter(n => live.has(n.id) && this.layerOf(n) === l);

    // 消化层主干：source → process → energy（水库）
    for (const s of inLayer('digest').filter(n => n.type === 'source')) {
      for (const pr of inLayer('digest').filter(n => n.type === 'process')) link(s.id, pr.id);
    }
    for (const pr of inLayer('digest').filter(n => n.type === 'process')) {
      link(pr.id, 'energy');
    }
    for (const st of inLayer('digest').filter(n => n.type === 'storage')) link(st.id, 'energy');
    // 消化层废物出口（胞肛等 sink）：挂到能量池，排出代谢残余
    for (const sk of inLayer('digest').filter(n => n.type === 'sink')) link(sk.id, 'energy');

    // 循环层：能量池 → 循环节点；循环节点 → 下游节点（作为养分中继）
    const circ = inLayer('circulation');
    for (const c of circ) {
      link('energy', c.id);
      for (const n of P.nodes) {
        if (!live.has(n.id)) continue;          // 隐退节点不中继
        if (this.layerOf(n) === 'circulation') continue;
        if (n.type === 'source') continue;
        if (n.moduleId || n.id === 'energy') link(c.id, n.id);
      }
    }

    // 神经层：神经网 → 神经节（脑）
    for (const p of inLayer('nerve').filter(n => n.type === 'process')) {
      link('energy', p.id);
      for (const s of inLayer('nerve').filter(n => n.type === 'sink')) link(p.id, s.id);
    }
    for (const s of inLayer('nerve').filter(n => n.type === 'sink')) link(s.id, 'brain');

    // 运动层：肌节 → 肌肉
    for (const s of inLayer('motor').filter(n => n.type === 'sink')) {
      link('energy', s.id);
      link(s.id, 'muscle');
    }
    return added;
  },

  /**
   * 按层的服务能力（物流页分层展示）：
   * digest      消化道吞吐（决定代谢产出 P）
   * circulation 循环泵最宽路径 / 12（养分能铺多远）
   * nerve       脑供能（神经节未被上游供能则靠 energy 直连兜底）
   * motor       运动实现率
   */
  layerFlows(P: { nodes: FlowNode[]; pipes: Pipe[] }): Record<FlowLayer, number> {
    const live = liveNodeIds(P.nodes);
    const circ = P.nodes.filter(n => live.has(n.id) && this.layerOf(n) === 'circulation');
    const circFlow = circ.length === 0
      ? Infinity // 无循环层：视为未限制（旧单细胞路径）
      : Math.max(...circ.map(c => Math.min(this.widest(P, 'energy', c.id), this.widest(P, c.id, 'muscle'))));
    const nerve = P.nodes.filter(n => live.has(n.id) && this.layerOf(n) === 'nerve' && n.type === 'sink');
    const nerveFlow = nerve.length === 0
      ? this.widest(P, 'energy', 'brain')
      : Math.max(...nerve.map(n => this.widest(P, 'energy', n.id)));
    return {
      digest: this.services(P).digestCap,
      circulation: Math.min(1, circFlow / 12),
      nerve: Math.min(1, nerveFlow / 6),
      motor: this.services(P).muscleReal,
    };
  },

  /** 重算物流服务：消化道效率 / 运动实现率 / 脑供能 / 瓶颈
   吞吐 = min(管线最宽路径, 节点自身处理量) —— 强化器官提高处理量 → 吞吐真涨（不再只靠扩管线） */
  services(P: { nodes: FlowNode[]; pipes: Pipe[] }) {
    let digestCap = 0;
    // v0.6：隐退节点（被同槽高阶器官顶替）不参与吞吐计算，
    // 否则口沟 + 基础口器会形成两条并行入口，消化吞吐凭空翻倍
    const live = liveNodeIds(P.nodes);
    const sources = P.nodes.filter(n => live.has(n.id) && n.type === 'source');
    const processes = P.nodes.filter(n => live.has(n.id) && n.type === 'process');
    for (const s of sources) {
      for (const pr of processes) {
        const path = Math.min(this.widest(P, s.id, pr.id), this.widest(P, pr.id, 'energy'));
        // 节点处理量也是上限之一（强化处理器官 → 处理量↑ → 吞吐↑）
        const c = Math.min(path, pr.rate, s.rate);
        if (c > digestCap) digestCap = c;
      }
    }
    const digestionEfficiency = Math.min(1, digestCap / 10);
    const muscleFlow = this.widest(P, 'energy', 'muscle');
    const brainFlow = this.widest(P, 'energy', 'brain');
    const bottleneck = this.bottleneck(P);
    return {
      digestionEfficiency,
      digestCap,
      muscleReal: Math.min(1, muscleFlow / 8),
      brainEff: Math.min(1, brainFlow / 6),
      bottleneck,
    };
  },

  /** 瓶颈链路（编辑器橙色高亮） */
  bottleneck(P: { pipes: Pipe[] }): { a: string; b: string; cap: number } | null {
    let worst: { a: string; b: string; cap: number } | null = null;
    for (const l of P.pipes) {
      if (!worst || l.cap < worst.cap) worst = { a: l.a, b: l.b, cap: l.cap };
    }
    return worst;
  },

  /** 新建带物流节点的器官实例（安装时调用；自动接入所属层） */
  makeNode(id: string, moduleId: string, x: number, y: number): FlowNode {
    const m = DataStore.module(moduleId);
    return {
      id,
      type: m.node!.type,
      layer: this.layerOf({ layer: m.node!.layer, type: m.node!.type }),
      x,
      y,
      rate: m.node!.rate,
      moduleId,
      auto: true,
    };
  },
};