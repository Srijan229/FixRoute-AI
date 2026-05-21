import { getPathQuality } from "./pathQuality.js";
import { classifyIssueResolution, type ResolutionType } from "./resolutionType.js";
import type { BenchmarkCase, RichDataset, RichPullRequestRecord } from "./types.js";

export type ResolutionGroundTruth = {
  issue_number: number;
  actual_resolution_type: ResolutionType;
  actual_created_files: boolean;
  actual_only_docs_config_or_test: boolean;
  created_files: string[];
  modified_files: string[];
  changed_file_count: number;
};

function compactList(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function textForCase(
  benchmarkCase: BenchmarkCase,
  pullRequests: RichPullRequestRecord[],
): string {
  return [
    benchmarkCase.title,
    benchmarkCase.body,
    benchmarkCase.labels.join(" "),
    ...pullRequests.map((record) => record.pullRequest.title),
    ...pullRequests.map((record) => record.pullRequest.body || ""),
    ...pullRequests.flatMap((record) =>
      (record.commits || []).map((commit) => commit.commit.message),
    ),
  ]
    .join("\n")
    .toLowerCase();
}

function isCategoryOnly(files: string[], categories: string[]): boolean {
  return (
    files.length > 0 &&
    files.every((filePath) => categories.includes(getPathQuality(filePath).category))
  );
}

function inferActualResolutionType(input: {
  benchmarkCase: BenchmarkCase;
  pullRequests: RichPullRequestRecord[];
  createdFiles: string[];
  modifiedFiles: string[];
  changedFiles: string[];
}): ResolutionType {
  const text = textForCase(input.benchmarkCase, input.pullRequests);
  const classifier = classifyIssueResolution({
    title: input.benchmarkCase.title,
    body: input.benchmarkCase.body,
    labels: input.benchmarkCase.labels,
  });

  if (isCategoryOnly(input.changedFiles, ["docs"])) {
    return "docs";
  }

  if (isCategoryOnly(input.changedFiles, ["config"])) {
    return "config";
  }

  if (isCategoryOnly(input.changedFiles, ["test"])) {
    return "test";
  }

  if (/\b(refactor|cleanup|rename|move|restructure)\b/.test(text)) {
    return "refactor";
  }

  if (input.createdFiles.length > 0) {
    if (
      /\b(add|new|feature request|introduce|implement|support|no way to|missing)\b/.test(
        text,
      ) &&
      !/\b(existing|already|current|improve|extend|include|additional)\b/.test(text)
    ) {
      return "new_feature";
    }

    return "enhancement_with_new_files";
  }

  if (
    classifier.resolution_type === "enhancement" ||
    /\b(improve|extend|allow|include|additional|make it possible|option)\b/.test(
      text,
    )
  ) {
    return "enhancement";
  }

  if (
    classifier.resolution_type === "new_feature" &&
    /\b(feature request|add support|new feature|no way to|missing capability)\b/.test(
      text,
    )
  ) {
    return "new_feature";
  }

  if (
    /\b(bug|fix|crash|broken|regression|expected|actual|error|fails|unable|cannot)\b/.test(
      text,
    )
  ) {
    return "existing_bug";
  }

  return "unknown";
}

export function buildResolutionGroundTruth(
  cases: BenchmarkCase[],
  dataset: RichDataset,
): Map<number, ResolutionGroundTruth> {
  const pullRequestsByIssue = new Map<number, RichPullRequestRecord[]>();

  for (const record of dataset.pullRequests) {
    for (const issueNumber of record.linkedIssueNumbers) {
      const current = pullRequestsByIssue.get(issueNumber) || [];
      current.push(record);
      pullRequestsByIssue.set(issueNumber, current);
    }
  }

  const output = new Map<number, ResolutionGroundTruth>();

  for (const benchmarkCase of cases) {
    const pullRequests = pullRequestsByIssue.get(benchmarkCase.issue_number) || [];
    const files = pullRequests.flatMap((record) => record.files);
    const createdFiles = compactList(
      files
        .filter((file) => file.status === "added")
        .map((file) => file.filename),
    );
    const modifiedFiles = compactList(
      files
        .filter((file) => file.status === "modified")
        .map((file) => file.filename),
    );
    const changedFiles = compactList(files.map((file) => file.filename));
    const actualResolutionType = inferActualResolutionType({
      benchmarkCase,
      pullRequests,
      createdFiles,
      modifiedFiles,
      changedFiles,
    });

    output.set(benchmarkCase.issue_number, {
      issue_number: benchmarkCase.issue_number,
      actual_resolution_type: actualResolutionType,
      actual_created_files: createdFiles.length > 0,
      actual_only_docs_config_or_test: isCategoryOnly(changedFiles, [
        "docs",
        "config",
        "test",
      ]),
      created_files: createdFiles,
      modified_files: modifiedFiles,
      changed_file_count: changedFiles.length,
    });
  }

  return output;
}
