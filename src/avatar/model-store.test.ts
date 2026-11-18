import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AvatarAssetError, AvatarAssetStore } from './model-store.ts'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-avatar-'))
  const modelsDir = join(root, 'models')
  const vendorDir = join(root, 'vendor')
  mkdirSync(join(modelsDir, 'custom-avatar'), { recursive: true })
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(
    join(modelsDir, 'custom-avatar', 'custom-avatar.model3.json'),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'custom-avatar.moc3', Textures: ['texture_00.png'] } }),
  )
  writeFileSync(join(modelsDir, 'custom-avatar', 'custom-avatar.moc3'), 'FAKEMOC3')
  writeFileSync(join(modelsDir, 'custom-avatar', 'texture_00.png'), 'FAKEPNG')
  writeFileSync(
    join(modelsDir, 'custom-avatar', 'manifest.json'),
    JSON.stringify({ name: '自制角色', source: '本地自制', license: 'Live2D Free Material License' }),
  )
  // 无 model3.json 的目录不应入列
  mkdirSync(join(modelsDir, 'not-a-model'), { recursive: true })
  writeFileSync(join(vendorDir, 'live2dcubismcore.min.js'), '// core')
  writeFileSync(join(vendorDir, 'pixi.min.js'), '// pixi')
  // 缺 extension：vendorStatus 应如实报 false
  const store = new AvatarAssetStore({ modelsDir, vendorDir })
  return { store, modelsDir, vendorDir, root }
}

