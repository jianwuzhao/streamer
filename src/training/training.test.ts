import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { loadConfig, getFeatureGates } from '../config.ts'
import { PolicyService } from '../governance/policy-decision.ts'
import { FakeProbeHandle } from '../testing/fake-probe.ts'
import { ResourceArbiter } from '../resources/arbiter.ts'
import { makeTmpDb } from '../testing/helpers.ts'
import { TrainingSamplePipeline, redact } from './samples.ts'
import { TrainingScheduler } from './scheduler.ts'
import { runTrainingWorker, type TrainingJobSpec } from './worker.ts'

// ---------------------------------------------------------------------------

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function makeJobSpec(over: Partial<TrainingJobSpec> = {}): TrainingJobSpec {
  return {
    run_id: 'run_it_1',
    mode: 'dry_run',
    base_profile: 'main-4b',
    max_steps: 4,
    wall_budget_s: 60,
    samples: [{ text: '样本' }, { text: '样本' }, { text: '样本' }, { text: '样本' }],
    replay_fraction: 0.7,
    checkpoint_dir: `${makeTmpDb().dir}/ckpt`,
    resume_from: null,
    decision: {
      id: 'dec_1',
      action: 'train',
      payloadHash: 'h',
      epoch: 0,
      expiresAt: futureIso(3600),
      result: 'allow',
    },
    ...over,
  }
}

test('样本管道：脱敏（伪名/手机号/长数字不入参数）', () => {
  const out = redact('观众 vw_aabbccddeeff0011 问 13812345678 的账号 1234567890123456 是什么')
  assert.ok(!out.includes('vw_aabbccddeeff0011'))
  assert.ok(!out.includes('13812345678'))
  assert.ok(out.includes('[viewer]'))
  assert.ok(out.includes('[phone]') || out.includes('[id]'))
})

test('样本管道：用途不允许/第三方无来源/空文本均拒绝', () => {
  const t = makeTmpDb()
  try {
    const pipeline = new TrainingSamplePipeline(t.db)
    assert.equal(pipeline.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: false, text: '内容', sessionId: 's' }).rejected, 'purpose_not_allowed')
    assert.equal(pipeline.ingest({ sourceKind: 'allowed_third_party', purposeAllowed: true, text: '内容', sessionId: 's' }).rejected, 'third_party_not_allowed')
    assert.equal(pipeline.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: true, text: 'ab', sessionId: 's' }).rejected, 'empty_text')
  } finally {
    t.cleanup()
  }
})

test('样本管道：相同文本同簇；heldout 不进批量；样本不足报错', () => {
  const t = makeTmpDb()
  try {
    const pipeline = new TrainingSamplePipeline(t.db)
    const a = pipeline.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: true, text: '种田片段先简短回应催促再说明动作', sessionId: 's1' })
    const b = pipeline.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: true, text: '种田片段先简短回应催促再说明动作', sessionId: 's2' })
    assert.equal(a.clusterId, b.clusterId) // 近重复（相同文本）同簇，不受场次影响
    for (let i = 0; i < 40; i++) {
      pipeline.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: true, text: `第 ${i} 条完全不同的有效样本内容 ${i * 7}`, sessionId: `sess-${i % 6}` })
    }
    // heldout 存在且不参与批量
    const heldout = t.db.prepare(`SELECT COUNT(*) AS n FROM training_samples WHERE split='heldout'`).get() as { n: number }
    assert.ok(heldout.n > 0, '应有冻结测试集')
    const batch = pipeline.buildBatch({ minNewEligible: 30, replayFraction: 0.7, maxPerCluster: 3, maxPerSession: 5 })
    assert.ok('sampleIds' in batch)
    if ('sampleIds' in batch) {
      assert.ok(batch.sampleIds.length > 0)
      const held = t.db.prepare(
        `SELECT COUNT(*) AS n FROM training_samples WHERE split='heldout' AND sample_id IN (${batch.sampleIds.map(() => '?').join(',')})`,
      ).get(...batch.sampleIds) as { n: number }
      assert.equal(held.n, 0)
    }
    // 不足
    const insufficient = pipeline.buildBatch({ minNewEligible: 999, replayFraction: 0.7, maxPerCluster: 3, maxPerSession: 5 })
    assert.ok('error' in insufficient && insufficient.error === 'insufficient_new_samples')
  } finally {
    t.cleanup()
  }
})

test('worker 集成：真实 Python dry-run 状态机回执', async () => {
  const tmp = makeTmpDb()
  try {
    const spec = makeJobSpec({ checkpoint_dir: `${tmp.dir}/ckpt` })
    const { events, receipt, exitCode } = await runTrainingWorker(spec, {
      cwd: resolve(process.cwd(), 'training-worker'),
      timeoutMs: 30_000,
    })
    assert.equal(exitCode, 0)
    assert.equal(receipt?.state, 'completed')
    assert.equal(receipt?.steps, 4)
    assert.equal(receipt?.params_changed, true)
    assert.ok(receipt?.checkpoint_id.startsWith('ckpt_'))
    const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state)
    assert.deepEqual(states, [
      'prepare_cpu', 'drain_gpu', 'train_slice', 'checkpoint', 'release_gpu', 'warmup_champion',
    ])
  } finally {
    tmp.cleanup()
  }
})

