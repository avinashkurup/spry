/**
 * @module resource-contributions
 *
 * Parse a plain-text “contribution spec” into a stream of resolved resource contributions,
 * suitable for ingestion/materialization pipelines that need:
 * - consistent destination paths (either a direct destPath or destPrefix + relative path)
 * - provenance metadata per contribution (line number, raw spec line, parsed instruction record)
 * - a resource access strategy decision (local filesystem vs remote URL, plus related hints)
 *
 * This module is intentionally “two-stage”:
 * 1) `specs()` yields validated spec lines and records any issues.
 * 2) `provenance()` expands each spec across one or more bases, runs `strategyDecisions(...)`,
 *    and yields concrete contribution objects with computed `destPath`.
 *
 * Spec grammar (updated)
 *
 * There is one shared positional “dest token” after the candidate. Its meaning depends on
 * whether the candidate is multi-target (glob) or single-target (including URLs).
 *
 * - Unlabeled:
 *   - Multi-target candidate:  `<candidate-multiple> [<destPrefix>] ...`
 *   - Single candidate / URL: `<candidate-single-or-url> <destPath> ...`
 *
 * - Labeled (when `args.labeled` is true):
 *   - Multi-target candidate:  `<label> <candidate-multiple> [<destPrefix>] ...`
 *   - Single candidate / URL: `<label> <candidate-single-or-url> <destPath> ...`
 *
 * Interpretation rules:
 * - Candidate is HTTP/HTTPS URL        → single-target; dest token means destPath (required,
 *                                       but may be "." / "./dir" via resolveDestPath()).
 * - Candidate is a glob/multi-target   → dest token means destPrefix (optional; may fall back
 *                                       to args.destPrefix; one of them must exist).
 * - Candidate is a single local path   → dest token means destPath (required, but may be "."
 *                                       / "./dir" via resolveDestPath()).
 *
 * Flags and “meta”
 *
 * This module consumes:
 * - optional `label`
 * - `candidate`
 * - optional positional `destToken`
 *
 * Everything else positional (after those consumed tokens) is preserved as an opaque `meta`
 * string on the spec line. Flags are available via `ir`/`ppiq` (Posix PI parsing) and are
 * intentionally not duplicated into `meta`.
 *
 * MIME override
 * - Each spec line may provide `--mime <MIME TYPE>`.
 * - If present, it is applied to ResourceProvenance.mimeType BEFORE strategyDecisions(),
 *   affecting encoding selection (`utf8-text` vs `utf8-binary`) consistently.
 *
 * Destination behavior (updated)
 * - In prefix-mode (multi-target), destPrefix is applied and a relative segment is appended:
 *     destPath = normalize(join(destPrefix, relativeSegment))
 * - In path-mode (single local / URL), destToken is resolved into the final destPath:
 *     destPath = normalize(resolvedDestPath)
 *   destPrefix is undefined in this mode.
 *
 * URL handling
 * - If a candidate parses as HTTP/HTTPS and `args.allowUrls` is not true, an error issue is
 *   recorded and the line is skipped.
 * - For URL candidates, we use the first effective base only (bases[0]) when constructing
 *   the strategy decision input (keeps behavior deterministic when multiple bases exist).
 *
 * Issues reporting
 * - This module does not throw on bad lines by default; it accumulates `issues[]` entries with
 *   severity and line context. Callers should inspect `issues` after iteration.
 *
 * Generic typing
 * - `resourceContributions(...)` is generic over the parsed line “shape” and the resulting
 *   contribution type.
 * - Use `args.toContribution(...)` to enrich/extend emitted contribution objects while
 *   preserving type information.
 *
 * Notes on type-safety upgrades (unobvious but important)
 * - We avoid attaching ad-hoc `__line` / `__destPrefix` fields and then deleting them. Instead
 *   we define a typed “strategy input” provenance shape that carries internal metadata safely
 *   through `strategyDecisions(...)` (including glob expansion).
 * - `specs()` is re-iterable: we cache validated spec lines to prevent single-use generator
 *   surprises (tests often call `specs()` before `provenance()`).
 */