test('avatar：模型目录扫描——只列含 model3.json 的目录，manifest 驱动展示名', () => {
  const { store, root } = makeFixture()
  try {
    const retired = join(root, 'models', 'Hiyori')
    mkdirSync(retired)
    writeFileSync(join(retired, 'Hiyori.model3.json'), '{}')
    assert.throws(() => store.readModelFile('Hiyori', 'Hiyori.model3.json'), AvatarAssetError)
    const models = store.listModels()
    assert.equal(models.length, 1)
    assert.equal(models[0]?.id, 'custom-avatar')
    assert.equal(models[0]?.entry, 'custom-avatar.model3.json')
    assert.equal(models[0]?.name, '自制角色')
    assert.equal(models[0]?.source, '本地自制')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('avatar：vendor 状态与读取——缺件如实标注，未知名拒绝', () => {
  const { store, root } = makeFixture()
  try {
    const status = store.vendorStatus()
    assert.equal(status.core, true)
    assert.equal(status.pixi, true)
    assert.equal(status.extension, false)
    const core = store.readVendorFile('core')
    assert.equal(core.text, '// core')
    assert.throws(() => store.readVendorFile('nope'), AvatarAssetError)
    assert.throws(() => store.readVendorFile('extension'), AvatarAssetError) // 文件缺失
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('avatar：前景轮廓仅与原立绘配对使用，老素材或重新裁图时仍能播放口型', () => {
  const { store, root, modelsDir } = makeFixture()
  try {
    const id = 'custom-avatar'
    const dir = join(modelsDir, id)
    const portrait = join(dir, 'portrait-frame.png')
    const config = join(dir, 'mouth-model.json')
    const image = 'portrait'
    const mouth = { x: 0.5, y: 0.45, width: 0.1, tilt: 0 }
    writeFileSync(portrait, image)
    writeFileSync(config, JSON.stringify(mouth))
    writeFileSync(join(dir, 'motion-mask.png'), 'mask')
    assert.deepEqual(store.readPrototype(id), { image: Buffer.from(image).toString('base64'), mouth })

    writeFileSync(config, JSON.stringify({ ...mouth, motionMaskSource: hash('sha256', image) }))
    assert.deepEqual(store.readPrototype(id), {
      image: Buffer.from(image).toString('base64'), mouth, motionMask: Buffer.from('mask').toString('base64'),
    })
    writeFileSync(join(dir, 'head-mask.png'), 'head')
    assert.equal(store.readPrototype(id).headMask, Buffer.from('head').toString('base64'))
    writeFileSync(portrait, 'new crop')
    assert.equal(store.readPrototype(id).motionMask, undefined)
    assert.equal(store.readPrototype(id).headMask, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('avatar：模型文件下发——正常读取 + 路径穿越/类型/大小防护', () => {
  const { store, root } = makeFixture()
  try {
    const f = store.readModelFile('custom-avatar', 'texture_00.png')
    assert.equal(f.bytes, 7)
    assert.equal(Buffer.from(f.base64, 'base64').toString(), 'FAKEPNG')
    // 子目录相对路径允许（motions/xxx.motion3.json 场景）
    mkdirSync(join(root, 'models', 'custom-avatar', 'motions'))
    writeFileSync(join(root, 'models', 'custom-avatar', 'motions', 'idle.motion3.json'), '{}')
    assert.doesNotThrow(() => store.readModelFile('custom-avatar', 'motions/idle.motion3.json'))
    // 越界与非法
    assert.throws(() => store.readModelFile('custom-avatar', '../vendor/pixi.min.js'), AvatarAssetError)
    assert.throws(() => store.readModelFile('custom-avatar', '../../etc/passwd'), AvatarAssetError)
    assert.throws(() => store.readModelFile('../models', 'x.json'), AvatarAssetError) // id 越界
    assert.throws(() => store.readModelFile('custom-avatar', 'evil.exe'), AvatarAssetError) // 扩展名白名单
    assert.throws(() => store.readModelFile('ghost', 'model3.json'), AvatarAssetError) // 不存在
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('avatar：眨眼定位只使用配对立绘的双眼坐标，缺失或越界时安全降级', () => {
  const { store, root, modelsDir } = makeFixture()
  try {
    const dir = join(modelsDir, 'custom-avatar')
    const mouth = { x: 0.5, y: 0.5, width: 0.1, tilt: 0, motionMaskSource: hash('sha256', 'portrait') }
    const eye = { x: 0.4, y: 0.3, width: 0.06, height: 0.02, tilt: 0.1 }
    const eyes = [eye, { ...eye, x: 0.6 }]
    writeFileSync(join(dir, 'portrait-frame.png'), 'portrait')
    const config = join(dir, 'mouth-model.json')
    const save = (value: unknown) => writeFileSync(config, JSON.stringify({ ...mouth, eyes: value }))
    save(eyes)
    assert.deepEqual(store.readPrototype('custom-avatar').eyes, eyes)
    for (const invalid of [[eye], [eye, { ...eye, x: 0.99 }], [eye, { ...eye, tilt: 4 }], [eye, { ...eye, height: 0 }]]) {
      save(invalid)
      assert.equal(store.readPrototype('custom-avatar').eyes, undefined)
    }
    save(eyes)
    writeFileSync(join(dir, 'portrait-frame.png'), 'recropped')
    assert.equal(store.readPrototype('custom-avatar').eyes, undefined)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('avatar：模型目录符号链接——指向根外/别名他模型一律拒绝', () => {
  const { store, root, modelsDir } = makeFixture()
  try {
    // 根外目录伪装成模型目录（过去 realpath 基准随之逃逸，现在必须拒绝）
    const outside = join(root, 'outside', 'stolen')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'stolen.model3.json'), '{}')
    writeFileSync(join(outside, 'secret.png'), 'SECRET')
    symlinkSync(outside, join(modelsDir, 'linked'))
    assert.throws(() => store.readModelFile('linked', 'secret.png'), AvatarAssetError)
    // 根内其他模型目录的别名（解析后 realDir ≠ 根下名为 id 的直接子目录）
    symlinkSync(join(modelsDir, 'custom-avatar'), join(modelsDir, 'copy'))
    assert.throws(() => store.readModelFile('copy', 'texture_00.png'), AvatarAssetError)
    // 符号链接目录不入列
    assert.equal(store.listModels().length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('avatar：manifest 读取受限——符号链接逃逸/超大文件按缺失处理', () => {
  const { store, root, modelsDir } = makeFixture()
  try {
    // manifest.json 为符号链接：lstat 非常规文件 → 按缺失处理（不跟随、不受目标大小影响）
    const outsideDir = join(root, 'outside')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(join(outsideDir, 'big.json'), `${JSON.stringify({ name: 'STOLEN' })}\n`.repeat(5000))
    const dir = join(modelsDir, 'badman')
    mkdirSync(dir)
    writeFileSync(join(dir, 'badman.model3.json'), '{}')
    symlinkSync(join(outsideDir, 'big.json'), join(dir, 'manifest.json'))
    // 断链 manifest 同样按缺失处理（保持原有 absent/broken 行为）
    const broken = join(modelsDir, 'brokenman')
    mkdirSync(broken)
    writeFileSync(join(broken, 'brokenman.model3.json'), '{}')
    symlinkSync(join(root, 'nope.json'), join(broken, 'manifest.json'))
    const byId = new Map(store.listModels().map((m) => [m.id, m]))
    assert.equal(byId.get('badman')?.name, 'badman')
    assert.equal(byId.get('badman')?.source, null)
    assert.equal(byId.get('brokenman')?.name, 'brokenman')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('avatar：白名单名符号链接——无扩展名/可执行真实目标拒绝，目录内正常别名放行', () => {
  const { store, root, modelsDir } = makeFixture()
  try {
    const dir = join(modelsDir, 'custom-avatar')
    writeFileSync(join(dir, 'payload'), 'no-ext') // 无扩展名真实文件
    writeFileSync(join(dir, 'run.sh'), 'x') // 可执行类真实文件
    symlinkSync('payload', join(dir, 'data.json')) // 允许名 → 无扩展名目标
    symlinkSync('run.sh', join(dir, 'steal.png')) // 允许名 → 可执行目标
    symlinkSync('texture_00.png', join(dir, 'alias.png')) // 目录内正常别名
    assert.throws(() => store.readModelFile('custom-avatar', 'data.json'), AvatarAssetError)
    assert.throws(() => store.readModelFile('custom-avatar', 'steal.png'), AvatarAssetError)
    const ok = store.readModelFile('custom-avatar', 'alias.png')
    assert.equal(Buffer.from(ok.base64, 'base64').toString(), 'FAKEPNG')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
