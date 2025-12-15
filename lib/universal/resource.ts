/**
 * Core resource loading pipeline for Spry:
 *
 * 1. provenanceFromPaths() – turn string paths into ResourceProvenance
 * 2. strategies()          – assign ResourceStrategy + lazy loaders + handle globs
 * 3. resources()           – apply plugins and optional fetch overrides
 *
 * This file intentionally stays "core": no markdown, no domain-specific plugins.
 */

import { expandGlobSync } from "@std/fs";
import { contentType } from "@std/media-types";
import { dirname, isGlob as stdIsGlob, join } from "@std/path";

/* -------------------------------------------------------------------------- */
/*                               Core types                                   */
/* -------------------------------------------------------------------------- */

export type ResourcePath = string;
export type ResourceLabel = string;
export type MimeType = string;

export type ResourceProvenance = {
  readonly path: ResourcePath;
  readonly label?: ResourceLabel;
  readonly mimeType?: MimeType;
};

export type ResourceStrategy = {
  readonly target: "remote-url" | "local-fs";
  readonly encoding: "utf8-text" | "utf8-binary";
  readonly url?: URL;
};

export type Resource<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = {
  readonly provenance: P;
  readonly strategy: S;

  readonly text: () => Promise<string>;
  readonly safeText: (defaultText?: string) => Promise<string | Error>;

  readonly bytes: () => Promise<Uint8Array>;
  readonly safeBytes: (
    defaultBytes?: Uint8Array,
  ) => Promise<Uint8Array | Error>;

  readonly stream: () => Promise<ReadableStream<Uint8Array>>;
  readonly reader: () => Promise<ReadableStreamDefaultReader<Uint8Array>>;
};

/* -------------------------------------------------------------------------- */
/*                            Mime / encoding helpers                         */
/* -------------------------------------------------------------------------- */

export const detectMimeFromPath = (
  path: ResourcePath,
): MimeType | undefined => {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = path.slice(dot); // includes '.'
  const mime = contentType(ext);
  return mime ? mime.split(";", 1)[0].trim().toLowerCase() : undefined;
};

const isTextMime = (mime?: MimeType): boolean => {
  if (!mime) return false;
  const m = mime.toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m.endsWith("+json") ||
    m === "application/xml" ||
    m.endsWith("+xml") ||
    m === "application/sql"
  );
};

const detectEncoding = (mime?: MimeType): ResourceStrategy["encoding"] =>
  isTextMime(mime) ? "utf8-text" : "utf8-binary";

/* -------------------------------------------------------------------------- */
/*                       Fetch overrides / default fetchers                   */
/* -------------------------------------------------------------------------- */

export type FetchOverride<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = (
  input: RequestInfo | URL | string,
  init: RequestInit | undefined,
  provenance: P,
  strategy: S,
) => Promise<Response>;

const defaultRemoteFetch = async <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  input: RequestInfo | URL | string,
  init: RequestInit | undefined,
  _prov: P,
  _strat: S,
): Promise<Response> => {
  return await fetch(input, init);
};

const defaultLocalFetch = async <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  _input: RequestInfo | URL | string,
  _init: RequestInit | undefined,
  prov: P,
  _strat: S,
): Promise<Response> => {
  const path = prov.path;
  const data = await Deno.readFile(path);
  const mime = prov.mimeType ?? detectMimeFromPath(path) ??
    "application/octet-stream";
  return new Response(data, {
    headers: { "content-type": mime },
  });
};

/**
 * Shared loader factory for all Resource implementations (default and overrides).
 */
const makeLoaders = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  fetcher: FetchOverride<P, S>,
  prov: P,
  strat: S,
): Pick<
  Resource<P, S>,
  "text" | "safeText" | "bytes" | "safeBytes" | "stream" | "reader"