import {
  basename,
  isGlob as stdIsGlob,
  join,
  normalize,
  relative,
} from "@std/path";
import z from "@zod/zod";
import {
  instructionsFromText,
  type InstructionsResult,
  type PosixPIQuery,
  queryPosixPI,
} from "./posix-pi.ts";
import {
  detectMimeFromPath,
  hasGlobChar,
  provenanceResource,
  Resource,
  ResourceLabel,
  ResourcePath,
  ResourceProvenance,
  type ResourceStrategy,
  strategyDecisions,
  tryParseHttpUrl,
} from "./resource.ts";

/** See existing file for full docs/types; unchanged unless shown below. */
export type FlexibleContributionsFlags = {
  readonly labeled?: boolean;
  readonly interpolate?: boolean;
  readonly base?: unknown;
};

/**
 * Destination intent as a discriminated union.
 *
 * - kind:"prefix" → multi-target mode; destPath is computed as prefix + relative segment
 * - kind:"path"   → single-target mode; destPath is the final destination path
 */
export type Dest =
  | { readonly kind: "prefix"; readonly value: string }
  | { readonly kind: "path"; readonly value: string };

type CandidateKind =
  | { readonly kind: "remote-url"; readonly url: URL }
  | { readonly kind: "glob" }
  | { readonly kind: "single-path" };

function classifyCandidate(candidate: string): CandidateKind {
  const url = tryParseHttpUrl(candidate);
  if (url) return { kind: "remote-url", url };

  // Align with resource.ts default behavior: stdIsGlob, plus common glob metacharacters.
  const isGlobLike = stdIsGlob(candidate) || hasGlobChar(candidate);
  return isGlobLike ? { kind: "glob" } : { kind: "single-path" };
}

export type ContributeSpecLineParsed<Shape> = z.ZodSafeParseResult<Shape>;

export type ContributeSpecLine<Shape = unknown> = {
  readonly lineNumInRawInstructions: number;
  readonly rawInstructions: string;
  readonly ir: InstructionsResult;
  readonly ppiq: PosixPIQuery;

  readonly label?: string;
  readonly candidate: string;

  /**
   * The 2nd positional token (after candidate), if present.
   * Interpreted later as either:
   * - destPrefix (glob/multi-target), or
   * - destPath (single local / URL), potentially through a resolver.
   */
  readonly destToken?: string;

  /**
   * Opaque positional remainder after this module consumes:
   * - label (optional)
   * - candidate
   * - destToken (optional)
   *
   * Unobvious: flags are not duplicated here. Flags are available via `ir` / `ppiq`.
   */
  readonly meta: string;

  readonly parsedArgs?: ContributeSpecLineParsed<Shape>;
};

export type FromTextOptions<Shape = unknown> = FlexibleContributionsFlags & {
  readonly transform?: (line: string, lineNum: number) => string | false;
  readonly schema?: (
    line: Omit<ContributeSpecLine<unknown>, "parsedArgs">,
  ) => z.ZodType<Shape> | false;
};

function* textContributions<Shape = unknown>(
  text: string,
  opts?: FromTextOptions<Shape>,
): Generator<ContributeSpecLine<Shape>> {
  const labeled = !!opts?.labeled;
  const lines = text.split(/\r\n|\r|\n/);
  let lineNum = 0;

  const effectiveLines = lines.at(-1) === "" ? lines.slice(0, -1) : lines;

  for (const raw of effectiveLines) {
    lineNum++;

    const transformed = opts?.transform ? opts.transform(raw, lineNum) : raw;
    if (transformed === false) continue;

    const trimmed = transformed.trim();
    if (!trimmed) continue;

    const ir = instructionsFromText(trimmed);
    const ppiq = queryPosixPI(ir.pi);

    const args = [...ir.pi.args];
    const required = labeled ? 2 : 1;
    if (args.length < required) continue;

    // Consume the structured head of the line.
    const label = labeled ? args.shift() : undefined;
    const candidate = args.shift() ?? "";

    // Consume the dest token (optional). What remains becomes meta.
    const destToken = args.shift();
    const meta = args.join(" ");

    const baseLine: Omit<ContributeSpecLine<unknown>, "parsedArgs"> = {
      lineNumInRawInstructions: lineNum,
      rawInstructions: trimmed,
      ir,
      ppiq,
      ...(label !== undefined ? { label } : null),
      candidate,
      ...(destToken !== undefined ? { destToken } : null),
      meta,
    };

    const schema = opts?.schema ? opts.schema(baseLine) : false;
    if (schema) {
      const parsedArgs = schema.safeParse(baseLine);

      yield {
        ...(baseLine as unknown as Omit<
          ContributeSpecLine<Shape>,
          "parsedArgs"
        >),
        parsedArgs: parsedArgs as ContributeSpecLineParsed<Shape>,
      } satisfies ContributeSpecLine<Shape>;
    } else {
      yield baseLine as unknown as ContributeSpecLine<Shape>;
    }
  }
}

