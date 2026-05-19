import fs from "node:fs";
import path from "node:path";
import { loadSemanticEnv } from "../config/env.js";
import {
  createEmbeddingProvider,
  getRichSemanticIndexFilePath,
  saveRichSemanticIndex,
} from "../lib/embeddings.js";
import { logInfo } from "../lib/logger.js";
import { getPatchHunkQuality, getPathQuality } from "../lib/pathQuality.js";
import type {
  RichDataset,
  RichSemanticIndex,
  RichSemanticRecord,
  SemanticRecordType,
} from "../lib/types.js";

const RICH_DATASET_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "normalized",
  "richDataset.json",
);
const HOLDOUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "processed",
  "evaluation",
  "holdout.json",
);
const BATCH_SIZE = Number(process.env.RICH_SEMANTIC_BATCH_SIZE || 50);
const TEXT_LIMIT = Number(process.env.RICH_SEMANTIC_TEXT_LIMIT || 12000);

type PendingSemanticRecord = Omit<RichSemanticRecord, "vector">;

type Args = {
  holdout: "train" | null;
};

function parseArgs(argv: string[]): Args {
  let holdout: "train" | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--holdout" && argv[index + 1]) {
      const value = argv[index + 1];

      if (value !== "train") {
        throw new Error("--holdout currently supports only 'train'");
      }

      holdout = value;
      index += 1;
    }
  }

  return { holdout };
}

function loadRichDataset(): RichDataset {
  if (!fs.existsSync(RICH_DATASET_PATH)) {
    throw new Error("Missing rich dataset. Run normalize:rich first.");
  }

  return JSON.parse(fs.readFileSync(RICH_DATASET_PATH, "utf8")) as RichDataset;
}

function loadTrainIssueNumbers(): Set<number> {
  if (!fs.existsSync(HOLDOUT_PATH)) {
    throw new Error("Missing holdout split. Run build:holdout first.");
  }

  const split = JSON.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as {
    train_issue_numbers: number[];
  };
  return new Set(split.train_issue_numbers);
}

function compactText(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim() || "")
    .filter((part) => part.length > 0)
    .join("\n\n")
    .slice(0, TEXT_LIMIT);
}

function labelsText(labels: Array<{ name: string }>): string {
  return labels.map((label) => label.name).join(" ");
}

function makeRecord(
  record: Omit<PendingSemanticRecord, "metadata"> & {
    metadata?: PendingSemanticRecord["metadata"];
  },
): PendingSemanticRecord {
  return {
    ...record,
    metadata: record.metadata || {},
  };
}

