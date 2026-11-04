import { defineConfig, type Plugin } from 'vite';

/**
 * GitHub Pages 不能自定义响应头，内容安全策略只能通过 meta 下发。
 * script-src 'self' 禁止内联脚本与行内事件处理器（innerHTML 注入不再可执行）；
 * style-src 保留 'unsafe-inline' 是因为 DOM UI 使用行内 style 属性与 cssText；
 * img-src 允许 canvas 生成的 data:/blob: 纹理；object-src/base-uri/form-action 收紧。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** 仅在生产构建注入；开发服务器保留 HMR 所需能力。 */
function cspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html: string) {
      // 必须插在 <head> 最前：meta CSP 只对出现在它之后的资源生效
      return html.replace(
        '<head>',
        `<head>\n  <meta name="referrer" content="no-referrer" />\n` +
        `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [cspMeta()],
  base: './',
  server: {
    port: 5173,
    strictPort: false,
    host: 'localhost'
  },
  build: {
    outDir: 'dist',
    // Phaser 引擎单包约 1.19 MB 属预期体积（已按需动态导入独立分包），提高告警阈值避免噪音
    chunkSizeWarningLimit: 1300,
    // Phaser 独立分包：菜单/引擎代码可长期缓存，首屏只下载自己的代码。
    // Vite 8 / Rolldown 要求 manualChunks 为函数（对象写法已废弃）。
    rollupOptions: {
      output: {
        manualChunks: (id: string) => id.includes('/node_modules/phaser/') ? 'phaser' : undefined,
      },
    },
  }
});
