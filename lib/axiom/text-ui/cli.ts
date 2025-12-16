#!/usr/bin/env -S deno run -A --node-modules-dir=auto

// cli.ts
//
// Spry Graph Viewer CLI
// - Reads Markdown fixture(s)
// - Builds a FlexibleProjection via flexibleProjectionFromFiles()
// - Shows the containedInSection hierarchy in a TUI tree

import { Command } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import { bold, gray, magenta, yellow } from "@std/fmt/colors";
import type { Node, Position } from "types/unist";
import { inspect } from "unist-util-inspect";
import { selectAll } from "unist-util-select";
import { ListerBuilder } from "../../universal/lister-tabular-tui.ts";
import { TreeLister } from "../../universal/lister-tree-tui.ts";
import { shebang } from "../../universal/pmd-shebang.ts";
import { computeSemVerSync } from "../../universal/version.ts";
import { headingLikeNodeDataBag } from "../edge/rule/mod.ts";
import { markdownASTs } from "../io/mod.ts";
import { flexibleProjectionFromFiles } from "../projection/flexible.ts";
import * as webUI from "../web-ui/service.ts";

type FlexibleProjection = Awaited<
  ReturnType<typeof flexibleProjectionFromFiles>
>;

type HierarchyRow = {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
  readonly type: string;
  readonly dataKeys?: string;
  readonly fileRef?: string;
};

// We only need the parts of HierarchyNode that are relevant for this CLI.
type HierarchyNode = {
  nodeId: string;
  children: HierarchyNode[];
};

type PositionedNode = Node & { position?: Position };
type DataNode = Node & { data?: Record<string, unknown> };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function resolveMarkdownPaths(
  positional: string[],
  defaultFiles: string[] | undefined,
): string[] {
  if (positional.length > 0) return positional;
  if (defaultFiles && defaultFiles.length > 0) return defaultFiles;
  return [];
}

/**
 * Build flat rows suitable for TreeLister from the FlexibleProjection
 * for a single hierarchical relationship (e.g., "containedInSection").
 *
 * `includeNodeType` controls which mdast node.type values are rendered as rows.
 * Nodes whose type does not satisfy `includeNodeType(type)` are skipped, but
 * their children are still traversed and attached to the nearest visible
 * ancestor.
 */
