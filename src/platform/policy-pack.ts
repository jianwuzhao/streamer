/**
 * 平台政策包（方案 §23.1）：随安装包发布签名版本，开播前检查有效性。
 * 外部网页变化只生成待审政策差异，不让大模型自动改合规边界。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export interface PolicyRule {
  readonly rule_id: string
  readonly source_url: string
  readonly published_at: string
  readonly fetched_at: string
  readonly content_hash: string
  readonly effective_scope: readonly string[]
  readonly check: string
  readonly action: string
  readonly tests: readonly string[]
  readonly reviewer: string
}

export interface PolicyPack {
  readonly pack_id: string
  readonly platform: string
  readonly fetched_at: string
  readonly reviewer: string
  readonly rules: readonly PolicyRule[]
}

export interface PackValidity {
  readonly valid: boolean
  readonly reason?: string
  readonly ruleCount: number
}

export function loadPolicyPack(path: string): PolicyPack {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as PolicyPack
  if (!raw.pack_id || !Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error(`政策包结构非法: ${path}`)
  }
  for (const r of raw.rules) {
    if (!r.rule_id || !r.source_url || !r.effective_scope?.length || !r.check || !r.action) {
      throw new Error(`政策规则字段缺失: ${JSON.stringify(r).slice(0, 80)}`)
    }
  }
  return raw
}

export function ruleHash(rule: PolicyRule): string {
  return createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 16)
}

/** 开播前有效性检查（§23.2 开播前位置）。 */
export function checkPackValidity(pack: PolicyPack | null, platform: string): PackValidity {
  if (pack === null) return { valid: false, reason: '政策包缺失：未随安装版本发布', ruleCount: 0 }
  if (pack.platform !== platform) {
    return { valid: false, reason: `政策包平台不匹配（${pack.platform} ≠ ${platform}）`, ruleCount: pack.rules.length }
  }
  const broken = pack.rules.find((r) => ruleHash(r) !== r.content_hash && r.content_hash !== 'pinned-no-fetch')
  if (broken) return { valid: false, reason: `规则哈希校验失败: ${broken.rule_id}`, ruleCount: pack.rules.length }
  return { valid: true, ruleCount: pack.rules.length }
}
