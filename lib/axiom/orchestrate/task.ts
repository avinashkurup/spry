/**
 * Runbook Execution Layer
 *
 * This module turns a Markdown-based playbook into an *executable runbook*.
 *
 * What is a runbook?
 * ------------------
 * A runbook is a structured, step-by-step guide for completing a process
 * reliably. It is the operational equivalent of a recipe:
 *
 * - It lists the steps.
 * - It defines the order.
 * - It explains what should happen at each stage.
 * - It may capture results to be used by later steps.
 *
 * In Spry, the steps come from fenced code blocks inside Markdown files.
 * Some blocks represent actions to run, others store data, and some act
 * as directives that modify behavior (such as PARTIAL definitions).
 *
 * What this module does:
 * ----------------------
 * `tasksRunbook` builds all the machinery needed to *execute* those steps:
 *
 * - It applies the interpolation strategy defined by directives, so templates,
 *   variables, and partials expand correctly.
 *
 * - It renders each task into the final text that should run (e.g., a shell
 *   command), including automatic injection of metadata like `TASK`.
 *
 * - It executes tasks in dependency order, forming a directed acyclic graph
 *   (DAG) so that steps run only after their prerequisites complete.
 *
 * - It respects "memoize-only" tasks: steps that don't run but instead store
 *   computed text/data for later reuse.
 *
 * - It captures output from tasks when requested, storing results under a
 *   stable identity so later tasks can refer back to them.
 *
 * - It emits structured events during execution, allowing UIs, logs, or
 *   tracing systems to observe progress.
 *
 * In short:
 * ---------
 * This module is the bridge between a *static Markdown playbook* and a *live,
 * operational runbook*. It makes the Markdown actionable: renderable,
 * executable, traceable, and repeatable.
 */
import { eventBus } from "../../universal/event-bus.ts";
import { renderer } from "../../universal/render.ts";
import { shell, ShellBusEvents } from "../../universal/shell.ts";
import { textInfoShellEventBus } from "../../universal/shell-bus.ts";
import {
  executeDAG,
  fail,
  ok,
  Task,
  TaskExecEventMap,
  TaskExecutionPlan,
  textInfoTaskEventBus,
} from "../../universal/task.ts";
import { codeInterpolationStrategy } from "../mdast/code-interpolate.ts";
import { Directive, ExecutableTask } from "../projection/playbook.ts";

/**
 * Build a "runbook" facade around an executable task graph.
 *
 * This wires together:
 * - The code interpolation strategy (partials, memoization, safety mode).
 * - The renderer that turns a task into concrete text to execute.
 * - The shell wrapper that actually runs the text (or simulates it).
 * - A DAG executor that drives tasks according to dependencies.
 *
 * It returns a small object with:
 * - `execute(plan)`:
 *     Execute a `TaskExecutionPlan<T>` (DAG) of tasks.
 * - `sh`:
 *     The shell instance used for execution (useful for testing or
 *     advanced callers that need direct access).
 * - `cis`:
 *     The `codeInterpolationStrategy` instance (including memoization).
 * - `interpolator`:
 *     The rendered view of the interpolation strategy.
 *
 * Unobvious behavior:
 * - "Memoize-only" tasks:
 *   If `task.memoizeOnly` is true, the task is *never* executed in the shell.
 *   Instead, `interpolator.renderOne` is allowed to store any relevant data
 *   (for example, pre-computed text) in the interpolation memory.
 *
 * - `capture` semantics:
 *   If `task.spawnableArgs.capture` is set, the stdout of the executed task
 *   is turned into a string and fed back into `cis.memory.memoize` using the
 *   task’s `taskId()` and the capture specs. This is how later tasks can
 *   reference the *actual* runtime output of earlier tasks under a stable
 *   identity.
 *
 * - Locals injection:
 *   When rendering, we inject `TASK` into locals so templates can reference
 *   the task metadata (e.g. `TASK.spawnableIdentity`, args, etc.) without
 *   additional wiring.
 *
 * @typeParam T
 *   The task type, usually `ExecutableTask`, but this is generic so callers
 *   can extend it with richer metadata if desired.
 *
 * @typeParam Context
 *   Execution context type. Must at least include `runId: string`, but
 *   can be extended with whatever the calling layer needs (e.g. logging
 *   correlation IDs, environment info, etc.).
 *
 * @param opts
 *   Optional wiring:
 *
 *   - `directives`:
 *     The list of `Directive`s discovered in Markdown (e.g. PARTIALs,
 *     interpolation hints). These are fed into `codeInterpolationStrategy`,
 *     so they effectively control how templates are expanded and memoized.
 *
 *   - `shellBus`:
 *     Optional event bus for shell-level events (`ShellBusEvents`).
 *     Use this to observe process starts, exits, stdout/stderr, etc.
 *
 *   - `tasksBus`:
 *     Optional event bus for DAG-level events (`TaskExecEventMap<T, Context>`).
 *     Use this for higher-level progress monitoring, UIs, or tracing.
 *
 * @returns
 *   A small facade that can execute a `TaskExecutionPlan<T>`:
 *   `{ execute, sh, cis, interpolator }`.
 */
