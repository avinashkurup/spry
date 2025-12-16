// code-shell-serde_test.ts
import { assert, assertEquals } from "@std/assert";
import { catalogFromYaml, using } from "./code-shell-serde.ts";

import {
  duckdbEngine,
  type DuckDbInit,
  type PgInit,
  psqlEngine,
  sqlite3Engine,
  type SqliteInit,
} from "./code-shell.ts";
import { duckdbAvailable } from "./code-shell_test.ts";

Deno.test({
  name: "code-shell-serde: YAML from string (subtests)",
  fn: async (t) => {
    await t.step(
      "parses `catalog:` wrapper with postgres/sqlite/duckdb entries",
      () => {
        const yaml = `
catalog:
  pg_local:
    engine: postgres
    host: 127.0.0.1
    port: "5432"
    user: app
    dbname: appdb
    env:
      PGSERVICE: local
      PGPASSFILE: /tmp/pgpass

  sqlite1:
    engine: sqlite
    file: ":memory:"
    env:
      SQLITE_TMP: 1

  duckdb1:
    engine: duckdb
    file: ":memory:"
`;

        const catalog = catalogFromYaml(yaml);

        assert(catalog.pg_local);
        assert(catalog.sqlite1);
        assert(catalog.duckdb1);

        const pg = catalog.pg_local as PgInit;
        const sqlite = catalog.sqlite1 as SqliteInit;
        const duck = catalog.duckdb1 as DuckDbInit;

        // Engine identity tagging should match the engine wrapper helpers.
        assertEquals(pg.engineId, psqlEngine.id);
        assertEquals(sqlite.engineId, sqlite3Engine.id);
        assertEquals(duck.engineId, duckdbEngine.id);

        // Validate essential fields survive.
        assertEquals(pg.host, "127.0.0.1");
        assertEquals(pg.port, "5432");
        assertEquals(pg.user, "app");
        assertEquals(pg.dbname, "appdb");

        assertEquals(sqlite.file, ":memory:");
        assertEquals(duck.file, ":memory:");

        // Env normalization: numbers should become strings.
        assert(pg.env);
        assertEquals(pg.env.PGSERVICE, "local");
        assertEquals(pg.env.PGPASSFILE, "/tmp/pgpass");

        assert(sqlite.env);
        assertEquals(sqlite.env.SQLITE_TMP, "1");
      },
    );

    await t.step(
      "parses when entries are top-level (no `catalog:` wrapper)",
      () => {
        const yaml = `
pg_local:
  engine: postgres
  host: db.internal
  port: 5432
  user: readonly
  dbname: warehouse

sqlite1:
  engine: sqlite
  file: /tmp/example.db

duckdb1:
  engine: duckdb
  file: /tmp/example.duckdb
`;

        const catalog = catalogFromYaml(yaml);

        const pg = catalog.pg_local as PgInit;
        const sqlite = catalog.sqlite1 as SqliteInit;
        const duck = catalog.duckdb1 as DuckDbInit;

        assertEquals(pg.engineId, psqlEngine.id);
        assertEquals(sqlite.engineId, sqlite3Engine.id);
        assertEquals(duck.engineId, duckdbEngine.id);

        assertEquals(pg.host, "db.internal");
        assertEquals(pg.port, "5432"); // normalized from number
        assertEquals(pg.user, "readonly");
        assertEquals(pg.dbname, "warehouse");

        assertEquals(sqlite.file, "/tmp/example.db");
        assertEquals(duck.file, "/tmp/example.duckdb");
      },
    );

    await t.step("throws on unknown engine", () => {
      const yaml = `
catalog:
  bad1:
    engine: mysql
    host: localhost
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step("throws when a catalog entry is not an object", () => {
      const yaml = `
catalog:
  pg_local: "not-an-object"
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step("throws when env is not an object", () => {
      const yaml = `
catalog:
  pg_local:
    engine: postgres
    host: 127.0.0.1
    env: "not-an-object"
`;
      let threw = false;
      try {
        catalogFromYaml(yaml);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step(
      "exec sqlite3 :memory: from catalog (single spawn)",
      async () => {
        const yaml = `
catalog:
  sqlite1:
    engine: sqlite
    file: ":memory:"
`;
        const catalog = catalogFromYaml(yaml);
        const db = using(catalog, "sqlite1");

        const sql = [
          "create table t(x integer);",
          "insert into t values (41), (1);",
          "select sum(x) as s from t;",
        ].join("\n");

        const res = await db.spawn({ kind: "text", text: sql });
        assert(res.success);

        const out = new TextDecoder().decode(res.stdout);
        // sqlite3 output is simple; just confirm computed value shows up.
        assert(out.includes("42"));
      },
    );

    await t.step({
      name: "exec duckdb :memory: from catalog (single spawn)",
      ignore: !duckdbAvailable,
      fn: async () => {
        const yaml = `
catalog:
  duckdb1:
    engine: duckdb
    file: ":memory:"
`;
        const catalog = catalogFromYaml(yaml);
        const db = using(catalog, "duckdb1");

        const sql = [
          "create table t(x integer);",
          "insert into t values (10), (32);",
          "select sum(x) as s from t;",
        ].join("\n");

        const res = await db.spawn({ kind: "text", text: sql });
        assert(res.success);

        const out = new TextDecoder().decode(res.stdout);
        assert(out.includes("42"));
      },
    });
  },
});

Deno.test({
  name: "code-shell-serde: YAML from object (subtests)",
  fn: async (t) => {
    await t.step("parses object with `catalog:` wrapper", () => {
      const obj = {
        catalog: {
          pg_local: {
            engine: "postgres",
            host: "127.0.0.1",
            port: 5432,
            user: "app",
            dbname: "appdb",
            env: { PGSERVICE: "local", PGPASSFILE: "/tmp/pgpass" },
          },
          sqlite1: {
            engine: "sqlite",
            file: ":memory:",
          },
          duckdb1: {
            engine: "duckdb",
            file: ":memory:",
            env: { SOME_FLAG: true },
          },
        },
      };

      const catalog = catalogFromYaml(obj);

      const pg = catalog.pg_local as PgInit;
      const sqlite = catalog.sqlite1 as SqliteInit;
      const duck = catalog.duckdb1 as DuckDbInit;

      assertEquals(pg.engineId, psqlEngine.id);
      assertEquals(sqlite.engineId, sqlite3Engine.id);
      assertEquals(duck.engineId, duckdbEngine.id);

      assertEquals(pg.host, "127.0.0.1");
      assertEquals(pg.port, "5432"); // normalized
      assertEquals(pg.user, "app");
      assertEquals(pg.dbname, "appdb");

      assertEquals(sqlite.file, ":memory:");
      assertEquals(duck.file, ":memory:");

      assert(duck.env);
      assertEquals(duck.env.SOME_FLAG, "true");
    });

    await t.step(
      "parses object with top-level entries (no `catalog:` wrapper)",
      () => {
        const obj = {
          pg_local: {
            engine: "psql",
            host: "db.internal",
            port: "5432",
            user: "readonly",
            dbname: "warehouse",
          },
          sqlite1: {
            engine: "sqlite3",
            file: "/tmp/example.db",
          },
          duckdb1: {
            engine: "duckdb",
            file: "/tmp/example.duckdb",
          },
        };

        const catalog = catalogFromYaml(obj);

        const pg = catalog.pg_local as PgInit;
        const sqlite = catalog.sqlite1 as SqliteInit;
        const duck = catalog.duckdb1 as DuckDbInit;

        assertEquals(pg.engineId, psqlEngine.id);
        assertEquals(sqlite.engineId, sqlite3Engine.id);
        assertEquals(duck.engineId, duckdbEngine.id);

        assertEquals(pg.host, "db.internal");
        assertEquals(pg.port, "5432");
        assertEquals(pg.user, "readonly");
        assertEquals(pg.dbname, "warehouse");

        assertEquals(sqlite.file, "/tmp/example.db");
        assertEquals(duck.file, "/tmp/example.duckdb");
      },
    );

    await t.step("throws when object does not contain a catalog object", () => {
      // Root is an array, not an object.
      const obj = [] as unknown as Record<string, unknown>;
      let threw = false;
      try {
        catalogFromYaml(obj);
      } catch {
        threw = true;
      }
      assertEquals(threw, true);
    });

    await t.step("exec sqlite3 :memory: from object catalog", async () => {
      const obj = {
        catalog: {
          sqlite1: { engine: "sqlite", file: ":memory:" },
        },
      };

      const catalog = catalogFromYaml(obj);
      const db = using(catalog, "sqlite1");

      const sql = [
        "create table t(x text);",
        "insert into t values ('ok');",
        "select x from t;",
      ].join("\n");

      const res = await db.spawn({ kind: "text", text: sql });
      assert(res.success);

      const out = new TextDecoder().decode(res.stdout);
      assert(out.includes("ok"));
    });

    await t.step({
      name: "exec duckdb :memory: from object catalog",
      ignore: !duckdbAvailable,
      fn: async () => {
        const obj = {
          catalog: {
            duckdb1: { engine: "duckdb", file: ":memory:" },
          },
        };

        const catalog = catalogFromYaml(obj);
        const db = using(catalog, "duckdb1");

        const sql = [
          "create table t(x varchar);",
          "insert into t values ('ok');",
          "select x from t;",
        ].join("\n");

        const res = await db.spawn({ kind: "text", text: sql });
        assert(res.success);

        const out = new TextDecoder().decode(res.stdout);
        assert(out.includes("ok"));
      },
    });
  },
});
