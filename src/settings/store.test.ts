import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase } from '../storage/db.ts'
import {
  BUILTIN_AVATARS,
  BUILTIN_VOICES,
  BUILTIN_PROFILES,
  resolveProfile,
  SettingsStore,
  SettingsValidationError,
} from './store.ts'

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
    assert.equal(persona.personaName, '大肥鱼')
    assert.equal(persona.avatarId, 'fish-deskpet')
    assert.equal(persona.voiceInteractionEnabled, true)
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
    assert.equal(persona.avatarId, 'fish-night')
    assert.equal(persona.voiceId, 'chen-lang')
    assert.equal(persona.usageRightConfirmed, true)
    assert.equal(store.personaReady().ready, true)

    store.savePlatform({ operatorLoginConfirmedAt: '2026-11-12T10:00:00Z', operationMode: 'human_driven' })
    const platform = store.getPlatform()
    assert.equal(platform.operationMode, 'human_driven')
    assert.equal(store.platformReady().ready, true)

    // 同一 DB 重新打开（重启保留）
    const reopened = new SettingsStore(db)
    assert.equal(reopened.getPersona().personaName, '大肥鱼')
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
    assert.ok(BUILTIN_AVATARS.length >= 3)
    assert.ok(BUILTIN_VOICES.length >= 4)
    // 桌宠形象排在目录首位、默认选中，且带 style 标记
    assert.equal(BUILTIN_AVATARS[0]?.id, 'fish-deskpet')
    assert.equal(BUILTIN_AVATARS[0]?.style, 'deskpet')
    assert.ok(BUILTIN_AVATARS.some((a) => a.style === 'deskpet' && a.label.includes('桌宠')))
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

test('settings：角色档案目录（鹅次元角色 + dsh-pet 插件中档案）', () => {
  // 5 个档案：4 个鹅次元官网角色 + 1 个本插件内的 dsh-pet 桌宠档案
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
  assert.equal(pet?.name, '大肥鱼')
  // 未知 id 回落 dsh-pet
  assert.equal(resolveProfile('does-not-exist').id, 'dsh-pet')
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