export function tasksRunbook<
  T extends ExecutableTask,
  Context extends { readonly runId: string },
>(
  opts?: {
    directives: readonly Directive[];
    shellBus?: ReturnType<typeof eventBus<ShellBusEvents>>;
    tasksBus?: ReturnType<typeof eventBus<TaskExecEventMap<T, Context>>>;
  },
) {
  const cis = codeInterpolationStrategy(opts?.directives ?? [], {
    approach: "safety-first",
  });
  const interpolator = renderer(cis);
  const sh = shell({ bus: opts?.shellBus });
  const td = new TextDecoder();

  const execute = async (plan: TaskExecutionPlan<T>) =>
    await executeDAG(plan, async (task, ctx) => {
      const rendered = await interpolator.renderOne(task, {
        locals: (_, supplied) => ({
          ...supplied,
          TASK: task,
          resolveRelPath: task.provenance.resolveRelPath,
        }),
      });
      if (!rendered.error) {
        // if the task is a "memoize only" (no execution) then the interpolator
        // already handled the memoization and we won't run the task
        if (!task.memoizeOnly) {
          const execResult = await sh.auto(rendered.text, undefined, task);
          if (task.spawnableArgs.capture) {
            // before the task runs, "memoize" in interpolator.renderOne stores
            // the "source" (before execution) and now we need to overwrite that
            // "memoization" with the actual execution's stdout / result
            const output = Array.isArray(execResult)
              ? execResult.map((er) => td.decode(er.stdout)).join("\n")
              : td.decode(execResult.stdout);
            if (task.spawnableArgs.capture) {
              cis.memory.memoize?.(output, {
                identity: task.taskId(),
                captureSpecs: task.spawnableArgs.capture,
              });
            }
          }
        }
        return ok(ctx);
      } else {
        return fail(ctx, rendered.error);
      }
    }, { eventBus: opts?.tasksBus });

  return { execute, sh, cis, interpolator };
}

