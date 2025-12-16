#!/usr/bin/env -S deno run -A --node-modules-dir=auto

import { Command, EnumType } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/completions";
import { HelpCommand } from "@cliffy/help";
import {
  blue,
  bold,
  brightRed,
  brightYellow,
  cyan,
  gray,
  green,
  red,
  yellow,
} from "@std/fmt/colors";
import { relative } from "@std/path";
import { toMarkdown } from "mdast-util-to-markdown";
import { Code, Node, Root } from "types/mdast";
import { select } from "unist-util-select";

import { languageRegistry, LanguageSpec } from "../../universal/code.ts";
import { MarkdownDoc } from "../../universal/fluent-md.ts";
import {
  ColumnDef,
  ListerBuilder,
} from "../../universal/lister-tabular-tui.ts";
import {
  errorOnlyShellEventBus,
  markdownShellEventBus,
  verboseInfoShellEventBus,
} from "../../universal/shell-bus.ts";
import { shell, ShellBusEvents } from "../../universal/shell.ts";
import {
  executionPlanVisuals,
  ExecutionPlanVisualStyle,
} from "../../universal/task-visuals.ts";
import {
  errorOnlyTaskEventBus,
  executionPlan,
  executionSubplan,
  verboseInfoTaskEventBus,
} from "../../universal/task.ts";
import { computeSemVerSync } from "../../universal/version.ts";
import { ansiPrettyNodeIssues } from "../mdast/node-issues.ts";
import { exectutionReport, tasksRunbook } from "../orchestrate/task.ts";
import {
  ExecutableTask,
  PlaybookProjection,
  playbooksFromFiles,
} from "../projection/playbook.ts";
import { CaptureSpec } from "../remark/actionable-code-candidates.ts";
import * as axiomCLI from "./cli.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export type LsTaskRow = {
  code: Code;
  name: string;
  origin: string;
  engine: ReturnType<ReturnType<typeof shell>["strategy"]> | {
    engine: "memoize-only";
    label: "Memoize Only";
    linesOfCode: string[];
  };
  descr: string;
  deps?: string;
  flags: {
    isInterpolated: boolean;
    isSilent: boolean;
    isCaptured: CaptureSpec | false;
    isCaptureOnly: boolean;
    isGitIgnored: boolean;
    hasIssues: boolean;
  };
  graphs: string;
};

function lsFlagsField<Row extends LsTaskRow>():
  | Partial<ColumnDef<Row, Row["flags"]>>
  | undefined {
  return {
    header: "Args",
    defaultColor: gray,
    // deno-fmt-ignore
    format: (v) =>
        `${v.hasIssues ? brightRed("E") : " "} ${brightYellow(v.isInterpolated ? "I" : " ")} ${blue(v.isCaptured ? (v.isCaptured.nature == "relFsPath" ? "CF" : "CM") : "  ")} ${v.isGitIgnored ? "G" : " "} ${v.isGitIgnored ? "S" : " "}`,
  };
}

function lsColorPathField<Row extends LsTaskRow>(
  header: string,
): Partial<ColumnDef<Row, string>> {
  return {
    header,
    format: (supplied) => {
      const p = relative(Deno.cwd(), supplied);
      const i = p.lastIndexOf("/");
      return i < 0 ? bold(p) : gray(p.slice(0, i + 1)) + bold(p.slice(i + 1));
    },
    rules: [{
      when: (_v, r) =>
        "error" in r
          ? ((r.error ? String(r.error)?.trim().length ?? 0 : 0) > 0)
          : false,
      color: red,
    }],
  };
}

function lsTaskIdField<Row extends LsTaskRow>(): Partial<
  ColumnDef<Row, Row["name"]>
> {
  return {
    header: "Name",
    format: (v) => brightYellow(v), // TODO: give per-language color
  };
}

function lsCmdEngineField<Row extends LsTaskRow>(): Partial<
  ColumnDef<Row, Row["engine"]>
> {
  return {
    header: "ENGINE",
    format: (v) => {
      switch (v.engine) {
        case "shebang":
          return green(v.label);
        case "deno-task":
          return cyan(v.label);
        case "memoize-only":
          return gray(v.label);
      }
    },
  };
}

export enum VerboseStyle {
  Plain = "plain",
  Rich = "rich",
  Markdown = "markdown",
}

