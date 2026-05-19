import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import { createGitHubClient } from "../lib/github.js";
import { logInfo } from "../lib/logger.js";
import type {
  GitHubPullRequestReviewComment,
  LinkedPullRequestRecord,
  PullRequestReviewCommentRecord,
} from "../lib/types.js";

type PullRequestReviewCommentsCheckpoint = {
  pullRequestIndex: number;
};

const PULL_REQUESTS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequests",
  "linkedPullRequests.json",
);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequestReviewComments",
  "pullRequestReviewComments.json",
);
const CHECKPOINT_NAME = "fetchPullRequestReviewComments";
const PER_PAGE = 100;
const PULL_REQUEST_LIMIT = Number(
  process.env.PULL_REQUEST_REVIEW_COMMENTS_FETCH_LIMIT || 0,
);
const SAVE_INTERVAL = 25;

function loadLinkedPullRequests(): LinkedPullRequestRecord[] {
  if (!fs.existsSync(PULL_REQUESTS_PATH)) {
    throw new Error("Missing pull request dataset. Run fetch:prs first.");
  }

  return JSON.parse(
    fs.readFileSync(PULL_REQUESTS_PATH, "utf8"),
  ) as LinkedPullRequestRecord[];
}

function loadExistingRecords(): PullRequestReviewCommentRecord[] {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return [];
  }

  return JSON.parse(
    fs.readFileSync(OUTPUT_PATH, "utf8"),
  ) as PullRequestReviewCommentRecord[];
}

function saveRecords(records: PullRequestReviewCommentRecord[]): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2), "utf8");
}

async function fetchAllReviewComments(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  pullRequestNumber: number,
): Promise<GitHubPullRequestReviewComment[]> {
  const reviewComments: GitHubPullRequestReviewComment[] = [];
  let page = 1;

  while (true) {
    const pageReviewComments = await github.get<
      GitHubPullRequestReviewComment[]
    >(`/repos/${owner}/${repo}/pulls/${pullRequestNumber}/comments`, {
      query: {
        per_page: PER_PAGE,
        page,
      },
    });

    if (pageReviewComments.length === 0) {
      break;
    }

    reviewComments.push(...pageReviewComments);

    if (pageReviewComments.length < PER_PAGE) {
      break;
    }

    page += 1;
  }

  return reviewComments;
}

async function main() {
  const env = loadGitHubEnv();
  const github = createGitHubClient();
  const linkedPullRequests = loadLinkedPullRequests();
  const existingRecords = loadExistingRecords();
  const checkpoint = loadCheckpoint<PullRequestReviewCommentsCheckpoint>(
    CHECKPOINT_NAME,
  ) ?? {
    pullRequestIndex: 0,
  };
  const recordMap = new Map<number, PullRequestReviewCommentRecord>(
    existingRecords.map((record) => [record.pullRequestNumber, record]),
  );
  const stopIndex =
    PULL_REQUEST_LIMIT > 0
      ? Math.min(
          linkedPullRequests.length,
          checkpoint.pullRequestIndex + PULL_REQUEST_LIMIT,
        )
      : linkedPullRequests.length;
  let pullRequestIndex = checkpoint.pullRequestIndex;

  logInfo("Starting pull request review comments fetch", {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    pullRequestCount: linkedPullRequests.length,
    startingPullRequestIndex: pullRequestIndex,
    stopIndex,
    existingRecords: recordMap.size,
  });

  while (pullRequestIndex < stopIndex) {
    const pullRequestNumber =
      linkedPullRequests[pullRequestIndex].pullRequest.number;

    if (!recordMap.has(pullRequestNumber)) {
      const reviewComments = await fetchAllReviewComments(
        github,
        env.GITHUB_OWNER,
        env.GITHUB_REPO,
        pullRequestNumber,
      );
      recordMap.set(pullRequestNumber, {
        pullRequestNumber,
        reviewComments,
      });
    }

    pullRequestIndex += 1;

    if (pullRequestIndex % SAVE_INTERVAL === 0) {
      saveRecords(
        Array.from(recordMap.values()).sort(
          (a, b) => a.pullRequestNumber - b.pullRequestNumber,
        ),
      );
      saveCheckpoint(CHECKPOINT_NAME, { pullRequestIndex });
      logInfo("Processed pull request review comments batch", {
        scannedPullRequestCount: pullRequestIndex,
        recordsStored: recordMap.size,
      });
    }
  }

  saveRecords(
    Array.from(recordMap.values()).sort(
      (a, b) => a.pullRequestNumber - b.pullRequestNumber,
    ),
  );
  saveCheckpoint(CHECKPOINT_NAME, { pullRequestIndex });

  logInfo("Pull request review comments fetch complete", {
    scannedPullRequestCount: pullRequestIndex,
    recordsStored: recordMap.size,
    outputPath: OUTPUT_PATH,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