/**
 * A contribution always has:
 * - `dest` (prefix-mode or path-mode, discriminated)
 * - `destPath` (final destination path string)
 *
 * `destPrefix` is provided only for prefix-mode for convenience.
 */
export type ResourceContribution<SpecLine extends ContributeSpecLine> = {
  readonly dest: Dest;
  readonly destPath: string;
  readonly destPrefix?: string;
  readonly origin: SpecLine;
  readonly provenance: ResourceProvenance;
  readonly strategy: ResourceStrategy;
};

export type ResourceContributionsIssue = {
  readonly severity: "error" | "warn";
  readonly line: number;
  readonly rawInstructions: string;
  readonly message: string;
};

export type ResourceContributionsResult<
  Shape extends { destToken?: string },
  SpecLine extends ContributeSpecLine<Shape>,
  Contribution extends ResourceContribution<SpecLine>,
> = Readonly<{
  blockBases: readonly string[];
  issues: readonly ResourceContributionsIssue[];
  specs: () => Generator<SpecLine>;
  provenance: () => Generator<Contribution>;
  resources: () => Generator<
    Resource<
      {
        // Unobvious: `mimeType` is REQUIRED at this boundary for consumer DX.
        // We ensure the key is always present in resources().
        mimeType: string | undefined;
        destPath: string;
        spec: SpecLine;
        path: ResourcePath;
        label?: ResourceLabel;
      },
      ResourceStrategy
    >,
    void,
    unknown
  >;
}>;

type LabeledShape<
  Labeled extends boolean,
  Base extends { destToken?: string },
> = Labeled extends true ? (Base & { label: string }) : Base;

/**
 * Parse only what is present on the line.
 *
 * We intentionally do NOT attempt to decide whether destToken is a prefix or a path here.
 * That decision depends on candidate classification (URL vs glob vs single-path).
 */
function resourceContributionsSchema<
  Shape extends { destToken?: string },
>(
  labeled: boolean,
): z.ZodType<Shape> {
  const base = z.object({
    label: labeled ? z.string().min(1) : z.string().min(1).optional(),
    destToken: z.string().min(1).optional(),
    meta: z.string(),
    candidate: z.string().min(1),
  });

  return base.transform((raw) => {
    return {
      ...(raw.label !== undefined ? { label: raw.label } : null),
      ...(raw.destToken !== undefined ? { destToken: raw.destToken } : null),
    } as Shape;
  });
}

/**
 * Internal “strategy input” provenance.
 *
 * This is intentionally a ResourceProvenance superset so that:
 * - strategyDecisions() can treat it as provenance (it reads `path`, `mimeType`, etc.)
 * - our extra metadata survives glob expansion (resource.ts copies baseProv fields to children)
 *
 * Unobvious detail: carrying `base` through provenance means the base used for join/relative
 * calculations stays attached even after glob expansion replaces `path` with matched child paths.
 */
type StrategyInput<SpecLine> = ResourceProvenance & {
  readonly base: string;
  readonly __origin: SpecLine;
  readonly __dest: Dest;
};

function normalizePosixPath(p: string): string {
  return normalize(p).replace(/\\/g, "/");
}

/**
 * Compute the effective MIME type for a spec line.
 *
 * - `--mime <type>` wins (and is applied BEFORE strategyDecisions()).
 * - otherwise infer from the candidate string (best-effort).
 */
function mimeFromLine(
  line: ContributeSpecLine,
  candidate: string,
): string | undefined {
  const flag = line.ppiq.getTextFlag("mime");
  if (flag && flag.length > 0) return flag;
  return detectMimeFromPath(candidate);
}

