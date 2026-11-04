import { Ev, bus, type ToastPayload } from '../core/EventBus';

/** Toast 提示（GDD UI/Toast） */
export const Toast = {
  init(): void {
    bus.on(Ev.TOAST, (p: ToastPayload) => this.show(p.text, p.kind));
  },

  show(text: string, kind: ToastPayload['kind'] = 'info'): void {
    const root = document.getElementById('toasts');
    if (!root) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    root.appendChild(el);
    while (root.children.length > 4) root.removeChild(root.firstChild!);
    setTimeout(() => el.remove(), 3200);
  },
};