/**
 * Build a “report-generating” task runner that executes Markdown-defined tasks
 * and captures their outputs back into the document model.
 *
 * This factory produces a runbook-style executor whose purpose is not simply
 * to run tasks, but to *mutate the logical Markdown layer* with execution
 * results and emit a structured text report of everything that happened.
 *
 * High-level behavior:
 *
 * - Reads tasks originating from Markdown (ExecutableTask).
 * - Interpolates each task’s code cell using a safety-first interpolation
 *   strategy (directives → codeInterpolationStrategy → renderer).
 * - Executes each task in deterministic DAG order via `executeDAG()`.
 * - Captures shell output (stdout/stderr) through a text-only shell event bus.
 * - Captures task-level lifecycle events (scheduled, start, end, release, etc.)
 *   through a text-only task event bus.
 * - Writes execution results *back into the task objects themselves*, allowing
 *   upstream layers (Markdown emitters, reporting pipelines, etc.) to generate
 *   enriched Markdown that includes the executed output.
 *
 * The result is a lightweight Markdown-native reporting engine. A document
 * that originally contained runnable code blocks can be “played,” and its
 * code blocks are updated to contain the textual results of their execution.
 * This is conceptually similar to a literate programming pass, but modeled
 * explicitly as a Spry runbook.
 *
 * Key capabilities:
 *
 * • **Shell logging**: Uses `textInfoShellEventBus` (plain style) to capture
 *   shell execution traces into `shellEventBus.lines` — suitable for saving
 *   as a diagnostic artifact or embedding in a final Markdown report.
 *
 * • **Task logging**: Uses `textInfoTaskEventBus` (rich style w/ emojis, no
 *   ANSI) to produce a human-understandable execution trace for all DAG events.
 *
 * • **Result mutation**: When a task declares `spawnableArgs.capture`, the
 *   actual stdout becomes the task’s new `.value`. If capture is disabled,
 *   the interpolated code itself becomes the stored value. In both cases the
 *   task’s Markdown model is enriched.
 *
 * • **Memoization**: Interpolator memory stores both pre-execution source and
 *   post-execution output, allowing re-runs or downstream provenance features.
 *
 * Returned structure:
 *
 *   {
 *     execute       // (plan) → Promise<ExecuteSummary>
 *     sh            // shell wrapper used for task execution
 *     cis           // code interpolation strategy
 *     interpolator  // renderer wired to directives + memory
 *     shellEventBus // { bus, lines[] } for shell events
 *     tasksEventBus // { bus, lines[] } for task lifecycle events
 *   }
 *
 * Usage pattern:
 *
 *   const { execute, shellEventBus, tasksEventBus } = exectutionReport({ directives });
 *   const summary = await execute(plan);
 *   // shellEventBus.lines → shell transcript
 *   // tasksEventBus.lines → task DAG transcript
 *   // plan.tasks[].value → now populated with executed results
 *
 * This function is the preferred entry point when you want to:
 *   - turn executable Markdown into a reproducible report,
 *   - track both shell-level and DAG-level provenance,
 *   - mutate the Markdown model so an emitter can produce a new enriched file,
 *   - keep results fully deterministic and traceable.
 *
 * @template T extends ExecutableTask
 * @template Context extends { readonly runId: string }
 * @param opts Optional `{ directives }` array for interpolation.
 * @returns An object containing the executor, underlying shell, interpolator,
 *          and text-logging event buses.
 */
export function exectutionReport<
  T extends ExecutableTask,
  Context extends { readonly runId: string },
>(
  opts?: {
    readonly directives: readonly Directive[];
    readonly replaceContents?: (
      task: Task,
      content: string,
      nature: "execution-result" | "render-result",
    ) => void | Promise<void>;
  },
) {
  const replaceContents = opts?.replaceContents ??
    ((task: T, content: string) => {
      task.origin.meta = `--origin '${task.origin.lang} ${task.origin.meta}'`,
        task.origin.lang = "text",
        task.origin.value = content;
    });
  const shellEventBus = textInfoShellEventBus({ style: "rich" });
  const tasksEventBus = textInfoTaskEventBus<T, Context>({ style: "rich" });

  const cis = codeInterpolationStrategy(opts?.directives ?? [], {
    approach: "safety-first",
  });
  const interpolator = renderer(cis);
  const sh = shell({ bus: shellEventBus.bus });
  const td = new TextDecoder();

  const execute = async (plan: TaskExecutionPlan<T>) =>
    await executeDAG(plan, async (task, ctx) => {
      const rendered = await interpolator.renderOne(task, {
        locals: (_, supplied) => ({
          ...supplied,
          TASK: task,
          resolveRelPath: task.provenance.resolveRelPath,
        }),
      });
      if (!rendered.error) {
        // if the task is a "memoize only" (no execution) then the interpolator
        // already handled the memoization and we won't run the task
        if (!task.memoizeOnly) {
          const execResult = await sh.auto(rendered.text, undefined, task);
          if (task.spawnableArgs.capture) {
            // before the task runs, "memoize" in interpolator.renderOne stores
            // the "source" (before execution) and now we need to overwrite that
            // "memoization" with the actual execution's stdout / result
            const output = Array.isArray(execResult)
              ? execResult.map((er) => td.decode(er.stdout)).join("\n")
              : td.decode(execResult.stdout);
            if (task.spawnableArgs.capture) {
              cis.memory.memoize?.(output, {
                identity: task.taskId(),
                captureSpecs: task.spawnableArgs.capture,
              });
            }
            // mutate the code cell value with the results of the output
            replaceContents(task, output, "execution-result");
          } else {
            // even if the task was not run, mutate the interpolated code cell value
            replaceContents(task, rendered.text, "render-result");
          }
        }
        return ok(ctx);
      } else {
        return fail(ctx, rendered.error);
      }
    }, { eventBus: tasksEventBus.bus });

  // TODO: if there's a placeholder like `spry-results` then put the output in there

  return { execute, sh, cis, interpolator, shellEventBus, tasksEventBus };
}
