import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  // 星表 / HiPS 等大文件放在 public/data 下，由预处理脚本生成，不参与打包。
  publicDir: 'public',
});
