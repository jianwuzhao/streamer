import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { publishArtifact, sha256Content } from './publish.ts'

test('发布成功：内容落盘且哈希正确', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-test-'))
  try {
    const content = '{"model":"qwen3-4b","adapter":"lora-v3"}'
    const res = publishArtifact({ dir, filename: 'artifact-1.json', content })
    assert.equal(res.sha256, sha256Content(content))
    assert.equal(readFileSync(res.path, 'utf8'), content)
    assert.ok(!existsSync(join(dir, '.artifact-1.json.tmp-x')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('哈希校验失败：抛错且不落最终文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-test-'))
  try {
    assert.throws(() =>
      publishArtifact({
        dir,
        filename: 'bad.bin',
        content: 'payload',
        expectedSha256: 'deadbeef',
      }),
    )
    assert.ok(!existsSync(join(dir, 'bad.bin')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