/**
 * Deterministically derive a filesystem-ish path from a URL relative to a base URL.
 *
 * This replaces the old `relativeUrlAsFsPath(...)` helper entirely.
 *
 * Rules:
 * - If base and URL share origin, attempt to strip the base pathname prefix.
 * - Otherwise, preserve hostname + pathname.
 * - query/hash are appended (sanitized) so distinct URLs map to distinct dest paths.
 *
 * Unobvious: we always sanitize `: ? & #` because these are problematic in filenames.
 */
function urlPathRelativeToBase(base: string, url: string): string {
  const sanitize = (s: string) => s.replace(/[:?&#]/g, "_");

  try {
    const u = new URL(url, base);
    const b = new URL(base, base);

    // Different origins: include host to avoid collisions.
    if (u.origin !== b.origin) {
      const p = u.pathname.replace(/^\/+/, "");
      let out = `${u.hostname}/${p}`;
      if (u.search) out += sanitize(u.search);
      if (u.hash) out += sanitize(u.hash);
      return normalizePosixPath(out);
    }

    // Same origin: make path relative to base.pathname if possible.
    const basePath = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
    let rel = u.pathname.startsWith(basePath)
      ? u.pathname.slice(basePath.length)
      : u.pathname;
    rel = rel.replace(/^\/+/, "");

    if (u.search) rel += sanitize(u.search);
    if (u.hash) rel += sanitize(u.hash);

    return normalizePosixPath(rel);
  } catch {
    // If URL parsing fails, fall back to a safe-ish normalization.
    return normalizePosixPath(url);
  }
}

/* -------------------------------------------------------------------------- */
/*                Dest-path resolver callbacks (DX convenience)               */
/* -------------------------------------------------------------------------- */

export type ResolveDestPathContext<
  SpecLine extends ContributeSpecLine = ContributeSpecLine,
> = {
  /** Only for single-target candidates; globs use destPrefix rules. */
  readonly kind: "remote-url" | "single-path";
  readonly candidate: string;
  /** Effective first base (after line-level overrides + resolveBasePath). */
  readonly base: string;
  /** Present when kind==="remote-url". */
  readonly url?: URL;
  /** Raw dest token from the line (may be ".", "./dir", or explicit). */
  readonly destToken?: string;
  readonly origin: SpecLine;
};

export type ResolveDestPath<
  SpecLine extends ContributeSpecLine = ContributeSpecLine,
> = (
  ctx: ResolveDestPathContext<SpecLine>,
) => string | undefined;

function isAutoDestTokenDefault(token?: string): boolean {
  if (!token) return false;
  const t = token.trim();
  return t === "." || t === "./";
}

/**
 * Default resolver for single-path and URL candidates.
 *
 * - token "." / "./" => auto:
 *   - URL: derive base-relative URL path
 *   - local: basename(candidate)
 * - token "./some/dir" => join(dir, basename(...))
 * - otherwise: explicit destPath
 */
function defaultResolveDestPath(
  ctx: ResolveDestPathContext,
): string | undefined {
  const token = ctx.destToken?.trim();

  // Explicit destPath (most predictable: user wrote a path, we take it as-is).
  if (token && !isAutoDestTokenDefault(token) && !token.startsWith("./")) {
    return token;
  }

  // "./dir" convenience: put basename under that dir.
  if (token && token.startsWith("./") && token !== "./" && token !== ".") {
    const baseName = ctx.kind === "remote-url"
      ? basename(new URL(ctx.candidate, ctx.base).pathname)
      : basename(ctx.candidate);
    return join(token, baseName);
  }

  // Auto token "." or "./".
  if (isAutoDestTokenDefault(token)) {
    if (ctx.kind === "remote-url") {
      return urlPathRelativeToBase(ctx.base, ctx.candidate);
    }
    return basename(ctx.candidate);
  }

  // Missing token: caller decides (default behavior treats this as error).
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*                               Main export                                  */
/* -------------------------------------------------------------------------- */

export function resourceContributions<
  const Labeled extends boolean = false,
  Shape extends LabeledShape<Labeled, { destToken?: string }> = LabeledShape<
    Labeled,
    { destToken?: string }
  >,
  SpecLine extends ContributeSpecLine<Shape> = ContributeSpecLine<Shape>,
  Contribution extends ResourceContribution<SpecLine> = ResourceContribution<
    SpecLine
  >,
>(
  text: string,
  args?: {
    /** Enable labeled grammar: `<label> <candidate> <destToken?> ...` */
    readonly labeled?: Labeled;

    /**
     * One or more base paths/URLs that candidates are resolved against.
     * Renamed from `base` to `fromBase`.
     */
    readonly fromBase?: string | string[];

    /**
     * Default destination prefix used only for prefix-mode (multi-target) lines
     * when the line omits destToken.
     *
     * In path-mode (single / URL), the dest token is required (but may be ".").
     */
    readonly destPrefix?: string;

    /** Whether HTTP/HTTPS URL candidates are allowed. Default false. */
    readonly allowUrls?: boolean;

    /** Optional mapper to transform base strings before use. */
    readonly resolveBasePath?: (path: string) => string;

    /** Optional pre-parse line transform. Return false to skip a line. */
    readonly transform?: (line: string, lineNum: number) => string | false;

    /**
     * Optional hook to resolve destPath for single-path + URL candidates.
     *
     * Typical use: "." and "./dir" conventions, custom mapping, hashing, etc.
     * If omitted, defaults to:
     * - URL + "." => urlPathRelativeToBase(base, url)
     * - local + "." => basename(candidate)
     * - "./dir" => join("./dir", basename(...))
     */
    readonly resolveDestPath?: ResolveDestPath<SpecLine>;

    /**
     * Optional hook to enrich contribution outputs while preserving generic typing.
     */
    readonly toContribution?: (base: {
      dest: Dest;
      destPath: string;
      destPrefix?: string;
      origin: SpecLine;
      provenance: ResourceProvenance;
      strategy: ResourceStrategy;
    }) => Contribution;
  },
): ResourceContributionsResult<Shape, SpecLine, Contribution> {
  const blockBases = Array.isArray(args?.fromBase)
    ? args.fromBase
    : (typeof args?.fromBase === "string" && args.fromBase.length > 0
      ? [args.fromBase]
      : ["." as const]);

  const labeled = !!args?.labeled;
  const issues: ResourceContributionsIssue[] = [];

  const schema = resourceContributionsSchema<Shape>(labeled);

  // Re-iterable specs: cache validated lines once (best DX).
  let cachedSpecs: SpecLine[] | undefined;

  const buildSpecsOnce = (): SpecLine[] => {
    if (cachedSpecs) return cachedSpecs;

    const out: SpecLine[] = [];
    for (
      const line of textContributions<Shape>(text, {
        labeled,
        transform: args?.transform,
        schema: () => schema,
      })
    ) {
      if (!line.parsedArgs) continue;

      if (!line.parsedArgs.success) {
        issues.push({
          severity: "error",
          line: line.lineNumInRawInstructions,
          rawInstructions: line.rawInstructions,
          message: labeled
            ? `Invalid spec line (expected "<label> <candidate> <destToken?> ..."), skipping.`
            : `Invalid spec line (expected "<candidate> <destToken?> ..."), skipping.`,
        });
        continue;
      }

      if (tryParseHttpUrl(line.candidate) && !args?.allowUrls) {
        issues.push({
          severity: "error",
          line: line.lineNumInRawInstructions,
          rawInstructions: line.rawInstructions,
          message: "URL candidate is present but allowUrls is false, skipping.",
        });
        continue;
      }

      out.push(line as unknown as SpecLine);
    }

    cachedSpecs = out;
    return out;
  };

  function* specs(): Generator<SpecLine> {
    for (const s of buildSpecsOnce()) yield s;
  }

  function* provenance(): Generator<Contribution> {
    const inputs: StrategyInput<SpecLine>[] = [];

    for (const line of specs()) {
      const parsed = line.parsedArgs!;
      const destToken = parsed.success ? parsed.data.destToken : undefined;

      const candidatePath = line.candidate;
      const candidateKind = classifyCandidate(candidatePath);

      const specBases = line.ppiq.getTextFlagValues("base");
      let bases = specBases.length > 0 ? specBases : blockBases;
      if (args?.resolveBasePath) {
        bases = bases.map((b) => args.resolveBasePath!(b));
      }

      // Deterministic base selection for single-target lines (single local + URL).
      const base0 = bases[0] ?? ".";

      // MIME override is applied here (before strategyDecisions()).
      const mime = mimeFromLine(line, candidatePath);
      const baseProvCommon: Pick<ResourceProvenance, "mimeType"> = {
        ...(mime ? { mimeType: mime } : null),
      };

      // --- URL: path-mode (destPath) with "." convenience via resolver -----------
      if (candidateKind.kind === "remote-url") {
        const resolver = args?.resolveDestPath ?? defaultResolveDestPath;
        const resolved = resolver({
          kind: "remote-url",
          candidate: candidatePath,
          base: base0,
          url: candidateKind.url,
          destToken,
          origin: line,
        });

        if (!resolved || resolved.length === 0) {
          issues.push({
            severity: "error",
            line: line.lineNumInRawInstructions,
            rawInstructions: line.rawInstructions,
            message:
              `Missing destPath: URL candidates require "<destPath>" (or use "." / "./dir" for auto).`,
          });
          continue;
        }

        inputs.push({
          path: candidatePath,
          label: candidatePath,
          ...baseProvCommon,
          base: base0,
          __origin: line,
          __dest: { kind: "path", value: resolved },
        });

        continue;
      }

      // --- Single local: path-mode (destPath) with "." convenience via resolver ---
      if (candidateKind.kind === "single-path") {
        const resolver = args?.resolveDestPath ?? defaultResolveDestPath;
        const resolved = resolver({
          kind: "single-path",
          candidate: candidatePath,
          base: base0,
          destToken,
          origin: line,
        });

        if (!resolved || resolved.length === 0) {
          issues.push({
            severity: "error",
            line: line.lineNumInRawInstructions,
            rawInstructions: line.rawInstructions,
            message:
              `Missing destPath: single candidates require "<destPath>" (or use "." / "./dir" for auto).`,
          });
          continue;
        }

        inputs.push({
          path: join(base0, candidatePath),
          label: candidatePath,
          ...baseProvCommon,
          base: base0,
          __origin: line,
          __dest: { kind: "path", value: resolved },
        });

        continue;
      }

      // --- Glob: prefix-mode (destPrefix) ---------------------------------------
      const effectivePrefix = (destToken && destToken.length > 0)
        ? destToken
        : args?.destPrefix;

      if (!effectivePrefix || effectivePrefix.length === 0) {
        issues.push({
          severity: "error",
          line: line.lineNumInRawInstructions,
          rawInstructions: line.rawInstructions,
          message:
            `Missing destPrefix: glob candidates require "[destPrefix]" or args.destPrefix.`,
        });
        continue;
      }

      for (const base of bases) {
        inputs.push({
          path: join(base, candidatePath),
          label: candidatePath,
          ...baseProvCommon,
          base,
          __origin: line,
          __dest: { kind: "prefix", value: effectivePrefix },
        });
      }
    }

    for (const sd of strategyDecisions(inputs)) {
      const p = sd.provenance as StrategyInput<SpecLine>;
      const strategy = sd.strategy;

      const dest = p.__dest;

      const destPath = dest.kind === "path"
        ? normalizePosixPath(dest.value)
        : (() => {
          // In prefix-mode we always append a relative segment.
          const rel = strategy.target === "local-fs"
            ? relative(p.base, p.path)
            : urlPathRelativeToBase(
              p.base,
              strategy.url?.toString() ?? String(p.path),
            );

          return normalizePosixPath(join(dest.value, rel));
        })();

      // Strip internal metadata
      const {
        base: _omitBase,
        __origin: _omitOrigin,
        __dest: _omitDest,
        ...provOut
      } = p;

      const baseOut = {
        dest,
        destPath,
        ...(dest.kind === "prefix" ? { destPrefix: dest.value } : null),
        origin: p.__origin,
        provenance: provOut as ResourceProvenance,
        strategy,
      };

      yield args?.toContribution
        ? args.toContribution(baseOut)
        : (baseOut as unknown as Contribution);
    }
  }

  function* resources() {
    for (const p of provenance()) {
      // Ensure mimeType exists as a KEY (even if undefined) to satisfy the
      // ResourceContributionsResult.resources() return type contract.
      const mimeType = p.provenance.mimeType ?? undefined;

      yield provenanceResource({
        provenance: {
          ...p.provenance,
          mimeType,
          destPath: p.destPath,
          spec: p.origin,
        },
        strategy: p.strategy,
      });
    }
  }

  return { blockBases, issues, specs, provenance, resources } as const;
}
