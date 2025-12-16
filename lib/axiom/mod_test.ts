import { assert, assertEquals, assertFalse } from "@std/assert";
import { dirname, resolve } from "@std/path";
import { Code, Node } from "types/mdast";
import { inspect } from "unist-util-inspect";
import { selectAll } from "unist-util-select";
import { graphEdgesTree, headingsTreeText } from "./edge/mod.ts";
import { fixturesFactory } from "./fixture/mod.ts";
import { nodeIssues } from "./mdast/node-issues.ts";
import { graph, GraphEdge, graphToDot, MarkdownEncountered } from "./mod.ts";
import { flexibleProjectionFromFiles } from "./projection/flexible.ts";
import {
  isMateriazableCodeCandidate,
  MaterializableCodeCandidate,
} from "./remark/actionable-code-candidates.ts";
import {
  contributeKeyword,
  importKeyword,
  IncludedNode,
  isContributeSpec,
  isIncludedNode,
} from "./remark/code-contribute.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ff = fixturesFactory(import.meta.resolve, "./fixture");
const fixtures = {
  ...ff,
  comprehensiveMdPath: ff.pmdPath("comprehensive.md"),
  runbook1MdPath: ff.pmdPath("runbook-01.md"),
  runbook2MdPath: ff.pmdPath("runbook-02.md"),
  runbook3MdPath: ff.pmdPath("runbook-03.md"),
  contrib1MdPath: ff.pmdPath("contribute-01.md"),
  include1MdPath: ff.pmdPath("include-01.md"),
};

export function isIncludedMaterializableCodeCandidate(
  n: IncludedNode<Node>,
): n is IncludedNode<MaterializableCodeCandidate> {
  return isMateriazableCodeCandidate(n);
}

