import assert from "node:assert/strict";
import { buildResolutionGroundTruth } from "../lib/resolutionEvaluation.js";
import { classifyIssueResolution } from "../lib/resolutionType.js";
import { buildSemanticIssueProfile } from "../lib/issueProfile.js";
import { buildImplementationPattern } from "../lib/implementationPattern.js";
import {
  extractImportsFromSource,
  extractSymbolsFromSource,
  inferTestLinks,
  touchedSymbolsForPatch,
} from "../lib/symbolIndex.js";
import type { BenchmarkCase, RichDataset } from "../lib/types.js";

function testResolutionClassifier(): void {
  const bug = classifyIssueResolution({
    title: "Chat input crashes when pressing Enter",
    body: "Expected message to send. Actual error with stack trace.",
  });
  assert.equal(bug.resolution_type, "existing_bug");
  assert.equal(bug.requires_existing_file_edits, true);

  const feature = classifyIssueResolution({
    title: "Add export button for chat history",
    body: "Feature request: allow users to export chat history.",
  });
  assert.equal(feature.resolution_type, "new_feature");
  assert.equal(feature.requires_new_files, true);

  const enhancement = classifyIssueResolution({
    title: "Allow chat export to include timestamps",
    body: "Enhancement: extend existing export behavior.",
  });
  assert.equal(enhancement.resolution_type, "enhancement");
  assert.equal(enhancement.requires_existing_file_edits, true);

  const existingOption = classifyIssueResolution({
    title: "Add option to existing chat export to include timestamps",
    body: "The export feature already exists, but it should expose timestamp output.",
  });
  assert.equal(existingOption.resolution_type, "enhancement");

  const docs = classifyIssueResolution({
    title: "Document how to configure chat model providers",
    body: "Update README examples and documentation.",
  });
  assert.equal(docs.resolution_type, "docs");
}

function testCanonicalIssueProfile(): void {
  const profile = buildSemanticIssueProfile({
    title: "Add export button for chat history",
    body: "No way to export chat history today.",
  });

  assert.equal(profile.resolution_type, "new_feature");
  assert.equal(profile.missing_capability, true);
  assert.equal(profile.requires_new_files, true);
  assert.ok(profile.likely_surface.length > 0);
  assert.ok(profile.reasoning.length > 0);
}

function testImplementationPatternExtraction(): void {
  const pattern = buildImplementationPattern({
    pullRequest: {
      id: 1,
      number: 42,
      title: "Add chat history export action",
      body: "Adds a new export action for chat history.",
      html_url: "https://example.test/pr/42",
      state: "closed",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      closed_at: "2026-01-01T00:00:00Z",
      merged_at: "2026-01-01T00:00:00Z",
    },
    files: [
      {
        filename:
          "src/vs/workbench/contrib/chat/browser/actions/chatExportAction.ts",
        status: "added",
        changes: 120,
      },
      {
        filename: "src/vs/workbench/contrib/chat/browser/chat.contribution.ts",
        status: "modified",
        changes: 14,
      },
    ],
    patchHunks: [
      {
        filePath:
          "src/vs/workbench/contrib/chat/browser/actions/chatExportAction.ts",
        pullRequestNumber: 42,
        oldStartLine: 0,
        oldLineCount: 0,
        newStartLine: 1,
        newLineCount: 10,
        patchText: "+export class ChatExportAction {}",
      },
    ],
  });

  assert.deepEqual(pattern.created_files, [
    "src/vs/workbench/contrib/chat/browser/actions/chatExportAction.ts",
  ]);
  assert.deepEqual(pattern.modified_existing_files, [
    "src/vs/workbench/contrib/chat/browser/chat.contribution.ts",
  ]);
  assert.ok(pattern.new_symbols_added.includes("ChatExportAction"));
  assert.ok(pattern.surfaces.includes("ui"));
  assert.ok(pattern.label_weight > 0 && pattern.label_weight <= 1);
}

