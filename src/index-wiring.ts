/**
 * 插件装配辅助（从 index.ts 拆出，保持组装根 ≤400 行）：
 * 包内自定位、技能包播种、内置技能处理器、云端覆盖与成本记账。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DafeiyuConfigType } from './config.ts'
import type { DB } from './storage/db.ts'
import type { CloudSettingsType } from './settings/store.ts'
import type { QualityGate } from './routing/quality-gate.ts'
import { loadSkillPackage } from './skills/package-loader.ts'
import { SKILL_LIFECYCLE, type SkillRegistry } from './skills/registry.ts'
import type { SkillExecutor } from './skills/executor.ts'

/** 包根目录（lib/index.js 或 src/index.ts 均回溯到包根）。 */
export function packageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

export function skillPackagesDir(): string {
  return process.env.DAFEIYU_SKILL_PACKAGES ?? join(packageDir(), 'skill-packages')
}

/**
 * 内置表达技能处理器：礼物答谢模板（本地拼装，不调用模型，§10.2）。
 */
export function registerBuiltinHandlers(executor: SkillExecutor, qualityGate: QualityGate): void {
  executor.registerHandler('gift-ack-template', async (args) => {
    const input = args as { viewerNickname?: string; giftName: string; nameMention?: boolean }
    const mention =
      input.nameMention !== false &&
      input.viewerNickname !== undefined &&
      qualityGate.checkRequestText(input.viewerNickname).pass
        ? `感谢「${input.viewerNickname}」`
        : '谢谢这位朋友'
    const phrase = `${mention}送出的${input.giftName}，先把日子过好，咱们接着种田。`
    return {
      output: { phrase },
      toolReceipts: [{ tool: 'local-template', ok: true }],
    }
  })
}

/**
 * 播种技能包目录：表达/只读技能（无权限扩张）测试通过后自动发布
 * （draft→…→active 逐级推进，§7.2）；权限超出的技能停在 draft。
 */
export function seedSkillPackages(registry: SkillRegistry, dir: string, onIssue: (message: string) => void): void {
  if (!existsSync(dir)) return
  for (const skillDir of readdirSync(dir, { withFileTypes: true })) {
    if (!skillDir.isDirectory()) continue
    const versionsRoot = resolve(dir, skillDir.name)
    for (const versionDir of readdirSync(versionsRoot, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) continue
      const pkgDir = resolve(versionsRoot, versionDir.name)
      try {
        const pkg = loadSkillPackage(pkgDir)
        const registered = registry.register(pkg.manifest, { packagePath: pkgDir })
        if (registered.manifest.permissions.length === 0 && registered.manifest.kind !== 'action') {
          let idx = SKILL_LIFECYCLE.indexOf(registered.status as (typeof SKILL_LIFECYCLE)[number])
          idx = idx < 0 ? SKILL_LIFECYCLE.length - 1 : idx
          for (let i = idx + 1; i < SKILL_LIFECYCLE.length; i++) {
            registry.setStatus(registered.skillId, registered.version, SKILL_LIFECYCLE[i] as (typeof SKILL_LIFECYCLE)[number])
          }
        }
      } catch (err) {
        // 坏包跳过并留日志（不阻断启动）
        onIssue(`技能包 ${pkgDir} 注册失败: ${(err as Error).message}`)
      }
    }
  }
}

/**
 * 云端设置覆盖（§24.1 向导第 4 步）：settings/cloud 的 provider 非空才覆盖
 * config.yaml；预算未填保持原值（null 仍禁用付费调用）。重启插件后生效；
 * API key 永不落库，仍由 DAFEIYU_CLOUD_API_KEY 环境变量提供。
 */
export function applyCloudOverrides(base: DafeiyuConfigType, cloud: CloudSettingsType): DafeiyuConfigType {
  if (cloud.provider.trim() === '') return base
  return {
    ...base,
    models: {
      ...base.models,
      cloud: {
        ...base.models.cloud,
        enabled: cloud.enabled,
        provider: cloud.provider,
        model: cloud.model.trim() === '' ? base.models.cloud.model : cloud.model,
        dailyBudgetCny: cloud.dailyBudgetCny ?? base.models.cloud.dailyBudgetCny,
      },
    },
  }
}

/** 云端成本记账：usage 表当日合计（阶段 A 简化实现；对账以服务商账单为准 §19）。 */
export function sqliteCostTracker(db: DB) {
  return {
    getSpentTodayCny(): number {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const row = db
        .prepare('SELECT COALESCE(SUM(cost_cny), 0) AS total FROM usage WHERE created_at >= ?')
        .get(todayStart.toISOString()) as { total: number } | undefined
      return row?.total ?? 0
    },
    add(costCny: number): void {
      db.prepare(`INSERT INTO audit (action, summary) VALUES ('cloud_cost', ?)`).run(`+${costCny} CNY`)
    },
  }
}
