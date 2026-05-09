import { createNeo4jClient } from "../lib/neo4j.js";
import { logInfo } from "../lib/logger.js";

type CountRow = {
  count: number;
};

type EvidencePathRow = {
  issueNumber: number;
  issueTitle: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  filePath: string;
  componentName: string;
};

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && value !== null && "toNumber" in value) {
    const maybeInteger = value as { toNumber: () => number };
    return maybeInteger.toNumber();
  }

  throw new Error("Unable to convert Neo4j numeric value");
}

async function getNodeCount(sessionQuery: (query: string) => Promise<CountRow>, label: string) {
  return sessionQuery(`MATCH (n:${label}) RETURN count(n) AS count`);
}

async function main() {
  const neo4jClient = createNeo4jClient();
  const session = neo4jClient.getSession();

  async function runCountQuery(query: string): Promise<CountRow> {
    const result = await session.run(query);
    const firstRecord = result.records[0];

    if (!firstRecord) {
      return { count: 0 };
    }

    return {
      count: toNumber(firstRecord.get("count"))
    };
  }

  try {
    await neo4jClient.verifyConnection();

    const counts = {
      issues: await getNodeCount(runCountQuery, "Issue"),
      pullRequests: await getNodeCount(runCountQuery, "PullRequest"),
      files: await getNodeCount(runCountQuery, "File"),
      components: await getNodeCount(runCountQuery, "Component"),
      labels: await getNodeCount(runCountQuery, "Label"),
      developers: await getNodeCount(runCountQuery, "Developer")
    };

    logInfo("Graph node counts", {
      issues: counts.issues.count,
      pullRequests: counts.pullRequests.count,
      files: counts.files.count,
      components: counts.components.count,
      labels: counts.labels.count,
      developers: counts.developers.count
    });

    const relationshipCountsResult = await session.run(`
      MATCH ()-[r]->()
      RETURN type(r) AS relationshipType, count(r) AS count
      ORDER BY relationshipType
    `);

    const relationshipCounts = relationshipCountsResult.records.map((record) => ({
      relationshipType: String(record.get("relationshipType")),
      count: toNumber(record.get("count"))
    }));

    logInfo("Graph relationship counts", {
      relationshipCounts
    });

    const evidencePathResult = await session.run(`
      MATCH (issue:Issue)-[:FIXED_BY]->(pr:PullRequest)-[:CHANGES]->(file:File)-[:BELONGS_TO]->(component:Component)
      RETURN issue.number AS issueNumber,
             issue.title AS issueTitle,
             pr.number AS pullRequestNumber,
             pr.title AS pullRequestTitle,
             file.path AS filePath,
             component.name AS componentName
      ORDER BY issue.number ASC, pr.number ASC, file.path ASC
      LIMIT 5
    `);

    const evidencePaths: EvidencePathRow[] = evidencePathResult.records.map((record) => ({
      issueNumber: toNumber(record.get("issueNumber")),
      issueTitle: String(record.get("issueTitle")),
      pullRequestNumber: toNumber(record.get("pullRequestNumber")),
      pullRequestTitle: String(record.get("pullRequestTitle")),
      filePath: String(record.get("filePath")),
      componentName: String(record.get("componentName"))
    }));

    logInfo("Sample evidence paths", {
      evidencePaths: evidencePaths.map((pathRow) => [
        `Issue #${pathRow.issueNumber}: ${pathRow.issueTitle}`,
        `FIXED_BY PR #${pathRow.pullRequestNumber}: ${pathRow.pullRequestTitle}`,
        `CHANGES ${pathRow.filePath}`,
        `BELONGS_TO ${pathRow.componentName}`
      ])
    });
  } finally {
    await session.close();
    await neo4jClient.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  process.exit(1);
});
