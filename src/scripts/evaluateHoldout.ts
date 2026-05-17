import fs from "node:fs";
import path from "node:path";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { generateRecommendation } from "../lib/recommendation.js";
import { logInfo } from "../lib/logger.js";
import type { BenchmarkCase, HoldoutSplit } from "../lib/types.js";

const HOLDOUT_PATH = path.resolve(process.cwd(), "data", "processed", "evaluation", "holdout.json");

type Args = {
  limit?: number;
};

type HoldoutEvaluationReport = {
  evaluated_cases: number;
  component_accuracy: number;
  top1_support_coverage: number;
  file_recall_at_5: number;
  file_recall_at_10: number;
  file_precision_at_5: number;
  focused_file_recall_at_5: number;
  focused_file_recall_at_10: number;
  component_top3_accuracy: number;
  unknown_component_rate: number;
  narrow_case_count: number;
  narrow_file_recall_at_5: number;
  narrow_focused_file_recall_at_5: number;
  broad_pr_case_count: number;
  broad_file_recall_at_5: number;
  broad_focused_file_recall_at_5: number;
  broad_pr_component_accuracy: number;
  component_aligned_file_hit_rate: number;
  per_component: Record<
    string,
    {
      case_count: number;
      top1_accuracy: number;
      top3_accuracy: number;
      component_aligned_file_hit_rate: number;
    }
  >;
  confusion_matrix: Array<{
    expected_component: string;
    predicted_component: string;
    count: number;
    sample_issue_numbers: number[];
  }>;
  dominant_misroutes: Array<{
    expected_component: string;
    predicted_component: string;
    count: number;
    sample_issue_numbers: number[];
  }>;
  failures: Array<{
    issue_number: number;
    expected_component: string;
    predicted_component: string;
    expected_files: string[];
    focused_expected_files: string[];
    predicted_files: string[];
    predicted_duplicate: number | string;
  }>;
  train_issue_count: number;
  test_issue_count: number;
  train_closed_at_range: HoldoutSplit["metadata"]["train_closed_at_range"];
  test_closed_at_range: HoldoutSplit["metadata"]["test_closed_at_range"];
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

function loadHoldoutSplit(): HoldoutSplit {
  if (!fs.existsSync(HOLDOUT_PATH)) {
    throw new Error("Missing holdout split. Run build:holdout first.");
  }

  return JSON.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as HoldoutSplit;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function filePriorityScore(filePath: string, expectedComponent: string): number {
  const normalizedPath = filePath.toLowerCase();
  let score = 0;

  if (mapFilePathToComponent(filePath) === expectedComponent) {
    score += 50;
  }

  if (normalizedPath.includes("/src/")) {
    score += 20;
  }

  if (normalizedPath.endsWith(".ts") || normalizedPath.endsWith(".tsx")) {
    score += 10;
  }

  if (normalizedPath.includes("/common/") || normalizedPath.includes("/browser/")) {
    score += 5;
  }

  if (normalizedPath.includes("/test/")) {
    score -= 10;
  }

  if (normalizedPath.endsWith(".css") || normalizedPath.endsWith(".md") || normalizedPath.endsWith(".yml")) {
    score -= 8;
  }

  if (normalizedPath.startsWith(".vscode/") || normalizedPath.startsWith("build/")) {
    score -= 12;
  }

  return score;
}

function deriveFocusedExpectedFiles(benchmarkCase: BenchmarkCase): string[] {
  const componentFiles = benchmarkCase.expected.files.filter(
    (filePath) => mapFilePathToComponent(filePath) === benchmarkCase.expected.component
  );
  const candidateFiles = componentFiles.length > 0 ? componentFiles : benchmarkCase.expected.files;

  return [...candidateFiles]
    .sort((left, right) => {
      const scoreDifference =
        filePriorityScore(right, benchmarkCase.expected.component) -
        filePriorityScore(left, benchmarkCase.expected.component);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return left.localeCompare(right);
    })
    .slice(0, 10);
}

function recall(expectedFiles: string[], predictedFiles: string[]): number {
  if (expectedFiles.length === 0) {
    return 0;
  }

  const hits = expectedFiles.filter((file) => predictedFiles.includes(file)).length;
  return hits / expectedFiles.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const holdoutSplit = loadHoldoutSplit();
  const cases = args.limit ? holdoutSplit.test_cases.slice(0, args.limit) : holdoutSplit.test_cases;

  let componentCorrect = 0;
  let top1SupportExists = 0;
  let fileRecallAt5Total = 0;
  let fileRecallAt10Total = 0;
  let filePrecisionAt5Total = 0;
  let focusedFileRecallAt5Total = 0;
  let focusedFileRecallAt10Total = 0;
  let componentTop3Correct = 0;
  let unknownPredictions = 0;
  let narrowCaseCount = 0;
  let narrowFileRecallAt5Total = 0;
  let narrowFocusedFileRecallAt5Total = 0;
  let broadPrCaseCount = 0;
  let broadFileRecallAt5Total = 0;
  let broadFocusedFileRecallAt5Total = 0;
  let broadPrComponentCorrect = 0;
  let componentAlignedFileHitCount = 0;
  const perComponentStats = new Map<
    string,
    { caseCount: number; top1Correct: number; top3Correct: number; componentAlignedHitCount: number }
  >();
  const confusionStats = new Map<string, { expectedComponent: string; predictedComponent: string; count: number; sampleIssueNumbers: number[] }>();
  const failures: Array<{
    issue_number: number;
    expected_component: string;
    predicted_component: string;
    expected_files: string[];
    focused_expected_files: string[];
    predicted_files: string[];
    predicted_duplicate: number | string;
  }> = [];

  for (const benchmarkCase of cases) {
    const recommendation = await generateRecommendation({
      title: benchmarkCase.title,
      description: benchmarkCase.body,
      topK: 5
    });

    const predictedComponent = recommendation.suggested_component;
    const predictedFilesAt5 = recommendation.likely_impacted_files.slice(0, 5).map((file) => file.file_path);
    const predictedFilesAt10 = recommendation.likely_impacted_files.slice(0, 10).map((file) => file.file_path);
    const expectedFiles = benchmarkCase.expected.files;
    const focusedExpectedFiles = deriveFocusedExpectedFiles(benchmarkCase);
    const fileHitsAt5 = expectedFiles.filter((file) => predictedFilesAt5.includes(file)).length;
    const fileRecallAt5 = recall(expectedFiles, predictedFilesAt5);
    const fileRecallAt10 = recall(expectedFiles, predictedFilesAt10);
    const focusedFileRecallAt5 = recall(focusedExpectedFiles, predictedFilesAt5);
    const focusedFileRecallAt10 = recall(focusedExpectedFiles, predictedFilesAt10);
    const filePrecisionAt5 = predictedFilesAt5.length > 0 ? fileHitsAt5 / predictedFilesAt5.length : 0;
    const top3Components = unique(
      recommendation.likely_impacted_files.map((file) => file.component).filter((component) => component !== "Unknown")
    ).slice(0, 3);
    const componentAlignedHit = recommendation.likely_impacted_files.some(
      (file) => file.component === benchmarkCase.expected.component
    );
    const isTop3Correct =
      top3Components.includes(benchmarkCase.expected.component) || predictedComponent === benchmarkCase.expected.component;
    const isBroadPrCase = expectedFiles.length > 10;
    const componentStats = perComponentStats.get(benchmarkCase.expected.component) || {
      caseCount: 0,
      top1Correct: 0,
      top3Correct: 0,
      componentAlignedHitCount: 0
    };

    componentStats.caseCount += 1;

    if (predictedComponent === benchmarkCase.expected.component) {
      componentCorrect += 1;
      componentStats.top1Correct += 1;
    }

    if (recommendation.similar_tickets.length > 0) {
      top1SupportExists += 1;
    }

    if (isTop3Correct) {
      componentTop3Correct += 1;
      componentStats.top3Correct += 1;
    }

    if (predictedComponent === "Unknown") {
      unknownPredictions += 1;
    }

    if (isBroadPrCase) {
      broadPrCaseCount += 1;

      if (predictedComponent === benchmarkCase.expected.component) {
        broadPrComponentCorrect += 1;
      }
    }

    if (componentAlignedHit) {
      componentAlignedFileHitCount += 1;
      componentStats.componentAlignedHitCount += 1;
    }

    perComponentStats.set(benchmarkCase.expected.component, componentStats);

    const confusionKey = `${benchmarkCase.expected.component}=>${predictedComponent}`;
    const confusionRow = confusionStats.get(confusionKey) || {
      expectedComponent: benchmarkCase.expected.component,
      predictedComponent,
      count: 0,
      sampleIssueNumbers: []
    };

    confusionRow.count += 1;

    if (confusionRow.sampleIssueNumbers.length < 5) {
      confusionRow.sampleIssueNumbers.push(benchmarkCase.issue_number);
    }

    confusionStats.set(confusionKey, confusionRow);

    fileRecallAt5Total += fileRecallAt5;
    fileRecallAt10Total += fileRecallAt10;
    filePrecisionAt5Total += filePrecisionAt5;
    focusedFileRecallAt5Total += focusedFileRecallAt5;
    focusedFileRecallAt10Total += focusedFileRecallAt10;

    if (isBroadPrCase) {
      broadFileRecallAt5Total += fileRecallAt5;
      broadFocusedFileRecallAt5Total += focusedFileRecallAt5;
    } else {
      narrowCaseCount += 1;
      narrowFileRecallAt5Total += fileRecallAt5;
      narrowFocusedFileRecallAt5Total += focusedFileRecallAt5;
    }

    if (
      predictedComponent !== benchmarkCase.expected.component ||
      focusedFileRecallAt5 === 0
    ) {
      failures.push({
        issue_number: benchmarkCase.issue_number,
        expected_component: benchmarkCase.expected.component,
        predicted_component: predictedComponent,
        expected_files: benchmarkCase.expected.files,
        focused_expected_files: focusedExpectedFiles,
        predicted_files: predictedFilesAt5,
        predicted_duplicate: recommendation.possible_duplicate.issue_number
      });
    }
  }

  const perComponent = Object.fromEntries(
    Array.from(perComponentStats.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([component, stats]) => [
        component,
        {
          case_count: stats.caseCount,
          top1_accuracy: Number((stats.top1Correct / stats.caseCount).toFixed(3)),
          top3_accuracy: Number((stats.top3Correct / stats.caseCount).toFixed(3)),
          component_aligned_file_hit_rate: Number((stats.componentAlignedHitCount / stats.caseCount).toFixed(3))
        }
      ])
  );

  const confusionMatrix = Array.from(confusionStats.values()).sort(
    (left, right) =>
      right.count - left.count ||
      left.expectedComponent.localeCompare(right.expectedComponent) ||
      left.predictedComponent.localeCompare(right.predictedComponent)
  ).map((row) => ({
    expected_component: row.expectedComponent,
    predicted_component: row.predictedComponent,
    count: row.count,
    sample_issue_numbers: row.sampleIssueNumbers
  }));

  const dominantMisroutes = confusionMatrix
    .filter((row) => row.expected_component !== row.predicted_component)
    .slice(0, 15);

  const report: HoldoutEvaluationReport = {
    evaluated_cases: cases.length,
    component_accuracy: Number((componentCorrect / cases.length).toFixed(3)),
    top1_support_coverage: Number((top1SupportExists / cases.length).toFixed(3)),
    file_recall_at_5: Number((fileRecallAt5Total / cases.length).toFixed(3)),
    file_recall_at_10: Number((fileRecallAt10Total / cases.length).toFixed(3)),
    file_precision_at_5: Number((filePrecisionAt5Total / cases.length).toFixed(3)),
    focused_file_recall_at_5: Number((focusedFileRecallAt5Total / cases.length).toFixed(3)),
    focused_file_recall_at_10: Number((focusedFileRecallAt10Total / cases.length).toFixed(3)),
    component_top3_accuracy: Number((componentTop3Correct / cases.length).toFixed(3)),
    unknown_component_rate: Number((unknownPredictions / cases.length).toFixed(3)),
    narrow_case_count: narrowCaseCount,
    narrow_file_recall_at_5: narrowCaseCount > 0 ? Number((narrowFileRecallAt5Total / narrowCaseCount).toFixed(3)) : 0,
    narrow_focused_file_recall_at_5:
      narrowCaseCount > 0 ? Number((narrowFocusedFileRecallAt5Total / narrowCaseCount).toFixed(3)) : 0,
    broad_pr_case_count: broadPrCaseCount,
    broad_file_recall_at_5: broadPrCaseCount > 0 ? Number((broadFileRecallAt5Total / broadPrCaseCount).toFixed(3)) : 0,
    broad_focused_file_recall_at_5:
      broadPrCaseCount > 0 ? Number((broadFocusedFileRecallAt5Total / broadPrCaseCount).toFixed(3)) : 0,
    broad_pr_component_accuracy:
      broadPrCaseCount > 0 ? Number((broadPrComponentCorrect / broadPrCaseCount).toFixed(3)) : 0,
    component_aligned_file_hit_rate: Number((componentAlignedFileHitCount / cases.length).toFixed(3)),
    per_component: perComponent,
    confusion_matrix: confusionMatrix,
    dominant_misroutes: dominantMisroutes,
    failures,
    train_issue_count: holdoutSplit.metadata.train_case_count,
    test_issue_count: holdoutSplit.metadata.test_case_count,
    train_closed_at_range: holdoutSplit.metadata.train_closed_at_range,
    test_closed_at_range: holdoutSplit.metadata.test_closed_at_range
  };

  logInfo("Holdout evaluation complete", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
