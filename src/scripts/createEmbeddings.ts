import fs from "node:fs";
import path from "node:path";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import {
  createEmbeddingProvider,
  buildIssueEmbeddingText,
  getEmbeddingsFilePath,
  saveEmbeddingIndex
} from "../lib/embeddings.js";
import { logInfo } from "../lib/logger.js";
import type { GitHubIssue, HoldoutSplit, IssueEmbeddingRecord } from "../lib/types.js";

const ISSUES_PATH = path.resolve(process.cwd(), "data", "raw", "issues", "issues.json");
const HOLDOUT_PATH = path.resolve(process.cwd(), "data", "processed", "evaluation", "holdout.json");
const BATCH_SIZE = 50;
const CHECKPOINT_NAME = "createEmbeddings";

type EmbeddingCheckpoint = {
  completedIssueNumbers: number[];
  recordCount: number;
};

type CreateEmbeddingsArgs = {
  reset: boolean;
  holdout: "train" | null;
};

function parseArgs(argv: string[]): CreateEmbeddingsArgs {
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

  return {
    reset: argv.includes("--reset"),
    holdout
  };
}

function loadIssues(): GitHubIssue[] {
  if (!fs.existsSync(ISSUES_PATH)) {
    throw new Error("Missing issue dataset. Run fetch:issues first.");
  }

  return JSON.parse(fs.readFileSync(ISSUES_PATH, "utf8")) as GitHubIssue[];
}

function loadHoldoutSplit(): HoldoutSplit {
  if (!fs.existsSync(HOLDOUT_PATH)) {
    throw new Error("Missing holdout split. Run build:holdout first.");
  }

  return JSON.parse(fs.readFileSync(HOLDOUT_PATH, "utf8")) as HoldoutSplit;
}

function loadExistingIndex(): IssueEmbeddingRecord[] {
  const outputPath = getEmbeddingsFilePath();

  if (!fs.existsSync(outputPath)) {
    return [];
  }

  return JSON.parse(fs.readFileSync(outputPath, "utf8")) as IssueEmbeddingRecord[];
}

function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    chunks.push(items.slice(index, index + batchSize));
  }

  return chunks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const holdoutSplit = args.holdout ? loadHoldoutSplit() : null;
  const allowedIssueNumbers = holdoutSplit ? new Set(holdoutSplit.train_issue_numbers) : null;
  const issues = loadIssues().filter((issue) => (allowedIssueNumbers ? allowedIssueNumbers.has(issue.number) : true));
  const provider = createEmbeddingProvider();
  const checkpointName = args.holdout ? `${CHECKPOINT_NAME}.${args.holdout}` : CHECKPOINT_NAME;
  const checkpoint = args.reset ? null : loadCheckpoint<EmbeddingCheckpoint>(checkpointName);
  const existingRecords = args.reset ? [] : loadExistingIndex();
  const recordMap = new Map<number, IssueEmbeddingRecord>(
    existingRecords
      .filter((record) => (allowedIssueNumbers ? allowedIssueNumbers.has(record.issueNumber) : true))
      .map((record) => [record.issueNumber, record])
  );
  const completedIssueNumbers = new Set<number>(
    checkpoint?.completedIssueNumbers ||
      Array.from(recordMap.values()).map((record) => record.issueNumber)
  );
  const remainingIssues = issues.filter((issue) => !completedIssueNumbers.has(issue.number));
  const batches = chunkArray(remainingIssues, BATCH_SIZE);

  logInfo("Starting embedding build", {
    reset: args.reset,
    holdoutMode: args.holdout || "full",
    totalIssues: issues.length,
    alreadyCompleted: completedIssueNumbers.size,
    remainingIssues: remainingIssues.length
  });

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const texts = batch.map((issue) => buildIssueEmbeddingText(issue));
    let vectors: number[][];

    try {
      vectors = await provider.embedBatch(texts);
    } catch (error) {
      saveEmbeddingIndex(Array.from(recordMap.values()).sort((a, b) => a.issueNumber - b.issueNumber));
      saveCheckpoint(checkpointName, {
        completedIssueNumbers: Array.from(completedIssueNumbers.values()).sort((a, b) => a - b),
        recordCount: recordMap.size
      });
      throw error;
    }

    for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
      const issue = batch[itemIndex];
      recordMap.set(issue.number, {
        issueNumber: issue.number,
        title: issue.title,
        url: issue.html_url,
        labels: issue.labels.map((label) => label.name).sort((a, b) => a.localeCompare(b)),
        text: texts[itemIndex],
        vector: vectors[itemIndex]
      });
      completedIssueNumbers.add(issue.number);
    }

    saveEmbeddingIndex(Array.from(recordMap.values()).sort((a, b) => a.issueNumber - b.issueNumber));
    saveCheckpoint(checkpointName, {
      completedIssueNumbers: Array.from(completedIssueNumbers.values()).sort((a, b) => a - b),
      recordCount: recordMap.size
    });

    logInfo("Created embedding batch", {
      batchNumber: index + 1,
      batchCount: batches.length,
      batchSize: batch.length,
      completedIssueCount: completedIssueNumbers.size
    });
  }

  saveEmbeddingIndex(Array.from(recordMap.values()).sort((a, b) => a.issueNumber - b.issueNumber));

  logInfo("Embedding index created", {
    holdoutMode: args.holdout || "full",
    recordCount: recordMap.size
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
