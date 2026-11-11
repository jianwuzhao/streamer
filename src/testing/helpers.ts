/** 测试公共设施：临时数据库与收集型记录器。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDatabase, type DB } from '../storage/db.ts'

export interface TmpDb {
  readonly db: DB
  readonly dir: string
  cleanup(): void
}

export function makeTmpDb(): TmpDb {
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-test-'))
  const db = openDatabase(join(dir, 'test.db'))
  migrate(db)
  return {
    db,
    dir,
    cleanup() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
