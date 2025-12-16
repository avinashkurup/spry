// code-shell-serde.ts
import { parse as parseYaml } from "@std/yaml";
import {
  defineLanguageInitCatalog,
  duckdbEngine,
  duckdbInit,
  type EngineTagged,
  type ExecutionMode,
  type LanguageEngine,
  type LanguageInitBase,
  type LanguageInitCatalog,
  type LanguageInput,
  type LanguageSpawnResult,
  LanguageSpawnShell,
  pgInit,
  psqlEngine,
  sqlite3Engine,
  sqliteInit,
} from "./code-shell.ts";
import { shell as createShell } from "./shell.ts";

/**
 * Parse a YAML catalog definition (or already-parsed object) into a
 * LanguageInitCatalog compatible with code-shell.ts engines.
 *
 * Expected YAML shape (either top-level or nested under `catalog:`):
 *
 * ```yaml
 * catalog:
 *   pg_local:
 *     engine: postgres
 *     host: 127.0.0.1
 *     port: "5432"
 *     user: app
 *     dbname: appdb
 *     # optional:
 *     password: ${NOT_RECOMMENDED_IN_MD}
 *     env:
 *       PGSERVICE: warehouse          # libpq/psql will honor this
 *       PGPASSFILE: /path/to/pgpass   # libpq/psql will honor this
 *
 *   sqlite1:
 *     engine: sqlite
 *     file: ":memory:"
 *
 *   duckdb1:
 *     engine: duckdb
 *     file: ":memory:"
 * ```
 */
export function catalogFromYaml(
  yaml: string | Record<string, unknown>,
): LanguageInitCatalog<LanguageInitBase & EngineTagged> {
  const root = typeof yaml === "string"
    ? (parseYaml(yaml) as Record<string, unknown> | null)
    : yaml;

  if (!root || typeof root !== "object") {
    throw new Error("catalogFromYaml: YAML did not parse to an object.");
  }

  const catalogNode = (root as Record<string, unknown>).catalog ?? root;
  if (
    !catalogNode || typeof catalogNode !== "object" ||
    Array.isArray(catalogNode)
  ) {
    throw new Error(
      "catalogFromYaml: expected an object at `catalog:` (or top-level).",
    );
  }

  const out: Record<string, LanguageInitBase & EngineTagged> = {};

  for (
    const [name, raw] of Object.entries(catalogNode as Record<string, unknown>)
  ) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `catalogFromYaml: catalog entry '${name}' must be an object.`,
      );
    }

    const entry = raw as Record<string, unknown>;
    const engine = String(entry.engine ?? "").toLowerCase();

    // Common init fields supported by LanguageInitBase
    const base: LanguageInitBase = {
      bin: typeof entry.bin === "string" ? entry.bin : undefined,
      cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
      env: normalizeEnv(entry.env),
    };

    if (engine === "postgres" || engine === "psql" || engine === "pg") {
      out[name] = pgInit({
        ...base,
        host: asString(entry.host),
        port: asString(entry.port),
        user: asString(entry.user),
        dbname: asString(entry.dbname),
        password: asString(entry.password), // optional; prefer env/pgpass/PGSERVICE
      });
      continue;
    }

    if (engine === "sqlite" || engine === "sqlite3") {
      out[name] = sqliteInit({
        ...base,
        file: asString(entry.file) ?? ":memory:",
      });
      continue;
    }

    if (engine === "duckdb") {
      out[name] = duckdbInit({
        ...base,
        file: asString(entry.file) ?? ":memory:",
      });
      continue;
    }

    throw new Error(
      `catalogFromYaml: entry '${name}' has unknown engine '${engine}'. ` +
        `Expected postgres|sqlite|duckdb.`,
    );
  }

  return defineLanguageInitCatalog(out);
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function normalizeEnv(
  v: unknown,
): Record<string, string | undefined> | undefined {
  if (!v) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(
      "catalogFromYaml: env must be an object of key/value pairs.",
    );
  }
  const env: Record<string, string | undefined> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (raw === undefined || raw === null) {
      env[k] = undefined;
    } else if (typeof raw === "string") {
      env[k] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      env[k] = String(raw);
    } else {
      throw new Error(
        `catalogFromYaml: env['${k}'] must be string|number|boolean|null.`,
      );
    }
  }
  return env;
}

export type UsingShell<Baggage = unknown> = {
  readonly kind: "using-shell";
  readonly using: string;
  readonly engine: LanguageEngine;
  readonly catalog: LanguageInitCatalog<LanguageInitBase & EngineTagged>;
  readonly initRef: { ref: string };
  readonly runtimeArgs?: readonly string[];
  spawn(
    input: LanguageInput,
    opts?: {
      mode?: ExecutionMode;
      cwd?: string;
      env?: Record<string, string | undefined>;
      programArgs?: readonly string[];
      baggage?: Baggage;
    },
  ): Promise<LanguageSpawnResult<Baggage>>;
};

export function using<Baggage = unknown>(
  catalog: LanguageInitCatalog<LanguageInitBase & EngineTagged>,
  using: string,
  args?: string,
  init?: {
    shell?: ReturnType<typeof createShell<Baggage>>;
    mode?: ExecutionMode;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): UsingShell<Baggage> {
  const entry = catalog[using];
  if (!entry) throw new Error(`using(): catalog entry '${using}' not found`);

  const engine = engineFromCatalogEntry(entry);
  const runtimeArgs = args ? splitArgvLine(args) : undefined;

  const sh = init?.shell ?? createShell<Baggage>({
    cwd: init?.cwd,
    env: init?.env,
  });

  const languageShell = new LanguageSpawnShell<Baggage>(sh);

  return {
    kind: "using-shell",
    using,
    engine,
    catalog,
    initRef: { ref: using },
    runtimeArgs,

    spawn: (input, opts) =>
      languageShell.spawn({
        engine,
        catalog,
        init: { ref: using },
        input,
        runtimeArgs,
        mode: opts?.mode ?? init?.mode,
        cwd: opts?.cwd,
        env: opts?.env,
        programArgs: opts?.programArgs,
        baggage: opts?.baggage,
      }),
  };
}

function engineFromCatalogEntry(
  entry: LanguageInitBase & EngineTagged,
): LanguageEngine {
  const id = entry.engineId;
  if (!id) {
    throw new Error(
      "using(): catalog entry is missing engineId; ensure it was created via pgInit/sqliteInit/duckdbInit (or equivalent).",
    );
  }

  if (id === psqlEngine.id) return psqlEngine;
  if (id === sqlite3Engine.id) return sqlite3Engine;
  if (id === duckdbEngine.id) return duckdbEngine;

  throw new Error(
    "using(): catalog entry engineId does not match any known engine (psql/sqlite3/duckdb).",
  );
}

// Simple quoted argv splitter (same behavior as shell.ts)
function splitArgvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let esc = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }

  if (cur) out.push(cur);
  return out;
}
