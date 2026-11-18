import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { validateFaceRig } from './face-rig.ts'
const { deformFaceRig } = runInNewContext(readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8') + ';({deformFaceRig})', {
  window: { __ModuleLoader__: { load() {} } },
})
function model() {
  const basis = { x: 50, y: 50, width: 20, cos: 1, sin: 0 }
  return { version: 1, kind: 'dafeiyu-face-2.5d', sourceSha256: 'image-hash', width: 100, height: 100,
    rect: [0, 0, 100, 100], points: [0, 0, 100, 0, 100, 100, 0, 100], indices: [0, 1, 2, 0, 2, 3],
    regions: { leftEye: [0, 1, 2], rightEye: [0, 2, 3], innerLips: [1, 2, 3] }, mouth: basis, eyes: [basis, basis],
    targets: Object.fromEntries(['jawOpen', 'mouthRound', 'smile', 'browLeft', 'browRight', 'blinkLeft', 'blinkRight'].map(name => [name, [0, 0, 0, 0, 0, 10, 0, 10]])) }
}
test('完整面部模型绑定原图，拒绝错配与越界索引', () => {
  assert.equal(validateFaceRig(model(), 'image-hash').kind, 'dafeiyu-face-2.5d')
  assert.throws(() => validateFaceRig(model(), 'different-image'), /匹配/)
  const invalid = model(); invalid.indices[0] = 999
  assert.throws(() => validateFaceRig(invalid, 'image-hash'), /无效/)
})
test('完整面部模型拒绝缺失五官、不完整形变和非有限坐标', () => {
  const incomplete = model(); incomplete.targets.jawOpen = [0]
  assert.throws(() => validateFaceRig(incomplete, 'image-hash'), /形变/)
  const missing = model(); missing.regions.leftEye = []
  assert.throws(() => validateFaceRig(missing, 'image-hash'), /五官/)
  const nan = model(); nan.points[0] = NaN
  assert.throws(() => validateFaceRig(nan, 'image-hash'), /无效/)
  const coords = model(); coords.eyes[0]!.cos = 2
  assert.throws(() => validateFaceRig(coords, 'image-hash'), /坐标/)
})
test('中性网格严格保留原坐标，独立控制有界且不修改模型源数据', () => {
  const rig = model(), original = structuredClone(rig)
  assert.deepEqual(Array.from(deformFaceRig(rig, {})), rig.points)
  assert.deepEqual(Array.from(deformFaceRig(rig, { jawOpen: Infinity })), rig.points)
  const moved = deformFaceRig(rig, { jawOpen: 999 })
  assert.equal(moved[5], 110)
  assert.deepEqual(rig, original)
})
