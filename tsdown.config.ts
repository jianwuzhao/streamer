import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  platform: 'node',
  target: 'node22',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: { neverBundle: ['yaml', 'zod', 'playwright-core', 'protobufjs'] },
  clean: true,
})
