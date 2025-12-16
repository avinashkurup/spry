import { parse } from "@std/path";
import z from "@zod/zod";
import { codeFrontmatter } from "../../axiom/mdast/code-frontmatter.ts";
import {
  codeInterpolationStrategy,
} from "../../axiom/mdast/code-interpolate.ts";
import {
  Directive,
  isMaterializable,
  PlaybookProjection,
  playbooksFromFiles,
} from "../../axiom/projection/playbook.ts";
import {
  contributeKeyword,
  ContributeSpec,
  isContributeSpec,
} from "../../axiom/remark/code-contribute.ts";
import { docFrontmatterDataBag } from "../../axiom/remark/doc-frontmatter.ts";
import { annotationsFactory } from "../../universal/annotations.ts";
import { MarkdownDoc } from "../../universal/fluent-md.ts";
import { forestToStatelessViews } from "../../universal/path-tree-tabular.ts";
import { renderer } from "../../universal/render.ts";
import {
  isRouteSupplier,
  PageRoute,
  RoutesBuilder,
} from "../../universal/route.ts";
import { raw as rawSQL, SQL, sqlCat } from "../../universal/sql-text.ts";
import { safeJsonStringify } from "../../universal/tmpl-literal-aide.ts";
import {
  contentSuppliers,
  mutateRouteInCellAttrs,
  sqlCodeCellLangSpec,
  SqlPageFileUpsert,
  SqlPageHeadOrTail,
  sqlPagePathsFactory,
} from "./content.ts";
import * as interp from "./interpolate.ts";
import { markdownLinkFactory } from "./interpolate.ts";

export const sqlPageConfSchema = z.object({
  // Core server & DB
  database_url: z.string().min(1).optional(),
  database_password: z.string().min(1).optional(), // optional, supported in newer versions
  listen_on: z.string().min(1).optional(), // e.g. "0.0.0.0:8080"
  port: z.number().min(1).optional(),
  web_root: z.string().min(1).optional(),

  // Routing / base path
  site_prefix: z.string().min(1).optional(), // e.g. "/sqlpage"

  // HTTPS / host
  https_domain: z.string().min(1).optional(), // e.g. "example.com"
  host: z.string().min(1).optional(), // required by SSO; must match domain exactly

  // Security / limits
  allow_exec: z.boolean().optional(),
  max_uploaded_file_size: z.number().int().positive().optional(),

  // Environment
  environment: z.enum(["production", "development"]).optional(),

  // Frontmatter-friendly nested OIDC
  oidc: z.object({
    issuer_url: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    redirect_path: z.string().min(1).optional(),
  }).optional(),

  // Also accept already-flat OIDC keys (as SQLPage expects in json)
  oidc_issuer_url: z.string().min(1).optional(),
  oidc_client_id: z.string().min(1).optional(),
  oidc_client_secret: z.string().min(1).optional(),
}).catchall(z.unknown());

export type SqlPageConf = z.infer<typeof sqlPageConfSchema>;