function buildHierarchyRowsForRelationship(
  model: FlexibleProjection,
  relName: string,
  includeNodeType: (node: Node) => boolean,
): HierarchyRow[] {
  const rows: HierarchyRow[] = [];

  const hierByDoc = model.hierarchies?.[relName] ?? {};
  const documents = model.documents;
  const nodes = model.nodes;
  const mdastStore = model.mdastStore;

  const docLabelById = new Map<string, string>();
  for (const d of documents) {
    docLabelById.set(d.id, d.label);
  }

  for (const [docId, forest] of Object.entries(hierByDoc)) {
    const docLabel = docLabelById.get(docId) ??
      documents.find((d) => d.id === docId)?.label ??
      docId;

    // Document root row
    const docRowId = `${docId}#root`;
    rows.push({
      id: docRowId,
      parentId: undefined,
      label: bold(docLabel),
      type: "document",
    });

    const emit = (node: HierarchyNode, parentId: string) => {
      const gvNode = nodes[node.nodeId];

      const type = gvNode?.type ?? "unknown";
      const label = gvNode?.label ?? node.nodeId;

      let dataKeys: string | undefined;
      let fileRef: string | undefined;

      // Only render this node if its mdast type is allowed.
      // Children are always traversed and attach to the nearest
      // visible ancestor (thisParentId).
      let thisParentId = parentId;

      if (
        gvNode &&
        typeof gvNode.mdastIndex === "number" &&
        Array.isArray(mdastStore)
      ) {
        const mdNode = mdastStore[gvNode.mdastIndex] as
          & DataNode
          & PositionedNode;

        // node.data keys
        if (mdNode.data && typeof mdNode.data === "object") {
          const keys = Object.keys(mdNode.data);
          if (keys.length > 0) {
            dataKeys = keys.join(", ");
          }
        }

        // fileRef-style "file:line:column"
        const pos = mdNode.position?.start;
        if (docLabel) {
          if (pos?.line != null) {
            const col = pos.column ?? 1;
            fileRef = `${docLabel}:${pos.line}:${col}`;
          } else {
            fileRef = docLabel;
          }
        }

        if (includeNodeType(mdNode)) {
          const rowId = `${docId}:${node.nodeId}:${rows.length}`;

          rows.push({
            id: rowId,
            parentId,
            label,
            type,
            dataKeys,
            fileRef,
          });

          thisParentId = rowId;
        }
      }

      if (Array.isArray(node.children)) {
        for (const ch of node.children) {
          emit(ch, thisParentId);
        }
      }
    };

    if (Array.isArray(forest)) {
      const hierarchyForest = forest as unknown as HierarchyNode[];
      for (const rootNode of hierarchyForest) {
        emit(rootNode, docRowId);
      }
    }
  }

  return rows;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

export class CLI {
  readonly webUiCLI: webUI.CLI;

  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[];
      readonly mdastCLI?: webUI.CLI;
    },
  ) {
    this.webUiCLI = conf?.mdastCLI ??
      new webUI.CLI({ defaultFiles: conf?.defaultFiles });
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd(subcommand?: string) {
    const description = "Spry Axiom Explorer CLI";
    const compose = subcommand
      ? new Command().name(subcommand).description(description)
      : new Command()
        .name("Spry Axiom")
        .version(() => computeSemVerSync(import.meta.url))
        .description(description)
        .command("help", new HelpCommand())
        .command("completions", new CompletionsCommand());

    for (
      const c of [
        this.webUiCLI.webUiCommand(),
        this.lsCommand(),
        this.inspectCommand(),
        this.projectionCommand(),
        this.shebangCommand(),
      ]
    ) {
      compose.command(c.getName(), c);
    }

    return compose;
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const cmdName = "ls";
    const { defaultFiles } = this.conf ?? {};
    return new Command()
      .example(
        `default ${
          (defaultFiles?.length ?? 0) > 0 ? `(${defaultFiles?.join(", ")})` : ""
        }`,
        `${cmdName} ${examplesCmd}`,
      )
      .example(
        "load md from local fs",
        `${cmdName} ${examplesCmd} ./runbook.md`,
      )
      .example(
        "load md from remote URL",
        `${cmdName} ${examplesCmd} https://SpryMD.org/runbook.md`,
      )
      .example(
        "load md from multiple",
        `${cmdName} ${examplesCmd} ./runbook.d https://qualityfolio.dev/runbook.md another.md`,
      );
  }

  inspectCommand(cmdName = "inspect") {
    return this.baseCommand({ examplesCmd: cmdName }).name(cmdName)
      .description("inspect mdast nodes as a hierarchy")
      .arguments("[paths...:string]")
      .option("--no-color", "Show output without ANSI colors")
      .action(
        async (options: { color?: boolean }, ...paths: string[]) => {
          const markdownPaths = resolveMarkdownPaths(
            paths,
            this.conf?.defaultFiles,
          );

          if (markdownPaths.length === 0) {
            console.log(
              gray(
                "No markdown paths provided and no default files configured.",
              ),
            );
            return;
          }

          for await (const mdAST of markdownASTs(markdownPaths)) {
            // mdast `inspect` does not like functions in code nodes
            // (like `contributables` in ContributeSpec)
            selectAll("code", mdAST.mdastRoot).forEach((code) => {
              const obj = code as unknown as Record<string, unknown>;
              for (const key in obj) {
                if (typeof obj[key] === "function") {
                  delete obj[key];
                }
              }
            });
            console.log(inspect(mdAST.mdastRoot, { color: options.color }));
          }
        },
      );
  }

  shebangCommand(cmdName = "shebang") {
    return this.baseCommand({ examplesCmd: cmdName }).name(cmdName)
      .description(
        "convert markdown files into executables with shebang (#!) helpers",
      )
      .arguments("[paths...:string]")
      .option("--dry-run", "Emit the shebang line without updating")
      .option("--entrypoint <ep:string>", "The launcher to use", {
        default: "./cli.ts",
      })
      .action(
        async (options, ...paths: string[]) => {
          const markdownPaths = resolveMarkdownPaths(
            paths,
            this.conf?.defaultFiles,
          );

          if (markdownPaths.length === 0) {
            console.log(
              gray(
                "No markdown paths provided and no default files configured.",
              ),
            );
            return;
          }

          const sb = shebang({
            ...options,
            entrypointArgs: ["projection", "--pretty"],
            resolver: import.meta.resolve,
          });
          await sb.emit(paths);
        },
      );
  }

  /**
   * `ls` command:
   * - builds FlexibleProjection from markdown sources
   * - shows the `containedInSection` hierarchy as a tree
   * - by default shows only heading + code nodes
   * - `-n, --node <type>` adds more mdast node.type values (e.g., paragraph)
   */
  lsCommand(cmdName = "ls") {
    return this.baseCommand({ examplesCmd: cmdName }).name(cmdName)
      .description("browse containedInSection hierarchy as a tree")
      .arguments("[paths...:string]")
      .option(
        "-n, --node <nodeType:string>",
        "Additional mdast node.type to include (e.g. paragraph). May be repeated.",
        { collect: true },
      )
      .option("--no-color", "Show output without ANSI colors")
      .action(
        async (
          options: {
            node?: string | string[];
            color?: boolean;
          },
          ...paths: string[]
        ) => {
          const markdownPaths = resolveMarkdownPaths(
            paths,
            this.conf?.defaultFiles,
          );

          if (markdownPaths.length === 0) {
            console.log(
              gray(
                "No markdown paths provided and no default files configured.",
              ),
            );
            return;
          }

          const model = await flexibleProjectionFromFiles(markdownPaths);

          // Default types: heading + code
          const baseTypes = new Set<string>(["heading", "code"]);

          const extraTypes = new Set<string>(
            Array.isArray(options.node)
              ? options.node
              : options.node
              ? [options.node]
              : [],
          );

          const includeNodeType = (node: Node): boolean =>
            baseTypes.has(node.type) || extraTypes.has(node.type) ||
            headingLikeNodeDataBag.is(node);

          const relName = "containedInSection";
          const rows = buildHierarchyRowsForRelationship(
            model,
            relName,
            includeNodeType,
          );

          if (!rows.length) {
            console.log(
              gray(
                `No hierarchy found for relationship ${relName}.`,
              ),
            );
            return;
          }

          const useColor = options.color;

          const base = new ListerBuilder<HierarchyRow>()
            .from(rows)
            .declareColumns("label", "type", "fileRef", "dataKeys")
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          base.field("label", "label", {
            header: "NAME",
            defaultColor: (s: string) => s,
          });
          base.field("type", "type", {
            header: "TYPE",
            defaultColor: gray,
          });
          base.field("fileRef", "fileRef", {
            header: "FILE",
            defaultColor: magenta,
          });
          base.field("dataKeys", "dataKeys", {
            header: "DATA",
            defaultColor: yellow,
          });

          base.select("label", "type", "fileRef", "dataKeys");

          const treeLister = TreeLister.wrap(base)
            .from(rows)
            .byParentChild({ idKey: "id", parentIdKey: "parentId" })
            .treeOn("label")
            .dirFirst(true);

          await treeLister.ls(true);
        },
      );
  }

  /**
   * `projection` command:
   * - builds FlexibleProjection from markdown sources
   * - emits as JSON to STDOUT
   */
  projectionCommand(cmdName = "projection") {
    return this.baseCommand({ examplesCmd: cmdName }).name(cmdName)
      .description(
        "compute a projection and emit as JSON (defaults to flexible)",
      )
      .arguments("[paths...:string]")
      .option("--pretty", "Pretty-print (indent) the JSON", {
        conflicts: ["jsonl"],
      })
      .option("--jsonl", "Independently prepare JSON per file as JSONL", {
        conflicts: ["pretty"],
      })
      .action(
        async (
          options: { jsonl?: boolean; pretty?: boolean },
          ...paths: string[]
        ) => {
          const markdownPaths = resolveMarkdownPaths(
            paths,
            this.conf?.defaultFiles,
          );

          if (markdownPaths.length === 0) {
            console.log(
              gray(
                "No markdown paths provided and no default files configured.",
              ),
            );
            return;
          }

          if (!options.jsonl || options.pretty) {
            const model = await flexibleProjectionFromFiles(markdownPaths);
            console.log(JSON.stringify(model, null, options.pretty ? 2 : 0));
          } else {
            for (const mp of markdownPaths) {
              const model = await flexibleProjectionFromFiles([mp]);
              console.log(JSON.stringify(model)); // one JSON per line ("JSONL")
            }
          }
        },
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Stand-alone entrypoint                                                     */
/* -------------------------------------------------------------------------- */

if (import.meta.main) {
  await new CLI().run();
}
