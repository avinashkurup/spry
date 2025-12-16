import {
  bold,
  cyan,
  dim,
  gray,
  green,
  magenta,
  red,
  yellow,
} from "@std/fmt/colors";
import { eventBus } from "./event-bus.ts";
import { MarkdownDoc } from "./fluent-md.ts";
import { ShellBusEvents } from "./shell.ts";
import { indent } from "./tmpl-literal-aide.ts";

/**
 * Create a verbose info bus for Shell events.
 *
 * - style: "rich" → emoji + ANSI colors
 * - style: "plain" → no emoji, no colors
 *
 * Pass the returned `bus` into `shell({ bus })`.
 */
export function verboseInfoShellEventBus<Baggage = unknown>(
  init: {
    readonly style: "plain" | "rich";
    readonly emitStdOut?: (
      event: ShellBusEvents<Baggage>["spawn:done"],
    ) => boolean;
  },
) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents<Baggage>>();
  const te = new TextDecoder();
  const { emitStdOut } = init;

  const E = {
    rocket: "🚀",
    check: "✅",
    cross: "❌",
    boom: "💥",
    play: "▶️",
    gear: "⚙️",
    page: "📄",
    broom: "🧹",
    timer: "⏱️",
    box: "🧰",
  } as const;

  const c = {
    tag: (s: string) => (fancy ? bold(magenta(s)) : s),
    cmd: (s: string) => (fancy ? bold(cyan(s)) : s),
    ok: (s: string) => (fancy ? green(s) : s),
    warn: (s: string) => (fancy ? yellow(s) : s),
    err: (s: string) => (fancy ? red(s) : s),
    path: (s: string) => (fancy ? bold(s) : s),
    faint: (s: string) => (fancy ? dim(s) : s),
    gray: (s: string) => (fancy ? gray(s) : s),
  };

  const em = {
    start: (s: string) => (fancy ? `${E.rocket} ${s}` : s),
    done: (
      s: string,
      ok: boolean,
    ) => (fancy ? `${ok ? E.check : E.cross} ${s}` : s),
    error: (s: string) => (fancy ? `${E.boom} ${s}` : s),
    play: (s: string) => (fancy ? `${E.play} ${s}` : s),
    gear: (s: string) => (fancy ? `${E.gear} ${s}` : s),
    page: (s: string) => (fancy ? `${E.page} ${s}` : s),
    broom: (s: string) => (fancy ? `${E.broom} ${s}` : s),
    timer: (ms?: number) =>
      ms === undefined
        ? ""
        : fancy
        ? ` ${E.timer} ${Math.round(ms)}ms`
        : ` ${Math.round(ms)}ms`,
  };

  const fmtArgs = (args: readonly string[]) =>
    args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

  // ---- listeners ----
  bus.on("spawn:start", ({ cmd, args, cwd, hasStdin }) => {
    const line =
      `${c.tag("[spawn]")} ${em.start(c.cmd(cmd))} ${fmtArgs(args)} ` +
      c.faint(
        [
          cwd ? `cwd=${cwd}` : "",
          hasStdin ? "stdin=piped" : "stdin=null",
        ].filter(Boolean).join(" "),
      );
    console.info(line);
  });

  bus.on(
    "spawn:done",
    (ev) => {
      const { cmd, args, code, success, durationMs, stdout, stderr } = ev;
      if (!emitStdOut || emitStdOut(ev)) {
        console.info(
          `${c.tag("[spawn]")} ${em.done(c.cmd(cmd), success)} ${
            fmtArgs(args)
          } ` +
            (success ? c.ok(`code=${code}`) : c.err(`code=${code}`)) +
            em.timer(durationMs),
        );
      }
      if (stdout.length > 0) {
        console.info(dim(indent(te.decode(stdout))));
      }
      if (stderr.length > 0) {
        console.info(red(indent(te.decode(stderr))));
      }
    },
  );

  bus.on("spawn:error", ({ cmd, args, error }) => {
    const line =
      `${c.tag("[spawn]")} ${em.error(c.cmd(cmd))} ${fmtArgs(args)} ` +
      c.err(String(error instanceof Error ? error.message : error));
    console.error(line);
  });

  bus.on("task:line:start", ({ index, line }) => {
    const msg = `${c.tag("[task]")} ${em.play(`L${index}`)} ${c.gray(line)}`;
    console.info(msg);
  });

  bus.on(
    "task:line:done",
    ({ index, line, code, success, durationMs }) => {
      console.info(
        `${c.tag("[task]")} ${em.done(`L${index}`, success)} ` +
          (success ? c.ok(`code=${code}`) : c.err(`code=${code}`)) +
          ` ${c.gray(line)}` +
          em.timer(durationMs),
      );
      // we don't emit stdout and stderr because spawn:done will already
      // have been called for deno tasks
    },
  );

  bus.on("shebang:tempfile", ({ path }) => {
    console.info(`${c.tag("[shebang]")} ${em.page("temp")} ${c.path(path)}`);
  });

  bus.on("shebang:cleanup", ({ path, ok, error }) => {
    const head = `${c.tag("[shebang]")} ${em.broom("cleanup")} ${
      c.path(path)
    } `;
    console[ok ? "info" : "error"](
      head + (ok ? c.ok("ok") : c.err(String(error ?? "error"))),
    );
  });

  bus.on("auto:mode", ({ mode }) => {
    const txt = mode === "shebang" ? "shebang" : "eval-lines";
    const msg = `${c.tag("[auto]")} ${em.gear(txt)}`;
    console.info(msg);
  });

  return bus;
}