// Utility: drop undefined recursively
export function dropUndef<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = dropUndef(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// Produces the exact JSON object you can write to sqlpage/sqlpage.json
export function sqlPageConf(conf: z.infer<typeof sqlPageConfSchema>) {
  // Start from a shallow clone
  const out: Record<string, unknown> = { ...conf };

  // Flatten nested OIDC if provided
  if (conf.oidc) {
    const { issuer_url, client_id, client_secret, scopes, redirect_path } =
      conf.oidc;
    // Only set flat keys if not already set at top level
    if (issuer_url && out.oidc_issuer_url === undefined) {
      out.oidc_issuer_url = issuer_url;
    }
    if (client_id && out.oidc_client_id === undefined) {
      out.oidc_client_id = client_id;
    }
    if (client_secret && out.oidc_client_secret === undefined) {
      out.oidc_client_secret = client_secret;
    }
    if (scopes !== undefined) out.oidc_scopes = scopes; // SQLPage ignores unknowns; keeping for future
    if (redirect_path !== undefined) out.oidc_redirect_path = redirect_path;
    delete out.oidc;
  }

  // Clean undefineds
  return dropUndef(out);
}

export function sqlPageInterpolator(
  playbook: PlaybookProjection,
  directives: Iterable<Directive>,
) {
  const pagination = {
    active: undefined as undefined | ReturnType<typeof interp.pagination>,
    prepare: interp.pagination,
    debug: `/* \${paginate("tableOrViewName")} not called yet*/`,
    limit: `/* \${paginate("tableOrViewName")} not called yet*/`,
    navigation: `/* \${paginate("tableOrViewName")} not called yet*/`,
    navWithParams: (..._extraQueryParams: string[]) =>
      `/* \${paginate("tableOrViewName")} not called yet*/`,
  };

  // available as "ctx.*" in ${...} variables
  const globals = {
    env: Deno.env.toObject(),
    pagination,
    playbook,
    absUrlQuoted: interp.absUrlQuoted,
    absUrlUnquoted: interp.absUrlUnquoted,
    absUrlUnquotedEncoded: interp.absUrlUnquotedEncoded,
    absUrlQuotedEncoded: interp.absUrlQuotedEncoded,
    breadcrumbs: interp.breadcrumbs,
    sitePrefixed: interp.absUrlQuoted,
    md: markdownLinkFactory({ url_encode: "replace" }),
    rawSQL,
    sqlCat,
    SQL,
    paginate: (tableOrViewName: string, whereSQL?: string) => {
      const pn = interp.pagination({ tableOrViewName, whereSQL });
      pagination.active = pn;
      pagination.debug = pn.debugVars();
      pagination.limit = pn.limit();
      pagination.navigation = pn.navigation();
      pagination.navWithParams = pn.navigation;
      return pagination.active.init();
    },
  };

  const strategy = codeInterpolationStrategy(directives, {
    approach: "unsafe-allowed",
    unsafeGlobalsCtxName: "ctx",
    globals,
  });

  // available as "locals" in ${...} variables without "ctx." prefix
  const typicalLocals = {
    pagination: globals.pagination,
    paginate: globals.paginate,
    SQL,
    cat: sqlCat,
    md: globals.md,
    raw: rawSQL,
  };

  const interpolator = renderer(strategy);

  return { strategy, typicalLocals, globals, interpolator };
}

export async function* sqlPageFiles(
  playbook: Awaited<ReturnType<typeof sqlPagePlaybook>>,
  mode: "typical" | "package",
) {
  const { sources, routes, materializables, routeAnnsF, directives } = playbook;
  const { sqlSPF, jsonSPF, handlers: csHandlers, contents } =
    contentSuppliers();

  const spi = sqlPageInterpolator(playbook, directives);

  const ensureExtn = (name: string, ext: string) =>
    parse(name).ext.toLowerCase() === ext.toLowerCase()
      ? name
      : `${name}${ext}`;

  for (const src of sources) {
    if (docFrontmatterDataBag.is(src.mdastRoot)) {
      const fm = src.mdastRoot.data.documentFrontmatter.parsed.fm;
      yield sqlSPF(
        `spry.d/auto/frontmatter/${src.file.basename}.auto.json`,
        JSON.stringify(fm, null, 2),
      );
    }
  }

  const contribSPFs: ContributeSpec[] = [];

  for (const d of directives) {
    switch (d.directive) {
      case "HEAD":
        yield {
          kind: "head_sql",
          path: ensureExtn(`sql.d/head/${d.identity}`, ".sql"),
          cell: d,
          ...contents(d, codeFrontmatter(d)),
        } satisfies SqlPageHeadOrTail;
        break;

      case "TAIL":
        yield {
          kind: "tail_sql",
          path: ensureExtn(`sql.d/tail/${d.identity}`, ".sql"),
          cell: d,
          ...contents(d, codeFrontmatter(d)),
        } satisfies SqlPageHeadOrTail;
        break;

      case contributeKeyword:
        if (isContributeSpec(d) && d.identity == "sqlpage_files") {
          contribSPFs.push(d);
        }
    }
  }

  const { interpolator: { renderOne }, typicalLocals } = spi;

  for await (const m of materializables) {
    const handlers = csHandlers(m.language);
    for (const handler of handlers) {
      const spc = await handler(m, {
        registerIssue: (message, error) =>
          console.error(`ERROR: ${message} ${error}`),
      });
      if (spc) {
        if (typeof spc.contents === "string") {
          const rendered = await renderOne(m, {
            body: () => spc.contents,
            locals: (locals) => ({
              ...typicalLocals,
              ...locals,
              cell: m,
              path: spc.path,
              spc,
            }),
          });
          spc.contents = rendered.text;
          // see if any @route.* annotations are supplied in the mutated content
          // and merge them with existing { route: {...} } cell
          const route = routeAnnsF.transform(
            await routeAnnsF.catalog(rendered.text),
          );
          if (route) {
            mutateRouteInCellAttrs(m, spc.path, undefined, route);
          }
        }
        yield spc;
        if (isMaterializable(spc.cell)) {
          const cell = spc.cell;
          if (!cell.isBlob) {
            yield jsonSPF(
              `spry.d/auto/cell/${spc.path}.auto.json`,
              safeJsonStringify(cell, 2),
              { cell, isAutoGenerated: true },
            );
          }
          // TODO: add Markdown context "instructions" (before the cell)
          // if (cell.instructions) {
          //   yield jsonSPF(
          //     `spry.d/auto/instructions/${td.content.path}.auto.md`,
          //     cell.instructions.markdown,
          //     { cell, isAutoGenerated: true },
          //   );
          // }
          if (
            cell.materializationAttrs &&
            Object.entries(cell.materializationAttrs).length
          ) {
            yield jsonSPF(
              `spry.d/auto/resource/${spc.path}.auto.json`,
              JSON.stringify(dropUndef(cell.materializationAttrs), null, 2),
              { cell, isAutoGenerated: true },
            );
          }
        }
      }
    }

    // now that all content mutations (template replacements) are completed,
    // build the routes tree from anything with { route: {...} } in fenced
    // attrs or @route annotations
    if (isRouteSupplier(m.materializationAttrs)) {
      routes.encounter(m.materializationAttrs.route as PageRoute);
    }
  }

  const { forest, breadcrumbs, edges, serializers } = await routes.resolved();

  yield sqlSPF(
    `spry.d/auto/route/tree.auto.txt`,
    serializers.asciiTreeText({
      showPath: true,
      includeCounts: true,
    }),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/forest.auto.json`,
    JSON.stringify(forest.roots, null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/forest.schema.auto.json`,
    JSON.stringify(z.toJSONSchema(forest.schemas.forest), null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/breadcrumbs.auto.json`,
    JSON.stringify(breadcrumbs.crumbs, null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/breadcrumbs.schema.auto.json`,
    JSON.stringify(z.toJSONSchema(breadcrumbs.schema), null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/edges.auto.json`,
    JSON.stringify(edges.edges, null, 2),
    { isAutoGenerated: true },
  );
  yield jsonSPF(
    `spry.d/auto/route/edges.schema.auto.json`,
    JSON.stringify(z.toJSONSchema(edges.schemas.edges), null, 2),
    { isAutoGenerated: true },
  );

  const sv = forestToStatelessViews(forest, { viewPrefix: "navigation_" });
  yield sqlSPF(`sql.d/tail/navigation.auto.sql`, sv.sql, {
    kind: "tail_sql",
  });

  yield jsonSPF(`spry.d/README.md`, dropInAutoReadme().write(), {
    isAutoGenerated: true,
  });

  let contribsIndex = 0;
  for (const c of contribSPFs) {
    // TODO: do we need to use resolveBasePath?
    // TODO: should we interpolate? or allow injections?
    const contribs = c.contributables({ allowUrls: true });
    const contribModes = c.contributeQPI.getTextFlagValues("mode");

    const encountered = Array.from(contribs.provenance());
    yield jsonSPF(
      `spry.d/auto/contribute/${
        contribSPFs.length > 1 ? `${c.identity}${contribsIndex}` : c.identity
      }.auto.json`,
      safeJsonStringify({
        origin: {
          blockBases: contribs.blockBases,
          issues: contribs.issues,
          contribModes,
        },
        resources: encountered,
      }, 2),
      { cell: c, isAutoGenerated: true },
    );
    contribsIndex++;

    if (contribModes.length && !contribModes.find((m) => m === mode)) continue;

    for await (const r of contribs.resources()) {
      const contents = r.strategy.encoding === "utf8-text"
        ? await r.safeText(
          `Unable to read ${
            JSON.stringify({ strategy: r.strategy, provenance: r.provenance })
          }`,
        )
        : await r.stream();
      yield {
        kind: "sqlpage_file_upsert",
        path: r.provenance.destPath,
        contents: contents instanceof Error
          ? JSON.stringify(contents)
          : contents,
        isBinary: false,
        asErrorContents: (text) => text,
      } satisfies SqlPageFileUpsert;
    }
  }
}

// deno-fmt-ignore
export function dropInAutoReadme() {
    const md = new MarkdownDoc();
    md.h1("Spry Dropin Resources and Routes");
    md.pTag`After annotations are parsed and validated, Spry generates the following in \`spry.d/auto\`:`;
    md.li("`../sql.d/head/*.sql` contains `HEAD` SQL files that are inserted before sqlpage_files upserts")
    md.li("`../sql.d/tail/*.sql` contains `TAIL` SQL files that are inserted after sqlpage_files upserts")
    md.li("[`../sql.d/tail/navigation.auto.sql`](../sql.d/tail/navigation.auto.sql) contains `TAIL` SQL file which describes all the JSON content in relational database format")
    md.li("`auto/cell/` directory contains each markdown source file's cells in JSON.")
    md.li("`auto/frontmatter/` directory contains each markdown source file's frontmatter in JSON (after it's been interpolated).")
    md.li("`auto/instructions/` directory contains the markdown source before each SQLPage `sql` fenced blocks individually.")
    md.li("`auto/resource/` directory contains parsed fence attributes blocks like { route: { ... } } and `@spry.*` with `@route.*` embedded annotations for each route / endpoint individually.")
    md.li("`auto/route/` directory contains route annotations JSON for each route / endpoint individually.")
    md.li("[`auto/route/breadcrumbs.auto.json`](auto/route/breadcrumbs.auto.json) contains computed \"breadcrumbs\" for each @route.* annotation.")
    md.li("[`auto/route/breadcrumbs.schema.auto.json`](auto/route/breadcrumbs.schema.auto.json) contains JSON schema for `route/breadcrumbs.auto.json`")
    md.li("[`auto/route/edges.auto.json`](auto/route/edges.auto.json) contains route edges to conveniently build graph with `forest.auto.json`.")
    md.li("[`auto/route/edges.schema.auto.json`](auto/route/edges.schema.auto.json) contains JSON schema for `route/edges.auto.json`")
    md.li("[`auto/route/forest.auto.json`](auto/route/forest.auto.json) contains full routes ('forest') in JSON format.")
    md.li("[`auto/route/forest.schema.auto.json`](auto/route/forest.schema.auto.json) JSON schema for `route/forest.auto.json`.")
    md.li("[`auto/route/tree.auto.txt`](auto/route/tree.auto.txt) contains route tree in ASCII text format.")
    return md;
  }

export async function sqlPagePlaybook(
  markdownPaths: Parameters<typeof playbooksFromFiles>[0],
  options?: Parameters<typeof playbooksFromFiles>[1],
) {
  const pbff = await playbooksFromFiles(markdownPaths, options);
  const routes = new RoutesBuilder();
  const spp = sqlPagePathsFactory();
  const routeAnnsF = annotationsFactory({
    language: sqlCodeCellLangSpec,
    prefix: "route.",
  });

  return { ...pbff, routes, spp, routeAnnsF };
}
