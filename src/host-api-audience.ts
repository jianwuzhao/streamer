/**
 * 观众与治理 GET 路由（§6.4 管理入口 / §24.2 高级设置）：
 * audience/overview、audience/profile（隔离读取）、
 * governance/skills|memory|releases|audit。
 * 命中路径自行写响应并返回 true；未命中返回 false 交回主入口。
 */
import type { DafeiyuPluginHandle } from './index.ts'
import { all, get } from './storage/db.ts'
import { json, type ServerResponse } from './host-api-shared.ts'

interface ViewerProfileRow {
  readonly viewer_key: string
  readonly display_nickname: string | null
  readonly first_seen_at: string | null
  readonly last_seen_at: string | null
  readonly deletion_status: string
}

interface PrivacyRequestRow {
  readonly request_id: string
  readonly viewer_key: string
  readonly kind: string
  readonly status: string
  readonly created_at: string
  readonly resolved_at: string | null
}

interface SkillVersionRow {
  readonly skill_id: string
  readonly version: string
  readonly status: string
  readonly manifest: string
  readonly package_path: string
  readonly created_at: string
}

interface MemoryCandidateRow {
  readonly id: string
  readonly revision: number
  readonly layer: string
  readonly namespace: string
  readonly claim: string
  readonly kind: string
  readonly scene: string
  readonly supporting_evidence: string
  readonly counter_evidence: string
  readonly status: string
  readonly review_after: string
  readonly updated_at: string
}

interface ReleaseRow {
  readonly release_id: string
  readonly status: string
  readonly canary_fraction: number
  readonly created_at: string
  readonly activated_at: string | null
}

interface AuditRow {
  readonly audit_id: number
  readonly action: string
  readonly summary: string
  readonly created_at: string
}

interface DecisionRow {
  readonly decision_id: string
  readonly actor: string
  readonly action: string
  readonly result: string
  readonly created_at: string
}

export function handleAudienceGetRoute(
  handle: DafeiyuPluginHandle,
  path: string,
  query: URLSearchParams,
  res: ServerResponse,
): boolean {
  if (path === 'audience/overview') {
    const viewers = all<ViewerProfileRow>(
      handle.db,
      `SELECT viewer_key, display_nickname, first_seen_at, last_seen_at, deletion_status
       FROM viewer_profiles ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 30`,
    )
    const requests = all<PrivacyRequestRow>(
      handle.db,
      `SELECT request_id, viewer_key, kind, status, created_at, resolved_at
       FROM privacy_requests ORDER BY created_at DESC LIMIT 20`,
    )
    const tombstones = get<{ n: number }>(handle.db, 'SELECT COUNT(*) AS n FROM deletion_tombstones')?.n ?? 0
    json(res, 200, {
      ok: true,
      viewers: viewers.map((v) => ({
        viewerKey: v.viewer_key,
        nickname: v.display_nickname,
        firstSeenAt: v.first_seen_at,
        lastSeenAt: v.last_seen_at,
        deletionStatus: v.deletion_status,
      })),
      requests,
      tombstoneCount: tombstones,
      notes: [
        'viewer_key 为 HMAC 伪名化键：昵称变化不换身份、跨平台不合并；伪名化不等于匿名化',
        '删除为两步：先提交申请（received），验证身份后才执行落墓碑',
        '退出个性化保留字段但 purpose 过滤生效（服务与安全事件仍维护）',
      ],
    })
    return true
  }

  if (path === 'audience/profile') {
    const viewerKey = query.get('viewer') ?? ''
    if (viewerKey === '') {
      json(res, 400, { ok: false, error: '缺少 viewer 参数' })
      return true
    }
    const summary = handle.audience.profiles.profileSummary(viewerKey)
    // 画像隔离读取（§20.2）：仅该 viewerKey 的当前有效字段；墓碑优先于任何读取
    const fields = handle.audience.profiles.currentFields(viewerKey)
    const interactions = handle.audience.profiles.aggregateInteractionCounts(viewerKey)
    const requests = all<PrivacyRequestRow>(
      handle.db,
      `SELECT request_id, viewer_key, kind, status, created_at, resolved_at
       FROM privacy_requests WHERE viewer_key = ? ORDER BY created_at DESC LIMIT 10`,
      viewerKey,
    )
    json(res, 200, { ok: true, summary, fields, interactions, requests })
    return true
  }

  if (path === 'governance/skills') {
    const rows = all<SkillVersionRow>(
      handle.db,
      `SELECT skill_id, version, status, manifest, package_path, created_at
       FROM skill_versions ORDER BY skill_id, created_at DESC LIMIT 100`,
    )
    json(res, 200, {
      ok: true,
      skills: rows.map((r) => {
        let manifest: Record<string, unknown> = {}
        try {
          manifest = JSON.parse(r.manifest) as Record<string, unknown>
        } catch { /* 坏 manifest 如实置空 */ }
        return {
          skillId: r.skill_id,
          version: r.version,
          status: r.status,
          kind: typeof manifest.kind === 'string' ? manifest.kind : null,
          description: typeof manifest.description === 'string' ? manifest.description : null,
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions.length : 0,
          packagePath: r.package_path,
          createdAt: r.created_at,
        }
      }),
    })
    return true
  }

  if (path === 'governance/memory') {
    const rows = all<MemoryCandidateRow>(
      handle.db,
      `SELECT id, revision, layer, namespace, claim, kind, scene,
              supporting_evidence, counter_evidence, status, review_after, updated_at
       FROM memory_candidates ORDER BY updated_at DESC LIMIT 50`,
    )
    json(res, 200, {
      ok: true,
      memories: rows.map((r) => ({
        id: r.id,
        revision: r.revision,
        layer: r.layer,
        namespace: r.namespace,
        claim: r.claim,
        kind: r.kind,
        scene: r.scene,
        supportingEvidence: JSON.parse(r.supporting_evidence) as unknown[],
        counterEvidence: JSON.parse(r.counter_evidence) as unknown[],
        status: r.status,
        reviewAfter: r.review_after,
        updatedAt: r.updated_at,
      })),
      notes: ['L2 假设需 ≥2 独立证据；矛盾双方 challenged，不呈现为确定事实；查询时过期即失效'],
    })
    return true
  }

  if (path === 'governance/releases') {
    const rows = all<ReleaseRow>(
      handle.db,
      `SELECT release_id, status, canary_fraction, created_at, activated_at
       FROM releases ORDER BY created_at DESC LIMIT 30`,
    )
    json(res, 200, { ok: true, activeReleaseId: handle.governance.releases.activeReleaseId(), releases: rows })
    return true
  }

  if (path === 'governance/audit') {
    const audits = all<AuditRow>(handle.db, `SELECT audit_id, action, summary, created_at FROM audit ORDER BY audit_id DESC LIMIT 50`)
    const decisions = all<DecisionRow>(
      handle.db,
      `SELECT decision_id, actor, action, result, created_at FROM decisions ORDER BY created_at DESC LIMIT 20`,
    )
    json(res, 200, {
      ok: true,
      audits,
      decisions,
      notes: ['审计不含观众直接标识与凭据；决策含 payloadHash 绑定与治理 epoch'],
    })
    return true
  }

  return false
}
