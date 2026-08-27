// Test adapter: maps the D1-style interface used by AppStore onto
// node:sqlite (in-memory), so app-layer tests run against real SQL.
import { DatabaseSync } from "node:sqlite";

export interface TestStatement {
  bind(...values: unknown[]): TestStatement;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface TestD1 { prepare(sql: string): TestStatement; }

function toSqlValue(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === null || typeof value === "number" || typeof value === "bigint" || typeof value === "string") return value;
  if (value instanceof Uint8Array) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return String(value);
}

export function sqliteD1(): { db: TestD1; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const db: TestD1 = {
    prepare(sql: string): TestStatement {
      const stmt = raw.prepare(sql);
      let params: unknown[] = [];
      return {
        bind(...values: unknown[]) { params = values; return this; },
        async run() {
          const info = stmt.run(...params.map(toSqlValue));
          return { success: true, meta: { changes: Number(info.changes ?? 0) } };
        },
        async first<T>() { return (stmt.get(...params.map(toSqlValue)) as T | undefined) ?? null; },
        async all<T>() { return { results: stmt.all(...params.map(toSqlValue)) as T[] }; },
      };
    },
  };
  return { db, raw };
}
