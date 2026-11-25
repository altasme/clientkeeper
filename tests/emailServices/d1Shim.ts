// A minimal D1Database stand-in over Node's built-in node:sqlite, so the
// email-services engine's real SQL runs in tests against the real schema.
//
// Faithful where it matters for these tests:
//   - each statement executes atomically (as in D1);
//   - batch() is one transaction, rolled back on any error (as in D1);
//   - every call yields to the event loop first, so concurrent engine calls
//     genuinely interleave between statements. That is what lets the
//     concurrency tests catch a check-then-write race.
// Not a full D1 implementation (no raw(), no dump(), no exec() parity).

import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Value = string | number | bigint | null | Uint8Array;

const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

function toValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || v instanceof Uint8Array) return v;
  throw new Error(`Unsupported bind value: ${typeof v}`);
}

const plain = (row: unknown) => (row ? { ...(row as Record<string, unknown>) } : null);
const hasReturning = (sql: string) => /\bRETURNING\b/i.test(sql);

class ShimStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly args: Value[] = []
  ) {}

  bind(...args: unknown[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, args.map(toValue));
  }

  execSync(): { results: Record<string, unknown>[]; changes: number } {
    const stmt = this.db.prepare(this.sql);
    if (hasReturning(this.sql) || /^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      const rows = stmt.all(...this.args).map((r) => plain(r)!);
      return { results: rows, changes: hasReturning(this.sql) ? rows.length : 0 };
    }
    const r = stmt.run(...this.args);
    return { results: [], changes: Number(r.changes) };
  }

  async first<T>(col?: string): Promise<T | null> {
    await yieldTurn();
    const { results } = this.execSync();
    const row = results[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T>() {
    await yieldTurn();
    const { results, changes } = this.execSync();
    return { results: results as T[], success: true, meta: { changes } };
  }

  async run() {
    await yieldTurn();
    const { results, changes } = this.execSync();
    return { results, success: true, meta: { changes } };
  }
}

export class ShimD1 {
  readonly raw: DatabaseSync;
  constructor(schemaSql: string) {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec(schemaSql);
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw, sql);
  }

  async batch(statements: ShimStatement[]) {
    await yieldTurn();
    this.raw.exec("BEGIN");
    try {
      const out = statements.map((s) => {
        const { results, changes } = s.execSync();
        return { results, success: true, meta: { changes } };
      });
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_SCHEMA_PATH = join(here, "schema.fixture.sql");
// The real canonical schema, when a clienthub checkout sits next to this
// repo (as in the development workspace). Optional.
export const CLIENTHUB_SCHEMA_PATH = process.env.CLIENTHUB_SCHEMA ?? join(here, "..", "..", "..", "clienthub", "d1", "schema.sql");

export function schemaSql(): string {
  if (process.env.EMAIL_TESTS_USE_CLIENTHUB_SCHEMA === "1" && existsSync(CLIENTHUB_SCHEMA_PATH)) return readFileSync(CLIENTHUB_SCHEMA_PATH, "utf8");
  return readFileSync(FIXTURE_SCHEMA_PATH, "utf8");
}

export function newDb(): ShimD1 & D1Database {
  return new ShimD1(schemaSql()) as unknown as ShimD1 & D1Database;
}
