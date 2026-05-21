import fs from "node:fs";
import path from "node:path";
import { buildResolutionGroundTruth } from "../lib/resolutionEvaluation.js";
import { classifyIssueResolution, type ResolutionType } from "../lib/resolutionType.js";
import { logInfo } from "../lib/logger.js";
import type { BenchmarkCase, HoldoutSplit, RichDataset } from "../lib/types.js";

const HOLDOUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "holdout.json",
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
  "resolutionClassifierEvaluation.json",
);

const RESOLUTION_TYPES: ResolutionType[] = [
  "existing_bug",
  "new_feature",
  "enhancement",
  "enhancement_with_new_files",
  "refactor",
  "docs",
  "config",
  "test",
  "unknown",
];

type Args = {
  limit?: number;
};

type ClassMetrics = {
  precision: number;
  recall: number;
  true_positive: number;
  false_positive: number;
  false_negative: number;
  support: number;
};

type EvaluationRow = {
  issue_number: number;
  title: string;
  actual_resolution_type: ResolutionType;
  predicted_resolution_type: ResolutionType;
  actual_created_files: boolean;
  predicted_requires_new_files: boolean;
  new_file_probability: number;
  confidence: number;
  evidence_terms: string[];
  created_files: string[];
};

type ResolutionClassifierReport = {
  dataset: {
    evaluated_cases: number;
    train_issue_count: number;
    test_issue_count: number;
  };
  metrics: {
    accuracy: number;
    requires_new_files_precision: number;
    requires_new_files_recall: number;
    requires_new_files_accuracy: number;
    new_feature_precision: number;
    new_feature_recall: number;
    enhancement_precision: number;
    enhancement_recall: number;
    existing_bug_precision: number;
    existing_bug_recall: number;
  };
  per_class: Record<string, ClassMetrics>;
  confusion_matrix: Record<string, Record<string, number>>;
  rows: EvaluationRow[];
  likely_misclassified_examples: EvaluationRow[];
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

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

function emptyConfusionMatrix(): Record<string, Record<string, number>> {
  return Object.fromEntries(
    RESOLUTION_TYPES.map((actual) => [
      actual,
      Object.fromEntries(RESOLUTION_TYPES.map((predicted) => [predicted, 0])),
    ]),
  );
}

function classMetrics(
  rows: EvaluationRow[],
  resolutionType: ResolutionType,
): ClassMetrics {
  const truePositive = rows.filter(
    (row) =>
      row.actual_resolution_type === resolutionType &&
      row.predicted_resolution_type === resolutionType,
  ).length;
  const falsePositive = rows.filter(
    (row) =>
      row.actual_resolution_type !== resolutionType &&
      row.predicted_resolution_type === resolutionType,
  ).length;
  const falseNegative = rows.filter(
    (row) =>
      row.actual_resolution_type === resolutionType &&
      row.predicted_resolution_type !== resolutionType,
  ).length;
  const support = rows.filter(
    (row) => row.actual_resolution_type === resolutionType,
  ).length;

  return {
    precision: rate(truePositive, truePositive + falsePositive),
    recall: rate(truePositive, truePositive + falseNegative),
    true_positive: truePositive,
    false_positive: falsePositive,
    false_negative: falseNegative,
    support,
  };
}

function saveReport(report: ResolutionClassifierReport): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const holdout = loadJsonFile<HoldoutSplit>(
    HOLDOUT_PATH,
    "Missing holdout split. Run build:holdout first.",
  );
  const richDataset = loadJsonFile<RichDataset>(
    RICH_DATASET_PATH,
    "Missing rich dataset. Run normalize:rich first.",
  );
  const cases: BenchmarkCase[] = args.limit
    ? holdout.test_cases.slice(0, args.limit)
    : holdout.test_cases;
  const groundTruth = buildResolutionGroundTruth(cases, richDataset);
  const rows = cases.map<EvaluationRow>((benchmarkCase) => {
    const prediction = classifyIssueResolution({
      title: benchmarkCase.title,
      body: benchmarkCase.body,
      labels: benchmarkCase.labels,
    });
    const actual = groundTruth.get(benchmarkCase.issue_number);

    if (!actual) {
      throw new Error(
        `Missing resolution ground truth for issue #${benchmarkCase.issue_number}`,
      );
    }

    return {
      issue_number: benchmarkCase.issue_number,
      title: benchmarkCase.title,
      actual_resolution_type: actual.actual_resolution_type,
      predicted_resolution_type: prediction.resolution_type,
      actual_created_files: actual.actual_created_files,
      predicted_requires_new_files: prediction.requires_new_files,
      new_file_probability: prediction.new_file_probability,
      confidence: prediction.confidence,
      evidence_terms: prediction.evidence_terms,
      created_files: actual.created_files,
    };
  });
  const confusionMatrix = emptyConfusionMatrix();

  for (const row of rows) {
    confusionMatrix[row.actual_resolution_type][row.predicted_resolution_type] += 1;
  }

  const perClass = Object.fromEntries(
    RESOLUTION_TYPES.map((resolutionType) => [
      resolutionType,
      classMetrics(rows, resolutionType),
    ]),
  );
  const correct = rows.filter(
    (row) => row.actual_resolution_type === row.predicted_resolution_type,
  ).length;
  const newFileTruePositive = rows.filter(
    (row) => row.actual_created_files && row.predicted_requires_new_files,
  ).length;
  const newFilePredicted = rows.filter(
    (row) => row.predicted_requires_new_files,
  ).length;
  const newFileActual = rows.filter((row) => row.actual_created_files).length;
  const report: ResolutionClassifierReport = {
    dataset: {
      evaluated_cases: rows.length,
      train_issue_count: holdout.metadata.train_case_count,
      test_issue_count: holdout.metadata.test_case_count,
    },
    metrics: {
      accuracy: rate(correct, rows.length),
      requires_new_files_precision: rate(
        newFileTruePositive,
        newFilePredicted,
      ),
      requires_new_files_recall: rate(newFileTruePositive, newFileActual),
      requires_new_files_accuracy: rate(
        rows.filter(
          (row) =>
            row.actual_created_files === row.predicted_requires_new_files,
        ).length,
        rows.length,
      ),
      new_feature_precision: perClass.new_feature.precision,
      new_feature_recall: perClass.new_feature.recall,
      enhancement_precision: perClass.enhancement.precision,
      enhancement_recall: perClass.enhancement.recall,
      existing_bug_precision: perClass.existing_bug.precision,
      existing_bug_recall: perClass.existing_bug.recall,
    },
    per_class: perClass,
    confusion_matrix: confusionMatrix,
    rows,
    likely_misclassified_examples: rows
      .filter((row) => row.actual_resolution_type !== row.predicted_resolution_type)
      .slice(0, 25),
  };

  saveReport(report);
  logInfo("Resolution classifier evaluation complete", {
    outputPath: OUTPUT_PATH,
    metrics: report.metrics,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
