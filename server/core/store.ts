import { Database } from 'bun:sqlite'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareHome } from './home.ts'
import { CoreError } from './client.ts'

/** How long a statement waits out another connection's lock. The wait blocks the app's one thread, so it stays short:
 *  a lock that outlasts it fails the statement, which its caller reports or a timer's next tick tries again. */
export const LOCK_WAIT = 1000

/** Shepherdr-owned product records. Process liveness always comes from core, not this store. */
export class CoreStore {
  readonly db: Database
  constructor(readonly home: string) {
    prepareHome(home)
    const path = join(home, 'state.sqlite')
    this.db = new Database(path, { create: true })
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA busy_timeout=${LOCK_WAIT}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,key));
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`)
  }
  // A snapshot reads the same rows thousands of times in one synchronous run. Keep the raw text until the next
  // microtask or write, and parse per call so no caller shares an object.
  // shortcut: writes made straight through `db` don't clear it; they are deletes followed by an emit, never a read in the same run.
  private rows?: { one: Map<string, string | null>; many: Map<string, string[]> }
  private cache() {
    if (!this.rows) { this.rows = { one: new Map(), many: new Map() }; queueMicrotask(() => { this.rows = undefined }) }
    return this.rows
  }
  get<T>(kind: string, key: string): T | undefined {
    const one = this.cache().one, id = `${kind}\0${key}`
    let value = one.get(id)
    if (value === undefined) { value = (this.db.query('SELECT value FROM records WHERE kind=? AND key=?').get(kind, key) as { value: string } | null)?.value ?? null; one.set(id, value) }
    return value === null ? undefined : JSON.parse(value) as T
  }
  all<T>(kind: string): T[] {
    const many = this.cache().many
    let values = many.get(kind)
    if (!values) { values = (this.db.query('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind) as { value: string }[]).map(row => row.value); many.set(kind, values) }
    return values.map(value => JSON.parse(value) as T)
  }
  set(kind: string, key: string, value: unknown) {
    this.rows = undefined
    this.db.query('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value').run(kind, key, JSON.stringify(value))
  }
  delete(kind: string, key: string) { this.rows = undefined; this.db.query('DELETE FROM records WHERE kind=? AND key=?').run(kind, key) }
  next(key: string) {
    return this.db.transaction(() => {
      this.db.query('INSERT INTO counters VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1').run(key)
      return (this.db.query('SELECT value FROM counters WHERE key=?').get(key) as { value: number }).value
    })()
  }
  /** Durable delivery receipts. Losing a response must not repeat a send, merge, or permission answer. */
  async command<T>(id: string, input: unknown, perform: () => Promise<T>): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid command id')
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const claim = this.db.transaction(() => {
      const old = this.db.query('SELECT * FROM commands WHERE id=?').get(id) as { hash: string; result: string | null; error: string | null } | null
      if (old) return old
      this.db.query('INSERT INTO commands(id,hash) VALUES(?,?)').run(id, hash)
      return undefined
    })()
    if (claim) {
      if (claim.hash !== hash) throw new CoreError('conflict', 'Command id belongs to a different action')
      if (claim.error || claim.result === null) throw new CoreError('uncertain', claim.error || 'Command was interrupted; check its outcome')
      return JSON.parse(claim.result) as T
    }
    try {
      const result = await perform()
      this.db.query('UPDATE commands SET result=? WHERE id=?').run(JSON.stringify(result ?? null), id)
      return result
    } catch (error) {
      this.db.query('UPDATE commands SET error=? WHERE id=?').run('Command did not complete normally; check its outcome before retrying', id)
      throw error
    }
  }
  close() { this.db.close() }
}
