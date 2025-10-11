import { basename, dirname, join } from "jsr:@std/path@^1";
import { z } from "jsr:@zod/zod@4";
import { DocCodeCellMutator } from "../notebook/mod.ts";
import {
  forestToEdges,
  pathTree,
  pathTreeNavigation,
  pathTreeSerializers,
} from "../universal/path-tree.ts";

export const pageRouteSchema = z.object({
  path: z.string().describe(
    "Logical route path; the primary key within a namespace.",
  ),
  pathBasename: z.string().optional().describe(
    "The path's basename without any directory path (usually computed by default from path)",
  ),
  pathBasenameNoExtn: z.string().optional().describe(
    "The path's basename without any directory path or extension (usually computed by default from path)",
  ),
  pathDirname: z.string().optional().describe(
    "The path's dirname without any name (usually computed by default from path)",
  ),
  pathExtnTerminal: z.string().optional().describe(
    "The path's terminal (last) extension (like .sql, usually computed by default from path)",
  ),
  pathExtns: z.array(z.string()).optional().describe(
    "The path's full set of extensions if there multiple (like .sql.ts, usually computed by default from path)",
  ),
  caption: z.string().describe(
    "Human-friendly general-purpose name for display.",
  ),
  siblingOrder: z.number().optional().describe(
    "Optional integer to order children within the same parent.",
  ),
  url: z.string().optional().describe(
    "Optional external or alternate link target; defaults to using `path` when omitted.",
  ),
  title: z.string().optional().describe(
    "Full/long title for detailed contexts; defaults to `caption` when omitted.",
  ),
  abbreviatedCaption: z.string().optional().describe(
    "Short label for breadcrumbs or compact UIs; defaults to `caption` when omitted.",
  ),
  description: z.string().optional().describe(
    "Long-form explanation or summary of the route.",
  ),
  elaboration: z.json().optional().describe(
    'Optional structured attributes (e.g., { "target": "_blank", "lang": { "fr": { "caption": "..." } } }).',
  ),
  children: z.array(z.object({ path: z.string().describe("Child path") }))
    .optional().describe(
      "Simple array of paths filled out by path-tree computing and made available via SQL on the server",
    ),
}).strict().describe(
  "Navigation route annotation, supports hierarchy and ordered siblings.",
);

export type PageRoute = z.infer<typeof pageRouteSchema>;

export type RouteSupplier = {
  readonly route: PageRoute;
};

export const isRouteSupplier = (o: unknown): o is RouteSupplier =>
  o && typeof o === "object" && "route" in o &&
    typeof o.route === "object"
    ? true
    : false;

export function pathExtensions(path: string) {
  const name = basename(path);
  const parts = name.split(".");
  const exts = parts.slice(1).map((
    e,
    i,
    a,
  ) => (i < a.length - 1 ? `.${e}` : e));
  const terminal = exts[exts.length - 1] ?? "";
  return {
    basename: name,
    extensions: exts,
    terminal,
    autoMaterializable: () => {
      if (exts.length < 2) return false;
      const base = parts[0];
      const penultimate = parts[parts.length - 2];
      return join(
        dirname(path),
        `${base}.${
          penultimate.split(".").slice(0, -1).join(".")
        }auto.${penultimate}`,
      );
    },
  };
}

export const enrichRoute: DocCodeCellMutator<string> = (
  cell,
  { nb, registerIssue },
) => {
  if (!isRouteSupplier(cell.attrs)) return;
  const route = cell.attrs.route as PageRoute;
  if (!route.path && cell.info) {
    route.path = cell.info;
  }
  const extensions = pathExtensions(route.path);
  route.pathBasename = extensions.basename;
  route.pathBasenameNoExtn = extensions.basename.split(".")[0];
  route.pathDirname = dirname(route.path);
  route.pathExtnTerminal = extensions.terminal;
  route.pathExtns = extensions.extensions;
  const parsed = z.safeParse(pageRouteSchema, route);
  if (!parsed.success) {
    registerIssue({
      kind: "fence-attrs-json5-parse",
      disposition: "error",
      error: parsed.error,
      message: `Zod error parsing route: ${z.prettifyError(parsed.error)}`,
      provenance: nb.notebook.provenance,
      startLine: cell.startLine,
      endLine: cell.endLine,
    });
  }
};

export class Routes {
  constructor(readonly routeAnns: Iterable<PageRoute>) {
  }

  async populate() {
    const forest = await pathTree<PageRoute, string>(
      this.routeAnns,
      {
        nodePath: (n) => n.path,
        pathDelim: "/",
        synthesizeContainers: true,
        folderFirst: false,
        indexBasenames: ["index.sql"],
      },
    );

    const tree = forest.roots;
    const nav = pathTreeNavigation(forest);
    const edges = forestToEdges(forest);
    const serializers = pathTreeSerializers(forest);

    // const breadcrumbsSchema =
    const crumbs: z.infer<typeof nav.schemas.breadcrumbsMap> = {};
    for (const node of forest.treeByPath.values()) {
      if (node.payloads) {
        for (const p of node.payloads) {
          crumbs[p.path] = nav.ancestors(p);
        }
      }
    }
    return {
      forest,
      tree,
      breadcrumbs: { crumbs, schema: nav.schemas.breadcrumbsMap },
      serializers,
      edges,
    };
  }
}
