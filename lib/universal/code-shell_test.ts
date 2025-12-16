// code-shell_test.ts
// Unit tests for code-shell.ts focusing on sqlite3 engine (:memory:)

import { assert, assertEquals } from "@std/assert";
import type {
  EngineTagged,
  LanguageInitBase,
  LanguageInitCatalog,
} from "./code-shell.ts";
import {
  defineLanguageInitCatalog,
  duckdbEngine,
  duckdbInit,
  hydratePgInitWithSecrets,
  LanguageSpawnShell,
  pgEnv,
  pgInit,
  pgPasswordFromPgpass,
  pgSecretFromJsonEnv,
  pgServiceFromConf,
  psqlEngine,
  sqlite3Engine,
  sqliteInit,
} from "./code-shell.ts";
import { shell as createShell } from "./shell.ts";

const td = new TextDecoder();

function s(u8: Uint8Array): string {
  return td.decode(u8);
}

export async function hasSqlite3(): Promise<boolean> {
  try {
    const { success } = await new Deno.Command("sqlite3", {
      args: ["-version"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

export async function hasDuckdb(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("duckdb", {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    });
    const { success } = await cmd.output();
    return success;
  } catch {
    return false;
  }
}

export const sqliteAvailable = await hasSqlite3();
export const duckdbAvailable = await hasDuckdb();

Deno.test({
  name: "sqlite3Engine (:memory:): SQL execution (subtests)",
  ignore: !sqliteAvailable,
  fn: async (t) => {
    async function spawnSql(
      sql: string,
      init?: Parameters<typeof sqliteInit>[0],
      opts?: {
        mode?: "stdin" | "file" | "eval" | "auto";
        runtimeArgs?: readonly string[];
        baggage?: unknown;
        catalog?: LanguageInitCatalog<LanguageInitBase & EngineTagged>;
        initRef?: { ref: string };
      },
    ) {
      const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());
      const res = await sh.spawn({
        engine: sqlite3Engine,
        input: { kind: "text", text: sql, hint: { ext: ".sql" } },
        init: opts?.initRef ?? (init ? { init: sqliteInit(init) } : undefined),
        catalog: opts?.catalog,
        mode: opts?.mode,
        runtimeArgs: opts?.runtimeArgs,
        baggage: opts?.baggage,
      });
      return {
        ...res,
        stdoutText: s(res.stdout),
        stderrText: s(res.stderr),
      };
    }

    await t.step("basic SELECT via stdin", async () => {
      const res = await spawnSql("select 1;");
      assert(res.success);
      assertEquals(res.code, 0);
      assertEquals(res.stdoutText.trim(), "1");
      assertEquals(res.argv?.[0], "sqlite3");
      assertEquals(res.argv?.[1], ":memory:");
    });

    await t.step("practical DDL/DML + query (headers, csv mode)", async () => {
      const sql = [
        ".headers on",
        ".mode csv",
        "create table person(id integer primary key, name text not null, age int);",
        "insert into person(name, age) values ('Asha', 31), ('Bilal', 27), ('Zoya', 5);",
        "select count(*) as n, sum(age) as total_age from person;",
        "select name from person where age >= 27 order by age desc;",
      ].join("\n");

      const res = await spawnSql(sql, undefined, { runtimeArgs: ["-batch"] });
      assert(res.success);

      const lines = res.stdoutText.trim().split("\n").map((x) => x.trim());
      // Expect two result sets (each with header) in CSV mode.
      assertEquals(lines[0], "n,total_age");
      assertEquals(lines[1], "3,63");
      assertEquals(lines[2], "name");
      assertEquals(lines[3], "Asha");
      assertEquals(lines[4], "Bilal");
    });

    await t.step("transaction + join + computed column", async () => {
      const sql = [
        ".mode list",
        "begin;",
        "create table acct(id integer primary key, owner text not null);",
        "create table txn(id integer primary key, acct_id int not null, amt real not null,",
        "  foreign key(acct_id) references acct(id));",
        "insert into acct(owner) values ('Zubaida'), ('Rashid');",
        "insert into txn(acct_id, amt) values (1, 10.5), (1, -2.0), (2, 4.25);",
        "commit;",
        "select a.owner || ':' || printf('%.2f', sum(t.amt))",
        "  from acct a join txn t on t.acct_id = a.id",
        " group by a.id order by a.id;",
      ].join("\n");

      const res = await spawnSql(sql, undefined, { runtimeArgs: ["-batch"] });
      assert(res.success);

      const lines = res.stdoutText.trim().split("\n").map((x) => x.trim());
      assertEquals(lines[0], "Zubaida:8.50");
      assertEquals(lines[1], "Rashid:4.25");
    });

    await t.step(
      "constraint violation returns non-zero with .bail on",
      async () => {
        const sql = [
          ".bail on",
          "create table u(id integer primary key, email text unique);",
          "insert into u(email) values ('a@example.com');",
          "insert into u(email) values ('a@example.com');",
          "select 'should-not-print';",
        ].join("\n");

        const res = await spawnSql(sql, undefined, { runtimeArgs: ["-batch"] });
        assert(!res.success);
        assert(res.code !== 0);
        assertEquals(res.stdoutText.includes("should-not-print"), false);

        const err = res.stderrText.toLowerCase();
        assert(err.includes("unique") || err.includes("constraint"));
      },
    );

    await t.step("file mode executes .sql temp file", async () => {
      const sql = [
        ".mode list",
        "create table t(x int);",
        "insert into t(x) values (41), (1);",
        "select sum(x) from t;",
      ].join("\n");

      const res = await spawnSql(sql, undefined, {
        mode: "file",
        runtimeArgs: ["-batch"],
      });
      assert(res.success);
      assertEquals(res.stdoutText.trim(), "42");
      assert(res.argv);
      assertEquals(res.argv[0], "sqlite3");
      assertEquals(res.argv[1], ":memory:");
      assertEquals(res.argv[2].startsWith(".read "), true);
    });

    await t.step("catalog init by ref (explicit :memory:)", async () => {
      const catalog = defineLanguageInitCatalog({
        memdb: sqliteInit({ file: ":memory:" }),
      });

      const res = await spawnSql("select 'ok';", undefined, {
        initRef: { ref: "memdb" },
        catalog,
      });

      assert(res.success);
      assertEquals(res.stdoutText.trim(), "ok");
      assertEquals(res.argv?.[1], ":memory:");
    });

    await t.step("baggage is preserved through spawn", async () => {
      const baggage = { traceId: "t-123" };
      const res = await spawnSql("select 7;", undefined, { baggage });
      assert(res.success);
      assertEquals(res.stdoutText.trim(), "7");
      assertEquals(res.baggage, baggage);
    });
  },
});

Deno.test({
  name: "duckdbEngine (:memory:): SQL execution (subtests)",
  ignore: !duckdbAvailable,
  fn: async (t) => {
    const sh = new LanguageSpawnShell<unknown>(createShell<unknown>());
    await t.step("basic SELECT via stdin", async () => {
      const res = await sh.spawn({
        engine: duckdbEngine,
        input: { kind: "text", text: "select 1 as n;" },
        init: { init: duckdbInit({ file: ":memory:" }) },
      });

      const stdoutText = new TextDecoder().decode(res.stdout).trim();
      if (!res.success) {
        const stderrText = new TextDecoder().decode(res.stderr);
        throw new Error(`duckdb failed: ${stderrText}`);
      }

      // DuckDB default output is a table; just check it contains the value.
      if (!stdoutText.includes("1")) {
        throw new Error(`unexpected output: ${stdoutText}`);
      }
    });

    await t.step("practical DDL/DML + query", async () => {
      const sql = [
        "create table person(id integer, name varchar, age integer);",
        "insert into person values (1,'Asha',31), (2,'Bilal',27), (3,'Zoya',5);",
        "select count(*) as n, sum(age) as total_age from person;",
      ].join("\n");

      const res = await sh.spawn({
        engine: duckdbEngine,
        input: { kind: "text", text: sql },
        init: { init: duckdbInit({ file: ":memory:" }) },
      });

      const stdoutText = new TextDecoder().decode(res.stdout);
      if (!res.success) {
        const stderrText = new TextDecoder().decode(res.stderr);
        throw new Error(`duckdb failed: ${stderrText}`);
      }

      // Default table output; assert the computed numbers show up somewhere.
      if (!stdoutText.includes("3") || !stdoutText.includes("63")) {
        throw new Error(`unexpected output: ${stdoutText}`);
      }
    });

    await t.step("file mode executes .sql temp file", async () => {
      const sql = [
        "create table t(x integer);",
        "insert into t values (41), (1);",
        "select sum(x) as s from t;",
      ].join("\n");

      const res = await sh.spawn({
        engine: duckdbEngine,
        input: { kind: "text", text: sql, hint: { ext: ".sql" } },
        init: { init: duckdbInit({ file: ":memory:" }) },
        mode: "file",
      });

      const stdoutText = new TextDecoder().decode(res.stdout);
      if (!res.success) {
        const stderrText = new TextDecoder().decode(res.stderr);
        throw new Error(`duckdb failed: ${stderrText}`);
      }
      if (!stdoutText.includes("42")) {
        throw new Error(`unexpected output: ${stdoutText}`);
      }
    });
  },
});

Deno.test({
  name:
    "catalog + init refs: planInvocation demonstrates multi-engine usage (no execution)",
  fn: async (t) => {
    // This test is intentionally DX-oriented: it validates catalog wiring, init tagging,
    // and invocation planning without requiring the underlying runtimes to be installed.

    const catalog = defineLanguageInitCatalog({
      // PostgreSQL connections
      pg_local: pgInit({
        host: "127.0.0.1",
        port: "5432",
        user: "app",
        dbname: "appdb",
        // password is optional; when set, engine.mapEnv can inject PGPASSWORD
        password: "secret",
      }),
      pg_ro: pgInit({
        host: "db.example.internal",
        port: "5432",
        user: "readonly",
        dbname: "warehouse",
      }),

      // SQLite connections
      sqlite_mem: sqliteInit({ file: ":memory:" }),
      sqlite_file: sqliteInit({ file: "/tmp/example.db" }),

      // DuckDB connections
      duck_mem: duckdbInit({ file: ":memory:" }),
      duck_file: duckdbInit({ file: "/tmp/example.duckdb" }),
    });

    const input = { kind: "text" as const, text: "select 1 as n;" };

    await t.step("psql: init resolved by ref + argv planned", async () => {
      const resolved = psqlEngine.resolveInit({ ref: "pg_local" }, catalog);
      assert(resolved.init);

      const plan = await psqlEngine.planInvocation({
        bin: "psql",
        init: resolved.init,
        input,
        mode: "stdin",
      });

      assertEquals(plan.mode, "stdin");
      assertEquals(plan.argv[0], "psql");

      const argv = plan.argv.join(" ");
      // host/port/user/dbname flags should appear when provided
      assert(argv.includes("-h 127.0.0.1"));
      assert(argv.includes("-p 5432"));
      assert(argv.includes("-U app"));
      assert(argv.includes("-d appdb"));
      // ON_ERROR_STOP is always configured
      assert(argv.includes("ON_ERROR_STOP=1"));
      // Demonstrate env mapping usage (without asserting secrets in output).
      const mapped = psqlEngine.mapEnv?.({ init: resolved.init, env: {} }) ??
        undefined;
      assertEquals(mapped?.PGPASSWORD, "secret");
    });

    await t.step(
      "psql: recommended auth patterns (env wins; pgpass supported implicitly)",
      () => {
        // 1) If init.password is absent, engine does not inject PGPASSWORD.
        const noPw = pgInit({
          host: "127.0.0.1",
          port: "5432",
          user: "app",
          dbname: "appdb",
          // password intentionally omitted: rely on ~/.pgpass / PGPASSFILE / IAM / etc.
        });

        const injected1 = psqlEngine.mapEnv?.({ init: noPw, env: {} }) ??
          undefined;
        assertEquals(injected1, undefined);

        // 2) If caller already supplies PGPASSWORD in env, engine will NOT override it.
        const withPw = pgInit({
          host: "127.0.0.1",
          port: "5432",
          user: "app",
          dbname: "appdb",
          password: "from-init-should-not-win",
        });

        const injected2 = psqlEngine.mapEnv?.({
          init: withPw,
          env: { PGPASSWORD: "from-env-wins" },
        }) ?? undefined;

        assertEquals(injected2, undefined);

        // 3) If init.password exists and env doesn't, engine injects it as PGPASSWORD.
        const injected3 = psqlEngine.mapEnv?.({ init: withPw, env: {} }) ??
          undefined;
        assertEquals(injected3?.PGPASSWORD, "from-init-should-not-win");
      },
    );

    await t.step("sqlite3: init resolved by ref + argv planned", async () => {
      const resolved = sqlite3Engine.resolveInit(
        { ref: "sqlite_mem" },
        catalog,
      );
      assert(resolved.init);

      const plan = await sqlite3Engine.planInvocation({
        bin: "sqlite3",
        init: resolved.init,
        input,
        mode: "stdin",
      });

      assertEquals(plan.mode, "stdin");
      assertEquals(plan.argv[0], "sqlite3");
      assertEquals(plan.argv[1], ":memory:");
      assert(plan.stdin);
    });

    await t.step("duckdb: init resolved by ref + argv planned", async () => {
      const resolved = duckdbEngine.resolveInit({ ref: "duck_mem" }, catalog);
      assert(resolved.init);

      const plan = await duckdbEngine.planInvocation({
        bin: "duckdb",
        init: resolved.init,
        input,
        mode: "stdin",
      });

      assertEquals(plan.mode, "stdin");
      assertEquals(plan.argv[0], "duckdb");
      assertEquals(plan.argv[1], ":memory:");
      assert(plan.stdin);
    });

    await t.step(
      "engine safety: mismatched engineId in catalog ref throws",
      () => {
        // Using a sqlite init with psqlEngine should throw (engineId mismatch).
        const badCatalog = defineLanguageInitCatalog({
          wrong: sqliteInit({ file: ":memory:" }),
        });

        let threw = false;
        try {
          psqlEngine.resolveInit({ ref: "wrong" }, badCatalog);
        } catch {
          threw = true;
        }
        assertEquals(threw, true);
      },
    );
  },
});

Deno.test({
  name:
    "helpers: env vars + pgpass + pg_service.conf + secret hydration (unit-testable only)",
  fn: async (t) => {
    const saved = new Map<string, string | undefined>();
    const keysToTouch = [
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGDATABASE",
      "PGPASSWORD",
      "DATABASE_URL",
      "PGPASSFILE",
      "PGSERVICEFILE",
      "LOCAL_PGHOST",
      "LOCAL_PGPORT",
      "LOCAL_PGUSER",
      "LOCAL_PGDATABASE",
      "LOCAL_PGPASSWORD",
      "PG_SECRET_JSON",
    ] as const;

    const snapshot = () => {
      for (const k of keysToTouch) saved.set(k, Deno.env.get(k));
    };
    const restore = () => {
      for (const [k, v] of saved.entries()) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    };

    snapshot();
    try {
      // Clear relevant vars so each step is deterministic.
      for (const k of keysToTouch) Deno.env.delete(k);

      await t.step("pgEnv: reads PG* vars (no password by default)", () => {
        Deno.env.set("PGHOST", "127.0.0.1");
        Deno.env.set("PGPORT", "5432");
        Deno.env.set("PGUSER", "app");
        Deno.env.set("PGDATABASE", "appdb");
        Deno.env.set("PGPASSWORD", "should-not-be-read");

        const init = pgEnv();
        assertEquals(init.host, "127.0.0.1");
        assertEquals(init.port, "5432");
        assertEquals(init.user, "app");
        assertEquals(init.dbname, "appdb");
        assertEquals(init.password, undefined);
      });

      await t.step("pgEnv: can read prefixed env vars", () => {
        for (
          const k of [
            "PGHOST",
            "PGPORT",
            "PGUSER",
            "PGDATABASE",
            "PGPASSWORD",
          ] as const
        ) {
          Deno.env.delete(k);
        }

        Deno.env.set("LOCAL_PGHOST", "db.internal");
        Deno.env.set("LOCAL_PGPORT", "5433");
        Deno.env.set("LOCAL_PGUSER", "svc");
        Deno.env.set("LOCAL_PGDATABASE", "warehouse");
        Deno.env.set("LOCAL_PGPASSWORD", "ignored-by-default");

        const init = pgEnv({ prefix: "LOCAL_" });
        assertEquals(init.host, "db.internal");
        assertEquals(init.port, "5433");
        assertEquals(init.user, "svc");
        assertEquals(init.dbname, "warehouse");
        assertEquals(init.password, undefined);
      });

      await t.step("pgEnv: DSN parsing takes precedence when set", () => {
        // DSN should override PG* vars when present.
        Deno.env.set("PGHOST", "should-be-overridden");
        Deno.env.set("DATABASE_URL", "postgresql://u:p@myhost:6543/mydb");

        const init = pgEnv({ readPasswordFromEnv: false });
        assertEquals(init.host, "myhost");
        assertEquals(init.port, "6543");
        assertEquals(init.user, "u");
        assertEquals(init.dbname, "mydb");

        // Password should NOT be exposed unless explicitly opted-in.
        assertEquals(init.password, undefined);
      });

      await t.step(
        "pgPasswordFromPgpass: synthetic pgpass file match + wildcards",
        async () => {
          const pgpass = [
            "# comment",
            // hostname:port:database:username:password
            "db.internal:5432:warehouse:readonly:ro-pass",
            "*:5432:*:app:app-pass",
            "127.0.0.1:*:*:*:local-any",
          ].join("\n");

          const path = await Deno.makeTempFile({
            prefix: "pgpass-",
            suffix: ".txt",
          });
          try {
            await Deno.writeTextFile(path, pgpass);
            Deno.env.set("PGPASSFILE", path);

            const p1 = await pgPasswordFromPgpass({
              host: "db.internal",
              port: "5432",
              dbname: "warehouse",
              user: "readonly",
            });
            assertEquals(p1, "ro-pass");

            const p2 = await pgPasswordFromPgpass({
              host: "whatever",
              port: "5432",
              dbname: "anything",
              user: "app",
            });
            assertEquals(p2, "app-pass");

            const p3 = await pgPasswordFromPgpass({
              host: "127.0.0.1",
              port: "9999",
              dbname: "x",
              user: "y",
            });
            assertEquals(p3, "local-any");
          } finally {
            try {
              await Deno.remove(path);
            } catch {
              /* ignore */
            }
            Deno.env.delete("PGPASSFILE");
          }
        },
      );

      await t.step(
        "pgServiceFromConf: synthetic pg_service.conf parse",
        async () => {
          const conf = [
            "[warehouse]",
            "host=db.internal",
            "port=5432",
            "user=readonly",
            "dbname=warehouse",
            "",
            "[local]",
            "host=127.0.0.1",
            "port=5432",
            "user=app",
            "dbname=appdb",
          ].join("\n");

          const path = await Deno.makeTempFile({
            prefix: "pgsvc-",
            suffix: ".conf",
          });
          try {
            await Deno.writeTextFile(path, conf);
            Deno.env.set("PGSERVICEFILE", path);

            const svc = await pgServiceFromConf("warehouse");
            assert(svc);
            assertEquals(svc.host, "db.internal");
            assertEquals(svc.port, "5432");
            assertEquals(svc.user, "readonly");
            assertEquals(svc.dbname, "warehouse");
          } finally {
            try {
              await Deno.remove(path);
            } catch {
              /* ignore */
            }
            Deno.env.delete("PGSERVICEFILE");
          }
        },
      );

      await t.step(
        "pgSecretFromJsonEnv + hydratePgInitWithSecrets: fills missing fields",
        async () => {
          // Base init (non-sensitive)
          const base = {
            host: "db.internal",
            port: "5432",
            user: "app",
            dbname: "appdb",
          };

          // Simulate an AWS/Azure/GCP-injected secret JSON blob.
          Deno.env.set(
            "PG_SECRET_JSON",
            JSON.stringify({
              username: "app",
              password: "supersecret",
              host: "db.internal",
              port: 5432,
              dbname: "appdb",
            }),
          );

          const provider = pgSecretFromJsonEnv("PG_SECRET_JSON");

          const hydrated = await hydratePgInitWithSecrets(base, provider);
          assertEquals(hydrated.host, "db.internal");
          assertEquals(hydrated.port, "5432");
          assertEquals(hydrated.user, "app");
          assertEquals(hydrated.dbname, "appdb");
          assertEquals(hydrated.password, "supersecret");
        },
      );
    } finally {
      restore();
    }
  },
});
