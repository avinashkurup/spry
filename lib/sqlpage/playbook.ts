import { dirname } from "jsr:@std/path@^1";
import z from "jsr:@zod/zod@4";
import { MarkdownDoc } from "../markdown/fluent-doc.ts";
import {
  fbPartialsCollection,
  Issue,
  PlaybookCodeCell,
  Source,
} from "../markdown/notebook/mod.ts";
import {
  annotationsFactory,
  TaskDirectiveInspector,
  TaskDirectives,
  TasksProvenance,
} from "../task/cell.ts";
import { ensureLanguageByIdOrAlias } from "../universal/code.ts";
import {
  safeSourceText,
  SourceRelativeTo,
} from "../universal/content-acquisition.ts";
import { unsafeInterpolator } from "../universal/interpolate.ts";
import { forestToStatelessViews } from "../universal/path-tree-tabular.ts";
import { raw as rawSQL, SQL, sqlCat } from "../universal/sql-text.ts";
import { safeJsonStringify } from "../universal/tmpl-literal-aide.ts";
import { dropUndef } from "./conf.ts";
import {
  isSqlPageContent,
  SqlPageContent,
  sqlPageContentHelpers,
  SqlPageFileUpsert,
  sqlPagePathsFactory,
} from "./content.ts";
import * as interp from "./interpolate.ts";
import { markdownLinkFactory } from "./interpolate.ts";
import {
  isRouteSupplier,
  PageRoute,
  pageRouteSchema,
  pathExtensions,
  RoutesBuilder,
} from "./route.ts";

export type SqlPageProvenance = TasksProvenance;
export type SqlPageFrontmatter = Record<string, unknown> & {
  "sqlpage-conf"?: Record<string, unknown>;
};
export type SqlPageCellAttrs = Record<string, unknown>;
export type SqlPageIssue = Issue<SqlPageProvenance>;
export type SqlPageTDI = TaskDirectiveInspector<
  SqlPageProvenance,
  SqlPageFrontmatter,
  SqlPageCellAttrs,
  SqlPageIssue
>;

export const sqlCodeCellLangId = "sql" as const;
export const sqlCodeCellLangSpec = ensureLanguageByIdOrAlias(sqlCodeCellLangId);

export const sqlTaskHead = "HEAD" as const;
export const sqlTaskTail = "TAIL" as const;
export const sqlTaskSqlPageFileUpsert = "sqlpage_file-upsert" as const;
export const sqlTaskNature = [
  sqlTaskHead,
  sqlTaskTail,
  sqlTaskSqlPageFileUpsert,
] as const;
export type SqlTaskNature = typeof sqlTaskNature[number];

export function counter<Identifier>(identifier: Identifier, padValue = 4) {
  let value = -1;
  const incr = () => ++value;
  const nextPadded = () => String(incr()).padStart(padValue, "0");
  const nextText = (text = `${identifier}-`) =>
    `${text}${String(incr()).padStart(padValue, "0")}`;
  return { identifier, incr, nextPadded, nextText };
}

export function sqlHeadCellTDI(): SqlPageTDI {
  const heads = counter(sqlTaskHead);
  return ({ cell }) => {
    if (cell.language != sqlCodeCellLangId) return false;
    const pi = cell.parsedInfo;
    if (!pi) return false; // no identity, ignore
    if (pi.firstToken?.toLocaleUpperCase() != sqlTaskHead) return false;
    const identity = pi.secondToken ?? `sql.d/head/${heads.nextText()}`;
    return {
      nature: "CONTENT",
      identity,
      content: {
        kind: "head_sql",
        path: identity,
        contents: cell.source,
        cell,
      } satisfies SqlPageContent,
      language: sqlCodeCellLangSpec,
    };
  };
}

export function sqlTailCellTDI(): SqlPageTDI {
  const tails = counter(sqlTaskTail);
  return ({ cell }) => {
    if (cell.language != sqlCodeCellLangId) return false;
    const pi = cell.parsedInfo;
    if (!pi) return false; // no identity, ignore
    if (pi.firstToken?.toLocaleUpperCase() != sqlTaskHead) return false;
    const identity = pi.secondToken ?? `sql.d/head/${tails.nextText()}`;
    return {
      nature: "CONTENT",
      identity,
      content: {
        kind: "tail_sql",
        path: identity,
        contents: cell.source,
        cell,
      } satisfies SqlPageContent,
      language: sqlCodeCellLangSpec,
    };
  };
}

