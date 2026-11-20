import { get, run, type DB } from '../storage/db.ts'

export interface CloudRequestUsage {
  readonly prompt_tokens?: number
  readonly completion_tokens?: number
  readonly total_tokens?: number
}

const budgetDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' })

function tokens(value: number | undefined): number | null {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : null
}

export class CloudUsageLedger {
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
  }

  reserve(input: { model: string; requestLimit: number; budgetCny: number; inputCeiling: number; outputCeiling: number;
    inputRate: number | null; outputRate: number | null }) {
    const { model, requestLimit, budgetCny, inputCeiling, outputCeiling, inputRate, outputRate } = input
    const estimate = inputRate === null || outputRate === null ? null :
      (inputRate * inputCeiling + outputRate * outputCeiling) / 1_000_000
    const inserted = this.db.prepare(`INSERT INTO cloud_requests (budget_day, model, reserved_cny)
      SELECT ?, ?, ? FROM (SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(cost_cny, reserved_cny)), 0) AS spent
      FROM cloud_requests WHERE budget_day = ?)
      WHERE n < ? AND spent + COALESCE(?, 0) <= ?`)
      .run(budgetDay.format(), model, estimate, budgetDay.format(), requestLimit, estimate, budgetCny)
    if (!inserted.changes) return undefined
    return (usage: CloudRequestUsage | undefined, ok: boolean) => {
      const inputTokens = tokens(usage?.prompt_tokens)
      const outputTokens = tokens(usage?.completion_tokens)
      const total = tokens(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null)
      const cost = inputRate !== null && outputRate !== null && inputTokens !== null && outputTokens !== null
        ? (inputRate * inputTokens + outputRate * outputTokens) / 1_000_000 : null
      run(this.db, `UPDATE cloud_requests SET status = ?, tokens_in = ?, tokens_out = ?, tokens_total = ?,
        cost_cny = ? WHERE id = ?`, ok ? 'responded' : 'failed', inputTokens, outputTokens, total, cost, inserted.lastInsertRowid)
    }
  }

  today() {
    return get<{ requests: number; tokens: number | null; estimatedCostCny: number | null; unknownCostRequests: number }>(
      this.db, `SELECT COUNT(*) AS requests, SUM(tokens_total) AS tokens, SUM(cost_cny) AS estimatedCostCny,
      COUNT(*) - COUNT(cost_cny) AS unknownCostRequests FROM cloud_requests WHERE budget_day = ?`,
      budgetDay.format())!
  }
}