test('worker 集成：授权拒绝（退出码 2）→ 回执 failed', async () => {
  const tmp = makeTmpDb()
  try {
    const spec = makeJobSpec({
      checkpoint_dir: `${tmp.dir}/ckpt`,
      decision: {
        id: 'dec_1',
        action: 'train',
        payloadHash: 'h',
        epoch: 0,
        expiresAt: futureIso(3600),
        result: 'deny',
      },
    })
    const { receipt, exitCode } = await runTrainingWorker(spec, {
      cwd: resolve(process.cwd(), 'training-worker'),
      timeoutMs: 30_000,
    })
    assert.equal(exitCode, 2)
    assert.equal(receipt?.state, 'failed')
    assert.ok(receipt?.error?.includes('授权'))
  } finally {
    tmp.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 调度器

function makeSchedulerEnv() {
  const t = makeTmpDb()
  const config = loadConfig(resolve(process.cwd(), 'config/default.yaml'))
  config.training.dailyTrainingMinutesBudget = 60 // 打开训练窗口
  config.training.minNewEligibleSamples = 4
  const featureGates = getFeatureGates(config)
  const arbiter = new ResourceArbiter(new FakeProbeHandle({ timestampMs: 1, freeVramMb: 8000 }))
  arbiter.start() // 立即采样一次，使资源门有最新读数
  const policy = new PolicyService(t.db, { policyVersion: 'pv-d' })
  const samples = new TrainingSamplePipeline(t.db)
  return { t, db: t.db, config, featureGates, arbiter, policy, samples }
}

test('调度器：训练禁用（默认 null 预算）→ training_disabled', () => {
  const t = makeTmpDb()
  try {
    const config = loadConfig(resolve(process.cwd(), 'config/default.yaml'))
    const scheduler = new TrainingScheduler({
      db: t.db,
      config,
      featureGates: getFeatureGates(config),
      arbiter: new ResourceArbiter(new FakeProbeHandle({ timestampMs: 1, freeVramMb: 8000 })),
      policy: new PolicyService(t.db, { policyVersion: 'pv' }),
      samples: new TrainingSamplePipeline(t.db),
      championReleaseId: 'rel-champ',
    })
    const v = scheduler.evaluateOpportunity()
    assert.ok(!v.admit && v.reason === 'training_disabled')
  } finally {
    t.cleanup()
  }
})

test('调度器：样本不足 / 显存不足（探测不可用 fail-safe）', async () => {
  const env = makeSchedulerEnv()
  try {
    const s1 = new TrainingScheduler({ ...env, championReleaseId: 'rel' })
    const v1 = s1.evaluateOpportunity()
    assert.ok(!v1.admit && v1.reason === 'insufficient_samples')

    for (let i = 0; i < 6; i++) {
      env.samples.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: true, text: `样本内容 ${i} 各不相同`, sessionId: `s-${i}` })
    }
    const noVram = new TrainingScheduler({ ...env, arbiter: new ResourceArbiter(new FakeProbeHandle(null)), championReleaseId: 'rel' })
    const v2 = noVram.evaluateOpportunity()
    assert.ok(!v2.admit && v2.reason === 'insufficient_vram')
  } finally {
    env.t.cleanup()
  }
})

test('调度器：完整 dry-run 窗口（资源门+政策授权+真实 worker）→ champion 不变、检查点落库、断点续跑', async () => {
  const env = makeSchedulerEnv()
  process.env.DAFEIYU_DATA_DIR = env.t.dir
  try {
    for (let i = 0; i < 6; i++) {
      env.samples.ingest({ sourceKind: 'verified_local_reply', purposeAllowed: true, text: `训练样本 ${i} 内容互不相同 ${i * 3}`, sessionId: `s-${i}` })
    }
    await env.arbiter.sampleOnce() // 资源门需要最新读数（start 的首次采样是异步的）
    const scheduler = new TrainingScheduler({
      ...env,
      championReleaseId: 'rel-champion-1',
      workerCwd: resolve(process.cwd(), 'training-worker'),
    })
    const first = await scheduler.executeWindow({ mode: 'dry_run' })
    assert.ok(first.verdict.admit, JSON.stringify(first.verdict))
    assert.equal(first.receipt?.state, 'completed')
    assert.ok((first.receipt?.steps ?? 0) > 0)
    assert.ok(first.checkpointId)

    const runRow = env.t.db
      .prepare('SELECT status, optimizer_steps, champion_release_id FROM training_runs ORDER BY started_at DESC LIMIT 1')
      .get() as { status: string; optimizer_steps: number; champion_release_id: string }
    assert.equal(runRow.status, 'completed')
    assert.ok(runRow.optimizer_steps > 0)
    assert.equal(runRow.champion_release_id, 'rel-champion-1') // champion 全程不动

    const ckpt = env.t.db
      .prepare('SELECT checkpoint_id, steps FROM checkpoints ORDER BY created_at DESC LIMIT 1')
      .get() as { checkpoint_id: string; steps: number }
    assert.ok(ckpt.checkpoint_id.startsWith('ckpt_'))

    // 断点续跑：第二个窗口从上一检查点续（步数累积）
    const second = await scheduler.executeWindow({ mode: 'dry_run' })
    assert.equal(second.receipt?.state, 'completed')
    assert.ok((second.receipt?.steps ?? 0) > (first.receipt?.steps ?? 0), `${JSON.stringify(second.receipt)} 应大于 ${JSON.stringify(first.receipt)}`)
  } finally {
    delete process.env.DAFEIYU_DATA_DIR
    env.t.cleanup()
  }
})