Deno.test(`Axiom regression / smoke test`, async (t) => {
  const f = {
    comprehensive: {
      projection: "mod_test.ts-comprehensive.md-projection.json",
      graphDot: "mod_test.ts-comprehensive.md-graph.dot",
      inspect: "mod_test.ts-comprehensive.md-inspect.txt",
    },
  };

  const me: MarkdownEncountered[] = [];
  const _fpff = await flexibleProjectionFromFiles(
    [
      fixtures.comprehensiveMdPath, // always keep this first
      fixtures.runbook1MdPath,
      fixtures.runbook2MdPath,
      fixtures.runbook3MdPath,
      fixtures.contrib1MdPath,
      fixtures.include1MdPath,
    ],
    (encountered) => me.push(encountered),
  );

  await t.step(ff.relToCWD(fixtures.comprehensiveMdPath), async (s) => {
    const [comprehensive] = me;

    assert(comprehensive);
    const { mdastRoot: root } = comprehensive;
    const gr = graph(root);

    // when required, set to true to store stable "golden" versions
    const generateGoldens = false;

    // TODO: there's something unstable in the JSON (file paths, etc.) so fix it
    // await s.step(
    //   `validate stable projection via JSON in ${
    //     ff.relToCWD(f.comprehensive.projection)
    //   }`,
    //   async () => {
    //     // when required, use this to store stable "golden" version as a JSON file
    //     if (generateGoldens) {
    //       await fixtures.goldenJSON(f.comprehensive.projection, fpff);
    //       console.warn(
    //         `This test run is invalid since ${
    //           ff.relToCWD(f.comprehensive.projection)
    //         } is being generated.`,
    //       );
    //     }
    //     assertEquals(
    //       JSON.stringify(fpff), // comparing string to string since the file is large
    //       await fixtures.goldenText(f.comprehensive.projection),
    //     );
    //   },
    // );

    await s.step(
      `validate stable mdast tree via 'inspect' output in ${
        ff.relToCWD(f.comprehensive.inspect)
      }`,
      async () => {
        // when required, use this to store stable "golden" version as a text file:
        if (generateGoldens) {
          await fixtures.goldenText(f.comprehensive.inspect, inspect(root));
          console.warn(
            `This test run is invalid since ${
              ff.relToCWD(f.comprehensive.inspect)
            } is being generated.`,
          );
        }
        assertEquals(
          inspect(root),
          await fixtures.goldenText(f.comprehensive.inspect),
        );
      },
    );

    await s.step(
      `validate stable graph edges via GraphViz dot in ${
        ff.relToCWD(f.comprehensive.graphDot)
      }`,
      async () => {
        // when required, use this to store stable "golden" version of the edge in GraphViz dot format
        if (generateGoldens) {
          await fixtures.goldenText(f.comprehensive.graphDot, graphToDot(gr));
          console.warn(
            `This test run is invalid since ${
              ff.relToCWD(f.comprehensive.graphDot)
            } is being generated.`,
          );
        }

        assertEquals(
          graphToDot(gr),
          await fixtures.goldenText(f.comprehensive.graphDot),
        );
      },
    );

    await s.step(
      `smoke test relations and headings from ${comprehensive.file.basename}`,
      () => {
        assertEquals(Array.from(gr.rels), [
          "containedInSection",
          "sectionSemanticId",
          "frontmatter",
          "role:project",
          "role:strategy",
          "role:plan",
          "role:suite",
          "role:case",
          "role:evidence",
          "isCode",
          "isActionableCodeCandidate",
          "isTask",
        ]);

        assertEquals(gr.relCounts, {
          frontmatter: 12,
          containedInSection: 1172,
          isTask: 175,
          "role:case": 8,
          "role:evidence": 6,
          "role:plan": 6,
          "role:project": 1,
          "role:strategy": 8,
          "role:suite": 6,
          isCode: 16,
          isActionableCodeCandidate: 16,
          sectionSemanticId: 34,
        });

        const geTree = graphEdgesTree(
          gr.edges as GraphEdge<"containedInSection">[],
          { relationships: ["containedInSection"] },
        );
        assertEquals(headingsTreeText(geTree, false), headingsTreeGolden);
      },
    );
  });

  await t.step(ff.relToCWD(fixtures.runbook1MdPath), () => {
    const [_, runbook1] = me;

    assert(runbook1);
    const { mdastRoot: root } = runbook1;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isImportant",
      "isCode",
      "isActionableCodeCandidate",
      "codeDependsOn",
    ]);

    assertEquals(gr.relCounts, {
      isCode: 5,
      isActionableCodeCandidate: 5,
      isImportant: 1,
      codeDependsOn: 1,
    });
  });

  await t.step(ff.relToCWD(fixtures.runbook2MdPath), () => {
    const [_, _runbook1, runbook2] = me;

    assert(runbook2);
    const { mdastRoot: root } = runbook2;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isCode",
      "isActionableCodeCandidate",
      "isDirectiveCandidate",
      "isCodePartialCandidate",
      "codeDependsOn",
    ]);

    assertEquals(gr.relCounts, {
      isCode: 5,
      isActionableCodeCandidate: 4,
      isCodePartialCandidate: 1,
      codeDependsOn: 1,
      isDirectiveCandidate: 1,
    });
  });

  await t.step(ff.relToCWD(fixtures.runbook3MdPath), () => {
    const [_, _runbook1, _runbook2, runbook3] = me;

    assert(runbook3);
    const { mdastRoot: root } = runbook3;
    const gr = graph(root);

    assertEquals(Array.from(gr.rels), [
      "isCode",
      "isActionableCodeCandidate",
      "isTask",
    ]);

    assertEquals(gr.relCounts, {
      isCode: 6,
      isActionableCodeCandidate: 6,
      isTask: 6,
    });
  });

  await t.step(ff.relToCWD(fixtures.contrib1MdPath), () => {
    const [_, _runbook1, _runbook2, _runbook3, contrib1] = me;

    assert(contrib1);
    const { mdastRoot: root } = contrib1;

    const contributeCodeBlocks = selectAll("code", root).filter(
      (n) => (n as Code).lang === contributeKeyword,
    ) as Code[];

    assertEquals(contributeCodeBlocks.length, 3);
    const [firstNode, secondNode, includesNodes] = contributeCodeBlocks;
    assert(isContributeSpec(firstNode));
    assert(isContributeSpec(secondNode));
    assert(isContributeSpec(includesNodes));

    const first = firstNode.contributables({
      resolveBasePath: (base) =>
        resolve(dirname(fixtures.contrib1MdPath), base),
    });
    const firstRes = Array.from(first.provenance());
    assertEquals(firstRes.map((r) => r.destPath), [
      "SUNDRY/comma-separated-values.csv",
      "SUNDRY/group1-allergies.csv",
      "SUNDRY/group1-care-plans.csv",
      "SUNDRY/group1-patients.csv",
      "SUNDRY/pipe-separated-values.psv",
      "SUNDRY/plain-text.txt",
      "SUNDRY/plain.html",
      "SUNDRY/plain.png",
      "SUNDRY/plain.text",
      "SUNDRY/real-test.zip",
      "SUNDRY/sample.sql",
      "SUNDRY/security-test.tap",
      "SUNDRY/space-separated-values.ssv",
      "SUNDRY/synthetic-01.md",
      "SUNDRY/synthetic-01.pdf",
      "SUNDRY/synthetic-02.md",
      "SUNDRY/synthetic-02.pdf",
      "SUNDRY/synthetic-with-frontmatter.md",
      "SUNDRY/synthetic-with-unicode.jsonl",
      "SUNDRY/synthetic.bash",
      "SUNDRY/synthetic.doc",
      "SUNDRY/synthetic.docx",
      "SUNDRY/synthetic.json",
      "SUNDRY/synthetic.jsonl",
      "SUNDRY/synthetic.ppt",
      "SUNDRY/synthetic.sh",
      "SUNDRY/synthetic.xls",
      "SUNDRY/synthetic.xlsx",
      "SUNDRY/synthetic.yml",
      "SUNDRY/tab-separated-values.tsv",
      "SUNDRY/unknown-extension.xyz",
    ]);

    const second = secondNode.contributables({
      resolveBasePath: (base) =>
        resolve(dirname(fixtures.contrib1MdPath), base),
    });
    const secondRes = Array.from(second.provenance());
    assertEquals(secondRes.map((r) => [r.origin.label, r.destPath]), [
      ["CSV", "SUNDRY/comma-separated-values.csv"],
      ["CSV", "SUNDRY/group1-allergies.csv"],
      ["CSV", "SUNDRY/group1-care-plans.csv"],
      ["CSV", "SUNDRY/group1-patients.csv"],
      ["PDF", "SUNDRY/synthetic-01.pdf"],
      ["PDF", "SUNDRY/synthetic-02.pdf"],
      ["zip", "ARCHIVE/real-test.zip"],
    ]);

    const includedCodeBlocks = selectAll("code", root).filter((n) =>
      isIncludedNode(n)
    );
    assertEquals(
      includedCodeBlocks.map((
        r,
      ) => [r.include.origin.label, r.include.destPath]),
      [
        ["csv", "INCLUDE/comma-separated-values.csv"],
        ["csv", "INCLUDE/group1-allergies.csv"],
        ["csv", "INCLUDE/group1-care-plans.csv"],
        ["csv", "INCLUDE/group1-patients.csv"],
        ["sql", "sample.sql"],
      ],
    );
    for (const node of includedCodeBlocks) {
      assertEquals(
        (node as unknown as Code).value,
        Deno.readTextFileSync(node.include.provenance.path),
      );
    }
    assertEquals(
      (includedCodeBlocks[4] as unknown as Code).meta,
      `sample.sql --interpolate --injectable`,
    );
  });

  await t.step(ff.relToCWD(fixtures.include1MdPath), () => {
    const [_, _runbook1, _runbook2, _runbook3, _contrib1, include1] = me;

    assert(include1);
    const { mdastRoot: root } = include1;
    const gr = graph(root);

    assertEquals(gr.relCounts, {
      isImportant: 1,
      containedInSection: 68,
      frontmatter: 2,
      hasIssues: 14,
      isActionableCodeCandidate: 34,
      isCode: 37,
      isDirectiveCandidate: 2,
    });

    const contributeCodeBlocks = selectAll("code", root).filter(
      (n) =>
        (n as Code).lang === contributeKeyword ||
        (n as Code).lang === importKeyword,
    ) as Code[];
    assertEquals(contributeCodeBlocks.length, 2);

    const [firstNode, secondNode] = contributeCodeBlocks;
    assertFalse(nodeIssues.is(secondNode));
    assertFalse(nodeIssues.is(firstNode));

    assert(isContributeSpec(firstNode));
    assert(isContributeSpec(secondNode));

    const firstContribs = firstNode.contributables({
      allowUrls: true,
      resolveBasePath: (base) =>
        resolve(dirname(fixtures.runbook3MdPath), base),
    });
    assertEquals(firstContribs.issues.length, 0);
    assertEquals(
      Array.from(firstContribs.provenance()).map((r) =>
        `${r.origin.label} ${r.destPath} [${r.provenance.mimeType}] (${r.origin.lineNumInRawInstructions})`
      ),
      [
        "bash synthetic.bash [text/plain] (1)",
        "bash synthetic.bash [text/plain] (2)",
        "bash synthetic.sh [text/plain] (2)",
        "text plain-text.txt [text/plain] (3)",
        "text plain.html [text/plain] (3)",
        "text plain.text [text/plain] (3)",
        "text synthetic.bash [text/plain] (3)",
        "text synthetic.json [text/plain] (3)",
        "text synthetic.sh [text/plain] (3)",
        "utf8 synthetic-01.pdf [application/pdf] (4)",
        "utf8 synthetic-02.pdf [application/pdf] (4)",
        "utf8 synthetic.doc [application/msword] (4)",
        "utf8 synthetic.docx [application/vnd.openxmlformats-officedocument.wordprocessingml.document] (4)",
        "utf8 synthetic.ppt [application/vnd.ms-powerpoint] (4)",
        "utf8 synthetic.xls [application/vnd.ms-excel] (4)",
        "utf8 synthetic.xlsx [application/vnd.openxmlformats-officedocument.spreadsheetml.sheet] (4)",
        "json 64KB.json [application/json] (5)",
      ],
    );

    const secondContribs = secondNode.contributables({
      allowUrls: true,
      resolveBasePath: (base) =>
        resolve(dirname(fixtures.runbook3MdPath), base),
    });
    assertEquals(secondContribs.issues.length, 0);
    assertEquals(
      Array.from(secondContribs.provenance()).map((r) =>
        `${r.origin.label} ${r.destPath} [${r.provenance.mimeType}] (${r.origin.lineNumInRawInstructions})`
      ),
      [
        "bash synthetic.bash [text/plain] (1)",
        "bash synthetic.bash [text/plain] (2)",
        "bash synthetic.sh [text/plain] (2)",
        "text plain-text.txt [text/plain] (3)",
        "text plain.html [text/plain] (3)",
        "text plain.text [text/plain] (3)",
        "text synthetic.bash [text/plain] (3)",
        "text synthetic.json [text/plain] (3)",
        "text synthetic.sh [text/plain] (3)",
        "utf8 synthetic-01.pdf [application/pdf] (4)",
        "utf8 synthetic-02.pdf [application/pdf] (4)",
        "utf8 synthetic.doc [application/msword] (4)",
        "utf8 synthetic.docx [application/vnd.openxmlformats-officedocument.wordprocessingml.document] (4)",
        "utf8 synthetic.ppt [application/vnd.ms-powerpoint] (4)",
        "utf8 synthetic.xls [application/vnd.ms-excel] (4)",
        "utf8 synthetic.xlsx [application/vnd.openxmlformats-officedocument.spreadsheetml.sheet] (4)",
        "json 64KB.json [application/json] (5)",
      ],
    );

    const includedCodeBlocks = selectAll("code", root).filter(
      isIncludedNode<Code>,
    );
    assertEquals(includedCodeBlocks.length, 34);
    assertEquals(
      includedCodeBlocks.map((c) =>
        `${c.lang} ${
          c.meta?.replace(/--cwd.*/, "--cwd YES")
        } [${c.include.provenance.mimeType} ${
          c.isContentAcquired ? "content acquired" : "content NOT acquired"
        }]`
      ),
      [
        "bash synthetic.bash --mime text/plain [text/plain content acquired]",
        "bash synthetic.bash --mime text/plain [text/plain content acquired]",
        "bash synthetic.sh --mime text/plain [text/plain content acquired]",
        "text plain-text.txt --mime text/plain [text/plain content acquired]",
        "text plain.html --mime text/plain [text/plain content acquired]",
        "text plain.text --mime text/plain [text/plain content acquired]",
        "text synthetic.bash --mime text/plain [text/plain content acquired]",
        "text synthetic.json --mime text/plain [text/plain content acquired]",
        "text synthetic.sh --mime text/plain [text/plain content acquired]",
        "utf8 synthetic-01.pdf  [application/pdf content NOT acquired]",
        "utf8 synthetic-02.pdf  [application/pdf content NOT acquired]",
        "utf8 synthetic.doc  [application/msword content NOT acquired]",
        "utf8 synthetic.docx  [application/vnd.openxmlformats-officedocument.wordprocessingml.document content NOT acquired]",
        "utf8 synthetic.ppt  [application/vnd.ms-powerpoint content NOT acquired]",
        "utf8 synthetic.xls  [application/vnd.ms-excel content NOT acquired]",
        "utf8 synthetic.xlsx  [application/vnd.openxmlformats-officedocument.spreadsheetml.sheet content NOT acquired]",
        "json 64KB.json  [application/json content acquired]",
        "bash synthetic.bash --mime text/plain --graph INJECTED_BASH1 --cwd YES [text/plain content acquired]",
        "bash synthetic.bash --mime text/plain --graph INJECTED_BASH2 --cwd YES [text/plain content acquired]",
        "bash synthetic.sh --mime text/plain --graph INJECTED_BASH2 --cwd YES [text/plain content acquired]",
        "text plain-text.txt --mime text/plain --graph INJECTED_FS_TEXT [text/plain content acquired]",
        "text plain.html --mime text/plain --graph INJECTED_FS_TEXT [text/plain content acquired]",
        "text plain.text --mime text/plain --graph INJECTED_FS_TEXT [text/plain content acquired]",
        "text synthetic.bash --mime text/plain --graph INJECTED_FS_TEXT [text/plain content acquired]",
        "text synthetic.json --mime text/plain --graph INJECTED_FS_TEXT [text/plain content acquired]",
        "text synthetic.sh --mime text/plain --graph INJECTED_FS_TEXT [text/plain content acquired]",
        "utf8 synthetic-01.pdf --graph INJECTED_FS_BIN [application/pdf content NOT acquired]",
        "utf8 synthetic-02.pdf --graph INJECTED_FS_BIN [application/pdf content NOT acquired]",
        "utf8 synthetic.doc --graph INJECTED_FS_BIN [application/msword content NOT acquired]",
        "utf8 synthetic.docx --graph INJECTED_FS_BIN [application/vnd.openxmlformats-officedocument.wordprocessingml.document content NOT acquired]",
        "utf8 synthetic.ppt --graph INJECTED_FS_BIN [application/vnd.ms-powerpoint content NOT acquired]",
        "utf8 synthetic.xls --graph INJECTED_FS_BIN [application/vnd.ms-excel content NOT acquired]",
        "utf8 synthetic.xlsx --graph INJECTED_FS_BIN [application/vnd.openxmlformats-officedocument.spreadsheetml.sheet content NOT acquired]",
        "json 64KB.json --graph INJECTED_REMOTE [application/json content acquired]",
        ,
      ],
    );
    const re = /MIME '([^']+)' is not text/;
    assertEquals(
      includedCodeBlocks.map((c) =>
        `${c.lang} ${c.meta?.split(/\s+/)[0]} --graph ${
          c.include.origin.ppiq.getTextFlagValues("graph")
        } --cwd ${c.include.origin.ppiq.getTextFlag("cwd") ? "YES" : "NO"} [${
          nodeIssues.is(c)
            ? (c.data.issues.map((i) =>
              `${i.severity}: ${i.message.match(re)?.[0]}`
            ).join(", "))
            : 0
        }] (text: ${c.value.length})`
      ),
      [
        "bash synthetic.bash --graph  --cwd NO [0] (text: 45)",
        "bash synthetic.bash --graph  --cwd NO [0] (text: 45)",
        "bash synthetic.sh --graph  --cwd NO [0] (text: 45)",
        "text plain-text.txt --graph  --cwd NO [0] (text: 26)",
        "text plain.html --graph  --cwd NO [0] (text: 1050)",
        "text plain.text --graph  --cwd NO [0] (text: 26)",
        "text synthetic.bash --graph  --cwd NO [0] (text: 45)",
        "text synthetic.json --graph  --cwd NO [0] (text: 1814)",
        "text synthetic.sh --graph  --cwd NO [0] (text: 45)",
        "utf8 synthetic-01.pdf --graph  --cwd NO [info: MIME 'application/pdf' is not text] (text: 150)",
        "utf8 synthetic-02.pdf --graph  --cwd NO [info: MIME 'application/pdf' is not text] (text: 150)",
        "utf8 synthetic.doc --graph  --cwd NO [info: MIME 'application/msword' is not text] (text: 150)",
        "utf8 synthetic.docx --graph  --cwd NO [info: MIME 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' is not text] (text: 204)",
        "utf8 synthetic.ppt --graph  --cwd NO [info: MIME 'application/vnd.ms-powerpoint' is not text] (text: 161)",
        "utf8 synthetic.xls --graph  --cwd NO [info: MIME 'application/vnd.ms-excel' is not text] (text: 156)",
        "utf8 synthetic.xlsx --graph  --cwd NO [info: MIME 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' is not text] (text: 198)",
        "json 64KB.json --graph  --cwd NO [0] (text: 63732)",
        "bash synthetic.bash --graph INJECTED_BASH1 --cwd YES [0] (text: 45)",
        "bash synthetic.bash --graph INJECTED_BASH2 --cwd YES [0] (text: 45)",
        "bash synthetic.sh --graph INJECTED_BASH2 --cwd YES [0] (text: 45)",
        "text plain-text.txt --graph INJECTED_FS_TEXT --cwd NO [0] (text: 26)",
        "text plain.html --graph INJECTED_FS_TEXT --cwd NO [0] (text: 1050)",
        "text plain.text --graph INJECTED_FS_TEXT --cwd NO [0] (text: 26)",
        "text synthetic.bash --graph INJECTED_FS_TEXT --cwd NO [0] (text: 45)",
        "text synthetic.json --graph INJECTED_FS_TEXT --cwd NO [0] (text: 1814)",
        "text synthetic.sh --graph INJECTED_FS_TEXT --cwd NO [0] (text: 45)",
        "utf8 synthetic-01.pdf --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/pdf' is not text] (text: 150)",
        "utf8 synthetic-02.pdf --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/pdf' is not text] (text: 150)",
        "utf8 synthetic.doc --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/msword' is not text] (text: 150)",
        "utf8 synthetic.docx --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' is not text] (text: 204)",
        "utf8 synthetic.ppt --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/vnd.ms-powerpoint' is not text] (text: 161)",
        "utf8 synthetic.xls --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/vnd.ms-excel' is not text] (text: 156)",
        "utf8 synthetic.xlsx --graph INJECTED_FS_BIN --cwd NO [info: MIME 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' is not text] (text: 198)",
        "json 64KB.json --graph INJECTED_REMOTE --cwd NO [0] (text: 63732)",
      ],
    );
  });
});

