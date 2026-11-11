/**
 * JSON Schema 子集校验（技能输入/输出 manifest 契约）。
 *
 * 支持 type / required / properties / items / enum / minimum——覆盖阶段 B
 * 技能包的确定性校验需求；不支持的 schema 关键字如实报「不支持」，
 * 不静默放行。
 */
export interface SchemaIssue {
  readonly path: string
  readonly message: string
}

type Schema = {
  type?: string
  required?: string[]
  properties?: Record<string, Schema>
  items?: Schema
  enum?: unknown[]
  minimum?: number
  maxLength?: number
}

export function validateSchemaSubset(value: unknown, schema: unknown, path = '$'): readonly SchemaIssue[] {
  const issues: SchemaIssue[] = []
  if (schema === null || schema === undefined || typeof schema !== 'object') {
    return [{ path, message: '缺少 schema' }]
  }
  const s = schema as Schema
  if (s.type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
    if (s.type === 'integer' && !(typeof value === 'number' && Number.isInteger(value))) {
      issues.push({ path, message: `期望 integer，实际 ${actual}` })
    } else if (s.type === 'number' && typeof value !== 'number') {
      issues.push({ path, message: `期望 number，实际 ${actual}` })
    } else if (['string', 'boolean', 'object'].includes(s.type) && actual !== s.type) {
      issues.push({ path, message: `期望 ${s.type}，实际 ${actual}` })
    } else if (s.type === 'array' && actual !== 'array') {
      issues.push({ path, message: `期望 array，实际 ${actual}` })
    }
  }
  if (s.enum !== undefined && !s.enum.some((v) => v === value)) {
    issues.push({ path, message: `不在枚举 ${JSON.stringify(s.enum)} 内` })
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) {
      issues.push({ path, message: `${value} < minimum ${s.minimum}` })
    }
  }
  if (typeof value === 'string' && s.maxLength !== undefined && value.length > s.maxLength) {
    issues.push({ path, message: `长度 ${value.length} > maxLength ${s.maxLength}` })
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const key of s.required ?? []) {
      if (!(key in obj)) issues.push({ path: `${path}.${key}`, message: '缺少必填字段' })
    }
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      if (key in obj) {
        issues.push(...validateSchemaSubset(obj[key], sub, `${path}.${key}`))
      }
    }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => issues.push(...validateSchemaSubset(item, s.items, `${path}[${i}]`)))
  }
  return issues
}
