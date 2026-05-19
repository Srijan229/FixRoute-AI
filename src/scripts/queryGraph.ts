import {
  fetchIssueEvidence,
  searchIssuesByTitle,
} from "../lib/graphQueries.js";
import type { QueryIssueResult } from "../lib/types.js";

type QueryArgs = {
  issueNumber?: number;
  title?: string;
  limit: number;
};

function parseArgs(argv: string[]): QueryArgs {
  const args: QueryArgs = { limit: 5 };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--issue-number" && next) {
      args.issueNumber = Number(next);
      index += 1;
      continue;
    }

    if (current === "--title" && next) {
      args.title = next.trim();
      index += 1;
      continue;
    }

    if (current === "--limit" && next) {
      args.limit = Number(next);
      index += 1;
    }
  }

  if (!args.issueNumber && !args.title) {
    throw new Error("Provide either --issue-number <number> or --title <text>");
  }

  if (args.issueNumber && !Number.isFinite(args.issueNumber)) {
    throw new Error("--issue-number must be a number");
  }

  if (!Number.isFinite(args.limit) || args.limit <= 0) {
    throw new Error("--limit must be a positive number");
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.issueNumber) {
    const result = await fetchIssueEvidence(args.issueNumber);

    if (!result) {
      console.log(
        JSON.stringify(
          { message: `Issue #${args.issueNumber} not found in graph` },
          null,
          2,
        ),
      );
      return;
    }

    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const issueNumbers = await searchIssuesByTitle(args.title!, args.limit);
  const results = await Promise.all(
    issueNumbers.map((issueNumber) => fetchIssueEvidence(issueNumber)),
  );

  console.log(
    JSON.stringify(
      {
        query: args.title,
        matchCount: results.filter((result) => result !== null).length,
        matches: results.filter(
          (result): result is QueryIssueResult => result !== null,
        ),
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