/**
 * Create an error-focused event bus for Shell events.
 *
 * Only logs errors — ignores successful runs.
 * Displays concise diagnostics with decoded `stderr` output
 * when available. Style can be `"plain"` or `"rich"` for
 * emoji + ANSI-colored output.
 *
 * Pass the returned `bus` into `shell({ bus })`.
 *
 * Example:
 * ```ts
 * const bus = errorOnlyShellEventBus({ style: "rich" });
 * const sh = shell({ bus });
 * await sh.spawnText("deno run missing.ts");
 * ```
 */
export function errorOnlyShellEventBus<Baggage = unknown>(
  init: {
    readonly style: "plain" | "rich";
    readonly "shebang:tempfile"?: boolean;
    readonly emitStdOut?: (
      event: ShellBusEvents<Baggage>["spawn:done"],
    ) => boolean;
  },
) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents<Baggage>>();
  const { emitStdOut } = init;

  const E = {
    cross: "❌",
    boom: "💥",
    warn: "⚠️",
    page: "📄",
    broom: "🧹",
  } as const;

  const c = {
    tag: (s: string) => (fancy ? bold(magenta(s)) : s),
    cmd: (s: string) => (fancy ? bold(cyan(s)) : s),
    err: (s: string) => (fancy ? red(s) : s),
    path: (s: string) => (fancy ? bold(s) : s),
    faint: (s: string) => (fancy ? dim(s) : s),
  };

  const em = {
    fail: (s: string) => (fancy ? `${E.cross} ${s}` : s),
    boom: (s: string) => (fancy ? `${E.boom} ${s}` : s),
    warn: (s: string) => (fancy ? `${E.warn} ${s}` : s),
    page: (s: string) => (fancy ? `${E.page} ${s}` : s),
    broom: (s: string) => (fancy ? `${E.broom} ${s}` : s),
  };

  function decode(u8: Uint8Array): string {
    return new TextDecoder().decode(u8).trim();
  }

  // ---- listeners ----

  if (init["shebang:tempfile"]) {
    bus.on("shebang:tempfile", ({ path, script }) => {
      console.log({ where: "shebang:tempfile", path, script });
    });
  }

  bus.on("spawn:error", ({ cmd, args, error }) => {
    console.error(
      `${c.tag("[spawn]")} ${em.boom(c.cmd(cmd))} ${args.join(" ")} → ${
        c.err(String(error instanceof Error ? error.message : error))
      }`,
    );
  });

  bus.on(
    "spawn:done",
    (ev) => {
      const { cmd, args, code, success, stderr, stdout } = ev;
      if (!emitStdOut || emitStdOut(ev)) {
        console.info(decode(stdout));
      }
      if (!success) {
        console.error(
          `${c.tag("[spawn]")} ${em.fail(c.cmd(cmd))} ${args.join(" ")} ${
            c.err(`(code=${code})`)
          }`,
        );
        const msg = decode(stderr);
        if (msg) console.error(c.err(msg));
      }
    },
  );

  bus.on("task:line:done", ({ index, line, code, success }) => {
    // we don't emit stdout and stderr because spawn:done will already
    // have been called for deno tasks
    if (!success) {
      console.error(
        `${c.tag("[task]")} ${em.fail(`L${index}`)} ${
          c.err(`(code=${code})`)
        } ${c.faint(line)}`,
      );
    }
  });

  bus.on("shebang:cleanup", ({ path, ok, error }) => {
    if (!ok) {
      console.error(
        `${c.tag("[shebang]")} ${em.broom("cleanup")} ${c.path(path)} → ${
          em.warn(
            String(error ?? "unknown error"),
          )
        }`,
      );
    }
  });

  return bus;
}

