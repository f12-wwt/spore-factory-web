/** 统一的 HTML 文本/属性转义工具。
 * 所有通过 innerHTML 拼接的动态值都必须经过这里，避免数据表、存档或计算结果中的
 * 特殊字符改变 DOM 结构；配合 index.html 的 CSP 形成双层防护。 */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
