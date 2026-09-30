import { defineConfig } from 'vite';

/**
 * 部署到 GitHub Pages 的**项目页**时，站点不在域名根目录，而在
 * `https://<用户名>.github.io/<仓库名>/` 下面。这时如果还用默认的 `base: '/'`，
 * 打包出来的 `/assets/xxx.js` 会被解析到域名根目录，整站 404。
 *
 * 所以 base 通过环境变量注入，本地开发不设它、保持 `/`：
 * ```
 * VITE_BASE=/xingtu-deepseek/ pnpm build
 * ```
 * （部署工作流里会自动填成当前仓库名，见 .github/workflows/deploy-pages.yml）
 *
 * 运行时拉取的数据（`data/stars/manifest.json` 等）本来就都是**相对路径**，
 * 会跟着页面 URL 走，所以不需要额外处理。
 */
const base = process.env['VITE_BASE'] ?? '/';

export default defineConfig({
  base,
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
