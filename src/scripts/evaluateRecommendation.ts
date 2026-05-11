import fs from "node:fs";
import path from "node:path";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { generateRecommendation } from "../lib/recommendation.js";
import { logInfo } from "../lib/logger.js";
import type { BenchmarkCase, EvaluationReport } from "../lib/types.js";

const BENCHMARK_PATH = path.resolve(process.cwd(), "data", "processed", "evaluation", "benchmark.json");

type Args = {
  limit?: number;
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

function loadBenchmark(): BenchmarkCase[] {
  if (!fs.existsSync(BENCHMARK_PATH)) {
    throw new Error("Missing benchmark dataset. Run build:benchmark first.");
  }

  return JSON.parse(fs.readFileSync(BENCHMARK_PATH, "utf8")) as BenchmarkCase[];
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
  const benchmark = loadBenchmark();
  const cases = args.limit ? benchmark.slice(0, args.limit) : benchmark;

  let componentCorrect = 0;
  let duplicateCorrect = 0;
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
  const failures: EvaluationReport["failures"] = [];

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
    const isBroadPrCase = expectedFiles.length > 10;

    if (predictedComponent === benchmarkCase.expected.component) {
      componentCorrect += 1;
    }

    if (Number(recommendation.possible_duplicate.issue_number) === benchmarkCase.issue_number) {
      duplicateCorrect += 1;
    }

    if (top3Components.includes(benchmarkCase.expected.component) || predictedComponent === benchmarkCase.expected.component) {
      componentTop3Correct += 1;
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
    }

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
      focusedFileRecallAt5 === 0 ||
      Number(recommendation.possible_duplicate.issue_number) !== benchmarkCase.issue_number
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

  const report: EvaluationReport = {
    evaluated_cases: cases.length,
    component_accuracy: Number((componentCorrect / cases.length).toFixed(3)),
    duplicate_top1_accuracy: Number((duplicateCorrect / cases.length).toFixed(3)),
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
    failures
  };

  logInfo("Recommendation evaluation complete", report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