/**
 * Create a text-logging event bus for shell events.
 *
 * - style: "rich"  → includes emojis, no ANSI colors
 * - style: "plain" → no emojis
 *
 * All log lines are appended to the returned `lines` array, which can be
 * written to a file, persisted, or inspected in tests.
 *
 * Example:
 *   const { bus, lines } = textInfoShellEventBus({ style: "rich" });
 *   const sh = shell({ bus });
 *   await sh.spawnText("echo hello");
 *   // lines now contains concise textual logs
 */
export function textInfoShellEventBus<Baggage = unknown>(init: {
  readonly style: "plain" | "rich";
  readonly emitStdOut?: (
    event: ShellBusEvents<Baggage>["spawn:done"],
  ) => boolean;
}) {
  const fancy = init.style === "rich";
  const bus = eventBus<ShellBusEvents<Baggage>>();
  const te = new TextDecoder();
  const { emitStdOut } = init;

  const lines: string[] = [];

  const E = {
    rocket: "🚀",
    check: "✅",
    cross: "❌",
    boom: "💥",
    play: "▶️",
    page: "📄",
    broom: "🧹",
    timer: "⏱️",
    gear: "⚙️",
  } as const;

  const em = {
    start: (s: string) => (fancy ? `${E.rocket} ${s}` : s),
    done: (s: string, ok: boolean) =>
      fancy ? `${ok ? E.check : E.cross} ${s}` : s,
    error: (s: string) => (fancy ? `${E.boom} ${s}` : s),
    play: (s: string) => (fancy ? `${E.play} ${s}` : s),
    page: (s: string) => (fancy ? `${E.page} ${s}` : s),
    broom: (s: string) => (fancy ? `${E.broom} ${s}` : s),
    timer: (ms?: number) =>
      ms === undefined
        ? ""
        : fancy
        ? `${E.timer} ${Math.round(ms)}ms`
        : `${Math.round(ms)}ms`,
    gear: (s: string) => (fancy ? `${E.gear} ${s}` : s),
  };

  const tag = (s: string) => `[${s}]`;

  const fmtArgs = (args: readonly string[]) =>
    args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

  // ---- listeners ----

  bus.on("spawn:start", ({ cmd, args, cwd, hasStdin }) => {
    const meta = [
      cwd ? `cwd=${cwd}` : "",
      hasStdin ? "stdin=piped" : "stdin=null",
    ].filter(Boolean).join(" ");
    lines.push(
      `${tag("spawn")} ${em.start(cmd)} ${fmtArgs(args)}${
        meta ? " " + meta : ""
      }`,
    );
  });

  bus.on("spawn:done", (ev) => {
    const { cmd, args, code, success, durationMs, stdout, stderr } = ev;
    const head =
      `${tag("spawn")} ${em.done(cmd, success)} ${fmtArgs(args)} code=${code}` +
      (durationMs != null ? ` ${em.timer(durationMs)}` : "");
    lines.push(head);

    if (emitStdOut?.(ev)) {
      if (stdout.length > 0) {
        lines.push(`${tag("stdout")} ${te.decode(stdout)}`);
      }
    }
    if (stderr.length > 0) {
      lines.push(`${tag("stderr")} ${te.decode(stderr)}`);
    }
  });

  bus.on("spawn:error", ({ cmd, args, error }) => {
    lines.push(
      `${tag("spawn")} ${em.error(cmd)} ${fmtArgs(args)} error=${
        String(error instanceof Error ? error.message : error)
      }`,
    );
  });

  bus.on("task:line:start", ({ index, line }) => {
    lines.push(
      `${tag("task")} ${em.play(`L${index}`)} ${line}`,
    );
  });

  bus.on("task:line:done", ({ index, line, code, success, durationMs }) => {
    lines.push(
      `${tag("task")} ${
        success ? "ok" : "fail"
      } L${index} code=${code} ${line}${
        durationMs != null ? ` ${em.timer(durationMs)}` : ""
      }`,
    );
  });

  bus.on("shebang:tempfile", ({ path }) => {
    lines.push(
      `${tag("shebang")} ${em.page("temp")} path=${path}`,
    );
  });

  bus.on("shebang:cleanup", ({ path, ok, error }) => {
    lines.push(
      `${tag("shebang")} ${em.broom("cleanup")} path=${path} ${
        ok ? "ok" : `error=${String(error ?? "unknown")}`
      }`,
    );
  });

  bus.on("auto:mode", ({ mode }) => {
    const txt = mode === "shebang" ? "shebang" : "eval-lines";
    lines.push(`${tag("auto")} ${em.gear(txt)}`);
  });

  return { bus, lines };
}

