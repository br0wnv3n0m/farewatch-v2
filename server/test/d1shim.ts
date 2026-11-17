// Test-only stand-in for Cloudflare D1 on top of Node's built-in SQLite.
// Runs the real migration SQL, so the schema is tested too.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Value = string | number | null;

const returnsRows = (sql: string) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

class Statement {
  db: DatabaseSync;
  sql: string;
  args: Value[];
  constructor(db: DatabaseSync, sql: string, args: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args: unknown[]) {
    for (const a of args) if (a === undefined || typeof a === 'boolean') throw new Error(`D1 would reject bind value ${String(a)} in: ${this.sql}`);
    return new Statement(this.db, this.sql, args as Value[]);
  }
  async first<T>(): Promise<T | null> {
    return ((this.db.prepare(this.sql).get(...this.args) as T) ?? null);
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[], success: true, meta: {} };
  }
  async run() {
    return this.exec();
  }
  exec() {
    const s = this.db.prepare(this.sql);
    if (returnsRows(this.sql)) return { results: s.all(...this.args), success: true, meta: { changes: 0 } };
    const r = s.run(...this.args);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function createD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'));
  const d1 = {
    prepare: (sql: string) => new Statement(db, sql),
    async batch(statements: Statement[]) {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    raw: db,
  };
  return d1 as unknown as D1Database;
}
