import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
    host: 'localhost'
  },
  build: {
    outDir: 'dist',
    // Phaser 独立分包：菜单/引擎代码可长期缓存，首屏只下载自己的代码
    rollupOptions: {
      output: {
        manualChunks: { phaser: ['phaser'] },
      },
    },
  }
});
