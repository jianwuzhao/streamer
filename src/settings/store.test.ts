import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../storage/db.ts'
import { BUILTIN_AVATARS, BUILTIN_VOICES, BUILTIN_PROFILES, resolveProfile, CLOUD_PROVIDER_PRESETS, resolveCloudBaseUrl } from './catalogs.ts'
import { SettingsStore, SettingsValidationError } from './store.ts'

function makeStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-settings-'))
  const db = openDatabase(join(dataDir, 'dafeiyu.db'))
  migrate(db)
  return { store: new SettingsStore(db), dataDir, db }
}

test('settings：默认值齐备（schema default），未保存即可读', () => {
  const { store, db, dataDir } = makeStore()
  try {
    const persona = store.getPersona()
    assert.equal(persona.profileId, 'dsh-pet')
    assert.equal(persona.personaName, 'DSH 蓝发女仆')
    assert.equal(persona.avatarId, 'dsh-pet')
    assert.equal(persona.voiceId, 'qing-wan')
    assert.equal(persona.usageRightConfirmed, false)
    assert.equal(persona.aiLabelVisible, true)
    assert.equal(store.getPlatform().platform, 'douyin')
    assert.equal(store.getPlatform().operatorLoginConfirmedAt, null)
    assert.equal(store.getScene().resolution, '1280x720')
    assert.equal(store.getCloud().provider, '')
    assert.equal(store.getDataUsage().confirmed, false)
    assert.equal(store.getGifts().nameMention, true)
    // 未配置 ⇒ readiness 给单一可操作原因
    const pr = store.personaReady()
    assert.equal(pr.ready, false)
    assert.ok(!pr.ready && pr.reason.includes('主播形象未配置'))
    const pl = store.platformReady()
    assert.equal(pl.ready, false)
    assert.ok(!pl.ready && pl.reason.includes('直播接入未配置'))
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：round-trip 持久化 + 部分更新语义 + 就绪翻转', () => {
  const { store, db, dataDir } = makeStore()
  try {
    store.savePersona({ usageRightConfirmed: true, avatarId: 'fish-night' })
    // 部分更新：只改声音，其余保持
    store.savePersona({ voiceId: 'chen-lang' })
    const persona = store.getPersona()
    assert.equal(persona.avatarId, 'dsh-pet')
    assert.equal(persona.voiceId, 'chen-lang')
    assert.equal(persona.usageRightConfirmed, true)
    assert.equal(store.personaReady().ready, true)

    store.savePlatform({ operatorLoginConfirmedAt: '2026-11-12T10:00:00Z', operationMode: 'human_driven' })
    const platform = store.getPlatform()
    assert.equal(platform.operationMode, 'human_driven')
    assert.equal(store.platformReady().ready, true)

    // 同一 DB 重新打开（重启保留）
    const reopened = new SettingsStore(db)
    assert.equal(reopened.getPersona().personaName, 'DSH 蓝发女仆')
    assert.equal(reopened.getPersona().usageRightConfirmed, true)
    assert.equal(reopened.platformReady().ready, true)
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：AI 标识不可关闭——写 false 被拒并给中文单一原因', () => {
  const { store, db, dataDir } = makeStore()
  try {
    assert.throws(
      () => store.savePersona({ aiLabelVisible: false as unknown as boolean }),
      (err: unknown) => {
        assert.ok(err instanceof SettingsValidationError)
        assert.ok(err.issues.some((i) => i.includes('AI 标识不可关闭')))
        return true
      },
    )
    // 隐私下限同样不可放宽
    assert.throws(
      () => store.saveDataUsage({ profileTrainingDenied: false as unknown as boolean }),
      (err: unknown) => {
        assert.ok(err instanceof SettingsValidationError)
        return true
      },
    )
    assert.equal(store.getPersona().aiLabelVisible, true)
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：字段校验失败给出可读 issues；损坏行回落默认值', () => {
  const { store, db, dataDir } = makeStore()
  try {
    assert.throws(
      () => store.savePersona({ personaName: '' }),
      (err: unknown) => {
        assert.ok(err instanceof SettingsValidationError)
        assert.ok(err.issues.some((i) => i.includes('主播名称不能为空')))
        return true
      },
    )
    assert.throws(() => store.saveScene({ resolution: '4k' as unknown as string }))
    assert.throws(() => store.saveCloud({ dailyBudgetCny: -5 }))

    // 损坏行不阻断读取（回落默认），保存覆盖修复
    db.prepare(`INSERT INTO operator_settings (key, value, updated_at) VALUES ('scene', '{oops', 'x')`).run()
    assert.equal(store.getScene().resolution, '1280x720')
    store.saveScene({ title: '修复后的直播间' })
    assert.equal(store.getScene().title, '修复后的直播间')
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：目录与迁移 009 生效（operator_settings 表存在）', () => {
  const { store, db, dataDir } = makeStore()
  try {
    assert.ok(BUILTIN_AVATARS.length === 1)
    assert.ok(BUILTIN_VOICES.length >= 4)
    // 桌宠形象排在目录首位、默认选中，且带 style 标记
    assert.equal(BUILTIN_AVATARS[0]?.id, 'dsh-pet')
    assert.equal(BUILTIN_AVATARS[0]?.style, 'deskpet')
    assert.ok(BUILTIN_AVATARS.some((a) => a.style === 'deskpet' && a.label.includes('蓝发女仆')))
    store.saveGifts({ nameMention: false })
    const row = db.prepare(`SELECT value FROM operator_settings WHERE key = 'gifts'`).get() as { value: string }
    assert.equal((JSON.parse(row.value) as { nameMention: boolean }).nameMention, false)
    const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = 9').get()
    assert.ok(applied !== undefined)
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：角色档案目录（鹅次元角色 + 桌宠，形象版本不重复列出）', () => {
  assert.equal(BUILTIN_PROFILES.length, 5)
  const eciyuan = BUILTIN_PROFILES.filter((p) => p.source === 'eciyuan')
  assert.equal(eciyuan.length, 4)
  assert.deepEqual(eciyuan.map((p) => p.name), ['夏夏', '沈露白', '谷雨', '贝拉'])
  // 官网档案字段齐备（中文名/英文名/#标签/年龄/身高/星座/MBTI）
  for (const p of BUILTIN_PROFILES) {
    assert.ok(p.name.length > 0)
    assert.ok(p.enName.length > 0)
    assert.ok(p.tagline.length > 0)
    assert.ok(p.age && p.height && p.zodiac && p.mbti)
  }
  const pet = BUILTIN_PROFILES.find((p) => p.id === 'dsh-pet')
  assert.ok(pet !== undefined)
  assert.equal(pet?.source, 'plugin')
  assert.equal(pet?.style, 'deskpet')
  assert.equal(pet?.name, 'DSH 蓝发女仆')
  assert.equal(resolveProfile('xiaxia-3d').id, 'xiaxia')
  // 未知 id 回落 dsh-pet
  assert.equal(resolveProfile('does-not-exist').id, 'dsh-pet')
})

test('settings：已保存的澜序选择归入夏夏的三维形象，保留自定义设置', () => {
  const { store, db, dataDir } = makeStore()
  try {
    const migrated = store.savePersona({
      profileId: 'lanxu', personaName: '澜序', usageRightConfirmed: true, samplePhrase: '大家好',
    })
    assert.equal(migrated.profileId, 'xiaxia')
    assert.equal(migrated.appearance, 'rigged')
    assert.equal(store.getPersonaProfile().media?.modelId, 'xiaxia-3d')
    assert.equal(migrated.personaName, '夏夏')
    assert.equal(migrated.usageRightConfirmed, true)
    assert.equal(migrated.samplePhrase, '大家好')
    assert.equal(store.savePersona({ personaName: '我的主播' }).personaName, '我的主播')
    assert.equal(resolveProfile('xiaxia').name, '夏夏')
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：切换 role profile 后 getPersonaProfile 跟随选中档案且持久化', () => {
  const { store, db, dataDir } = makeStore()
  try {
    assert.equal(store.getPersonaProfile().id, 'dsh-pet')
    store.savePersona({ profileId: 'xiaxia' })
    assert.equal(store.getPersona().profileId, 'xiaxia')
    const profile = store.getPersonaProfile()
    assert.equal(profile.id, 'xiaxia')
    assert.equal(profile.name, '夏夏')
    assert.equal(profile.enName, 'XIAXIA')
    assert.equal(profile.tagline, '新传专业大二学生')
    assert.equal(profile.source, 'eciyuan')
    // 重启后仍保留
    assert.equal(new SettingsStore(db).getPersonaProfile().id, 'xiaxia')
    // 非法 profileId 被 schema 拒绝
    assert.throws(() => store.savePersona({ profileId: 'unknown' as unknown as string }), SettingsValidationError)
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('settings：云端自定义端点——合法 URL 可存、非法被拒、部分更新保留', () => {
  const { store, db, dataDir } = makeStore()
  try {
    assert.equal(store.getCloud().baseUrl, '')
    store.saveCloud({ provider: 'tokenhub', baseUrl: 'https://tokenhub.tencentmaas.com/v1' })
    assert.equal(store.getCloud().baseUrl, 'https://tokenhub.tencentmaas.com/v1')
    assert.equal(store.getCloud().provider, 'tokenhub')
    // 部分更新不丢端点
    store.saveCloud({ model: 'hy4' })
    assert.equal(store.getCloud().baseUrl, 'https://tokenhub.tencentmaas.com/v1')
    assert.equal(store.getCloud().model, 'hy4')
    // 非法 URL 被拒（中文原因）
    assert.throws(
      () => store.saveCloud({ baseUrl: 'not a url' }),
      (err: unknown) => {
        assert.ok(err instanceof SettingsValidationError)
        assert.ok(err.issues.some((i) => i.includes('有效 URL')))
        return true
      },
    )
  } finally {
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('catalogs：云端服务商预设——混元/DeepSeek 端点解析与未命中回落', () => {
  // 预设含腾讯云混元（OpenAI 兼容端点），模型名非空
  const hunyuan = CLOUD_PROVIDER_PRESETS.find((p) => p.id === 'tencent-hunyuan')
  assert.ok(hunyuan !== undefined, '应内置腾讯云混元预设')
  assert.equal(hunyuan?.baseUrl, 'https://api.hunyuan.cloud.tencent.com/v1')
  assert.ok((hunyuan?.models.length ?? 0) > 0)
  // 预设命中 → 内置端点；未命中（自定义）→ null（仍需环境变量提供端点）
  assert.equal(resolveCloudBaseUrl('tencent-hunyuan'), 'https://api.hunyuan.cloud.tencent.com/v1')
  assert.equal(resolveCloudBaseUrl(' deepseek '), 'https://api.deepseek.com/v1')
  assert.equal(resolveCloudBaseUrl('my-own-gateway'), null)
  assert.equal(resolveCloudBaseUrl(''), null)
})

test('settings：云端密钥界面维护——保存/掩码/清除与 env 优先', () => {
  const { store, db, dataDir } = makeStore()
  const previous = process.env.DAFEIYU_CLOUD_API_KEY
  delete process.env.DAFEIYU_CLOUD_API_KEY
  try {
    assert.equal(store.getCloudKeyStatus().source, 'none')
    store.saveCloudKey('sk-live-abcd1234')
    const status = store.getCloudKeyStatus()
    assert.equal(status.source, 'ui')
    assert.equal(status.masked, 'sk-••••1234')
    assert.ok(status.updatedAt !== null)
    // 原文只经装配取用；重启保留
    assert.equal(store.getCloudSecretRaw(), 'sk-live-abcd1234')
    assert.equal(new SettingsStore(db).getCloudKeyStatus().masked, 'sk-••••1234')
    // 环境变量优先展示
    process.env.DAFEIYU_CLOUD_API_KEY = 'env-key-987654321' // dsh-skip-sensitive
    const envFirst = store.getCloudKeyStatus()
    assert.equal(envFirst.source, 'env')
    assert.equal(envFirst.masked, 'env••••4321')
    // 清除只影响界面值
    store.clearCloudKey()
    assert.equal(store.getCloudSecretRaw(), '')
    assert.equal(store.getCloudKeyStatus().source, 'env')
    delete process.env.DAFEIYU_CLOUD_API_KEY
    assert.equal(store.getCloudKeyStatus().source, 'none')
    // 空密钥被拒（给中文单一原因）
    assert.throws(
      () => store.saveCloudKey('   '),
      (err: unknown) => {
        assert.ok(err instanceof SettingsValidationError)
        assert.ok(err.issues.some((i) => i.includes('请输入密钥')))
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.DAFEIYU_CLOUD_API_KEY
    else process.env.DAFEIYU_CLOUD_API_KEY = previous
    db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('配置备份：跨存储恢复六节，不导出密钥；重置授权与云端开关', () => {
  const source = makeStore(), target = makeStore()
  try {
    source.store.savePersona({ personaName: '测试主播', usageRightConfirmed: true })
    source.store.savePlatform({ roomUrl: 'https://live.douyin.com/123', operatorLoginConfirmedAt: '2026-11-12T10:00:00Z' })
    source.store.saveScene({ title: '恢复的画面' })
    source.store.saveCloud({ enabled: true, model: 'custom-model' })
    source.store.saveDataUsage({ confirmed: true })
    source.store.saveGifts({ nameMention: false })
    source.store.saveCloudKey('source-secret-123456')
    target.store.saveCloudKey('target-secret-654321')
    const backup = source.store.exportBackup()
    assert.ok(!JSON.stringify(backup).includes('secret'))
    const before = target.store.exportBackup()
    target.store.validateBackup(backup)
    assert.deepEqual(target.store.exportBackup().sections, before.sections)
    target.store.importBackup(backup)
    assert.equal(target.store.getPersona().personaName, '测试主播')
    assert.equal(target.store.getScene().title, '恢复的画面')
    assert.equal(target.store.getCloud().model, 'custom-model')
    assert.equal(target.store.getGifts().nameMention, false)
    assert.equal(target.store.getPersona().usageRightConfirmed, false)
    assert.equal(target.store.getPlatform().operatorLoginConfirmedAt, null)
    assert.equal(target.store.getDataUsage().confirmed, false)
    assert.equal(target.store.getCloud().enabled, false)
    assert.equal(target.store.getCloudSecretRaw(), 'target-secret-654321')
    assert.equal(new SettingsStore(target.db).getScene().title, '恢复的画面')
  } finally {
    for (const fixture of [source, target]) { fixture.db.close(); rmSync(fixture.dataDir, { recursive: true, force: true }) }
  }
})

test('配置备份：非法版本、秘密、未知字段、缺节、隐私与 AI 标识篡改均拒绝且零写入', () => {
  const { store, db, dataDir } = makeStore()
  try {
    const backup = store.exportBackup()
    const invalid = [null, [], {}, { ...backup, version: 2 }, { ...backup, cloud_secret: { apiKey: 'hidden' } },
      { ...backup, sections: { ...backup.sections, scene: { ...backup.sections.scene, title: '' } } },
      { ...backup, sections: { ...backup.sections, persona: { ...backup.sections.persona, aiLabelVisible: false } } },
      { ...backup, sections: { ...backup.sections, cloud: { ...backup.sections.cloud, apiKey: 'hidden' } } },
      { ...backup, sections: { ...backup.sections, dataUsage: { ...backup.sections.dataUsage, profileTrainingDenied: false } } },
      { ...backup, sections: { persona: backup.sections.persona } }]
    for (const input of invalid) assert.throws(() => store.importBackup(input), SettingsValidationError)
    assert.equal((db.prepare('SELECT count(*) AS n FROM operator_settings').get() as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT count(*) AS n FROM audit').get() as { n: number }).n, 0)
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
})

test('配置备份：写入中途失败时回滚设置与审计', () => {
  const { store, db, dataDir } = makeStore()
  try {
    store.saveScene({ title: '当前设置' })
    const before = db.prepare('SELECT * FROM operator_settings').all()
    const audit = db.prepare('SELECT * FROM audit').all()
    const backup = store.exportBackup()
    backup.sections.scene.title = '即将回滚'
    db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON operator_settings WHEN NEW.key = 'gifts' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    assert.throws(() => store.importBackup(backup), /test failure/)
    assert.deepEqual(db.prepare('SELECT * FROM operator_settings').all(), before)
    assert.deepEqual(db.prepare('SELECT * FROM audit').all(), audit)
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
})


test('settings：横屏舞台公告持久化、部分更新与超长输入保护', () => {
  const { store, db, dataDir } = makeStore()
  try {
    assert.equal(store.getScene().notice, '')
    store.saveScene({ broadcastLayout: 'landscape', notice: '  欢迎来到横屏舞台  ', background: 'night' })
    store.saveScene({ title: '夜航直播间' })
    const reopened = new SettingsStore(db)
    assert.equal(reopened.getScene().broadcastLayout, 'landscape')
    assert.equal(reopened.getScene().notice, '欢迎来到横屏舞台')
    assert.equal(reopened.getScene().background, 'night')
    assert.throws(() => store.saveScene({ notice: '字'.repeat(301) }))
    assert.equal(store.getScene().notice, '欢迎来到横屏舞台')
    store.saveScene({ broadcastLayout: 'portrait', notice: '' })
    assert.equal(store.getScene().notice, '')
  } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
})