export function mutateRouteInCellAttrs(
  cell: PlaybookCodeCell<string, SqlPageCellAttrs>,
  identity: string,
  registerIssue?: (message: string, error?: unknown) => void,
  candidateAnns?: unknown, // if routes were supplied in annotation
) {
  const validated = (route: unknown) => {
    const parsed = z.safeParse(pageRouteSchema, route);
    if (!parsed.success) {
      registerIssue?.(
        `Zod error parsing route: ${z.prettifyError(parsed.error)}`,
        parsed.error,
      );
      return false;
    }
    return true;
  };

  // if no route was supplied in the cell attributes, use what's in annotations
  if (!isRouteSupplier(cell.attrs)) {
    if (candidateAnns) cell.attrs.route = candidateAnns;
    return validated(cell.attrs.route);
  }

  // if route was supplied in the cell attributes, merge with annotations with
  // what's in the annotations overriding what's in cell attributes
  if (isRouteSupplier(cell.attrs) && candidateAnns) {
    // deno-lint-ignore no-explicit-any
    (cell.attrs as any).route = { ...cell.attrs.route, ...candidateAnns };
    return validated(cell.attrs.route);
  }

  // if we get to here, it's the first time we're seeing cell attributes
  const route = cell.attrs.route as PageRoute;
  if (!route.path) route.path = identity;
  const extensions = pathExtensions(route.path);
  route.pathBasename = extensions.basename;
  route.pathBasenameNoExtn = extensions.basename.split(".")[0];
  route.pathDirname = dirname(route.path);
  route.pathExtnTerminal = extensions.terminal;
  route.pathExtns = extensions.extensions;
  return validated(route);
}

export function sqlPageFileCellTDI(): SqlPageTDI {
  return ({ cell, registerIssue }) => {
    if (cell.language != sqlCodeCellLangId) return false;
    const pi = cell.parsedInfo;
    if (!pi || !pi.firstToken) return false; // no identity, ignore
    const path = pi.firstToken;
    mutateRouteInCellAttrs(cell, path, registerIssue);
    return {
      nature: "CONTENT",
      identity: path,
      content: {
        kind: "sqlpage_file_upsert",
        path,
        contents: cell.source,
        cell,
        asErrorContents: (text) => text.replaceAll(/^/gm, "-- "),
        isUnsafeInterpolatable: true,
        isInjectableCandidate: true,
      } satisfies SqlPageContent,
      language: sqlCodeCellLangSpec,
    };
  };
}

export function sqlPagePlaybookState() {
  const partials = fbPartialsCollection();
  const directives = new TaskDirectives<
    SqlPageProvenance,
    SqlPageFrontmatter,
    SqlPageCellAttrs,
    SqlPageIssue
  >(partials);
  directives.use(sqlHeadCellTDI());
  directives.use(sqlTailCellTDI());
  directives.use(sqlPageFileCellTDI()); // order matters, put head/tail before SqlPageFile
  const routes = new RoutesBuilder();
  const spp = sqlPagePathsFactory();
  return { directives, routes, spp, partials };
}

export type SqlPagePlaybookState = ReturnType<typeof sqlPagePlaybookState>;

