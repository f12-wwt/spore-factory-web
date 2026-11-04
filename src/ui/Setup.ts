import type { DiffConfig } from '../types/GameState';
import { DIFF_PRESETS } from '../systems/RunState';
import { Ev, bus } from '../core/EventBus';
import { esc } from '../core/escape';

/**
 * 开局设置（初始状态）：难度预设 + 6 项滑杆。
 * 菜单"开始进化"与死亡结算"以子代重启"都会先经过这里。
 */
export const Setup = {
  G: null as unknown as { diff: DiffConfig },

  init(G: { diff: DiffConfig }): void {
    this.G = G;

    // 预设按钮
    const btns = document.getElementById('diff-btns')!;
    btns.innerHTML = Object.values(DIFF_PRESETS)
      .map(p => `<button class="diff-btn ${p.preset === 'normal' ? 'active' : ''}" data-preset="${esc(p.preset)}">${esc(p.label)}</button>`)
      .join('');
    btns.querySelectorAll('[data-preset]').forEach(el => {
      el.addEventListener('click', () => {
        const p = DIFF_PRESETS[(el as HTMLElement).dataset.preset!];
        Object.assign(this.G.diff, p);
        btns.querySelectorAll('.diff-btn').forEach(b => { b.classList.remove('active'); });
        el.classList.add('active');
        this.syncSliders();
      });
    });

    // 滑杆：拖动即写入 diff 并标记为自定义
    document.querySelectorAll('#setup input[type="range"]').forEach(el => {
      const input = el as HTMLInputElement;
      input.addEventListener('input', () => {
        const key = input.dataset.key as keyof DiffConfig;
        (this.G.diff as unknown as Record<string, number | string>)[key] = parseFloat(input.value);
        this.G.diff.preset = 'custom';
        this.G.diff.label = '⚙️ 自定义';
        btns.querySelectorAll('.diff-btn').forEach(b => { b.classList.remove('active'); });
        this.syncLabels();
      });
    });

    document.getElementById('setup-start')!.onclick = () => {
      document.getElementById('setup')!.classList.add('hidden');
      bus.emit(Ev.MENU_START);
    };
    document.getElementById('setup-back')!.onclick = () => {
      document.getElementById('setup')!.classList.add('hidden');
      // 返回菜单/死亡结算/通关画面
      if (this.from === 'death') document.getElementById('death')!.classList.remove('hidden');
      else if (this.from === 'victory') document.getElementById('victory')!.classList.remove('hidden');
    };

    document.getElementById('menu-start')!.onclick = () => this.open('menu');
    document.getElementById('death-restart')!.onclick = () => this.open('death');
    document.getElementById('victory-restart')!.onclick = () => this.open('victory');
  },

  from: 'menu' as 'menu' | 'death' | 'victory',

  open(from: 'menu' | 'death' | 'victory'): void {
    this.from = from;
    if (from === 'menu') document.getElementById('menu')!.classList.add('hidden');
    else if (from === 'death') document.getElementById('death')!.classList.add('hidden');
    else document.getElementById('victory')!.classList.add('hidden');
    this.syncSliders();
    document.getElementById('setup')!.classList.remove('hidden');
  },

  /** 滑杆位置 ← 当前 diff */
  syncSliders(): void {
    document.querySelectorAll('#setup input[type="range"]').forEach(el => {
      const input = el as HTMLInputElement;
      const key = input.dataset.key as keyof DiffConfig;
      const v = this.G.diff[key];
      input.value = String(v);
    });
    this.syncLabels();
  },

  syncLabels(): void {
    document.querySelectorAll('#setup input[type="range"]').forEach(el => {
      const input = el as HTMLInputElement;
      const key = input.dataset.key as keyof DiffConfig;
      const out = document.getElementById(`out-${key}`);
      if (out) out.textContent = key === 'startGrowth' ? String(this.G.diff[key]) : `×${Number(this.G.diff[key]).toFixed(1)}`;
    });
  },
};
