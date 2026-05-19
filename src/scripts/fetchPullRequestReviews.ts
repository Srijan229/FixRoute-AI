import fs from "node:fs";
import path from "node:path";
import { loadGitHubEnv } from "../config/env.js";
import { loadCheckpoint, saveCheckpoint } from "../lib/checkpoint.js";
import { createGitHubClient } from "../lib/github.js";
import { logInfo } from "../lib/logger.js";
import type {
  GitHubPullRequestReview,
  LinkedPullRequestRecord,
  PullRequestReviewRecord,
} from "../lib/types.js";

type PullRequestReviewsCheckpoint = {
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
  "pullRequestReviews",
  "pullRequestReviews.json",
);
const CHECKPOINT_NAME = "fetchPullRequestReviews";
const PER_PAGE = 100;
const PULL_REQUEST_LIMIT = Number(
  process.env.PULL_REQUEST_REVIEWS_FETCH_LIMIT || 0,
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

function loadExistingRecords(): PullRequestReviewRecord[] {
  if (!fs.existsSync(OUTPUT_PATH)) {
    return [];
  }

  return JSON.parse(
    fs.readFileSync(OUTPUT_PATH, "utf8"),
  ) as PullRequestReviewRecord[];
}

function saveRecords(records: PullRequestReviewRecord[]): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(records, null, 2), "utf8");
}

async function fetchAllReviews(
  github: ReturnType<typeof createGitHubClient>,
  owner: string,
  repo: string,
  pullRequestNumber: number,
): Promise<GitHubPullRequestReview[]> {
  const reviews: GitHubPullRequestReview[] = [];
  let page = 1;

  while (true) {
    const pageReviews = await github.get<GitHubPullRequestReview[]>(
      `/repos/${owner}/${repo}/pulls/${pullRequestNumber}/reviews`,
      {
        query: {
          per_page: PER_PAGE,
          page,
        },
      },
    );

    if (pageReviews.length === 0) {
      break;
    }

    reviews.push(...pageReviews);

    if (pageReviews.length < PER_PAGE) {
      break;
    }

    page += 1;
  }

  return reviews;
}

async function main() {
  const env = loadGitHubEnv();
  const github = createGitHubClient();
  const linkedPullRequests = loadLinkedPullRequests();
  const existingRecords = loadExistingRecords();
  const checkpoint = loadCheckpoint<PullRequestReviewsCheckpoint>(
    CHECKPOINT_NAME,
  ) ?? {
    pullRequestIndex: 0,
  };
  const recordMap = new Map<number, PullRequestReviewRecord>(
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

  logInfo("Starting pull request reviews fetch", {
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
      const reviews = await fetchAllReviews(
        github,
        env.GITHUB_OWNER,
        env.GITHUB_REPO,
        pullRequestNumber,
      );
      recordMap.set(pullRequestNumber, {
        pullRequestNumber,
        reviews,
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
      logInfo("Processed pull request reviews batch", {
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

  logInfo("Pull request reviews fetch complete", {
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
