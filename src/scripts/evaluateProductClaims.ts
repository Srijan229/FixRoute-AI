import fs from "node:fs";
import path from "node:path";
import {
  loadEmbeddingIndex,
  loadRichSemanticIndex,
} from "../lib/embeddings.js";
import { generateRecommendation } from "../lib/recommendation.js";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { logInfo } from "../lib/logger.js";
import { getPathQuality } from "../lib/pathQuality.js";
import type {
  BenchmarkCase,
  HoldoutSplit,
  PatchHunk,
  RecommendationResult,
} from "../lib/types.js";

const HOLDOUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "holdout.json",
);
const PATCH_HUNKS_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "patches",
  "patchHunks.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "productEvaluation.json",
);

type Args = {
  limit?: number;
};

type LineRange = {
  filePath: string;
  startLine: number;
  endLine: number;
};

type ProductEvaluationReport = {
  claim_under_test: string;
  valid_for_product_claims: boolean;
  leakage: {
    detected: boolean;
    issue_embedding_leak_count: number;
    rich_semantic_leak_count: number;
    leaked_issue_numbers_sample: number[];
    note: string;
  };
  dataset: {
    evaluated_cases: number;
    train_issue_count: number;
    test_issue_count: number;
    eligible_case_count: number;
    train_closed_at_range: HoldoutSplit["metadata"]["train_closed_at_range"];
    test_closed_at_range: HoldoutSplit["metadata"]["test_closed_at_range"];
  };
  metrics: {
    component_accuracy: number;
    component_top3_accuracy: number;
    file_recall_at_5: number;
    file_recall_at_10: number;
    file_precision_at_5: number;
    focused_file_recall_at_5: number;
    focused_file_recall_at_10: number;
    line_range_overlap_rate: number;
    patch_hunk_file_hit_rate: number;
    similar_issue_self_leak_rate: number;
    evidence_path_validity_rate: number;
    unknown_component_rate: number;
    component_aligned_file_hit_rate: number;
  };
  thresholds: {
    component_accuracy_target: number;
    component_top3_accuracy_target: number;
    focused_file_recall_at_5_target: number;
    component_aligned_file_hit_rate_target: number;
    evidence_path_validity_rate_target: number;
    supported: boolean;
    reason: string;
  };
  per_component: Record<
    string,
    {
      case_count: number;
      component_accuracy: number;
      focused_file_recall_at_5: number;
    }
  >;
  failures: Array<{
    issue_number: number;
    expected_component: string;
    predicted_component: string;
    expected_files: string[];
    predicted_files: string[];
    expected_line_ranges: LineRange[];
    predicted_line_ranges: LineRange[];
    possible_duplicate: number | string;
    failure_reasons: string[];
  }>;
};

function parseArgs(argv: string[]): Args {
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--limit" && argv[index + 1]) {
      limit = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive number");
  }

  return { limit };
}

