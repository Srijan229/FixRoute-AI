import fs from "node:fs";
import path from "node:path";
import {
  loadEmbeddingIndex,
  loadRichSemanticIndex,
} from "../lib/embeddings.js";
import { generateRecommendation } from "../lib/recommendation.js";
import { buildResolutionGroundTruth } from "../lib/resolutionEvaluation.js";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { logInfo } from "../lib/logger.js";
import { getPathQuality } from "../lib/pathQuality.js";
import type {
  BenchmarkCase,
  HoldoutSplit,
  PatchHunk,
  RecommendationResult,
  RichDataset,
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
const RICH_DATASET_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "normalized",
  "richDataset.json",
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
    area_recall_at_3: number;
    area_recall_at_5: number;
    file_recall_at_5: number;
    file_recall_at_10: number;
    file_precision_at_5: number;
    focused_file_recall_at_5: number;
    focused_file_recall_at_10: number;
    historical_patch_file_hit_rate: number;
    similar_issue_self_leak_rate: number;
    evidence_path_validity_rate: number;
    unknown_component_rate: number;
    component_aligned_file_hit_rate: number;
  };
  thresholds: {
    component_accuracy_target: number;
    component_top3_accuracy_target: number;
    area_recall_at_5_target: number;
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
  by_resolution_type: Record<
    string,
    {
      case_count: number;
      component_accuracy: number;
      area_recall_at_5: number;
      file_recall_at_5: number;
      existing_files_to_extend_recall_at_5: number;
      new_file_needed_precision: number;
      new_file_needed_recall: number;
      created_file_case_count: number;
    }
  >;
  by_created_files: Record<
    "created_files" | "no_created_files",
    {
      case_count: number;
      component_accuracy: number;
      area_recall_at_5: number;
      file_recall_at_5: number;
    }
  >;
  failures: Array<{
    issue_number: number;
    expected_component: string;
    predicted_component: string;
    expected_areas: string[];
    predicted_areas: string[];
    expected_files: string[];
    predicted_files: string[];
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

function impactAreaForFile(filePath: string): string {
  const parts = filePath.split("/");

  if (parts.length <= 2) {
    return parts[0] || filePath;
  }

  if (filePath.startsWith("src/vs/workbench/contrib/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 7)).join("/");
  }

  if (filePath.startsWith("src/vs/platform/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 6)).join("/");
  }

  if (filePath.startsWith("src/vs/editor/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 6)).join("/");
  }

  if (filePath.startsWith("src/vs/sessions/") && parts.length >= 5) {
    return parts.slice(0, Math.min(parts.length - 1, 6)).join("/");
  }

  if (filePath.startsWith("extensions/") && parts.length >= 4) {
    return parts.slice(0, Math.min(parts.length - 1, 5)).join("/");
  }

  return parts.slice(0, Math.min(parts.length - 1, 4)).join("/") || filePath;
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

function buildCreatedFileLookup(dataset: RichDataset | null): Map<number, Set<string>> {
  const lookup = new Map<number, Set<string>>();

  if (!dataset) {
    return lookup;
  }

  for (const record of dataset.pullRequests) {
    const createdFiles = record.files
      .filter((file) => file.status === "added")
      .map((file) => file.filename);

    if (createdFiles.length === 0) {
      continue;
    }

    for (const issueNumber of record.linkedIssueNumbers) {
      const current = lookup.get(issueNumber) ?? new Set<string>();

      for (const filePath of createdFiles) {
        current.add(filePath);
      }

      lookup.set(issueNumber, current);
    }
  }

  return lookup;
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
  const richDataset = loadOptionalJsonFile<RichDataset | null>(
    RICH_DATASET_PATH,
    null,
  );
  const cases = args.limit
    ? holdoutSplit.test_cases.slice(0, args.limit)
    : holdoutSplit.test_cases;
  const createdFileLookup = buildCreatedFileLookup(richDataset);
  const resolutionGroundTruth = richDataset
    ? buildResolutionGroundTruth(cases, richDataset)
    : new Map();
  const testIssueNumbers = new Set(
    holdoutSplit.test_cases.map((testCase) => testCase.issue_number),
  );
  const leakage = detectLeakage(testIssueNumbers);

  let componentCorrect = 0;
  let componentTop3Correct = 0;
  let areaRecallAt3Total = 0;
  let areaRecallAt5Total = 0;
  let fileRecallAt5Total = 0;
  let fileRecallAt10Total = 0;
  let filePrecisionAt5Total = 0;
  let focusedFileRecallAt5Total = 0;
  let focusedFileRecallAt10Total = 0;
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
  const byResolutionTypeStats = new Map<
    string,
    {
      count: number;
      componentCorrect: number;
      areaRecallAt5Total: number;
      fileRecallAt5Total: number;
      extendRecallAt5Total: number;
      newFilePredicted: number;
      newFileActual: number;
      newFileTruePositive: number;
      createdFileCases: number;
    }
  >();
  const byCreatedFileStats = new Map<
    "created_files" | "no_created_files",
    {
      count: number;
      componentCorrect: number;
      areaRecallAt5Total: number;
      fileRecallAt5Total: number;
    }
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
    const predictedExtendFilesAt5 = recommendation.existing_files_to_extend
      .slice(0, 5)
      .map((file) => file.file_path);
    const expectedFiles = benchmarkCase.expected.files;
    const createdFilesForCase = Array.from(
      createdFileLookup.get(benchmarkCase.issue_number) ?? [],
    );
    const actualResolutionType =
      resolutionGroundTruth.get(benchmarkCase.issue_number)
        ?.actual_resolution_type || recommendation.resolution_type;
    const hasCreatedFiles = createdFilesForCase.length > 0;
    const focusedExpectedFiles = deriveFocusedExpectedFiles(benchmarkCase);
    const expectedAreas = unique(
      focusedExpectedFiles.map((filePath) => impactAreaForFile(filePath)),
    );
    const predictedAreasAt3 = recommendation.likely_impacted_areas
      .slice(0, 3)
      .map((area) => area.area_path);
    const predictedAreasAt5 = recommendation.likely_impacted_areas
      .slice(0, 5)
      .map((area) => area.area_path);
    const expectedRanges = expectedLineRangesForCase(benchmarkCase, patchHunks);
    const top3Components = unique(
      recommendation.likely_impacted_files
        .map((file) => file.component)
        .filter((component) => component !== "Unknown"),
    ).slice(0, 3);
    const fileRecallAt5 = recall(expectedFiles, predictedFilesAt5);
    const extendRecallAt5 = recall(expectedFiles, predictedExtendFilesAt5);
    const fileRecallAt10 = recall(expectedFiles, predictedFilesAt10);
    const focusedFileRecallAt5 = recall(
      focusedExpectedFiles,
      predictedFilesAt5,
    );
    const focusedFileRecallAt10 = recall(
      focusedExpectedFiles,
      predictedFilesAt10,
    );
    const areaRecallAt3 = recall(expectedAreas, predictedAreasAt3);
    const areaRecallAt5 = recall(expectedAreas, predictedAreasAt5);
    const fileHitsAt5 = expectedFiles.filter((file) =>
      predictedFilesAt5.includes(file),
    ).length;
    const filePrecisionAt5 =
      predictedFilesAt5.length > 0 ? fileHitsAt5 / predictedFilesAt5.length : 0;
    const componentAlignedFileHit = recommendation.likely_impacted_files.some(
      (file) => file.component === benchmarkCase.expected.component,
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
    const resolutionStats = byResolutionTypeStats.get(
      actualResolutionType,
    ) || {
      count: 0,
      componentCorrect: 0,
      areaRecallAt5Total: 0,
      fileRecallAt5Total: 0,
      extendRecallAt5Total: 0,
      newFilePredicted: 0,
      newFileActual: 0,
      newFileTruePositive: 0,
      createdFileCases: 0,
    };
    const createdBucket = hasCreatedFiles ? "created_files" : "no_created_files";
    const createdStats = byCreatedFileStats.get(createdBucket) || {
      count: 0,
      componentCorrect: 0,
      areaRecallAt5Total: 0,
      fileRecallAt5Total: 0,
    };

    if (predictedComponent === benchmarkCase.expected.component) {
      componentCorrect += 1;
      componentStats.componentCorrect += 1;
      resolutionStats.componentCorrect += 1;
      createdStats.componentCorrect += 1;
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

    if (expectedRanges.length > 0 && patchHunkFileHit) {
      patchHunkFileHitCount += 1;
    }

    if (areaRecallAt5 === 0) {
      failureReasons.push("no_impact_area_hit_at_5");
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
    areaRecallAt3Total += areaRecallAt3;
    areaRecallAt5Total += areaRecallAt5;
    componentStats.count += 1;
    componentStats.focusedRecallAt5Total += focusedFileRecallAt5;
    perComponentStats.set(benchmarkCase.expected.component, componentStats);
    resolutionStats.count += 1;
    resolutionStats.areaRecallAt5Total += areaRecallAt5;
    resolutionStats.fileRecallAt5Total += fileRecallAt5;
    resolutionStats.extendRecallAt5Total += extendRecallAt5;
    resolutionStats.newFilePredicted += recommendation.routing
      .requires_new_files
      ? 1
      : 0;
    resolutionStats.newFileActual += hasCreatedFiles ? 1 : 0;
    resolutionStats.newFileTruePositive +=
      recommendation.routing.requires_new_files && hasCreatedFiles ? 1 : 0;
    resolutionStats.createdFileCases += hasCreatedFiles ? 1 : 0;
    byResolutionTypeStats.set(actualResolutionType, resolutionStats);
    createdStats.count += 1;
    createdStats.areaRecallAt5Total += areaRecallAt5;
    createdStats.fileRecallAt5Total += fileRecallAt5;
    byCreatedFileStats.set(createdBucket, createdStats);

    if (failureReasons.length > 0) {
      failures.push({
        issue_number: benchmarkCase.issue_number,
        expected_component: benchmarkCase.expected.component,
        predicted_component: predictedComponent,
        expected_areas: expectedAreas,
        predicted_areas: predictedAreasAt5,
        expected_files: expectedFiles,
        predicted_files: predictedFilesAt5,
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
    area_recall_at_5_target: 0.35,
    focused_file_recall_at_5_target: 0.35,
    component_aligned_file_hit_rate_target: 0.75,
    evidence_path_validity_rate_target: 0.95,
  };
  const metrics = {
    component_accuracy: rate(componentCorrect, cases.length),
    component_top3_accuracy: rate(componentTop3Correct, cases.length),
    area_recall_at_3: rate(areaRecallAt3Total, cases.length),
    area_recall_at_5: rate(areaRecallAt5Total, cases.length),
    file_recall_at_5: rate(fileRecallAt5Total, cases.length),
    file_recall_at_10: rate(fileRecallAt10Total, cases.length),
    file_precision_at_5: rate(filePrecisionAt5Total, cases.length),
    focused_file_recall_at_5: rate(focusedFileRecallAt5Total, cases.length),
    focused_file_recall_at_10: rate(focusedFileRecallAt10Total, cases.length),
    historical_patch_file_hit_rate: rate(
      patchHunkFileHitCount,
      lineEvaluableCases,
    ),
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
    metrics.area_recall_at_5 >= thresholds.area_recall_at_5_target &&
    metrics.focused_file_recall_at_5 >=
      thresholds.focused_file_recall_at_5_target &&
    metrics.component_aligned_file_hit_rate >=
      thresholds.component_aligned_file_hit_rate_target &&
    metrics.evidence_path_validity_rate >=
      thresholds.evidence_path_validity_rate_target;

  const report: ProductEvaluationReport = {
    claim_under_test:
      "Given a new GitHub issue title/body, FixRoute AI classifies the engineering work type, then routes to likely components, areas, existing files to inspect or extend, possible new files, implementation patterns, similar historical tickets, and evidence paths.",
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
    by_resolution_type: Object.fromEntries(
      Array.from(byResolutionTypeStats.entries())
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([resolutionType, stats]) => [
          resolutionType,
          {
            case_count: stats.count,
            component_accuracy: rate(stats.componentCorrect, stats.count),
            area_recall_at_5: rate(stats.areaRecallAt5Total, stats.count),
            file_recall_at_5: rate(stats.fileRecallAt5Total, stats.count),
            existing_files_to_extend_recall_at_5: rate(
              stats.extendRecallAt5Total,
              stats.count,
            ),
            new_file_needed_precision: rate(
              stats.newFileTruePositive,
              stats.newFilePredicted,
            ),
            new_file_needed_recall: rate(
              stats.newFileTruePositive,
              stats.newFileActual,
            ),
            created_file_case_count: stats.createdFileCases,
          },
        ]),
    ),
    by_created_files: {
      created_files: {
        case_count: byCreatedFileStats.get("created_files")?.count || 0,
        component_accuracy: rate(
          byCreatedFileStats.get("created_files")?.componentCorrect || 0,
          byCreatedFileStats.get("created_files")?.count || 0,
        ),
        area_recall_at_5: rate(
          byCreatedFileStats.get("created_files")?.areaRecallAt5Total || 0,
          byCreatedFileStats.get("created_files")?.count || 0,
        ),
        file_recall_at_5: rate(
          byCreatedFileStats.get("created_files")?.fileRecallAt5Total || 0,
          byCreatedFileStats.get("created_files")?.count || 0,
        ),
      },
      no_created_files: {
        case_count: byCreatedFileStats.get("no_created_files")?.count || 0,
        component_accuracy: rate(
          byCreatedFileStats.get("no_created_files")?.componentCorrect || 0,
          byCreatedFileStats.get("no_created_files")?.count || 0,
        ),
        area_recall_at_5: rate(
          byCreatedFileStats.get("no_created_files")?.areaRecallAt5Total || 0,
          byCreatedFileStats.get("no_created_files")?.count || 0,
        ),
        file_recall_at_5: rate(
          byCreatedFileStats.get("no_created_files")?.fileRecallAt5Total || 0,
          byCreatedFileStats.get("no_created_files")?.count || 0,
        ),
      },
    },
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