const headingsTreeGolden = `
- containedInSection
  heading: #1 Spry remark ecosystem Test Fixture 01
  ├─ paragraph: Objectives
  ├─ paragraph: Risks
  ├─ heading: #2 Plugin Orchestration Strategy
  │  ├─ paragraph: Doc frontmatter plugin
  │  ├─ paragraph: Heading frontmatter plugin
  │  ├─ paragraph: Node classification plugin
  │  ├─ paragraph: Node identities plugin
  │  ├─ paragraph: Code annotations plugin
  │  ├─ paragraph: Code frontmatter plugin
  │  ├─ paragraph: Code partial plugin
  │  ├─ paragraph: Code injection plugin
  │  └─ paragraph: Key Goals
  ├─ heading: #2 Node Classification & Doc Frontmatter Strategy
  │  ├─ paragraph: Doc Frontmatter Plugin Behavior
  │  ├─ paragraph: Node Classification Plugin Behavior
  │  └─ heading: #3 Node Classification Verification Plan
  │     ├─ paragraph: Cycle Goals
  │     └─ heading: #4 Node Classification Visibility Suite
  │        ├─ paragraph: Scope
  │        └─ heading: #5 Verify headings are classified according to doc frontmatter rules
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  │              └─ paragraph: Attachment
  ├─ heading: #2 Node Identities & Heading Frontmatter Strategy
  │  └─ heading: #3 Node Identity & Heading Frontmatter Plan
  │     ├─ paragraph: Cycle Goals
  │     └─ heading: #4 Node Identity Suite
  │        └─ heading: #5 Verify @id markers bind to nearest semantic node
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  │              └─ paragraph: Attachment
  ├─ heading: #2 Code Annotations & Code Frontmatter Strategy
  │  └─ heading: #3 Code Metadata Verification Plan
  │     └─ heading: #4 Code Metadata Suite
  │        └─ heading: #5 Verify code annotations and code frontmatter are both attached
  │           ├─ paragraph: Description
  │           ├─ paragraph: Synthetic Example Code Cell
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  ├─ heading: #2 Code Partials & Code Injection Strategy
  │  └─ heading: #3 Partial & Injection Plan
  │     └─ heading: #4 Partial Library Suite
  │        ├─ heading: #5 Define a reusable TypeScript partial
  │        ├─ heading: #5 Define a reusable Markdown partial for use with directives
  │        └─ heading: #5 Inject the partial into another cell by logical ID
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  ├─ heading: #2 Doc Schema Strategy
  │  └─ heading: #3 Doc Schema Validation Plan
  │     └─ heading: #4 Schema Compliance Suite
  │        └─ heading: #5 Validate project-level schema
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  ├─ heading: #2 mdast-io Round-Trip Strategy
  │  └─ heading: #3 mdast-io Round-Trip Plan
  │     └─ heading: #4 Round-Trip Integrity Suite
  │        └─ heading: #5 Verify mdast-io preserves plugin metadata across round-trip
  │           ├─ paragraph: Description
  │           ├─ paragraph: Preconditions
  │           ├─ paragraph: Steps
  │           ├─ paragraph: Expected Results
  │           └─ heading: #6 Evidence
  │              └─ paragraph: Attachment
  └─ heading: #2 Summary`.trim();
