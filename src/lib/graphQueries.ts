import neo4j from "neo4j-driver";
import { createNeo4jClient } from "./neo4j.js";
import type { IssueSummary, QueryIssueResult } from "./types.js";

type EvidenceRow = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  issueState: string;
  labels: string[];
  assignees: string[];
  pullRequestNumber: number | null;
  pullRequestTitle: string | null;
  pullRequestUrl: string | null;
  filePath: string | null;
  componentName: string | null;
  authors: string[];
};

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && value !== null && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  throw new Error("Unable to convert Neo4j numeric value");
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    )
    .sort((a, b) => a.localeCompare(b));
}

export async function fetchIssueEvidence(
  issueNumber: number,
): Promise<QueryIssueResult | null> {
  const neo4jClient = createNeo4jClient();
  const session = neo4jClient.getSession();

  try {
    await neo4jClient.verifyConnection();

    const result = await session.run(
      `
        MATCH (issue:Issue {number: $issueNumber})
        OPTIONAL MATCH (issue)-[:HAS_LABEL]->(label:Label)
        OPTIONAL MATCH (issue)-[:ASSIGNED_TO]->(assignee:Developer)
        OPTIONAL MATCH (issue)-[:FIXED_BY]->(pr:PullRequest)
        OPTIONAL MATCH (pr)-[:AUTHORED_BY]->(author:Developer)
        OPTIONAL MATCH (pr)-[:CHANGES]->(file:File)
        OPTIONAL MATCH (file)-[:BELONGS_TO]->(component:Component)
        RETURN issue.number AS issueNumber,
               issue.title AS issueTitle,
               issue.url AS issueUrl,
               issue.state AS issueState,
               collect(DISTINCT label.name) AS labels,
               collect(DISTINCT assignee.login) AS assignees,
               pr.number AS pullRequestNumber,
               pr.title AS pullRequestTitle,
               pr.url AS pullRequestUrl,
               file.path AS filePath,
               component.name AS componentName,
               collect(DISTINCT author.login) AS authors
        ORDER BY pullRequestNumber ASC, filePath ASC
      `,
      { issueNumber },
    );

    if (result.records.length === 0) {
      return null;
    }

    const rows: EvidenceRow[] = result.records.map((record) => ({
      issueNumber: toNumber(record.get("issueNumber")),
      issueTitle: String(record.get("issueTitle")),
      issueUrl: String(record.get("issueUrl")),
      issueState: String(record.get("issueState")),
      labels: getStringArray(record.get("labels")),
      assignees: getStringArray(record.get("assignees")),
      pullRequestNumber:
        record.get("pullRequestNumber") === null
          ? null
          : toNumber(record.get("pullRequestNumber")),
      pullRequestTitle:
        record.get("pullRequestTitle") === null
          ? null
          : String(record.get("pullRequestTitle")),
      pullRequestUrl:
        record.get("pullRequestUrl") === null
          ? null
          : String(record.get("pullRequestUrl")),
      filePath:
        record.get("filePath") === null ? null : String(record.get("filePath")),
      componentName:
        record.get("componentName") === null
          ? null
          : String(record.get("componentName")),
      authors: getStringArray(record.get("authors")),
    }));

    const issue: IssueSummary = {
      number: rows[0].issueNumber,
      title: rows[0].issueTitle,
      url: rows[0].issueUrl,
      state: rows[0].issueState,
      labels: rows[0].labels,
      assignees: rows[0].assignees,
    };

    const pullRequestMap = new Map<
      number,
      {
        number: number;
        title: string;
        url: string;
        authors: string[];
        changedFiles: Array<{ path: string; component: string }>;
      }
    >();
    const fileMap = new Map<
      string,
      { path: string; component: string; linkedPullRequests: number[] }
    >();
    const evidencePaths: string[][] = [];

    for (const row of rows) {
      if (
        row.pullRequestNumber === null ||
        row.pullRequestTitle === null ||
        row.pullRequestUrl === null
      ) {
        continue;
      }

      if (!pullRequestMap.has(row.pullRequestNumber)) {
        pullRequestMap.set(row.pullRequestNumber, {
          number: row.pullRequestNumber,
          title: row.pullRequestTitle,
          url: row.pullRequestUrl,
          authors: row.authors,
          changedFiles: [],
        });
      }

      if (row.filePath && row.componentName) {
        const pullRequest = pullRequestMap.get(row.pullRequestNumber);

        if (
          pullRequest &&
          !pullRequest.changedFiles.some((file) => file.path === row.filePath)
        ) {
          pullRequest.changedFiles.push({
            path: row.filePath,
            component: row.componentName,
          });
        }

        const existingFile = fileMap.get(row.filePath);

        if (!existingFile) {
          fileMap.set(row.filePath, {
            path: row.filePath,
            component: row.componentName,
            linkedPullRequests: [row.pullRequestNumber],
          });
        } else if (
          !existingFile.linkedPullRequests.includes(row.pullRequestNumber)
        ) {
          existingFile.linkedPullRequests.push(row.pullRequestNumber);
        }

        evidencePaths.push([
          `Issue #${row.issueNumber}: ${row.issueTitle}`,
          `FIXED_BY PR #${row.pullRequestNumber}: ${row.pullRequestTitle}`,
          `CHANGES ${row.filePath}`,
          `BELONGS_TO ${row.componentName}`,
        ]);
      }
    }

    return {
      issue,
      linkedPullRequests: Array.from(pullRequestMap.values()).sort(
        (a, b) => a.number - b.number,
      ),
      likelyFiles: Array.from(fileMap.values()).sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
      evidencePaths,
    };
  } finally {
    await session.close();
    await neo4jClient.close();
  }
}

export async function searchIssuesByTitle(
  queryText: string,
  limit: number,
): Promise<number[]> {
  const neo4jClient = createNeo4jClient();
  const session = neo4jClient.getSession();

  try {
    await neo4jClient.verifyConnection();

    const tokens = Array.from(
      new Set(
        queryText
          .toLowerCase()
          .split(/\s+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 3),
      ),
    );

    if (tokens.length === 0) {
      return [];
    }

    const result = await session.run(
      `
        WITH $tokens AS tokens
        MATCH (issue:Issue)
        WHERE EXISTS { (issue)-[:FIXED_BY]->(:PullRequest) }
        WITH issue,
             reduce(score = 0, token IN tokens |
               score +
               CASE WHEN toLower(issue.title) CONTAINS token THEN 3 ELSE 0 END +
               CASE WHEN toLower(coalesce(issue.body, "")) CONTAINS token THEN 1 ELSE 0 END
             ) AS score
        WHERE score > 0
        RETURN issue.number AS issueNumber
        ORDER BY score DESC, issue.updatedAt DESC
        LIMIT $limit
      `,
      { tokens, limit: neo4j.int(limit) },
    );

    return result.records.map((record) => toNumber(record.get("issueNumber")));
  } finally {
    await session.close();
    await neo4jClient.close();
  }
}
