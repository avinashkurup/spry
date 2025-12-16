/**
 * contribute-specs-resolver.ts
 *
 * Thin wrapper around `resourceContributions()` for ```contribute blocks.
 *
 * ```contribute <target> [PI flags...]
 * <candidate> [<destPrefix>] [flags...]
 * ...
 * ```
 *
 * Block PI flags:
 * - --base / -B         => fromBase
 * - --dest              => destPrefix
 * - --labeled           => labeled
 * - --interpolate / -I  => interpolate spec body before parsing
 *
 * This plugin:
 * - parses fence PI + interpolates block body (optional)
 * - attaches `contributables()` to the Code node, returning the contributions factory
 */
import z from "@zod/zod";
import type { Code, Node, Root } from "types/mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";

import { safeInterpolate } from "../../universal/flexible-interpolator.ts";
import {
  flexibleTextSchema,
  InstructionsResult,
  mergeFlexibleText,
  queryPosixPI,
} from "../../universal/posix-pi.ts";
import {
  ContributeSpecLine,
  ResourceContribution,
  resourceContributions,
} from "../../universal/resource-contributions.ts";

import { assert } from "@std/assert/assert";
import { provenanceResource } from "../../universal/resource.ts";
import {
  type CodeFrontmatter,
  codeFrontmatter,
} from "../mdast/code-frontmatter.ts";
import { addIssue, addIssues } from "../mdast/node-issues.ts";
import {
  CodeDirectiveCandidate,
  isCodeDirectiveCandidate,
} from "./code-directive-candidates.ts";

export const contributePiFlagsSchema = z.object({
  base: flexibleTextSchema.optional(),
  dest: z.string().optional(),
  labeled: z.boolean().optional(),
  interpolate: z.boolean().optional(),

  // shortcuts
  /* base */ B: flexibleTextSchema.optional(),
  /* interpolate */ I: z.boolean().optional(),
}).transform((raw) => ({
  base: mergeFlexibleText(raw.base, raw.B),
  dest: raw.dest,
  labeled: raw.labeled,
  interpolate: raw.I ?? raw.interpolate,
}));

export type ContributePiFlags = z.infer<typeof contributePiFlagsSchema>;

export type ContributeSpec = Code & {
  identity?: string;
  contributeFM: CodeFrontmatter;
  contributeQPI: ReturnType<typeof queryPosixPI<ContributePiFlags>>;
  contributeSF: ReturnType<
    ReturnType<typeof queryPosixPI<ContributePiFlags>>["safeFlags"]
  >;
  contributables: (opts?: {
    resolveBasePath?: (path: string) => string;
    allowUrls?: boolean;
    /** Default destPrefix for lines that omit it. */
    destPrefix?: string;
    /** Enable labeled grammar in the spec body. */
    labeled?: boolean;
    /** Optional line transform before parsing spec body. */
    transform?: (line: string, lineNum: number) => string | false;
  }) => ReturnType<typeof resourceContributions>;
};

export function isContributeSpec(code: Code): code is ContributeSpec {
  const c = code as unknown as Partial<ContributeSpec>;
  return !!(
    c &&
    typeof c === "object" &&
    typeof c.contributables === "function" &&
    !!c.contributeFM &&
    !!c.contributeQPI &&
    !!c.contributeSF
  );
}

export interface ContributeOptions {
  readonly isSpecBlock?: (node: Code) => boolean;
  readonly interpolationCtx?: (
    tree: Root,
    file: VFile,
  ) => Record<string, unknown>;
}

export const contributeKeyword = "contribute" as const;
export const includeKeyword = "include" as const;
export const importKeyword = "import" as const;

function defaultIsSpecBlock(code: Code) {
  return code.lang === contributeKeyword || code.lang === includeKeyword ||
    code.lang === importKeyword;
}

export function isIncludeSpecBlock(spec: ContributeSpec) {
  return spec.lang === includeKeyword || spec.lang === importKeyword ||
      spec.identity === includeKeyword || spec.identity === importKeyword ||
      spec.contributeQPI.getFlag("I", includeKeyword, importKeyword)
    ? true
    : false;
}