> => {
  const text = async (): Promise<string> => {
    const res = await fetcher(prov.path, undefined, prov, strat);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    return await res.text();
  };

  const safeText = async (
    defaultText?: string,
  ): Promise<string | Error> => {
    try {
      return await text();
    } catch (err) {
      if (defaultText !== undefined) return defaultText;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const bytes = async (): Promise<Uint8Array> => {
    const res = await fetcher(prov.path, undefined, prov, strat);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  };

  const safeBytes = async (
    defaultBytes?: Uint8Array,
  ): Promise<Uint8Array | Error> => {
    try {
      return await bytes();
    } catch (err) {
      if (defaultBytes !== undefined) return defaultBytes;
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const stream = async (): Promise<ReadableStream<Uint8Array>> => {
    const res = await fetcher(prov.path, undefined, prov, strat);
    if (!res.ok) {
      throw new Error(`Fetch ${res.status} for ${prov.path}`);
    }
    const body = res.body;
    if (!body) {
      throw new Error(`No body for ${prov.path}`);
    }
    return body;
  };

  const reader = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> =>
    (await stream()).getReader();

  return { text, safeText, bytes, safeBytes, stream, reader };
};

/* -------------------------------------------------------------------------- */
/*                        Phase 1: Provenance factory                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn plain paths into ResourceProvenance objects.
 *
 * - `path` is the original string
 * - `label` defaults to the path
 * - `mimeType` is guessed from the file extension (if any)
 */
export function* provenanceFromPaths(
  paths: Iterable<ResourcePath>,
): Iterable<ResourceProvenance> {
  for (const path of paths) {
    const mime = detectMimeFromPath(path);
    yield {
      path,
      label: path,
      ...(mime ? { mimeType: mime } : null),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                     Phase 2: Strategies & loaders                          */
/* -------------------------------------------------------------------------- */

export type StrategiesInit<
  P extends ResourceProvenance = ResourceProvenance,
> = {
  /**
   * Control glob handling for a given provenance.
   *
   * - return `false`      → never treat this provenance as a glob.
   * - return `true`       → always treat as a glob candidate.
   * - return `"auto"`     → treat as glob if it has glob chars (* ? [).
   *
   * If absent, globs are disabled by default.
   */
  readonly isGlob?: (prov: P) => boolean | "auto";
};

export const hasGlobChar = (s: string): boolean =>
  s.includes("*") || s.includes("?") || s.includes("[");

export const tryParseHttpUrl = (path: string): URL | undefined => {
  try {
    const url = new URL(path);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const normalizeProvenance = <P extends ResourceProvenance>(
  origProv: P,
): P => {
  const mime = origProv.mimeType ?? detectMimeFromPath(origProv.path);
  if (mime && origProv.mimeType !== mime) {
    return { ...origProv, mimeType: mime } as P;
  }
  return origProv;
};

export const strategyFromProvenance = <P extends ResourceProvenance>(
  prov: P,
): ResourceStrategy => {
  const normalized = normalizeProvenance(prov);
  const url = tryParseHttpUrl(normalized.path);
  const encoding = detectEncoding(normalized.mimeType);
  const target: ResourceStrategy["target"] = url ? "remote-url" : "local-fs";
  return { target, encoding, url };
};

export function provenanceResource<
  P extends ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(origin: {
  provenance: P;
  strategy: S;
}) {
  const { provenance, strategy } = origin;

  const fetcher: FetchOverride<P, S> = strategy.target === "remote-url"
    ? defaultRemoteFetch<P, S>
    : defaultLocalFetch<P, S>;

  const loaders = makeLoaders<P, S>(fetcher, provenance, strategy);
  const resource: Resource<P, S> = { provenance, strategy, ...loaders };

  return resource;
}

/**
 * Phase 2 (low-level): classify provenances and compute strategies,
 * without attaching loaders.
 *
 * - Classifies each provenance as `remote-url` or `local-fs`.
 * - Detects MIME and encoding (`utf8-text` vs `utf8-binary`).
 * - Handles glob expansion (if configured).
 */
export function* strategyDecisions<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  provenances: Iterable<P>,
  init?: StrategiesInit<P>,
) {
  const isGlob = init?.isGlob ?? ((p) => stdIsGlob(p.path));

  for (const origProv of provenances) {
    const baseProv = normalizeProvenance(origProv as P);
    const path = baseProv.path;
    const baseStrategy = strategyFromProvenance(baseProv) as S;
    const url = (baseStrategy as ResourceStrategy).url;

    // Glob handling only for non-URLs
    if (!url) {
      // Globs are DISABLED by default unless isGlob is provided
      const decision = isGlob ? isGlob(baseProv) : false;
      const treatAsGlob = decision === true ||
        (decision === "auto" && hasGlobChar(path));

      if (treatAsGlob) {
        for (const entry of expandGlobSync(path)) {
          const childProvRaw: P = {
            ...baseProv,
            path: entry.path as ResourcePath,
          };

          const childProv = normalizeProvenance(childProvRaw);
          const childStrategy = strategyFromProvenance(childProv) as S;
          yield { provenance: childProv, strategy: childStrategy };
        }
        continue;
      }
    }

    // Non-glob (or URL) path → emit as-is
    yield { provenance: baseProv, strategy: baseStrategy };
  }
}

/* -------------------------------------------------------------------------- */
/*                  Phase 3: Resource plugins + fetch overrides               */
/* -------------------------------------------------------------------------- */

export type ResourcePlugin<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = (
  resource: Resource<P, S>,
) => Resource<P, S> | void | Promise<Resource<P, S> | void>;

export type ResourceInit<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = {
  readonly plugins?: readonly ResourcePlugin<P, S>[];

  /**
   * Optional override for remote HTTP(S) fetching.
   * Signature matches `fetch(input, init)` plus provenance + strategy.
   */
  readonly onFetchRemoteURL?: FetchOverride<P, S>;

  /**
   * Optional override for local filesystem fetching.
   * Signature matches `fetch(input, init)` plus provenance + strategy.
   */
  readonly onFetchLocalFS?: FetchOverride<P, S>;
};

const makeLoadersWithOverrides = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  base: Resource<P, S>,
  init: ResourceInit<P, S>,
): Pick<
  Resource<P, S>,
  "text" | "safeText" | "bytes" | "safeBytes" | "stream" | "reader"
> => {
  const prov = base.provenance;
  const strat = base.strategy;

  const fetcher: FetchOverride<P, S> = strat.target === "remote-url"
    ? (init.onFetchRemoteURL ?? defaultRemoteFetch<P, S>)
    : (init.onFetchLocalFS ?? defaultLocalFetch<P, S>);

  return makeLoaders<P, S>(fetcher, prov, strat);
};

/**
 * Apply ResourceInit (fetch overrides + plugins) to a single Resource.
 *
 * - If no init is provided, returns the base resource unchanged.
 * - If overrides are provided, replaces text/bytes/stream/reader with new loaders.
 * - If plugins are provided, runs them in order; last non-void result wins.
 */
export async function applyResourceInit<
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  base: Resource<P, S>,
  init?: ResourceInit<P, S>,
): Promise<Resource<P, S>> {
  if (!init) return base;

  const plugins = init.plugins ?? [];
  const hasOverrides = !!init.onFetchRemoteURL || !!init.onFetchLocalFS;

  let r: Resource<P, S> = base;

  if (hasOverrides) {
    const loaders = makeLoadersWithOverrides(r, init);
    r = { ...r, ...loaders };
  }

  for (const plugin of plugins) {
    const out = await plugin(r);
    if (out) r = out;
  }

  return r;
}

/**
 * Phase 3: apply plugins and optional fetch overrides to Resources.
 *
 * - If fetch overrides are provided, they replace the base text/bytes/stream/reader loaders.
 * - Plugins can enrich or transform a Resource (1:1).
 */
export async function* resources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  init?: ResourceInit<P, S>,
): AsyncGenerator<Resource<P, S>, void, unknown> {
  for await (const base of src) {
    const r = await applyResourceInit(base, init);
    yield r;
  }
}

/* -------------------------------------------------------------------------- */
/*                         Helpers: unique + text/bytes                       */
/* -------------------------------------------------------------------------- */

export async function* uniqueResources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
): AsyncGenerator<Resource<P, S>, void, unknown> {
  const seen = new Set<string>();

  for await (const r of src) {
    const provKey = JSON.stringify(r.provenance);
    const key = `${r.strategy.target}:${provKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    yield r;
  }
}

/**
 * Materialize text from Resources.
 *
 * - Calls `safeText()`
 * - If it returns a string, yields `{ resource, text }`
 * - If it returns an Error:
 *   - If `onError` returns a replacement, yields that.
 *   - Otherwise skips the resource.
 */
export async function* textResources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  options?: {
    readonly onError?: (
      resource: Resource<P, S>,
      error: Error,
    ) =>
      | { resource: Resource<P, S>; text: string }
      | false
      | Promise<{ resource: Resource<P, S>; text: string } | false>;
  },
) {
  for await (const resource of src) {
    const result = await resource.safeText();
    if (typeof result === "string") {
      yield { resource, text: result };
      continue;
    }

    const error = result instanceof Error ? result : new Error(String(result));
    const replaced = await options?.onError?.(resource, error);
    if (replaced) yield replaced;
  }
}

/**
 * Materialize bytes from Resources.
 *
 * - Calls `safeBytes()`
 * - If it returns Uint8Array, yields `{ resource, bytes }`
 * - If it returns an Error:
 *   - If `onError` returns a replacement, yields that.
 *   - Otherwise skips the resource.
 */
export async function* binaryResources<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  src: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  options?: {
    readonly onError?: (
      resource: Resource<P, S>,
      error: Error,
    ) =>
      | { resource: Resource<P, S>; bytes: Uint8Array }
      | false
      | Promise<{ resource: Resource<P, S>; bytes: Uint8Array } | false>;
  },
) {
  for await (const resource of src) {
    const result = await resource.safeBytes();
    if (result instanceof Uint8Array) {
      yield { resource, bytes: result };
      continue;
    }

    const error = result instanceof Error ? result : new Error(String(result));
    const replaced = await options?.onError?.(resource, error);
    if (replaced) yield replaced;
  }
}

/* -------------------------------------------------------------------------- */
/*                               Type guards                                  */
/* -------------------------------------------------------------------------- */

export const isRemoteResource = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { target: "remote-url" }> =>
  r.strategy.target === "remote-url";

export const isLocalResource = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { target: "local-fs" }> =>
  r.strategy.target === "local-fs";

export const isUtf8TextEncoded = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { encoding: "utf8-text" }> =>
  r.strategy.encoding === "utf8-text";

export const isUtf8BinaryEncoded = <
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(
  r: Resource<P, S>,
): r is Resource<P, S & { encoding: "utf8-binary" }> =>
  r.strategy.encoding === "utf8-binary";

/* -------------------------------------------------------------------------- */
/*                        Factory: resourcesFactory                           */
/* -------------------------------------------------------------------------- */

export type ResourcesFactoryInit<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = StrategiesInit<P> & ResourceInit<P, S>;

export type ResourcesFactory<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
> = {
  readonly init: ResourcesFactoryInit<P, S>;

  /**
   * Register one or more plugins to be applied in order.
   * Mutates the factory's plugin list.
   */
  use: (...plugins: ResourcePlugin<P, S>[]) => void;

  /**
   * Phase 2: classify provenances and attach strategies + base loaders.
   */
  strategies: (provenances: Iterable<P>) => Iterable<Resource<P, S>>;

  /**
   * Phase 3: apply fetch overrides and plugins.
   */
  resources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  ) => AsyncIterable<Resource<P, S>>;

  uniqueResources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
  ) => AsyncIterable<Resource<P, S>>;

  textResources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
    options?: Parameters<typeof textResources<P, S>>[1],
  ) => AsyncIterable<{ resource: Resource<P, S>; text: string }>;

  binaryResources: (
    res: Iterable<Resource<P, S>> | AsyncIterable<Resource<P, S>>,
    options?: Parameters<typeof binaryResources<P, S>>[1],
  ) => AsyncIterable<{ resource: Resource<P, S>; bytes: Uint8Array }>;
};

/**
 * Create a factory that binds common init (glob rules, fetch overrides, plugins)
 * and exposes typed helpers:
 *
 *   const rf = resourcesFactory<ResourceProvenance, ResourceStrategy>(init);
 *   rf.use(myPlugin);
 *   const strat = rf.strategies(provs);
 *   for await (const r of rf.resources(strat)) { ... }
 */
export function resourcesFactory<
  P extends ResourceProvenance = ResourceProvenance,
  S extends ResourceStrategy = ResourceStrategy,
>(
  init: ResourcesFactoryInit<P, S> = {},
): ResourcesFactory<P, S> {
  const plugins: ResourcePlugin<P, S>[] = [...(init.plugins ?? [])];

  const factoryInit: ResourcesFactoryInit<P, S> = {
    ...init,
    plugins,
  };

  return {
    init: factoryInit,

    use: (...more) => {
      plugins.push(...more);
    },

    strategies: (provenances) => {
      return Array.from(strategyDecisions<P, S>(provenances, {
        isGlob: factoryInit.isGlob,
      })).map(provenanceResource);
    },

    resources: (res) =>
      resources<P, S>(res, {
        plugins,
        onFetchRemoteURL: factoryInit.onFetchRemoteURL,
        onFetchLocalFS: factoryInit.onFetchLocalFS,
      }),

    uniqueResources: (res) => uniqueResources<P, S>(res),

    textResources: (res, options) => textResources<P, S>(res, options),

    binaryResources: (res, options) => binaryResources<P, S>(res, options),
  };
}

/* -------------------------------------------------------------------------- */
/*                          relativeTo helper factory                         */
/* -------------------------------------------------------------------------- */

/**
 * Factory to create new provenances and resources relative to a base Resource.
 *
 * - For local-fs resources, relative paths are resolved against dirname(base.path).
 * - For remote-url resources, relative paths are resolved against the base URL.
 */
export function relativeTo<
  P extends ResourceProvenance,
  S extends ResourceStrategy,
>(base: Resource<P, S>) {
  const { provenance: baseProv, strategy: baseStrat } = base;

  const baseIsRemote = baseStrat.target === "remote-url";
  const baseUrl = baseIsRemote
    ? (baseStrat.url ?? tryParseHttpUrl(baseProv.path))
    : undefined;
  const baseDir = baseIsRemote ? undefined : dirname(baseProv.path);

  const path = (p: string): { provenance: P; strategy: S } => {
    let resolvedPath: string;

    if (baseIsRemote && baseUrl) {
      resolvedPath = new URL(p, baseUrl).toString();
    } else if (!baseIsRemote && baseDir) {
      resolvedPath = join(baseDir, p);
    } else {
      resolvedPath = p;
    }

    const {
      mimeType: _omitMime,
      label: _omitLabel,
      path: _omitPath,
      ...rest
    } = baseProv as P & {
      mimeType?: MimeType;
      label?: ResourceLabel;
      path: string;
    };

    const provRaw = {
      ...(rest as P),
      path: resolvedPath,
      label: resolvedPath,
    } as P;

    const provenance = normalizeProvenance(provRaw);
    const strategy = strategyFromProvenance(provenance) as S;

    return { provenance, strategy };
  };

  const resource = (p: string): Resource<P, S> => {
    const { provenance } = path(p);
    return provenanceResource<P, S>({
      provenance,
      strategy: strategyFromProvenance(provenance) as S,
    });
  };

  return { path, resource };
}

/* -------------------------------------------------------------------------- */
/*               Single-call functional helpers (non-pipeline API)           */
/* -------------------------------------------------------------------------- */

/**
 * Create a Resource for a single path using default loaders
 * (no plugins, no fetch overrides).
 */
export function resourceFromPath(
  path: ResourcePath,
): Resource<ResourceProvenance, ResourceStrategy> {
  const iter = provenanceFromPaths([path])[Symbol.iterator]();
  const first = iter.next();
  if (first.done || !first.value) {
    throw new Error(`No provenance for path: ${path}`);
  }
  const provenance = first.value;
  return provenanceResource<ResourceProvenance, ResourceStrategy>({
    provenance,
    strategy: strategyFromProvenance(provenance),
  });
}

/**
 * Read UTF-8 text from a single path using default loaders.
 * Throws on fetch/read errors.
 */
export async function readText(path: ResourcePath): Promise<string> {
  const r = resourceFromPath(path);
  return await r.text();
}

/**
 * Read UTF-8 text from a single path using default loaders,
 * returning a default if provided, or an Error on failure.
 */
export async function readSafeText(
  path: ResourcePath,
  defaultText?: string,
): Promise<string | Error> {
  const r = resourceFromPath(path);
  return await r.safeText(defaultText);
}

/**
 * Read binary bytes from a single path using default loaders.
 * Throws on fetch/read errors.
 */
export async function readBytes(path: ResourcePath): Promise<Uint8Array> {
  const r = resourceFromPath(path);
  return await r.bytes();
}

/**
 * Read binary bytes from a single path using default loaders,
 * returning a default if provided, or an Error on failure.
 */
export async function readSafeBytes(
  path: ResourcePath,
  defaultBytes?: Uint8Array,
): Promise<Uint8Array | Error> {
  const r = resourceFromPath(path);
  return await r.safeBytes(defaultBytes);
}

/* --------------------- Helpers that respect factory init ------------------ */

// type aliases used below
type BaseProv = ResourceProvenance;
type BaseStrat = ResourceStrategy;
type BaseInit = ResourcesFactoryInit<BaseProv, BaseStrat>;
type BaseResource = Resource<BaseProv, BaseStrat>;

/**
 * Create a Resource for a single path using a ResourcesFactoryInit:
 * respects fetch overrides, plugins, and glob rules.
 *
 * If globbing is enabled and expands to multiple files, the first
 * resulting Resource is returned.
 */
export async function resourceFromPathWith(
  path: ResourcePath,
  init: BaseInit = {},
): Promise<BaseResource> {
  const rf = resourcesFactory<BaseProv, BaseStrat>(init);
  const provs = provenanceFromPaths([path]);
  const stratIter = rf.strategies(provs);

  for await (const base of stratIter) {
    // base has default loaders; apply overrides + plugins for this one
    return await applyResourceInit(base, init);
  }

  throw new Error(`No resource produced for path: ${path}`);
}

/**
 * Read UTF-8 text from a single path with overrides/plugins applied.
 */
export async function readTextWith(
  path: ResourcePath,
  init: BaseInit = {},
): Promise<string> {
  const r = await resourceFromPathWith(path, init);
  return await r.text();
}

/**
 * Read UTF-8 text from a single path with overrides/plugins applied,
 * returning a default if provided, or an Error on failure.
 */
export async function readSafeTextWith(
  path: ResourcePath,
  init: BaseInit = {},
  defaultText?: string,
): Promise<string | Error> {
  const r = await resourceFromPathWith(path, init);
  return await r.safeText(defaultText);
}

/**
 * Read binary bytes from a single path with overrides/plugins applied.
 */
export async function readBytesWith(
  path: ResourcePath,
  init: BaseInit = {},
): Promise<Uint8Array> {
  const r = await resourceFromPathWith(path, init);
  return await r.bytes();
}

/**
 * Read binary bytes from a single path with overrides/plugins applied,
 * returning a default if provided, or an Error on failure.
 */
export async function readSafeBytesWith(
  path: ResourcePath,
  init: BaseInit = {},
  defaultBytes?: Uint8Array,
): Promise<Uint8Array | Error> {
  const r = await resourceFromPathWith(path, init);
  return await r.safeBytes(defaultBytes);
}

/* ----------------- Multi-path / glob-capable convenience ------------------ */

/**
 * Collect Resources for one or more paths, with optional overrides/plugins.
 * If globbing is enabled via init.isGlob, patterns may expand to many files.
 */
export async function collectResources(
  paths: Iterable<ResourcePath>,
  init: BaseInit = {},
): Promise<BaseResource[]> {
  const rf = resourcesFactory<BaseProv, BaseStrat>(init);
  const provs = provenanceFromPaths(paths);
  const stratIter = rf.strategies(provs);
  const resIter = rf.resources(stratIter);

  const out: BaseResource[] = [];
  for await (const r of resIter) {
    out.push(r);
  }
  return out;
}

/**
 * Collect `{ resource, text }` for one or more paths, using textResources().
 * Resources that error are skipped unless onError in init.plugins handles them.
 */
export async function collectTextResources(
  paths: Iterable<ResourcePath>,
  init: BaseInit = {},
  options?: Parameters<typeof textResources<BaseProv, BaseStrat>>[1],
): Promise<{ resource: BaseResource; text: string }[]> {
  const rf = resourcesFactory<BaseProv, BaseStrat>(init);
  const provs = provenanceFromPaths(paths);
  const stratIter = rf.strategies(provs);
  const resIter = rf.resources(stratIter);
  const txtIter = rf.textResources(resIter, options);

  const out: { resource: BaseResource; text: string }[] = [];
  for await (const item of txtIter) {
    out.push(item);
  }
  return out;
}

/**
 * Collect `{ resource, bytes }` for one or more paths, using binaryResources().
 * Resources that error are skipped unless onError in init.plugins handles them.
 */
export async function collectBinaryResources(
  paths: Iterable<ResourcePath>,
  init: BaseInit = {},
  options?: Parameters<typeof binaryResources<BaseProv, BaseStrat>>[1],
): Promise<{ resource: BaseResource; bytes: Uint8Array }[]> {
  const rf = resourcesFactory<BaseProv, BaseStrat>(init);
  const provs = provenanceFromPaths(paths);
  const stratIter = rf.strategies(provs);
  const resIter = rf.resources(stratIter);
  const binIter = rf.binaryResources(resIter, options);

  const out: { resource: BaseResource; bytes: Uint8Array }[] = [];
  for await (const item of binIter) {
    out.push(item);
  }
  return out;
}