function testResolutionGroundTruth(): void {
  const benchmarkCase: BenchmarkCase = {
    issue_number: 1,
    title: "Allow chat export to include timestamps",
    body: "Existing export should include timestamps.",
    labels: ["feature-request"],
    difficulty: "medium",
    expected: {
      component: "Chat",
      files: [
        "src/vs/workbench/contrib/chat/browser/actions/chatExportAction.ts",
        "src/vs/workbench/contrib/chat/browser/actions/chatExportTimestampHelper.ts",
      ],
      pull_requests: [42],
    },
  };
  const dataset: RichDataset = {
    issues: [],
    pullRequests: [
      {
        pullRequest: {
          id: 1,
          number: 42,
          title: "Allow chat export to include timestamps",
          body: "Enhance existing export.",
          html_url: "https://example.test/pr/42",
          state: "closed",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          closed_at: "2026-01-01T00:00:00Z",
          merged_at: "2026-01-01T00:00:00Z",
        },
        linkedIssueNumbers: [1],
        files: [
          {
            filename:
              "src/vs/workbench/contrib/chat/browser/actions/chatExportAction.ts",
            status: "modified",
          },
          {
            filename:
              "src/vs/workbench/contrib/chat/browser/actions/chatExportTimestampHelper.ts",
            status: "added",
          },
        ],
        commits: [],
        reviews: [],
        reviewComments: [],
        patchHunks: [],
      },
    ],
    metadata: {
      issueCount: 0,
      pullRequestCount: 1,
      issueCommentCount: 0,
      issueTimelineEventCount: 0,
      pullRequestReviewCount: 0,
      pullRequestReviewCommentCount: 0,
      patchHunkCount: 0,
      generatedAt: "2026-01-01T00:00:00Z",
    },
  };
  const truth = buildResolutionGroundTruth([benchmarkCase], dataset).get(1);

  assert.equal(truth?.actual_resolution_type, "enhancement_with_new_files");
  assert.equal(truth?.actual_created_files, true);
}

function testSymbolIndexExtraction(): void {
  const filePath = "src/vs/workbench/contrib/chat/browser/chatExportAction.ts";
  const text = [
    "import { ChatHistoryService } from './chatHistoryService';",
    "export class ChatExportAction {",
    "  async run() {",
    "    return ChatHistoryService.exportHistory();",
    "  }",
    "}",
    "export const CHAT_EXPORT_COMMAND_ID = 'chat.exportHistory';",
    "registerCommand('chat.exportHistory', () => undefined);",
  ].join("\n");
  const symbols = extractSymbolsFromSource({
    repoOwner: "microsoft",
    repoName: "vscode",
    filePath,
    text,
  });
  const imports = extractImportsFromSource({
    filePath,
    text,
    knownFiles: new Set([
      filePath,
      "src/vs/workbench/contrib/chat/browser/chatHistoryService.ts",
    ]),
  });
  const testLinks = inferTestLinks([
    "src/vs/workbench/contrib/chat/browser/chatExportAction.ts",
    "src/vs/workbench/contrib/chat/test/browser/chatExportAction.test.ts",
  ]);
  const touchedSymbols = touchedSymbolsForPatch({
    pullRequestNumber: 42,
    filePath,
    patchText: "+export class ChatExportAction {}",
    symbolsByFile: new Map([[filePath, symbols]]),
  });

  assert.ok(symbols.some((symbol) => symbol.name === "ChatExportAction"));
  assert.ok(symbols.some((symbol) => symbol.kind === "command"));
  assert.equal(
    imports[0]?.resolvedFile,
    "src/vs/workbench/contrib/chat/browser/chatHistoryService.ts",
  );
  assert.equal(testLinks[0]?.sourceFile, filePath);
  assert.ok(
    touchedSymbols.some((symbol) => symbol.symbolName === "ChatExportAction"),
  );
}

function main(): void {
  testResolutionClassifier();
  testCanonicalIssueProfile();
  testImplementationPatternExtraction();
  testResolutionGroundTruth();
  testSymbolIndexExtraction();
  console.log("All tests passed");
}

main();
