/**
 * 技能包目录加载（方案 §7.1 包结构）。
 *
 * skills/<skill-id>/<version>/{manifest.yaml, input.schema.json, output.schema.json,
 * SKILL.md, examples.jsonl, tests.jsonl, runtime/}
 * manifest.yaml 引用同目录 schema 文件（$ref 同目录文件名），加载时内联合并。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface LoadedPackage {
  readonly dir: string
  readonly manifest: Record<string, unknown>
  readonly files: readonly string[]
}

/** 读取包目录并内联 schema 引用；文件缺失/坏 YAML 抛出具体错误。 */
export function loadSkillPackage(dir: string): LoadedPackage {
  const files = ['manifest.yaml', 'SKILL.md']
  const manifestRaw = readFileSync(join(dir, 'manifest.yaml'), 'utf8')
  const manifest = parseYaml(manifestRaw) as Record<string, unknown>
  if (manifest === null || typeof manifest !== 'object') {
    throw new Error(`${dir}/manifest.yaml 不是有效 YAML 对象`)
  }
  // 内联同目录 schema 文件
  for (const key of ['inputSchema', 'outputSchema'] as const) {
    const ref = manifest[key]
    if (typeof ref === 'string') {
      const schemaPath = join(dir, ref)
      const text = readFileSync(schemaPath, 'utf8')
      try {
        manifest[key] = JSON.parse(text)
        files.push(ref)
      } catch (err) {
        throw new Error(`${schemaPath} 不是有效 JSON：${(err as Error).message}`)
      }
    }
  }
  return { dir, manifest, files }
}
