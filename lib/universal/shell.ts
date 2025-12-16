import { eventBus } from "./event-bus.ts";

type WithBaggage<Baggage, T> = T & { baggage?: Baggage };

export type ShellBusEvents<Baggage = unknown> = {
  "spawn:start": WithBaggage<Baggage, {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    hasStdin: boolean;
  }>;
  "spawn:done": WithBaggage<Baggage, {
    cmd: string;
    args: string[];
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  }>;
  "spawn:error": WithBaggage<Baggage, {
    cmd: string;
    args: string[];
    error: unknown;
  }>;

  "task:line:start": WithBaggage<Baggage, { index: number; line: string }>;
  "task:line:done": WithBaggage<Baggage, {
    index: number;
    line: string;
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    durationMs: number;
  }>;

  "shebang:tempfile": WithBaggage<Baggage, { path: string; script: string }>;
  "shebang:cleanup": WithBaggage<
    Baggage,
    { path: string; ok: boolean; error?: unknown }
  >;

  "auto:mode": WithBaggage<Baggage, { mode: "shebang" | "eval" }>;
};

export function shell<Baggage = unknown>(init?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  tmpDir?: string;
  /** Optional, strongly-typed event bus for shell lifecycle */
  bus?: ReturnType<typeof eventBus<ShellBusEvents<Baggage>>>;
}) {
  const cwd = init?.cwd;
  const env = init?.env;
  const tmpDir = init?.tmpDir;
  const bus = init?.bus;

  type Events = ShellBusEvents<Baggage>;
  type ShellKey = keyof Events & string;
  type MaybeArgs<K extends ShellKey> = Events[K] extends void ? []
    : [Events[K]];

  type RunResult = {
    code: number;
    success: boolean;
    stdout: Uint8Array;
    stderr: Uint8Array;
    baggage?: Baggage;
  };

  const emit = <K extends ShellKey>(type: K, ...detail: MaybeArgs<K>): void => {
    if (!bus) return;
    (bus.emit as <T extends ShellKey>(t: T, ...d: MaybeArgs<T>) => boolean)(
      type,
      ...detail,
    );
  };

  function cleanEnv(
    e?: Record<string, string | undefined>,
  ): Record<string, string> | undefined {
    if (!e) return undefined;
    const pairs: [string, string][] = [];
    for (const [k, v] of Object.entries(e)) {
      if (v !== undefined) pairs.push([k, v]);
    }
    return pairs.length ? Object.fromEntries(pairs) : {};
  }

  const run = async (
    cmd: string,
    args: readonly string[],
    stdin?: Uint8Array,
    baggage?: Baggage,
  ): Promise<RunResult> => {
    const argsArr = [...args];
    emit("spawn:start", {
      cmd,
      args: argsArr,
      cwd,
      env: cleanEnv(env),
      hasStdin: !!(stdin && stdin.length),
      baggage,
    });

    const started = performance.now();
    const command = new Deno.Command(cmd, {
      args: argsArr,
      cwd,
      env: cleanEnv(env),
      stdin: stdin && stdin.length ? "piped" : "null",
      stdout: "piped",
      stderr: "piped",
    });

    try {
      if (stdin && stdin.length) {
        const child = command.spawn();
        try {
          const writer = child.stdin!.getWriter();
          try {
            await writer.write(stdin);
          } finally {
            await writer.close();
          }
          const { code, success, stdout, stderr } = await child.output();
          const durationMs = performance.now() - started;
          emit("spawn:done", {
            cmd,
            args: argsArr,
            code,
            success,
            stdout,
            stderr,
            durationMs,
            baggage,
          });
          return { code, success, stdout, stderr, baggage };
        } finally {
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        }
      } else {
        const { code, success, stdout, stderr } = await command.output();
        const durationMs = performance.now() - started;
        emit("spawn:done", {
          cmd,
          args: argsArr,
          code,
          success,
          stdout,
          stderr,
          durationMs,
          baggage,
        });
        return { code, success, stdout, stderr, baggage };
      }
    } catch (error) {
      emit("spawn:error", { cmd, args: argsArr, error, baggage });
      throw error;
    }
  };

  // simple quoted argv splitter for spawnText()
  const splitArgvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quote: '"' | "'" | null = null;
    let esc = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (esc) {
        cur += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        else cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch as '"' | "'";
        continue;
      }
      if (/\s/.test(ch)) {
        if (cur) {
          out.push(cur);
          cur = "";
        }
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  };

  const spawnArgv = (
    argv: readonly string[],
    stdin?: Uint8Array,
    baggage?: Baggage,
  ) => {
    if (!argv.length) {
      return Promise.resolve<RunResult>({
        code: 0,
        success: true,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        baggage,
      });
    }
    const [cmd, ...args] = argv;
    return run(cmd, args, stdin, baggage);
  };

  const spawnText = (line: string, stdin?: Uint8Array, baggage?: Baggage) =>
    spawnArgv(splitArgvLine(line), stdin, baggage);

  const denoTaskEval = async (
    program: string,
    baggage?: Baggage,
  ) => {
    const lines = program.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const results: Array<
      {
        index: number;
        line: string;
      } & RunResult
    > = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      emit("task:line:start", { index: i, line, baggage });
      const started = performance.now();
      const r = await spawnArgv(
        ["deno", "task", "--eval", line],
        undefined,
        baggage,
      );
      const durationMs = performance.now() - started;
      emit("task:line:done", {
        index: i,
        line,
        code: r.code,
        success: r.success,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs,
        baggage,
      });
      results.push({ index: i, line, ...r });
    }
    return results;
  };

  const spawnShebang = async (
    script: string,
    stdin?: Uint8Array,
    baggage?: Baggage,
  ) => {
    const file = await Deno.makeTempFile({
      dir: tmpDir,
      prefix: "shell-",
    });
    emit("shebang:tempfile", { path: file, script, baggage });
    try {
      await Deno.writeTextFile(file, script);
      await Deno.chmod(file, 0o755);
      const res = await spawnArgv([file], stdin, baggage);
      return res;
    } finally {
      try {
        await Deno.remove(file);
        emit("shebang:cleanup", { path: file, ok: true, baggage });
      } catch (error) {
        emit("shebang:cleanup", { path: file, ok: false, error, baggage });
      }
    }
  };

  const auto = <B extends Baggage = Baggage>(
    source: string,
    stdin?: Uint8Array,
    baggage?: B,
  ) => {
    const first = source.split(/\r?\n/, 1)[0] ?? "";
    if (first.startsWith("#!")) {
      emit("auto:mode", { mode: "shebang", baggage });
      return spawnShebang(source, stdin, baggage);
    } else {
      emit("auto:mode", { mode: "eval", baggage });
      return denoTaskEval(source, baggage);
    }
  };

  const strategy = (source: string) => {
    const linesOfCode = source.split(/\r?\n/, 1);
    const first = linesOfCode[0] ?? "";
    if (first.startsWith("#!")) {
      return { engine: "shebang" as const, label: first, linesOfCode };
    } else {
      return {
        engine: "deno-task" as const,
        label: `${linesOfCode.length} Deno task${
          linesOfCode.length > 1 ? "s" : ""
        }`,
        linesOfCode,
      };
    }
  };

  return {
    spawnText,
    spawnArgv,
    spawnShebang,
    denoTaskEval,
    auto,
    splitArgvLine,
    strategy,
  };
}
