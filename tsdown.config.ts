import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  platform: 'node',
  target: 'node22',
  // 插件包规范：main = lib/index.js（ESM）
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // 运行时依赖（yaml/zod）不打包，随包安装解析
  external: ['yaml', 'zod'],
  clean: true,
})