function contributeSpecs(
  code: Code,
  contributeFM: CodeFrontmatter,
  interpolationCtx?: Record<string, unknown>,
) {
  const contributeQPI = queryPosixPI<ContributePiFlags>(
    contributeFM.pi,
    undefined,
    { zodSchema: contributePiFlagsSchema },
  );

  // Default base to "." if not provided.
  if (!contributeQPI.hasFlag("base", "B")) contributeFM.pi.flags["base"] = ".";

  const contributeSF = contributeQPI.safeFlags();
  if (!contributeSF.success) {
    addIssue(code, {
      severity: "error",
      message:
        `Error reading contribute flags (line ${code.position?.start.line}):\n${
          z.prettifyError(contributeSF.error)
        }`,
      error: contributeSF.error,
    });
  }

  let specsSrc = code.value;
  if (contributeSF.success && contributeSF.data.interpolate) {
    specsSrc = safeInterpolate(specsSrc, {
      code,
      contributeFM,
      ...interpolationCtx,
    });
  }

  return {
    contributeFM,
    contributeQPI,
    contributeSF,
    specsSrc,
  };
}

export const prepareContributionSpecs: Plugin<[ContributeOptions?], Root> = (
  options,
) => {
  const isSpecBlock = options?.isSpecBlock ?? defaultIsSpecBlock;
  const interpolationCtx = options?.interpolationCtx;

  return (tree, vfile) => {
    visit(tree, "code", (code: Code) => {
      if (!isSpecBlock(code)) return;
      if (isContributeSpec(code)) return;

      const iCtx = interpolationCtx?.(tree, vfile);

      const contributeFM = codeFrontmatter(code, {
        cacheableInCodeNodeData: false,
        transform: iCtx
          ? ((lang, meta) => {
            if (meta) meta = safeInterpolate(meta, { code, ...iCtx });
            return { lang: lang ?? undefined, meta: meta ?? undefined };
          })
          : undefined,
      });

      if (!contributeFM) return;

      const target = contributeFM.pi.pos[0];
      if (!target) {
        addIssue(code, {
          severity: "error",
          message:
            `Contribute spec block is missing a target identity (expected \`\`\`${code.lang} <target>).`,
        });
        return;
      }

      const cs = contributeSpecs(code, contributeFM, iCtx);
      const directive = code as CodeDirectiveCandidate<
        string,
        typeof contributeKeyword
      >;
      directive.isCodeDirectiveCandidate = true;
      directive.directive = contributeKeyword;
      directive.identity = target;
      directive.instructions = contributeFM as unknown as InstructionsResult;
      assert(isCodeDirectiveCandidate(directive));

      const node = code as ContributeSpec;
      node.identity = target; // same as above, it's the same instance
      node.contributeFM = cs.contributeFM;
      node.contributeQPI = cs.contributeQPI;
      node.contributeSF = cs.contributeSF;

      node.contributables = (opts) => {
        if (!cs.contributeSF.success) {
          addIssue(node, {
            message:
              `Invalid codeFM ${node.lang} ${node.meta} (line ${node.position?.start.line})`,
            severity: "error",
            error: cs.contributeSF.error,
          });
          return [] as unknown as ReturnType<
            ContributeSpec["contributables"]
          >;
        }

        return resourceContributions(cs.specsSrc, {
          labeled: opts?.labeled ?? cs.contributeSF.data.labeled ??
            isIncludeSpecBlock(node),
          fromBase: cs.contributeSF.data.base,
          destPrefix: opts?.destPrefix ?? cs.contributeSF.data.dest,
          allowUrls: opts?.allowUrls ?? false,
          resolveBasePath: opts?.resolveBasePath,
          transform: opts?.transform,
        });
      };
    });
  };
};

export type IncludesSpec = Code & {
  includables: Iterable<Node>;
  resolveIncludes: () => Promise<void>;
};

export function isIncludesSpec(code: Node): code is IncludesSpec {
  const c = code as unknown as Partial<IncludesSpec>;
  return !!(c && typeof c === "object" && Array.isArray(c.includables)) &&
    typeof c.resolveIncludes === "function";
}

export type IncludedNode<N extends Node> = N & {
  readonly include: ResourceContribution<ContributeSpecLine>;
  readonly acquireContent: () => Promise<void>;
  isContentAcquired: boolean;
};

export function isIncludedNode<N extends Node>(
  node: Node,
): node is IncludedNode<N> {
  return node && "include" in node && node.include ? true : false;
}