function loadJsonFile<T>(filePath: string, errorMessage: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(errorMessage);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function loadOptionalJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function recall(expectedItems: string[], predictedItems: string[]): number {
  if (expectedItems.length === 0) {
    return 0;
  }

  const hits = expectedItems.filter((item) =>
    predictedItems.includes(item),
  ).length;
  return hits / expectedItems.length;
}

function filePriorityScore(
  filePath: string,
  expectedComponent: string,
): number {
  const quality = getPathQuality(filePath);
  const normalizedPath = filePath.toLowerCase();
  let score = quality.score * 100;

  if (mapFilePathToComponent(filePath) === expectedComponent) score += 50;
  if (normalizedPath.includes("/src/")) score += 20;
  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx"))
    score += 10;
  if (
    normalizedPath.includes("/common/") ||
    normalizedPath.includes("/browser/")
  )
    score += 5;
  if (normalizedPath.includes("/test/")) score -= 10;
  if (
    normalizedPath.endsWith(".css") ||
    normalizedPath.endsWith(".md") ||
    normalizedPath.endsWith(".yml")
  )
    score -= 8;
  if (
    normalizedPath.startsWith(".vscode/") ||
    normalizedPath.startsWith("build/")
  )
    score -= 12;

  return score;
}

function deriveFocusedExpectedFiles(benchmarkCase: BenchmarkCase): string[] {
  const componentFiles = benchmarkCase.expected.files.filter(
    (filePath) =>
      mapFilePathToComponent(filePath) === benchmarkCase.expected.component &&
      getPathQuality(filePath).includeInFocusedEvaluation,
  );
  const sourceFiles = benchmarkCase.expected.files.filter(
    (filePath) => getPathQuality(filePath).includeInFocusedEvaluation,
  );
  const candidateFiles =
    componentFiles.length > 0
      ? componentFiles
      : sourceFiles.length > 0
        ? sourceFiles
        : benchmarkCase.expected.files;

  return [...candidateFiles]
    .sort((left, right) => {
      const scoreDifference =
        filePriorityScore(right, benchmarkCase.expected.component) -
        filePriorityScore(left, benchmarkCase.expected.component);

      return scoreDifference !== 0
        ? scoreDifference
        : left.localeCompare(right);
    })
    .slice(0, 10);
}

function expectedLineRangesForCase(
  benchmarkCase: BenchmarkCase,
  patchHunks: PatchHunk[],
): LineRange[] {
  const expectedPullRequests = new Set(benchmarkCase.expected.pull_requests);

  return patchHunks
    .filter((hunk) => expectedPullRequests.has(hunk.pullRequestNumber))
    .filter((hunk) => getPathQuality(hunk.filePath).includeInFocusedEvaluation)
    .map((hunk) => ({
      filePath: hunk.filePath,
      startLine: hunk.newStartLine,
      endLine: hunk.newStartLine + Math.max(hunk.newLineCount - 1, 0),
    }));
}

function predictedLineRanges(
  recommendation: RecommendationResult,
): LineRange[] {
  return recommendation.likely_impacted_files.flatMap((file) =>
    (file.line_ranges || []).map((range) => ({
      filePath: file.file_path,
      startLine: range.start_line,
      endLine: range.end_line,
    })),
  );
}

function rangesOverlap(left: LineRange, right: LineRange): boolean {
  return (
    left.filePath === right.filePath &&
    left.startLine <= right.endLine &&
    right.startLine <= left.endLine
  );
}

function hasLineRangeOverlap(
  expectedRanges: LineRange[],
  predictedRanges: LineRange[],
): boolean {
  return expectedRanges.some((expected) =>
    predictedRanges.some((predicted) => rangesOverlap(expected, predicted)),
  );
}

function hasPatchHunkFileHit(
  expectedRanges: LineRange[],
  predictedFiles: string[],
): boolean {
  const expectedFiles = new Set(expectedRanges.map((range) => range.filePath));
  return predictedFiles.some((filePath) => expectedFiles.has(filePath));
}

function isEvidencePathValid(pathRow: string[]): boolean {
  return (
    pathRow.length === 4 &&
    pathRow[0].startsWith("Issue #") &&
    pathRow[1].startsWith("FIXED_BY PR #") &&
    pathRow[2].startsWith("CHANGES ") &&
    pathRow[3].startsWith("BELONGS_TO ")
  );
}

function detectLeakage(
  testIssueNumbers: Set<number>,
): ProductEvaluationReport["leakage"] {
  const leakedIssueNumbers = new Set<number>();
  let issueEmbeddingLeakCount = 0;
  let richSemanticLeakCount = 0;

  try {
    for (const record of loadEmbeddingIndex()) {
      if (testIssueNumbers.has(record.issueNumber)) {
        issueEmbeddingLeakCount += 1;
        leakedIssueNumbers.add(record.issueNumber);
      }
    }
  } catch {
    // Missing indexes will be reported by recommendation generation if needed.
  }

  try {
    for (const record of loadRichSemanticIndex().records) {
      if (record.issueNumber && testIssueNumbers.has(record.issueNumber)) {
        richSemanticLeakCount += 1;
        leakedIssueNumbers.add(record.issueNumber);
      }
    }
  } catch {
    // Rich semantic index is optional for current recommendation flow.
  }

  const detected = issueEmbeddingLeakCount > 0 || richSemanticLeakCount > 0;

  return {
    detected,
    issue_embedding_leak_count: issueEmbeddingLeakCount,
    rich_semantic_leak_count: richSemanticLeakCount,
    leaked_issue_numbers_sample: Array.from(leakedIssueNumbers.values())
      .sort((a, b) => a - b)
      .slice(0, 20),
    note: detected
      ? "Test issues are present in one or more retrieval indexes. Rebuild graph/indexes with the train split before making product accuracy claims."
      : "No test issue leakage detected in local embedding indexes.",
  };
}

function rate(value: number, count: number): number {
  return count > 0 ? Number((value / count).toFixed(3)) : 0;
}

function saveReport(report: ProductEvaluationReport): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const holdoutSplit = loadJsonFile<HoldoutSplit>(
    HOLDOUT_PATH,
    "Missing holdout split. Run build:holdout first.",
  );
  const patchHunks = loadOptionalJsonFile<PatchHunk[]>(PATCH_HUNKS_PATH, []);
  const cases = args.limit
    ? holdoutSplit.test_cases.slice(0, args.limit)
    : holdoutSplit.test_cases;
  const testIssueNumbers = new Set(
    holdoutSplit.test_cases.map((testCase) => testCase.issue_number),
  );
  const leakage = detectLeakage(testIssueNumbers);

  let componentCorrect = 0;
  let componentTop3Correct = 0;
  let fileRecallAt5Total = 0;
  let fileRecallAt10Total = 0;
  let filePrecisionAt5Total = 0;
  let focusedFileRecallAt5Total = 0;
  let focusedFileRecallAt10Total = 0;
  let lineRangeOverlapCount = 0;
  let patchHunkFileHitCount = 0;
  let similarIssueSelfLeakCount = 0;
  let validEvidencePathCount = 0;
  let evidencePathCount = 0;
  let unknownComponentCount = 0;
  let componentAlignedFileHitCount = 0;
  const perComponentStats = new Map<
    string,
    { count: number; componentCorrect: number; focusedRecallAt5Total: number }
  >();
  const failures: ProductEvaluationReport["failures"] = [];

  for (const benchmarkCase of cases) {
    const recommendation = await generateRecommendation({
      title: benchmarkCase.title,
      description: benchmarkCase.body,
      topK: 5,
    });
    const predictedComponent = recommendation.suggested_component;
    const predictedFilesAt5 = recommendation.likely_impacted_files
      .slice(0, 5)
      .map((file) => file.file_path);
    const predictedFilesAt10 = recommendation.likely_impacted_files
      .slice(0, 10)
      .map((file) => file.file_path);
    const expectedFiles = benchmarkCase.expected.files;
    const focusedExpectedFiles = deriveFocusedExpectedFiles(benchmarkCase);
    const expectedRanges = expectedLineRangesForCase(benchmarkCase, patchHunks);
    const predictedRanges = predictedLineRanges(recommendation);
    const top3Components = unique(
      recommendation.likely_impacted_files
        .map((file) => file.component)
        .filter((component) => component !== "Unknown"),
    ).slice(0, 3);
    const fileRecallAt5 = recall(expectedFiles, predictedFilesAt5);
    const fileRecallAt10 = recall(expectedFiles, predictedFilesAt10);
    const focusedFileRecallAt5 = recall(
      focusedExpectedFiles,
      predictedFilesAt5,
    );
    const focusedFileRecallAt10 = recall(
      focusedExpectedFiles,
      predictedFilesAt10,
    );
    const fileHitsAt5 = expectedFiles.filter((file) =>
      predictedFilesAt5.includes(file),
    ).length;
    const filePrecisionAt5 =
      predictedFilesAt5.length > 0 ? fileHitsAt5 / predictedFilesAt5.length : 0;
    const componentAlignedFileHit = recommendation.likely_impacted_files.some(
      (file) => file.component === benchmarkCase.expected.component,
    );
    const lineRangeOverlap = hasLineRangeOverlap(
      expectedRanges,
      predictedRanges,
    );
    const patchHunkFileHit = hasPatchHunkFileHit(
      expectedRanges,
      predictedFilesAt10,
    );
    const selfLeak = recommendation.similar_tickets.some(
      (ticket) => ticket.issue_number === benchmarkCase.issue_number,
    );
    const failureReasons: string[] = [];
    const componentStats = perComponentStats.get(
      benchmarkCase.expected.component,
    ) || {
      count: 0,
      componentCorrect: 0,
      focusedRecallAt5Total: 0,
    };

    if (predictedComponent === benchmarkCase.expected.component) {
      componentCorrect += 1;
      componentStats.componentCorrect += 1;
    } else {
      failureReasons.push("component_mismatch");
    }

    if (
      top3Components.includes(benchmarkCase.expected.component) ||
      predictedComponent === benchmarkCase.expected.component
    ) {
      componentTop3Correct += 1;
    }

    if (predictedComponent === "Unknown") {
      unknownComponentCount += 1;
      failureReasons.push("unknown_component");
    }

    if (componentAlignedFileHit) {
      componentAlignedFileHitCount += 1;
    } else {
      failureReasons.push("no_component_aligned_file");
    }

    if (expectedRanges.length > 0 && lineRangeOverlap) {
      lineRangeOverlapCount += 1;
    }

    if (expectedRanges.length > 0 && patchHunkFileHit) {
      patchHunkFileHitCount += 1;
    }

    if (expectedRanges.length > 0 && !lineRangeOverlap) {
      failureReasons.push("no_line_range_overlap");
    }

    if (focusedFileRecallAt5 === 0) {
      failureReasons.push("no_focused_file_hit_at_5");
    }

    if (selfLeak) {
      similarIssueSelfLeakCount += 1;
      failureReasons.push("self_issue_returned_as_similar");
    }

    for (const pathRow of recommendation.evidence_path) {
      evidencePathCount += 1;

      if (isEvidencePathValid(pathRow)) {
        validEvidencePathCount += 1;
      }
    }

    fileRecallAt5Total += fileRecallAt5;
    fileRecallAt10Total += fileRecallAt10;
    filePrecisionAt5Total += filePrecisionAt5;
    focusedFileRecallAt5Total += focusedFileRecallAt5;
    focusedFileRecallAt10Total += focusedFileRecallAt10;
    componentStats.count += 1;
    componentStats.focusedRecallAt5Total += focusedFileRecallAt5;
    perComponentStats.set(benchmarkCase.expected.component, componentStats);

    if (failureReasons.length > 0) {
      failures.push({
        issue_number: benchmarkCase.issue_number,
        expected_component: benchmarkCase.expected.component,
        predicted_component: predictedComponent,
        expected_files: expectedFiles,
        predicted_files: predictedFilesAt5,
        expected_line_ranges: expectedRanges.slice(0, 10),
        predicted_line_ranges: predictedRanges.slice(0, 10),
        possible_duplicate: recommendation.possible_duplicate.issue_number,
        failure_reasons: failureReasons,
      });
    }
  }

  const lineEvaluableCases = cases.filter(
    (benchmarkCase) =>
      expectedLineRangesForCase(benchmarkCase, patchHunks).length > 0,
  ).length;
  const thresholds = {
    component_accuracy_target: 0.6,
    component_top3_accuracy_target: 0.8,
    focused_file_recall_at_5_target: 0.35,
    component_aligned_file_hit_rate_target: 0.75,
    evidence_path_validity_rate_target: 0.95,
  };
  const metrics = {
    component_accuracy: rate(componentCorrect, cases.length),
    component_top3_accuracy: rate(componentTop3Correct, cases.length),
    file_recall_at_5: rate(fileRecallAt5Total, cases.length),
    file_recall_at_10: rate(fileRecallAt10Total, cases.length),
    file_precision_at_5: rate(filePrecisionAt5Total, cases.length),
    focused_file_recall_at_5: rate(focusedFileRecallAt5Total, cases.length),
    focused_file_recall_at_10: rate(focusedFileRecallAt10Total, cases.length),
    line_range_overlap_rate: rate(lineRangeOverlapCount, lineEvaluableCases),
    patch_hunk_file_hit_rate: rate(patchHunkFileHitCount, lineEvaluableCases),
    similar_issue_self_leak_rate: rate(similarIssueSelfLeakCount, cases.length),
    evidence_path_validity_rate: rate(
      validEvidencePathCount,
      evidencePathCount,
    ),
    unknown_component_rate: rate(unknownComponentCount, cases.length),
    component_aligned_file_hit_rate: rate(
      componentAlignedFileHitCount,
      cases.length,
    ),
  };
  const supported =
    !leakage.detected &&
    metrics.component_accuracy >= thresholds.component_accuracy_target &&
    metrics.component_top3_accuracy >=
      thresholds.component_top3_accuracy_target &&
    metrics.focused_file_recall_at_5 >=
      thresholds.focused_file_recall_at_5_target &&
    metrics.component_aligned_file_hit_rate >=
      thresholds.component_aligned_file_hit_rate_target &&
    metrics.evidence_path_validity_rate >=
      thresholds.evidence_path_validity_rate_target;

  const report: ProductEvaluationReport = {
    claim_under_test:
      "Given a new GitHub issue title/body, FixRoute AI predicts likely component, impacted files, line-range evidence, similar historical tickets, and evidence paths.",
    valid_for_product_claims: !leakage.detected,
    leakage,
    dataset: {
      evaluated_cases: cases.length,
      train_issue_count: holdoutSplit.metadata.train_case_count,
      test_issue_count: holdoutSplit.metadata.test_case_count,
      eligible_case_count: holdoutSplit.metadata.eligible_case_count,
      train_closed_at_range: holdoutSplit.metadata.train_closed_at_range,
      test_closed_at_range: holdoutSplit.metadata.test_closed_at_range,
    },
    metrics,
    thresholds: {
      ...thresholds,
      supported,
      reason: leakage.detected
        ? "Not supported for product claims because evaluation leakage was detected. Rebuild graph and indexes with train-only data."
        : supported
          ? "Supported against the configured thresholds."
          : "Not supported against the configured thresholds.",
    },
    per_component: Object.fromEntries(
      Array.from(perComponentStats.entries())
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([component, stats]) => [
          component,
          {
            case_count: stats.count,
            component_accuracy: rate(stats.componentCorrect, stats.count),
            focused_file_recall_at_5: rate(
              stats.focusedRecallAt5Total,
              stats.count,
            ),
          },
        ]),
    ),
    failures: failures.slice(0, 50),
  };

  saveReport(report);
  logInfo("Product claim evaluation complete", {
    outputPath: OUTPUT_PATH,
    validForProductClaims: report.valid_for_product_claims,
    metrics: report.metrics,
    supported: report.thresholds.supported,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