export function informationalEventBuses<T extends ExecutableTask, Context>(
  verbose?: VerboseStyle,
) {
  const emitStdOut = (ev: ShellBusEvents<T>["spawn:done"]) =>
    ev.baggage?.spawnableArgs.silent ? false : true;

  if (!verbose) {
    return {
      shellEventBus: errorOnlyShellEventBus<T>({ style: "rich", emitStdOut }),
      tasksEventBus: errorOnlyTaskEventBus<T, Context>({ style: "rich" }),
    };
  }

  switch (verbose) {
    case VerboseStyle.Plain:
      return {
        shellEventBus: verboseInfoShellEventBus({ style: "plain", emitStdOut }),
        tasksEventBus: verboseInfoTaskEventBus<T, Context>({ style: "plain" }),
      };

    case VerboseStyle.Rich:
      return {
        shellEventBus: verboseInfoShellEventBus({ style: "rich", emitStdOut }),
        tasksEventBus: verboseInfoTaskEventBus<T, Context>({ style: "rich" }),
      };

    case VerboseStyle.Markdown: {
      const md = new MarkdownDoc();
      const mdSEB = markdownShellEventBus({ md });
      return {
        mdSEB,
        shellEventBus: mdSEB.bus,
        tasksEventBus: undefined, // TODO: add tasks to markdown
        md,
        emit: () => console.log(md.write()),
      };
    }
  }
}

const verboseOpt = [
  "--verbose <style:verboseStyle>",
  "Emit information messages verbosely",
] as const;

const verboseStyle = new EnumType(VerboseStyle);

export const spawnableLangIds = ["shell"] as const;
export type SpawnableLangIds = typeof spawnableLangIds[number];
export const spawnableLangSpecs = spawnableLangIds.map((lid) => {
  const langSpec = languageRegistry.get(lid);
  if (!langSpec) throw new Error("this should never happen");
  return langSpec;
});

export class CLI {
  readonly axiomCLI: axiomCLI.CLI;
  readonly isSpawnable: (
    code: Code,
  ) => LanguageSpec | undefined;

  constructor(
    readonly conf?: {
      readonly defaultFiles?: string[]; // load these markdown files/remotes when no CLI arguments given
      readonly axiomCLI?: axiomCLI.CLI;
      readonly isSpawnable?: CLI["isSpawnable"];
    },
  ) {
    this.isSpawnable = conf?.isSpawnable ??
      ((code) =>
        spawnableLangSpecs.find((lang) =>
          lang.id == code.lang || lang.aliases?.find((a) => a == code.lang)
        ));
    this.axiomCLI = conf?.axiomCLI ??
      new axiomCLI.CLI({ defaultFiles: conf?.defaultFiles });
  }

  async run(args = Deno.args) {
    await this.rootCmd().parse(args);
  }

  rootCmd(subcommand?: string) {
    const description = "Spry Runbook operator";
    const compose = subcommand
      ? new Command().name(subcommand).description(description)
      : new Command()
        .name("runbook.ts")
        .version(() => computeSemVerSync(import.meta.url))
        .description(description)
        .command("help", new HelpCommand())
        .command("completions", new CompletionsCommand());

    for (
      const c of [
        this.lsCommand(),
        this.taskCommand(),
        this.runCommand(),
        this.issuesCommand(),
        this.reportCommand(),
      ]
    ) {
      compose.command(c.getName(), c);
    }

    if (!subcommand) {
      const axiomCmd = this.axiomCLI.rootCmd("axiom");
      compose.command(axiomCmd.getName(), axiomCmd);
    }

    return compose;
  }