function buildPendingRecords(
  dataset: RichDataset,
  allowedIssueNumbers: Set<number> | null,
): PendingSemanticRecord[] {
  const records: PendingSemanticRecord[] = [];

  for (const richIssue of dataset.issues) {
    const issue = richIssue.issue;

    if (allowedIssueNumbers && !allowedIssueNumbers.has(issue.number)) {
      continue;
    }

    const labels = issue.labels
      .map((label) => label.name)
      .sort((a, b) => a.localeCompare(b));

    records.push(
      makeRecord({
        id: `issue:${issue.number}`,
        type: "issue",
        issueNumber: issue.number,
        title: issue.title,
        url: issue.html_url,
        labels,
        text: compactText([
          `Issue #${issue.number}: ${issue.title}`,
          `Labels: ${labelsText(issue.labels)}`,
          issue.body,
          richIssue.comments.length > 0
            ? `Comment excerpts:\n${richIssue.comments
                .slice(0, 5)
                .map((comment) => comment.body || "")
                .join("\n\n")}`
            : null,
        ]),
        metadata: {
          state: issue.state,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
          commentCount: richIssue.comments.length,
          timelineEventCount: richIssue.timelineEvents.length,
        },
      }),
    );

    for (const comment of richIssue.comments) {
      records.push(
        makeRecord({
          id: `issue-comment:${comment.id}`,
          type: "issue_comment",
          issueNumber: issue.number,
          url: comment.html_url,
          text: compactText([
            `Issue #${issue.number}: ${issue.title}`,
            comment.body,
          ]),
          metadata: {
            commentId: comment.id,
            authorLogin: comment.user?.login || null,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
          },
        }),
      );
    }
  }

  for (const record of dataset.pullRequests) {
    const pullRequest = record.pullRequest;
    const linkedIssueNumbers = allowedIssueNumbers
      ? record.linkedIssueNumbers.filter((issueNumber) =>
          allowedIssueNumbers.has(issueNumber),
        )
      : record.linkedIssueNumbers;

    if (allowedIssueNumbers && linkedIssueNumbers.length === 0) {
      continue;
    }

    records.push(
      makeRecord({
        id: `pull-request:${pullRequest.number}`,
        type: "pull_request",
        pullRequestNumber: pullRequest.number,
        title: pullRequest.title,
        url: pullRequest.html_url,
        text: compactText([
          `Pull Request #${pullRequest.number}: ${pullRequest.title}`,
          pullRequest.body,
          `Linked issues: ${linkedIssueNumbers.join(", ")}`,
          `Changed files:\n${record.files.map((file) => file.filename).join("\n")}`,
          `Commit messages:\n${(record.commits || []).map((commit) => commit.commit.message).join("\n\n")}`,
        ]),
        metadata: {
          state: pullRequest.state,
          mergedAt: pullRequest.merged_at || null,
          authorLogin: pullRequest.user?.login || null,
          changedFileCount: record.files.length,
          commitCount: record.commits?.length || 0,
          reviewCount: record.reviews.length,
          reviewCommentCount: record.reviewComments.length,
        },
      }),
    );

    for (const commit of record.commits || []) {
      records.push(
        makeRecord({
          id: `commit:${commit.sha}`,
          type: "commit",
          pullRequestNumber: pullRequest.number,
          commitSha: commit.sha,
          url: commit.html_url,
          text: compactText([
            `Commit ${commit.sha} in PR #${pullRequest.number}: ${pullRequest.title}`,
            commit.commit.message,
          ]),
          metadata: {
            sha: commit.sha,
          },
        }),
      );
    }

    for (const review of record.reviews) {
      records.push(
        makeRecord({
          id: `review:${review.id}`,
          type: "review",
          pullRequestNumber: pullRequest.number,
          url: review.html_url,
          text: compactText([
            `Review on PR #${pullRequest.number}: ${pullRequest.title}`,
            review.body,
          ]),
          metadata: {
            reviewId: review.id,
            state: review.state,
            authorLogin: review.user?.login || null,
            submittedAt: review.submitted_at,
          },
        }),
      );
    }

    for (const comment of record.reviewComments) {
      const quality = getPathQuality(comment.path);

      if (!quality.includeInSemanticIndex) {
        continue;
      }

      records.push(
        makeRecord({
          id: `review-comment:${comment.id}`,
          type: "review_comment",
          pullRequestNumber: pullRequest.number,
          filePath: comment.path,
          url: comment.html_url,
          text: compactText([
            `Review comment on PR #${pullRequest.number}: ${pullRequest.title}`,
            `File: ${comment.path}`,
            comment.body,
            comment.diff_hunk,
          ]),
          metadata: {
            reviewCommentId: comment.id,
            reviewId: comment.pull_request_review_id,
            authorLogin: comment.user?.login || null,
            line: comment.line || null,
            originalLine: comment.original_line || null,
            startLine: comment.start_line || null,
            originalStartLine: comment.original_start_line || null,
            createdAt: comment.created_at,
            updatedAt: comment.updated_at,
            pathQualityCategory: quality.category,
            pathQualityScore: quality.score,
          },
        }),
      );
    }

    for (const hunk of record.patchHunks) {
      const quality = getPatchHunkQuality(hunk.filePath, hunk.patchText);

      if (!quality.includeInSemanticIndex) {
        continue;
      }

      records.push(
        makeRecord({
          id: `patch-hunk:${hunk.pullRequestNumber}:${hunk.filePath}:${hunk.oldStartLine}:${hunk.newStartLine}`,
          type: "patch_hunk",
          pullRequestNumber: pullRequest.number,
          filePath: hunk.filePath,
          text: compactText([
            `Patch hunk in PR #${pullRequest.number}: ${pullRequest.title}`,
            `File: ${hunk.filePath}`,
            hunk.patchText,
          ]),
          metadata: {
            oldStartLine: hunk.oldStartLine,
            oldLineCount: hunk.oldLineCount,
            newStartLine: hunk.newStartLine,
            newLineCount: hunk.newLineCount,
            pathQualityCategory: quality.category,
            pathQualityScore: quality.score,
          },
        }),
      );
    }
  }

  return records.filter((record) => record.text.trim().length > 0);
}

function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    chunks.push(items.slice(index, index + batchSize));
  }

  return chunks;
}

function countByType(
  records: Array<{ type: SemanticRecordType }>,
): Record<string, number> {
  return records.reduce<Record<string, number>>((counts, record) => {
    counts[record.type] = (counts[record.type] || 0) + 1;
    return counts;
  }, {});
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadSemanticEnv();
  const dataset = loadRichDataset();
  const allowedIssueNumbers = args.holdout ? loadTrainIssueNumbers() : null;
  const provider = createEmbeddingProvider();
  const pendingRecords = buildPendingRecords(dataset, allowedIssueNumbers);
  const batches = chunkArray(pendingRecords, BATCH_SIZE);
  const records: RichSemanticRecord[] = [];

  logInfo("Starting rich semantic index build", {
    sourcePath: RICH_DATASET_PATH,
    outputPath: getRichSemanticIndexFilePath(),
    provider: env.EMBEDDING_PROVIDER,
    dimension: env.EMBEDDING_DIMENSION,
    recordCount: pendingRecords.length,
    holdoutMode: args.holdout || "full",
    countsByType: countByType(pendingRecords),
  });

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const vectors = await provider.embedBatch(
      batch.map((record) => record.text),
    );

    for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
      records.push({
        ...batch[itemIndex],
        vector: vectors[itemIndex],
      });
    }

    logInfo("Created rich semantic index batch", {
      batchNumber: index + 1,
      batchCount: batches.length,
      batchSize: batch.length,
      completedRecordCount: records.length,
    });
  }

  const index: RichSemanticIndex = {
    metadata: {
      provider: env.EMBEDDING_PROVIDER,
      dimension: env.EMBEDDING_DIMENSION,
      generatedAt: new Date().toISOString(),
      sourcePath: RICH_DATASET_PATH,
      recordCount: records.length,
      countsByType: countByType(records),
    },
    records,
  };

  saveRichSemanticIndex(index);

  logInfo("Rich semantic index created", {
    outputPath: getRichSemanticIndexFilePath(),
    ...index.metadata,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