/**
 * markdownShellEventBus
 *
 * A ShellBusEvents listener that appends a rich, human-readable,
 * audit-quality Markdown log into a provided MarkdownDoc.
 *
 * - Always uses rich / emoji formatting.
 * - Does NOT create its own MarkdownDoc — you hand one in so multiple subsystems
 *   (shell, fleetfolio scanners, etc.) can share a single long-lived log.
 * - Appends sections as events fire instead of streaming to console.
 *
 * Typical usage:
 *
 * ```ts
 * const md = new MarkdownDoc({
 *   anchors: true,
 *   frontMatter: {
 *     session: "daily infra sweep",
 *     purpose: "EAA evidence capture",
 *   },
 * });
 *
 * const { bus, write } = markdownShellEventBus({ md });
 *
 * const sh = shell({ bus });
 * await sh.spawnText("deno --version");
 *
 * console.log(write());
 * ```
 */
export function markdownShellEventBus(init: {
  /**
   * The running Markdown log document that we will enrich.
   * Caller owns it; we just keep appending.
   */
  md: MarkdownDoc;
}) {
  const { md } = init;

  // emojis are always ON for this event bus
  const E = {
    rocket: "🚀",
    check: "✅",
    cross: "❌",
    boom: "💥",
    play: "▶️",
    gear: "⚙️",
    page: "📄",
    broom: "🧹",
    timer: "⏱️",
  } as const;

  const em = {
    start: (s: string) => `${E.rocket} ${s}`,
    done: (s: string, ok: boolean) => `${ok ? E.check : E.cross} ${s}`,
    error: (s: string) => `${E.boom} ${s}`,
    play: (s: string) => `${E.play} ${s}`,
    gear: (s: string) => `${E.gear} ${s}`,
    page: (s: string) => `${E.page} ${s}`,
    broom: (s: string) => `${E.broom} ${s}`,
    timer: (ms?: number) =>
      ms === undefined ? "" : ` ${E.timer} ${Math.round(ms)}ms`,
  };

  // inline md helpers (we don't rely on ANSI color here because Markdown is the log)
  const mdFmt = {
    codeInline: (s: string) => "`" + s.replace(/`/g, "\\`") + "`",
    path: (s: string) => "`" + s.replace(/`/g, "\\`") + "`",
    bold: (s: string) => `**${s}**`,
  };

  const fmtArgs = (args: readonly string[]) =>
    args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");

  const te = new TextDecoder();

  // ensure we have some top-level "Shell Session" section once.
  // We will not overwrite if caller already created one.
  md.section(
    "Shell Session",
    (m) => {
      m.p(
        "This section is generated by `markdownShellEventBus`. " +
          "It captures each shell task, command invocation, stdout/stderr, and outcomes " +
          "in Markdown form suitable for humans, audits, and long-term evidence logs.",
      );
      m.table(
        ["Field", "Value"],
        [
          ["Session started", new Date().toISOString()],
          ["Emitter", "markdownShellEventBus"],
        ],
        ["left", "left"],
      );
    },
    2,
    { id: "shell-session" },
  );

  // counters + helpers to group related lifecycle events into stable sub-sections
  let spawnSeq = 0;
  let currentSpawnIdx = 0;

  let taskSeq = 0;
  const taskTitleByIndex = new Map<number, string>();

  function spawnSectionTitle(idx: number, cmd: string, args: string[]) {
    // example: "🚀 Spawn 1. deno run main.ts --foo bar"
    const base = `${idx}. ${cmd} ${fmtArgs(args)}`.trim();
    return `${E.rocket} Spawn ${base}`;
  }

  function taskSectionTitle(idx: number /* line index */) {
    // example: "▶️ Task Line L3"
    return `${E.play} Task Line L${idx}`;
  }

  // The bus we return for shell() to emit into.
  const bus = eventBus<ShellBusEvents>();

  //
  // spawn:* lifecycle
  //
  bus.on("spawn:start", ({ cmd, args, cwd, hasStdin }) => {
    currentSpawnIdx = ++spawnSeq;
    const title = spawnSectionTitle(currentSpawnIdx, cmd, args);

    md.section(
      title,
      (m) => {
        m.p(em.start(mdFmt.bold("Command started")));
        m.table(
          ["Property", "Value"],
          [
            ["Command", mdFmt.codeInline(cmd)],
            ["Args", args.length ? fmtArgs(args) : "(none)"],
            ["CWD", cwd ? mdFmt.path(cwd) : "(inherit)"],
            ["stdin", hasStdin ? "piped" : "null"],
            ["Started at", new Date().toISOString()],
          ],
          ["left", "left"],
        );

        m.h3("Command Line");
        m.code(
          "bash",
          `${cmd} ${fmtArgs(args)}`.trim(),
        );
      },
      2,
      { id: `spawn-${currentSpawnIdx}` },
    );
  });

  bus.on(
    "spawn:done",
    ({ cmd, args, code, success, stdout, stderr, durationMs }) => {
      // append more info to the same spawn section
      const title = spawnSectionTitle(currentSpawnIdx, cmd, args);

      md.section(title, (m) => {
        m.h3(em.done("Result", success));

        m.table(
          ["Metric", "Value"],
          [
            ["Exit code", String(code)],
            ["Success", success ? "true" : "false"],
            [
              "Duration",
              `${Math.round(durationMs)}ms${em.timer(durationMs)}`,
            ],
          ],
          ["left", "left"],
        );

        if (stdout.length > 0) {
          m.h4("Captured stdout");
          m.code(
            "text",
            te.decode(stdout),
          );
        }

        if (stderr.length > 0) {
          m.h4("Captured stderr");
          m.code(
            "text",
            te.decode(stderr),
          );
        }
      });
    },
  );

  bus.on("spawn:error", ({ cmd, args, error }) => {
    // spawn:error might fire standalone, so give it its own seq
    const idx = ++spawnSeq;
    const title = spawnSectionTitle(idx, cmd, args);

    md.section(
      title,
      (m) => {
        m.h3(em.error("Spawn Error"));

        const errMsg = (error instanceof Error) ? error.message : String(error);

        m.table(
          ["Property", "Value"],
          [
            ["Command", mdFmt.codeInline(cmd)],
            ["Args", args.length ? fmtArgs(args) : "(none)"],
            ["Error", errMsg],
            ["When", new Date().toISOString()],
          ],
          ["left", "left"],
        );
      },
      2,
      { id: `spawn-${idx}` },
    );
  });

  //
  // task:line:* lifecycle for shell.auto() or shell.task()
  //
  bus.on("task:line:start", ({ index, line }) => {
    // Create the line section the first time we see this index.
    if (!taskTitleByIndex.has(index)) {
      taskSeq++;
      const title = taskSectionTitle(index);
      taskTitleByIndex.set(index, title);

      md.section(
        title,
        (m) => {
          m.p(em.play(mdFmt.bold("Task line started")));
          m.table(
            ["Property", "Value"],
            [
              ["Line index", `L${index}`],
              ["Started at", new Date().toISOString()],
            ],
            ["left", "left"],
          );

          m.h3("Line Content");
          m.code("bash", line);
        },
        2,
        { id: `task-${index}` },
      );
    } else {
      // re-open existing block if same logical line index is re-run
      const title = taskTitleByIndex.get(index)!;
      md.section(title, (m) => {
        m.p(em.play(mdFmt.bold("Task line re-run start")));
        m.table(
          ["Property", "Value"],
          [
            ["Line index", `L${index}`],
            ["Re-run at", new Date().toISOString()],
          ],
          ["left", "left"],
        );
      });
    }
  });

  bus.on(
    "task:line:done",
    ({ index, code, success, stdout, stderr, durationMs }) => {
      const title = taskTitleByIndex.get(index) ?? taskSectionTitle(index);

      md.section(title, (m) => {
        m.h3(em.done("Result", success));

        m.table(
          ["Metric", "Value"],
          [
            ["Exit code", String(code)],
            ["Success", success ? "true" : "false"],
            [
              "Duration",
              `${Math.round(durationMs)}ms${em.timer(durationMs)}`,
            ],
          ],
          ["left", "left"],
        );

        if (stdout.length > 0) {
          m.h4("Captured stdout");
          m.code(
            "text",
            te.decode(stdout),
          );
        }

        if (stderr.length > 0) {
          m.h4("Captured stderr");
          m.code(
            "text",
            te.decode(stderr),
          );
        }
      });
    },
  );

  //
  // shebang:* lifecycle for inline script tempfiles
  //
  bus.on("shebang:tempfile", ({ path }) => {
    const title = `${E.page} Shebang Script`;

    md.section(
      title,
      (m) => {
        m.h3(em.page("Temporary File Created"));

        m.table(
          ["Property", "Value"],
          [
            ["Temp file path", mdFmt.path(path)],
            ["Created at", new Date().toISOString()],
          ],
          ["left", "left"],
        );

        m.p(
          "The shell wrote inline script content to a temp file so it " +
            "could be executed via its declared `#!` interpreter.",
        );
      },
      2,
      { id: "shebang" },
    );
  });

  bus.on("shebang:cleanup", ({ path, ok, error }) => {
    const title = `${E.page} Shebang Script`;

    md.section(title, (m) => {
      m.h3(em.broom("Cleanup"));

      const errMsg = ok ? "" : (error ? String(error) : "error");

      m.table(
        ["Property", "Value"],
        [
          ["Temp file path", mdFmt.path(path)],
          ["Cleanup status", ok ? "ok" : "error"],
          ["Cleanup error", errMsg || "(none)"],
          ["When", new Date().toISOString()],
        ],
        ["left", "left"],
      );

      if (!ok) {
        m.quote(
          "Cleanup failed. Manual removal of the temp file may be required.",
        );
      }
    });
  });

  //
  // auto:mode lifecycle (how shell.auto() decided to execute)
  //
  bus.on("auto:mode", ({ mode }) => {
    const title = `${E.gear} Automation Mode`;

    md.section(
      title,
      (m) => {
        m.p(
          em.gear(
            mdFmt.bold("Inline task execution mode selected"),
          ),
        );
        m.table(
          ["Property", "Value"],
          [
            [
              "Mode",
              mode === "shebang"
                ? "shebang (write temp file and exec interpreter)"
                : "eval (pipe lines directly into interpreter)",
            ],
            ["When", new Date().toISOString()],
          ],
          ["left", "left"],
        );
      },
      2,
      { id: "auto-mode" },
    );
  });

  // Caller can grab the md they already passed in,
  // but we also return a `write()` convenience for finalization.
  return {
    bus,
    write: () => md.write(),
  };
}