  protected baseCommand({ examplesCmd }: { examplesCmd: string }) {
    const cmdName = "runbook";
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

  preface(check: Pick<PlaybookProjection, "issues">) {
    if (check.issues.length) {
      console.warn(
        red(
          `⚠️ ${check.issues.length} nodes issues found, use 'issues' command to list them.`,
        ),
      );
    }
  }

  taskCommand() {
    return new Command()
      .name("task")
      .description(`execute a specific cell and dependencies`)
      .type("verboseStyle", verboseStyle)
      .arguments("<taskId> [paths...:string]")
      .option(...verboseOpt)
      .option("--summarize", "Emit summary after execution in JSON")
      .action(
        async (opts, taskId, ...paths: string[]) => {
          const { tasks, directives, issues } = await playbooksFromFiles(
            paths.length ? paths : this.conf?.defaultFiles ?? [],
          );
          this.preface({ issues });
          if (tasks.find((t) => t.taskId() == taskId)) {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              { runId: string }
            >(opts?.verbose);
            const runbook = tasksRunbook({
              directives,
              shellBus: ieb.shellEventBus,
              tasksBus: ieb.tasksEventBus,
            });
            const rbResults = await runbook.execute(
              executionSubplan(executionPlan(tasks), [taskId]),
            );
            if (ieb.emit) ieb.emit();
            if (opts.summarize) {
              console.log(rbResults);
            }
          } else {
            console.warn(`Task '${taskId}' not found.`);
          }
        },
      );
  }

  runCommand() {
    return new Command()
      .name("run")
      .description(`execute all code cells in markdown documents as a DAG`)
      .type("verboseStyle", verboseStyle)
      .type("visualStyle", new EnumType(ExecutionPlanVisualStyle))
      .arguments("[paths...:string]")
      .option(...verboseOpt)
      .option(
        "--graph <name:string>",
        "Run only the nodes in provided graph(s)",
        {
          collect: true,
        },
      )
      .option("--summarize", "Emit summary after execution in JSON")
      .option("--visualize <style:visualStyle>", "Visualize the DAG")
      .action(
        async (opts, ...paths: string[]) => {
          const { tasks, directives, issues } = await playbooksFromFiles(
            paths.length ? paths : this.conf?.defaultFiles ?? [],
            {
              filter: opts.graph?.length
                ? ((task) =>
                  task.spawnableArgs.graphs?.some((g) =>
                      opts.graph!.includes(g)
                    )
                    ? true
                    : false)
                : ((task) => task.spawnableArgs.graphs?.length ? false : true),
            },
          );
          this.preface({ issues });
          const plan = executionPlan(tasks);
          if (opts?.visualize) {
            const epv = executionPlanVisuals(plan);
            console.log(epv.visualText(opts.visualize));
          } else {
            const ieb = informationalEventBuses<
              typeof tasks[number],
              { runId: string }
            >(opts?.verbose);
            const runbook = tasksRunbook({
              directives,
              shellBus: ieb.shellEventBus,
              tasksBus: ieb.tasksEventBus,
            });
            const rbResults = await runbook.execute(plan);
            if (ieb.emit) ieb.emit();
            if (opts.summarize) {
              console.log(rbResults);
            }
          }
        },
      );
  }

  reportCommand() {
    function sanitizeMdastForToMarkdown(node: Node) {
      if (!node || typeof node !== "object") return node;

      const result = { ...node };

      if ("children" in result && Array.isArray(result.children)) {
        result.children = result.children
          .filter(
            (child) =>
              child &&
              typeof child.type === "string" &&
              child.type !== "yaml" &&
              child.type !== "toml" &&
              child.type !== "decorator",
          )
          .map((child) => sanitizeMdastForToMarkdown(child));
      }

      return result;
    }

    return new Command()
      .name("report")
      .description(`execute all code cells and return as new markdown`)
      .arguments("[paths...:string]")
      .option(
        "--graph <name:string>",
        "Run only the nodes in provided graph(s)",
        {
          collect: true,
        },
      )
      .action(
        async (opts, ...paths: string[]) => {
          const { tasks, directives, issues, sources } =
            await playbooksFromFiles(
              paths.length ? paths : this.conf?.defaultFiles ?? [],
              {
                filter: opts.graph?.length
                  ? ((task) =>
                    task.spawnableArgs.graphs?.some((g) =>
                        opts.graph!.includes(g)
                      )
                      ? true
                      : false)
                  : ((task) =>
                    task.spawnableArgs.graphs?.length ? false : true),
              },
            );
          this.preface({ issues });
          const plan = executionPlan(tasks);
          // create a runbook that will mutate the original markdown with output
          const er = exectutionReport({ directives });
          await er.execute(plan); // the results all go back into the mdast code cells
          for (const src of sources) {
            const logNode = select(
              `code[lang="spry"][meta="exectutionReportLog"]`,
              src.mdastRoot,
            ) as Code;
            if (logNode) {
              logNode.lang = "text";
              logNode.value = er.shellEventBus.lines.join("\n");
              logNode.value += "\n----" + er.tasksEventBus.lines.join("\n");
            }
            console.log(
              toMarkdown(sanitizeMdastForToMarkdown(src.mdastRoot) as Root),
            );
          }
        },
      );
  }

  issuesCommand(cmdName = "issues") {
    return this.baseCommand({ examplesCmd: cmdName }).name(cmdName)
      .description(
        "display any issues (errors, warnings, etc.) in the mdast nodes",
      )
      .arguments("[paths...:string]")
      .action(
        async (_options, ...paths) => {
          const files = paths.length ? paths : this.conf?.defaultFiles ?? [];
          const { issues } = await playbooksFromFiles(files);
          if (issues.length) {
            console.log(ansiPrettyNodeIssues(issues).join("\n"));
          } else {
            console.info("No issues detected in " + files.join(", "));
          }
        },
      );
  }

  // -------------------------------------------------------------------------
  // ls command (tabular "physical" view)
  // -------------------------------------------------------------------------

  /**
   * `ls` – list mdast nodes in a tabular, content-hierarchy-friendly way.
   *
   * - By default: includes every node in the tree.
   * - With `--select <expr>`: only nodes matching that mdastql expression.
   * - With `--data`: adds a DATA column showing `Object.keys(node.data)`.
   * - With automatic node classification (via frontmatter + nodeClassifier),
   *   shows a CLASS column with key:value pairs.
   */
  protected lsCommand(cmdName = "ls") {
    return this.baseCommand({ examplesCmd: cmdName }).name(cmdName)
      .description(`list code cells (tasks) in markdown documents`)
      .arguments("[paths...:string]")
      .option("--no-color", "Show output without using ANSI colors")
      .action(
        async (options, ...paths: string[]) => {
          const sh = shell();
          const { tasks, issues } = await playbooksFromFiles(
            paths.length ? paths : this.conf?.defaultFiles ?? [],
          );
          this.preface({ issues });
          const lsRows = tasks.map((task) => {
            const { spawnableArgs: args } = task;
            return {
              code: task,
              name: task.taskId(),
              deps: task.taskDeps().join(", "),
              descr: args.description ?? "",
              origin: task.provenance.fileRef(task),
              engine: task.memoizeOnly
                ? {
                  engine: "memoize-only",
                  label: "Memoize Only",
                  linesOfCode: [],
                }
                : sh.strategy(task.value),
              flags: {
                isInterpolated: args.interpolate ? true : false,
                isCaptured: args.capture ? args.capture[0] : false,
                isCaptureOnly: task.memoizeOnly ?? false,
                isGitIgnored: args.capture && args.capture.filter((c) =>
                    c.nature === "relFsPath"
                  ).find((c) =>
                    c.gitignore
                  )
                  ? true
                  : false,
                isSilent: args.silent ?? false,
                hasIssues: false,
              },
              graphs: args.graphs ? args.graphs.join(", ") : "",
            } satisfies LsTaskRow;
          });

          if (lsRows.length === 0) {
            console.log(
              gray(
                "No nodes matched (did you supply any valid markdown files?).",
              ),
            );
            return;
          }

          const useColor = options.color;
          const builder = new ListerBuilder<LsTaskRow>()
            .from(lsRows)
            .declareColumns(
              "name",
              "engine",
              "deps",
              "descr",
              "origin",
              "flags",
              "graphs",
            )
            .requireAtLeastOneColumn(true)
            .color(useColor)
            .header(true)
            .compact(false);

          builder.field("name", "name", lsTaskIdField());
          builder.field("engine", "engine", lsCmdEngineField());
          builder.field("deps", "deps", {
            header: "DEPS",
            defaultColor: yellow,
          });
          builder.field("descr", "descr", { header: "DESCR" });
          builder.field("origin", "origin", lsColorPathField("ORIGIN"));
          builder.field("flags", "flags", lsFlagsField());
          builder.field("graphs", "graphs", {
            header: "GRAPH",
            defaultColor: yellow,
          });
          builder.select(
            "name",
            "deps",
            "graphs",
            "flags",
            "descr",
            "origin",
            "engine",
          );

          const lister = builder.build();
          await lister.ls(true);
        },
      );
  }
}

// ---------------------------------------------------------------------------
// Stand-alone entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await new CLI().run();
}
