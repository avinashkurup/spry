# Spry: Markdown as a Programmable Medium

> Lightweight TypeScript library for executable, composable Markdown.

You’ve probably used Markdown to **document** code. Spry lets you use Markdown
to **be** the code.

Spry is a lightweight TypeScript library that treats Markdown as a
**programmable medium** — every fence, section, and directive in your `.md` file
can express behavior, not just formatting. Instead of building new DSLs or YAML
pipelines, you describe intent in plain Markdown and let Spry materialize it as
code, data, or execution.

## Why Spry?

Modern engineering workflows already blur the line between documentation and
automation:

- Jupyter notebooks run Python next to prose.
- `README.md` files show how to build but can’t actually _build_.
- DevOps playbooks, SQL scripts, and AI prompts live in separate silos.

Spry unifies them. It makes Markdown an **active medium** that:

- Executes embedded code blocks and captures their outputs.
- Composes multiple source types (SQL, HTML, JSON, shell, etc.) as executable
  “cells”.
- Treats sections as first-class programmable units with attributes, metadata,
  and dependency graphs.
- Uses TypeScript for all parsing, safety, and runtime orchestration — no Python
  or heavy kernel machinery.

## What it looks like

See [support/assurance/scf/Spryfile.md](support/assurance/scf/Spryfile.md).

Every fenced block becomes an executable “cell,” every attribute a typed
directive, and the whole Markdown file turns into a reproducible workflow.

## Why not just use notebooks?

Spry is _non-interactive_ by default. Think of it as **Jupyter for build
systems**, **dbt for Markdown**, or **Makefiles written as prose**. It
emphasizes reproducibility and composability over visualization.

Markdown becomes your configuration, your source code, and your documentation —
all in one, all executable.

## Example Use Cases

- Self-verifying README files
- SQL migration notebooks
- Literate DevOps playbooks
- Data pipelines defined in Markdown
- AI prompt notebooks that emit structured JSON
- Documentation that proves its own examples work

## Getting Started with Spry for SQLPage

Spry can scaffold a complete **Markdown + SQLPage** project in seconds using the
built-in CLI initializer. You don’t need to manually create `spry.ts` or
`Spryfile.md` — just run one command.

### Quick Start

Install [`deno 2.5`](https://deno.land) or higher and run the following command
in an empty directory to bootstrap your project:

```bash
cd <your-project>  # create a new directory or use an existing one
deno run -A https://raw.githubusercontent.com/programmablemd/spry/main/lib/sqlpage/cli.ts init
./spry.ts help
```

This creates:

| File          | Purpose                                                     |
| ------------- | ----------------------------------------------------------- |
| `spry.ts`     | Executable wrapper to run Spry commands locally             |
| `Spryfile.md` | Executable Markdown defining SQLPage tasks, SQL, and routes |

Both files are ready to use immediately. You can verify the contents with
`cat spry.ts` and `cat Spryfile.md`.

### Development Mode (Live Reload)

Use `--watch` during development to rebuild automatically when your Markdown
changes:

```bash
./spry.ts spc --fs dev-src.auto --destroy-first --conf sqlpage/sqlpage.json --watch --with-sqlpage
```

- `--watch` monitors Markdown files for changes
- `--with-sqlpage` restarts SQLPage after each build

Or run SQLPage separately in another terminal and drop `--with-sqlpage`.

### Deployment Mode (Single Database)

After development, you can remove generated files and package everything into
your database:

```bash
./spry.ts spc --package --conf sqlpage/sqlpage.json | sqlite3 spry-sqlpage.sqlite.db
./spry.ts spc --package --conf sqlpage/sqlpage.json | psql
```

This produces a single SQLite database containing all `sqlpage_files` rows,
ready for production.

### Understanding the Generated Structure

| File                   | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `spry.ts`              | Project-local Spry runner, importing `CLI` from the correct source |
| `Spryfile.md`          | Executable Markdown defining tasks, SQL cells, and page routes     |
| `sqlpage/sqlpage.json` | SQLPage configuration (referenced by `spc` commands)               |
| `dev-src.auto/`        | Auto-generated SQLPage source directory in development mode        |

Spry parses each fenced code block in `Spryfile.md`, validates its directives,
and materializes them as executable workflows — all type-safe via TypeScript and
Zod.

### Next Steps

- Explore [`Spryfile.md`](support/assurance/scf/Spryfile.md) to understand how tasks and SQLPage routes are defined.
- Add more `bash` or `sql` fences to extend functionality.
- Run `./spry.ts help` to see available commands.