export interface IncludeNodeInsertOptions {
  readonly isSpecBlock: (
    node: ContributeSpec,
    vfile: VFile,
    root: Root,
  ) => false | Parameters<ContributeSpec["contributables"]>[0];
  readonly generatedNode?: (
    ctx: {
      readonly rc: ResourceContribution<ContributeSpecLine>;
      readonly specs: ContributeSpec;
    },
  ) => IncludedNode<Node>;
  readonly retainAfterInjections?: (node: Node) => boolean;
  readonly consumeEdges?: (
    edges: { generatedBy: Node; included: Node }[],
    vfile: VFile,
    tree: Root,
  ) => void;
}

const generatedCodeNode: IncludeNodeInsertOptions["generatedNode"] = (ctx) => {
  const {
    rc: {
      destPath,
      origin: { label: lang, lineNumInRawInstructions: pathLine, meta },
      provenance,
      strategy,
    },
    specs,
  } = ctx;
  const position = specs.position
    ? {
      line: specs.position.start.line + pathLine,
      column: 1,
      offset: undefined,
    }
    : undefined;
  const result: IncludedNode<Code> = {
    type: "code",
    lang,
    meta: `${destPath} ${meta}`,
    value:
      `should be replaced by text value of ${provenance.path} (${provenance.mimeType})`,
    position: position ? { start: position, end: position } : undefined,
    include: ctx.rc,
    isContentAcquired: false,
    acquireContent: async () => {
      if (strategy.encoding !== "utf8-text") {
        addIssues(result, [{
          message:
            `MIME '${provenance.mimeType}' is not text, ${provenance.path} not injected into code[${lang}].value`,
          severity: "info",
        }]);
        return;
      }

      const r = provenanceResource(ctx.rc);
      const text = await r.safeText();
      if (typeof text === "string") {
        result.value = text;
        result.isContentAcquired = true;
      } else {
        addIssues(result, [{
          message:
            `Unable to resolve include content ${r.provenance.path} (${r.provenance.mimeType})`,
          severity: "error",
          error: text,
        }]);
      }
    },
  };
  return result;
};

export const prepareIncludedNodes: Plugin<[IncludeNodeInsertOptions], Root> = (
  options,
) => {
  const { isSpecBlock } = options;
  const generatedNode = options?.generatedNode ?? generatedCodeNode;

  return (tree: Root, vfile: VFile) => {
    const { retainAfterInjections = () => true } = options ?? {};

    const mutations: {
      // deno-lint-ignore no-explicit-any
      parent: any;
      index: number;
      injected: Node[];
      mode: "retain-after-injections" | "remove-before-injections";
    }[] = [];

    visit(tree, "code", (code: Code, index, parent) => {
      if (parent == null || index == null) return;
      if (!isContributeSpec(code)) return;
      const isb = isSpecBlock(code, vfile, tree);
      if (!isb) return;

      const mode = retainAfterInjections == undefined
        ? "retain-after-injections" as const
        : (retainAfterInjections(code)
          ? "retain-after-injections" as const
          : "remove-before-injections" as const);

      const generated: IncludedNode<Node>[] = [];
      const contrib = code.contributables(isb);
      for (const rc of contrib.provenance()) {
        const newNode = generatedNode({ rc, specs: code });
        generated.push(newNode);
      }

      if (generated.length) {
        const node = code as unknown as IncludesSpec;
        node.includables = generated;
        node.resolveIncludes = async () => {
          for (const include of generated) {
            await include.acquireContent();
          }
        };
        assert(isIncludesSpec(code));

        if (options?.consumeEdges) {
          options.consumeEdges(
            generated.map((g) => ({ generatedBy: code, included: g })),
            vfile,
            tree,
          );
        }

        mutations.push({ parent, index, injected: generated, mode });
      }
    });

    // Apply mutations after traversal, from right to left.
    mutations.sort((a, b) => b.index - a.index);

    for (const { parent, index, injected, mode } of mutations) {
      if (mode === "remove-before-injections") {
        // Replace spec node with injected nodes
        parent.children.splice(index, 1, ...injected);
      } else {
        // retain-after-injections: keep spec; insert injected nodes after it
        parent.children.splice(index + 1, 0, ...injected);
      }
    }

    return tree;
  };
};