export function sqlPageInterpolator() {
  const context = (state: SqlPagePlaybookState) => {
    const { directives, routes } = state;
    const pagination = {
      active: undefined as undefined | ReturnType<typeof interp.pagination>,
      prepare: interp.pagination,
      debug: `/* \${paginate("tableOrViewName")} not called yet*/`,
      limit: `/* \${paginate("tableOrViewName")} not called yet*/`,
      navigation: `/* \${paginate("tableOrViewName")} not called yet*/`,
      navWithParams: (..._extraQueryParams: string[]) =>
        `/* \${paginate("tableOrViewName")} not called yet*/`,
    };
    return {
      state,
      directives,
      routes,
      pagination,
      absUrlQuoted: interp.absUrlQuoted,
      absUrlUnquoted: interp.absUrlUnquoted,
      absUrlUnquotedEncoded: interp.absUrlUnquotedEncoded,
      absUrlQuotedEncoded: interp.absUrlQuotedEncoded,
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
  };

  // "unsafely" means we're using JavaScript "eval"
  async function mutateUpsertUnsafely(
    ctx: ReturnType<typeof context>,
    spfu: SqlPageFileUpsert,
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    const { state: { directives } } = ctx;
    const { path } = spfu;

    let errSource: string | undefined;
    try {
      // "ic" is basically a "layout"
      const ic = spfu.isInjectableCandidate
        ? directives.partials.findInjectableForPath(path)
        : undefined;

      if (spfu.isUnsafeInterpolatable) {
        const source = ic?.injection?.wrap(spfu.contents) ?? spfu.contents;
        errSource = source;

        const commonLocals = {
          pagination: ctx.pagination,
          paginate: ctx.paginate,
          safeJsonStringify,
          SQL,
          cat: sqlCat,
          md: ctx.md,
          raw: rawSQL,
          ...spfu.cell?.attrs,
          ...spfu,
        };

        // NOTE: This is intentionally unsafe. Do not feed untrusted content.
        // Assume you're treating code cell blocks as fully trusted source code.
        const mutated = await unsafeInterp.interpolate(source, {
          ...commonLocals,
          partial: async (
            name: string,
            partialLocals?: Record<string, unknown>,
          ) => {
            const found = directives.partials.get(name);
            if (found) {
              const partialCell = directives.partialDirectives.find((pd) =>
                pd.partialDirective.partial.identity == found.identity
              );
              const { content: partial, interpolate, locals } = await found
                .content({
                  ...partialLocals,
                  ...commonLocals,
                  partial: partialCell,
                });
              if (!interpolate) return partial;
              return await unsafeInterp.interpolate(partial, locals, [{
                template: partial,
              }]);
            } else {
              return `/* partial '${name}' not found */`;
            }
          },
        });

        if (mutated !== spfu.contents) {
          spfu.contents = String(mutated);
          spfu.isInterpolated = true;
        }
      } else if (ic && ic.injection) {
        spfu.contents = ic.injection.wrap(spfu.contents);
      }

      if (ic) spfu.partialInjected = ic;
      return spfu;
    } catch (error) {
      spfu.error = error;
      return {
        ...spfu,
        contents: spfu.asErrorContents(
          `finalSqlPageFileEntries error: ${
            String(error)
          }\n*****\nSOURCE:\n${errSource}\n${
            safeJsonStringify({ ctx: unsafeInterp.ctx, spf: spfu }, 2)
          }`,
          error,
        ),
      };
    }
  }

  // "unsafely" means we're using JavaScript "eval"
  async function mutateContentUnsafely(
    ctx: ReturnType<typeof context>,
    spc: SqlPageContent,
    unsafeInterp: ReturnType<typeof unsafeInterpolator>,
  ) {
    if (spc.kind === "sqlpage_file_upsert") {
      return await mutateUpsertUnsafely(ctx, spc, unsafeInterp);
    }
    return spc;
  }

  return { context, mutateUpsertUnsafely, mutateContentUnsafely };
}

export class SqlPagePlaybook {
  protected constructor() {
  }

  async *sources(init: { mdSources: string[]; srcRelTo: SourceRelativeTo }) {
    for await (const md of init.mdSources) {
      const safeMdSrc = await safeSourceText(md, init.srcRelTo, {
        baseUrl: new URL(import.meta.url),
      });
      if (safeMdSrc.nature == "error") {
        console.error(safeMdSrc);
        continue;
      }
      yield {
        provenance: typeof safeMdSrc.source === "string"
          ? safeMdSrc.source
          : safeMdSrc.source.href,
        content: safeMdSrc.text,
      } satisfies Source<SqlPageProvenance>;
    }
  }

  async populateContent(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const { state } = init;
    const { directives: td } = state;

    /*  Markdown Files' Fenced Cells
        ↓
        NotebookCodeCell (syntactic)
           ↓
           PlaybookCodeCell (contextual)
               ↓
               TaskDirective (semantic)
                   ↓
                   Task / TaskCell (executable)
                       ↓
                       TASK (executable)
                       CONTENT (optionally executable) */

    // directives now has all the tasks/content across all notebooks in memory
    await td.populate(() => this.sources(init));

    const spInterpolator = sqlPageInterpolator();
    const spiContext = spInterpolator.context(state);
    const unsafeInterp = unsafeInterpolator(spiContext);
    const routeAnnsF = annotationsFactory({
      language: sqlCodeCellLangSpec,
      prefix: "route.",
    });

    return {
      state,
      spInterpolator,
      spiContext,
      unsafeInterp,
      routeAnnsF,
    };
  }

  async *sqlPageFiles(
    init: {
      mdSources: string[];
      srcRelTo: SourceRelativeTo;
      state: SqlPagePlaybookState;
    },
  ) {
    const p = await this.populateContent(init);
    const { state, spInterpolator, spiContext, unsafeInterp, routeAnnsF } = p;
    const { directives, routes } = state;
    const { sql: sqlSPF, json: jsonSPF } = sqlPageContentHelpers();

    for (const pd of directives.partialDirectives) {
      yield sqlSPF(
        `spry.d/auto/partial/${pd.partialDirective.partial.identity}.auto.sql`,
        `-- ${safeJsonStringify(pd)}\n${pd.partialDirective.partial.source}`,
        { isPartial: true, cell: pd },
      );
    }

    const { mutateContentUnsafely } = spInterpolator;
    for await (const t of directives.tasks) {
      const { taskDirective: td } = t;
      if (td.nature === "CONTENT" && isSqlPageContent(td.content)) {
        const mutated = await mutateContentUnsafely(
          spiContext,
          td.content,
          unsafeInterp,
        );
        // see if any @route.* annotations are supplied in the mutated content
        // and merge them with existing { route: {...} } cell
        const route = routeAnnsF.transform(
          await routeAnnsF.catalog(mutated.contents),
        );
        if (route) mutateRouteInCellAttrs(t, mutated.path, undefined, route);
        yield mutated;
        if (td.content.cell) {
          const cell = td.content.cell;
          yield jsonSPF(
            `spry.d/auto/cell/${td.content.path}.auto.json`,
            safeJsonStringify(cell, 2),
            { cell, isAutoGenerated: true },
          );
          if (cell.instructions) {
            yield jsonSPF(
              `spry.d/auto/instructions/${td.content.path}.auto.md`,
              cell.instructions.markdown,
              { cell, isAutoGenerated: true },
            );
          }
          if (Object.entries(cell.attrs).length) {
            yield jsonSPF(
              `spry.d/auto/resource/${td.content.path}.auto.json`,
              JSON.stringify(dropUndef(cell.attrs), null, 2),
              { cell, isAutoGenerated: true },
            );
          }
        }
      }

      // now that all content mutations (template replacements) are completed,
      // build the routes tree from anything with { route: {...} } in fenced
      // attrs or @route annotations
      if (isRouteSupplier(t.attrs)) {
        routes.encounter(t.attrs.route as PageRoute);
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

    yield jsonSPF(`spry.d/README.md`, this.dropInAutoReadme().write(), {
      isAutoGenerated: true,
    });

    return p;
  }

  // deno-fmt-ignore
  protected dropInAutoReadme() {
     const md = new MarkdownDoc();
      md.h1("Spry Dropin Resources and Routes");
      md.pTag`After annotations are parsed and validated, Spry generates the following in \`spry.d/auto\`:`;
      md.li("`../sql.d/head/*.sql` contains `HEAD` SQL files that are inserted before sqlpage_files upserts")
      md.li("`../sql.d/tail/*.sql` contains `TAIL` SQL files that are inserted after sqlpage_files upserts")
      md.li("[`../sql.d/tail/navigation.auto.sql`](../sql.d/tail/navigation.auto.sql) contains `TAIL` SQL file which describes all the JSON content in relational database format")
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

  static instance() {
    return new SqlPagePlaybook();
  }
}
