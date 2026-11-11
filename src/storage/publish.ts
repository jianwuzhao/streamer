/**
 * 不可变产物发布：临时路径写入 → 哈希校验 → 原子重命名（方案 §16）。
 * 用于模型/技能/索引产物；失败不落半成品、不更改已发布版本。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function sha256Content(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface PublishArtifactResult {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

/**
 * 将内容发布为不可变产物：
 * 1. 写入同目录临时文件（确保与目标在同一文件系统，rename 原子）；
 * 2. 计算并（可选）校验 sha256；
 * 3. 原子重命名为最终路径。
 * expectedSha256 不匹配或写入失败时清理临时文件并抛错，目标路径不受影响。
 */
export function publishArtifact(input: {
  dir: string
  filename: string
  content: string | Uint8Array
  expectedSha256?: string
}): PublishArtifactResult {
  const { dir, filename, content, expectedSha256 } = input
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, filename)
  const tmpPath = join(dir, `.${filename}.tmp-${process.pid}-${randomUUID()}`)
  try {
    writeFileSync(tmpPath, content)
    const sha256 = sha256Content(content)
    if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
      throw new Error(
        `产物哈希校验失败：期望 ${expectedSha256}，实际 ${sha256}（${finalPath}）`,
      )
    }
    renameSync(tmpPath, finalPath)
    return { path: finalPath, sha256, bytes: content.length }
  } catch (err) {
    rmSync(tmpPath, { force: true })
    throw err
  }
}

/** 迁移工具：发布前确保父目录存在（校验备份路径等场景）。 */
export function ensureDirFor(path: string): string {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  return dir
}
