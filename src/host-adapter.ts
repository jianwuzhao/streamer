/**
 * 宿主接入适配层（阶段 G 预备）。
 *
 * Cordis 宿主加载 lib/index.js 时以 define({ apply }) 方式装配：
 * 通过环境变量（DAFEIYU_DATA_DIR / DAFEIYU_CONFIG）映射到 createPlugin，
 * 不 import 宿主专属包（保持本仓库独立构建/测试）。
 * 首次安装：plugin_manager install_bundle <本目录>（需用户在宿主确认）。
 */
import { createPlugin, type DafeiyuPluginHandle } from './index.ts'

export interface HostContext {
  logger?: { info(message: string, ...args: unknown[]): void }
  env?: Readonly<Record<string, string | undefined>>
}

export interface HostPlugin {
  readonly name: string
  readonly handle: DafeiyuPluginHandle
  dispose(): void
}

/** 宿主 define 入口（cordis.patch.yml 行 dsh-dafeiyu-evolve 的 node 半）。 */
export function define(_ctx: unknown): { apply: (host: HostContext) => HostPlugin; dispose?: () => void } {
  void _ctx
  return {
    apply: (host: HostContext): HostPlugin => {
      const env = host.env ?? process.env
      const handle = createPlugin({
        ...(env.DAFEIYU_CONFIG !== undefined ? { configPath: env.DAFEIYU_CONFIG } : {}),
        ...(env.DAFEIYU_DATA_DIR !== undefined ? { dataDir: env.DAFEIYU_DATA_DIR } : {}),
        log: (m: string, ...args: unknown[]) => host.logger?.info(`[dafeiyu] ${m}`, ...args),
      })
      return {
        name: 'dsh-dafeiyu-evolve',
        handle,
        dispose: () => handle.dispose(),
      }
    },
  }
}
