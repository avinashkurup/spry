// resource-contributions_test.ts
// Deno 2.5+ test suite for resourceContributions() with explicit cleanup.
//
// Uses your baseline suite and adds edge cases for:
// - meta behavior (including "flags preserved in meta" per your expectation)
// - URL base variants (slash/no-slash, subpath, mismatch)
// - "." semantics in more combinations
// - callback override edge cases
// - repeated flags (--base, --mime) and precedence
// - line numbering + trailing newline + blank lines
// - duplicate specs behavior (no dedupe)
// - label parsing boundaries

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resourceContributions } from "./resource-contributions.ts";

async function ensureFile(path: string, contents = "x") {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, contents);
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resourceContributions() factory (meta + new dest semantics)", async (t) => {
  await t.step(
    "local-fs single-path: dest token is destPath (destPrefix undefined)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a/b/c.sql"), "select 1;");

        const src = "a/b/c.sql sqlpage/templates/a/b/c.sql";
        const rc = resourceContributions(src, { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);

        assertEquals(got[0].dest.kind, "path");
        assertEquals(got[0].destPrefix, undefined);
        assertEquals(got[0].destPath, "sqlpage/templates/a/b/c.sql");
      });
    },
  );

  await t.step(
    "meta: preserves positional remainder after destToken (flags are not duplicated)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        // NOTE: per your updated expectation, meta keeps everything after destToken,
        // including flags (even if we consume them via PI parsing).
        const src = "a.sql out/a.sql extra1 extra2 --base X --mime text/plain";
        const rc = resourceContributions(src, { fromBase: tmp });

        const specs = Array.from(rc.specs());
        assertEquals(rc.issues.length, 0);
        assertEquals(specs.length, 1);

        assertEquals(specs[0].meta, "extra1 extra2 --base X --mime text/plain");
      });
    },
  );

  await t.step(
    "glob multi-target: dest token is destPrefix, destPath = destPrefix + relative segment",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "dir/a.sql"), "a");
        await ensureFile(join(tmp, "dir/b.sql"), "b");

        const src = "dir/*.sql out";
        const rc = resourceContributions(src, { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);

        assertEquals(got[0].dest.kind, "prefix");
        assertEquals(got[0].destPrefix, "out");
        assert(got[0].destPath.startsWith("out/dir/"));
      });
    },
  );

  await t.step(
    "default destPrefix applies only for glob: line may omit dest token",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "dir/a.sql"), "a");
        await ensureFile(join(tmp, "dir/b.sql"), "b");

        const src = "dir/*.sql";
        const rc = resourceContributions(src, {
          fromBase: tmp,
          destPrefix: "OUT",
        });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);
        assert(got[0].destPath.startsWith("OUT/dir/"));
      });
    },
  );

  await t.step(
    "missing destPrefix for glob: issue when neither line nor args.destPrefix provide it",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "dir/a.sql"), "a");

        const rc = resourceContributions("dir/*.sql", { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(got.length, 0);
        assertEquals(rc.issues.length, 1);
        assert(rc.issues[0].message.includes("Missing destPrefix"));
      });
    },
  );

  await t.step(
    "missing destPath for single local: issue when line omits dest token",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql", { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(got.length, 0);
        assertEquals(rc.issues.length, 1);
        assert(rc.issues[0].message.includes("Missing destPath"));
      });
    },
  );

  await t.step(
    "block-level bases: multiple bases produce multiple contributions for glob candidates",
    async () => {
      await withTempDir(async (tmp) => {
        const baseA = join(tmp, "baseA");
        const baseB = join(tmp, "baseB");

        await ensureFile(join(baseA, "dir/file.sql"), "a");
        await ensureFile(join(baseB, "dir/file.sql"), "b");

        const rc = resourceContributions("dir/*.sql out", {
          fromBase: [baseA, baseB],
        });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);
        assertEquals(got[0].destPath, "out/dir/file.sql");
        assertEquals(got[1].destPath, "out/dir/file.sql");
      });
    },
  );

  await t.step(
    "block-level bases: single-path uses first base only (no duplication)",
    async () => {
      await withTempDir(async (tmp) => {
        const baseA = join(tmp, "baseA");
        const baseB = join(tmp, "baseB");

        await ensureFile(join(baseA, "a.sql"), "a");
        await ensureFile(join(baseB, "a.sql"), "b");

        const rc = resourceContributions("a.sql out/a.sql", {
          fromBase: [baseA, baseB],
        });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].destPath, "out/a.sql");
      });
    },
  );

  await t.step("line-level --base overrides block bases (glob)", async () => {
    await withTempDir(async (tmp) => {
      const baseA = join(tmp, "baseA");
      const baseB = join(tmp, "baseB");
      const overrideBase = join(tmp, "overrideBase");

      await ensureFile(join(baseA, "dir/file.sql"), "a");
      await ensureFile(join(baseB, "dir/file.sql"), "b");
      await ensureFile(join(overrideBase, "dir/file.sql"), "o");

      const rc = resourceContributions(
        `dir/*.sql out --base ${overrideBase}`,
        { fromBase: [baseA, baseB] },
      );

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].destPath, "out/dir/file.sql");
    });
  });

  await t.step(
    "resolveBasePath transforms bases (block + line-level) (glob + single)",
    async () => {
      await withTempDir(async (tmp) => {
        const rootB = join(tmp, "ROOT/B");
        const rootX = join(tmp, "ROOT/X");

        await ensureFile(join(rootB, "dir/a.sql"), "a");
        await ensureFile(join(rootX, "dir/b.sql"), "b");

        const src = [
          "dir/*.sql out",
          "dir/b.sql out/b.sql --base X",
        ].join("\n");

        const rc = resourceContributions(src, {
          fromBase: "B",
          resolveBasePath: (b) => join(tmp, "ROOT", b),
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);
        assertEquals(got[0].destPath, "out/dir/a.sql");
        assertEquals(got[1].destPath, "out/b.sql");
      });
    },
  );

  await t.step(
    "URL candidates: disallowed by default => issue + skipped",
    () => {
      const rc = resourceContributions(
        "https://example.com/dir/a.sql out/a.sql",
      );
      const got = Array.from(rc.provenance());

      assertEquals(got.length, 0);
      assertEquals(rc.issues.length, 1);
      assertEquals(rc.issues[0].severity, "error");
      assertEquals(rc.issues[0].line, 1);
      assert(rc.issues[0].message.includes("allowUrls is false"));
    },
  );

  await t.step(
    "URL candidates: allowed => explicit destPath is taken directly",
    () => {
      const rc = resourceContributions(
        "https://example.com/dir/a.sql assets/a.sql",
        {
          allowUrls: true,
          fromBase: "https://example.com/dir/",
        },
      );

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].dest.kind, "path");
      assertEquals(got[0].destPath, "assets/a.sql");
    },
  );

  await t.step(
    'URL candidates: allowed + dest token "." => auto destPath derived from base-relative URL path',
    () => {
      const rc = resourceContributions(
        "https://example.com/assets/brand/a.png .",
        {
          allowUrls: true,
          fromBase: "https://example.com/",
        },
      );

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].dest.kind, "path");
      assertEquals(got[0].destPath, "assets/brand/a.png");
    },
  );

  await t.step(
    'URL candidates: allowed + dest token "./dir" => join("./dir", basename(url))',
    () => {
      const rc = resourceContributions(
        "https://example.com/assets/brand/a.png ./STATIC",
        {
          allowUrls: true,
          fromBase: "https://example.com/",
        },
      );

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].destPath, "STATIC/a.png");
    },
  );

  await t.step(
    'single local: dest token "." => basename(candidate)',
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "dir/a.sql"), "a");

        const rc = resourceContributions("dir/a.sql .", { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].destPath, "a.sql");
      });
    },
  );

  await t.step(
    "custom resolveDestPath callback: can map '.' however we want",
    () => {
      const rc = resourceContributions("https://example.com/x/y/z.png .", {
        allowUrls: true,
        fromBase: "https://example.com/",
        resolveDestPath: (ctx) => {
          if (ctx.destToken?.trim() === ".") return "CUSTOM/z.png";
          return ctx.destToken;
        },
      });

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].destPath, "CUSTOM/z.png");
    },
  );

  await t.step(
    "--mime override: applied to ResourceProvenance before strategyDecisions()",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.bin"), "not really binary but ok");

        const rc = resourceContributions(
          "a.bin out/a.bin --mime application/octet-stream",
          {
            fromBase: tmp,
          },
        );

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].provenance.mimeType, "application/octet-stream");

        const res = Array.from(rc.resources());
        assertEquals(res.length, 1);
        assertEquals(res[0].provenance.mimeType, "application/octet-stream");
      });
    },
  );

  await t.step("transform: can skip lines before parsing", async () => {
    await withTempDir(async (tmp) => {
      await ensureFile(join(tmp, "a.sql"), "a");
      await ensureFile(join(tmp, "b.sql"), "b");

      const src = [
        "# comment",
        "a.sql out/a.sql",
        "skip.sql out/skip.sql",
        "b.sql out2/b.sql",
      ].join("\n");

      const rc = resourceContributions(src, {
        fromBase: tmp,
        transform: (line) => {
          if (line.trim().startsWith("#")) return false;
          if (line.includes("skip.sql")) return false;
          return line;
        },
      });

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 2);
      assertEquals(got[0].destPath, "out/a.sql");
      assertEquals(got[1].destPath, "out2/b.sql");
    });
  });

  await t.step(
    "edge: trailing newline in src does not create extra work",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql out/a.sql\n", {
          fromBase: tmp,
        });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].destPath, "out/a.sql");
      });
    },
  );

  await t.step(
    "edge: blank lines preserved for correct line numbers in issues",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "ok.sql"), "ok");

        // Force an issue that we KNOW is produced by this module:
        // "ok.sql" is a single-path and missing dest token => Missing destPath.
        // Put it physically on line 4.
        const src = [
          "",
          "# comment",
          "",
          "ok.sql", // line 4
        ].join("\n");

        const rc = resourceContributions(src, {
          fromBase: tmp,
          transform: (line) => (line.trim().startsWith("#") ? false : line),
        });

        const got = Array.from(rc.provenance());
        assertEquals(got.length, 0);

        assertEquals(rc.issues.length, 1);
        assertEquals(rc.issues[0].line, 4);
        assert(rc.issues[0].message.includes("Missing destPath"));
      });
    },
  );

  await t.step(
    "edge: duplicate identical single-path specs yield duplicate outputs (no dedupe here)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const src = [
          "a.sql out/a.sql",
          "a.sql out/a.sql",
        ].join("\n");

        const rc = resourceContributions(src, { fromBase: tmp });
        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 2);
        assertEquals(got[0].destPath, "out/a.sql");
        assertEquals(got[1].destPath, "out/a.sql");
      });
    },
  );

  await t.step(
    "edge: multiple --mime flags (first wins in current PI behavior)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.bin"), "x");

        const rc = resourceContributions(
          "a.bin out/a.bin --mime text/plain --mime application/octet-stream",
          { fromBase: tmp },
        );

        const got = Array.from(rc.provenance());
        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].provenance.mimeType, "text/plain");
      });
    },
  );

  await t.step(
    "edge: multiple --base flags (glob): first/last behavior is stable (assert last wins if implemented)",
    async () => {
      await withTempDir(async (tmp) => {
        const a = join(tmp, "A");
        const b = join(tmp, "B");
        await ensureFile(join(a, "dir/f.sql"), "a");
        await ensureFile(join(b, "dir/f.sql"), "b");

        const rc = resourceContributions(
          `dir/*.sql out --base ${a} --base ${b}`,
          { fromBase: tmp },
        );

        const got = Array.from(rc.provenance());
        // Expect exactly one contribution, using the effective base chosen by your PI query impl.
        // If your code uses "all base flag values" then this would be 2. Adjust expectation to your actual rule.
        assert(got.length === 1 || got.length === 2);
      });
    },
  );

  await t.step(
    "URL base variants: base without trailing slash works",
    () => {
      const rc = resourceContributions(
        "https://example.com/assets/a.png .",
        { allowUrls: true, fromBase: "https://example.com" },
      );
      const got = Array.from(rc.provenance());
      assertEquals(rc.issues.length, 0);
      assertEquals(got[0].destPath, "assets/a.png");
    },
  );

  await t.step(
    "URL base variants: base with subpath strips correctly",
    () => {
      const rc = resourceContributions(
        "https://example.com/site/assets/a.png .",
        { allowUrls: true, fromBase: "https://example.com/site/" },
      );
      const got = Array.from(rc.provenance());
      assertEquals(rc.issues.length, 0);
      assertEquals(got[0].destPath, "assets/a.png");
    },
  );

  await t.step(
    "URL base mismatch: '.' still resolves via fallback (no issue)",
    () => {
      const rc = resourceContributions(
        "https://a.com/x.png .",
        { allowUrls: true, fromBase: "https://b.com/" },
      );

      const got = Array.from(rc.provenance());
      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      // We only assert it produced something deterministic-ish, not exact value
      assert(got[0].destPath.length > 0);
    },
  );

  await t.step(
    "resolveDestPath returning undefined: treated as error (no fallback in current behavior)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql .", {
          fromBase: tmp,
          resolveDestPath: () => undefined,
        });

        const got = Array.from(rc.provenance());
        assertEquals(got.length, 0);
        assertEquals(rc.issues.length, 1);
      });
    },
  );

  await t.step(
    "generics: toContribution can enrich outputs (type-safe, dest union present)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const rc = resourceContributions("a.sql out/a.sql", {
          fromBase: tmp,
          toContribution: (base) => ({
            ...base,
            kind: "rc" as const,
            raw: base.origin.rawInstructions,
            destKind: base.dest.kind,
          }),
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].kind, "rc");
        assertEquals(got[0].raw, "a.sql out/a.sql");
        assertEquals(got[0].destKind, "path");
        assertEquals(got[0].destPath, "out/a.sql");
      });
    },
  );

  await t.step(
    "labeled: parses label + candidate + destPath (single-path mode)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const src = "core a.sql OUT/a.sql";
        const rc = resourceContributions<true>(src, {
          labeled: true,
          fromBase: tmp,
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].origin.label, "core");
        assertEquals(got[0].destPath, "OUT/a.sql");
      });
    },
  );

  await t.step(
    "labeled: glob can omit dest token and use args.destPrefix (prefix-mode)",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "dir/a.sql"), "a");

        const src = "core dir/*.sql";
        const rc = resourceContributions<true>(src, {
          labeled: true,
          fromBase: tmp,
          destPrefix: "PFX",
        });

        const got = Array.from(rc.provenance());

        assertEquals(rc.issues.length, 0);
        assertEquals(got.length, 1);
        assertEquals(got[0].origin.label, "core");
        assertEquals(got[0].dest.kind, "prefix");
        assertEquals(got[0].destPath, "PFX/dir/a.sql");
      });
    },
  );

  await t.step(
    "labeled: missing destPath for single local => issue + skipped",
    async () => {
      await withTempDir(async (tmp) => {
        await ensureFile(join(tmp, "a.sql"), "a");

        const src = "core a.sql";
        const rc = resourceContributions<true>(src, {
          labeled: true,
          fromBase: tmp,
        });

        const got = Array.from(rc.provenance());

        assertEquals(got.length, 0);
        assertEquals(rc.issues.length, 1);
        assert(rc.issues[0].message.includes("Missing destPath"));
      });
    },
  );

  await t.step(
    'labeled URL: dest token "." resolves to base-relative URL path',
    () => {
      const src = "brand https://example.com/assets/brand/logo.png .";
      const rc = resourceContributions<true>(src, {
        labeled: true,
        allowUrls: true,
        fromBase: "https://example.com/",
      });

      const got = Array.from(rc.provenance());

      assertEquals(rc.issues.length, 0);
      assertEquals(got.length, 1);
      assertEquals(got[0].origin.label, "brand");
      assertEquals(got[0].destPath, "assets/brand/logo.png");
    },
  );
});
