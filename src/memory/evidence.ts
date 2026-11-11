/**
 * 独立证据判定（方案 §5.2）。
 *
 * 至少两个独立证据事件才能进入自动验证；去重簇、同一账号刷屏和模型复述
 * 不算独立证据。该数量只是最小采样门槛，仍需来源与语义校验。
 */
export interface EvidenceRef {
  readonly eventId: string
  /** 事件归属观众（同观众多事件按独立来源计 1） */
  readonly viewerKey?: string
  /** 去重簇 ID（近重复文本合簇后同簇计 1） */
  readonly clusterId?: string
  /** 同源派生标记（模型复述/派生摘要 → 指向原始证据） */
  readonly derivedFrom?: string
}

export interface IndependenceVerdict {
  /** 计入独立证据的事件 */
  readonly independent: readonly EvidenceRef[]
  /** 被排除的事件及原因 */
  readonly rejected: readonly { readonly ref: EvidenceRef; readonly reason: string }[]
}

/**
 * 独立性分组：同一观众、同一近重复簇、同一派生来源各自只计一次。
 * 归并优先级：派生来源 > 去重簇 > 观众。
 */
export function countIndependentEvidence(refs: readonly EvidenceRef[]): IndependenceVerdict {
  const independent: EvidenceRef[] = []
  const rejected: { ref: EvidenceRef; reason: string }[] = []
  const seenOrigins = new Set<string>()
  const seenClusters = new Set<string>()
  const seenViewers = new Set<string>()
  /** 已计入独立证据的事件本体（派生/重复判定基准） */
  const countedEventIds = new Set<string>()

  const accept = (ref: EvidenceRef): void => {
    independent.push(ref)
    countedEventIds.add(ref.eventId)
  }

  for (const ref of refs) {
    if (ref.derivedFrom !== undefined) {
      if (seenOrigins.has(ref.derivedFrom) || countedEventIds.has(ref.derivedFrom)) {
        rejected.push({ ref, reason: `同源派生（derivedFrom=${ref.derivedFrom}）` })
        continue
      }
      seenOrigins.add(ref.derivedFrom)
      accept(ref)
      continue
    }
    if (ref.clusterId !== undefined) {
      if (seenClusters.has(ref.clusterId)) {
        rejected.push({ ref, reason: `同去重簇（clusterId=${ref.clusterId}）` })
        continue
      }
      seenClusters.add(ref.clusterId)
      accept(ref)
      continue
    }
    if (ref.viewerKey !== undefined) {
      if (seenViewers.has(ref.viewerKey)) {
        rejected.push({ ref, reason: `同一账号多事件（viewerKey=${ref.viewerKey}）` })
        continue
      }
      seenViewers.add(ref.viewerKey)
      accept(ref)
      continue
    }
    if (countedEventIds.has(ref.eventId)) {
      rejected.push({ ref, reason: '重复事件' })
      continue
    }
    accept(ref)
  }
  return { independent, rejected }
}

export const MIN_INDEPENDENT_EVIDENCE = 2
