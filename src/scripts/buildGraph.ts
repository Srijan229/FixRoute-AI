import fs from "node:fs";
import path from "node:path";
import type { ManagedTransaction, Session } from "neo4j-driver";
import { createNeo4jClient } from "../lib/neo4j.js";
import { logInfo } from "../lib/logger.js";
import type { GraphDataset, GraphRelationship } from "../lib/types.js";

const GRAPH_DATA_PATH = path.resolve(process.cwd(), "data", "processed", "graph", "graphData.json");
const BATCH_SIZE = 250;

function loadGraphDataset(): GraphDataset {
  if (!fs.existsSync(GRAPH_DATA_PATH)) {
    throw new Error("Missing processed graph dataset. Run normalize:graph first.");
  }

  const rawContents = fs.readFileSync(GRAPH_DATA_PATH, "utf8");
  return JSON.parse(rawContents) as GraphDataset;
}

function chunkArray<T>(items: T[], batchSize: number): T[][];
function chunkArray<T>(items: T[], batchSize: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += batchSize) {
    chunks.push(items.slice(index, index + batchSize));
  }

  return chunks;
}

async function createConstraints(session: Session): Promise<void> {
  const statements = [
    "CREATE CONSTRAINT issue_number_unique IF NOT EXISTS FOR (n:Issue) REQUIRE n.number IS UNIQUE",
    "CREATE CONSTRAINT pr_number_unique IF NOT EXISTS FOR (n:PullRequest) REQUIRE n.number IS UNIQUE",
    "CREATE CONSTRAINT file_path_unique IF NOT EXISTS FOR (n:File) REQUIRE n.path IS UNIQUE",
    "CREATE CONSTRAINT component_name_unique IF NOT EXISTS FOR (n:Component) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT label_name_unique IF NOT EXISTS FOR (n:Label) REQUIRE n.name IS UNIQUE",
    "CREATE CONSTRAINT developer_login_unique IF NOT EXISTS FOR (n:Developer) REQUIRE n.login IS UNIQUE"
  ];

  for (const statement of statements) {
    await session.run(statement);
  }
}

async function writeBatches<T>(
  session: Session,
  items: T[],
  query: string,
  label: string
): Promise<void> {
  const batches = chunkArray(items, BATCH_SIZE);

  for (let index = 0; index < batches.length; index += 1) {
    await session.executeWrite((tx: ManagedTransaction) => tx.run(query, { rows: batches[index] }));

    logInfo("Wrote Neo4j batch", {
      label,
      batchNumber: index + 1,
      batchCount: batches.length,
      batchSize: batches[index].length
    });
  }
}

function getRelationshipRows(relationships: GraphRelationship[], type: GraphRelationship["type"]) {
  return relationships.filter((relationship) => relationship.type === type);
}

async function main() {
  const graphDataset = loadGraphDataset();
  const neo4jClient = createNeo4jClient();
  const session = neo4jClient.getSession();

  try {
    await neo4jClient.verifyConnection();
    await createConstraints(session);

    await writeBatches(
      session,
      graphDataset.issues,
      `
        UNWIND $rows AS row
        MERGE (n:Issue {number: row.number})
        SET n.title = row.title,
            n.body = row.body,
            n.state = row.state,
            n.url = row.url,
            n.createdAt = row.createdAt,
            n.updatedAt = row.updatedAt,
            n.closedAt = row.closedAt
      `,
      "Issue"
    );

    await writeBatches(
      session,
      graphDataset.pullRequests,
      `
        UNWIND $rows AS row
        MERGE (n:PullRequest {number: row.number})
        SET n.title = row.title,
            n.body = row.body,
            n.state = row.state,
            n.url = row.url,
            n.createdAt = row.createdAt,
            n.updatedAt = row.updatedAt,
            n.closedAt = row.closedAt,
            n.mergedAt = row.mergedAt
      `,
      "PullRequest"
    );

    await writeBatches(
      session,
      graphDataset.files,
      `
        UNWIND $rows AS row
        MERGE (n:File {path: row.path})
      `,
      "File"
    );

    await writeBatches(
      session,
      graphDataset.components,
      `
        UNWIND $rows AS row
        MERGE (n:Component {name: row.name})
      `,
      "Component"
    );

    await writeBatches(
      session,
      graphDataset.labels,
      `
        UNWIND $rows AS row
        MERGE (n:Label {name: row.name})
      `,
      "Label"
    );

    await writeBatches(
      session,
      graphDataset.developers,
      `
        UNWIND $rows AS row
        MERGE (n:Developer {login: row.login})
      `,
      "Developer"
    );

    await writeBatches(
      session,
      getRelationshipRows(graphDataset.relationships, "HAS_LABEL"),
      `
        UNWIND $rows AS row
        MATCH (issue:Issue {number: row.issueNumber})
        MATCH (label:Label {name: row.labelName})
        MERGE (issue)-[:HAS_LABEL]->(label)
      `,
      "HAS_LABEL"
    );

    await writeBatches(
      session,
      getRelationshipRows(graphDataset.relationships, "FIXED_BY"),
      `
        UNWIND $rows AS row
        MATCH (issue:Issue {number: row.issueNumber})
        MATCH (pr:PullRequest {number: row.pullRequestNumber})
        MERGE (issue)-[:FIXED_BY]->(pr)
      `,
      "FIXED_BY"
    );

    await writeBatches(
      session,
      getRelationshipRows(graphDataset.relationships, "CHANGES"),
      `
        UNWIND $rows AS row
        MATCH (pr:PullRequest {number: row.pullRequestNumber})
        MATCH (file:File {path: row.filePath})
        MERGE (pr)-[:CHANGES]->(file)
      `,
      "CHANGES"
    );

    await writeBatches(
      session,
      getRelationshipRows(graphDataset.relationships, "BELONGS_TO"),
      `
        UNWIND $rows AS row
        MATCH (file:File {path: row.filePath})
        MATCH (component:Component {name: row.componentName})
        MERGE (file)-[:BELONGS_TO]->(component)
      `,
      "BELONGS_TO"
    );

    await writeBatches(
      session,
      getRelationshipRows(graphDataset.relationships, "ASSIGNED_TO"),
      `
        UNWIND $rows AS row
        MATCH (issue:Issue {number: row.issueNumber})
        MATCH (developer:Developer {login: row.developerLogin})
        MERGE (issue)-[:ASSIGNED_TO]->(developer)
      `,
      "ASSIGNED_TO"
    );

    await writeBatches(
      session,
      getRelationshipRows(graphDataset.relationships, "AUTHORED_BY"),
      `
        UNWIND $rows AS row
        MATCH (pr:PullRequest {number: row.pullRequestNumber})
        MATCH (developer:Developer {login: row.developerLogin})
        MERGE (pr)-[:AUTHORED_BY]->(developer)
      `,
      "AUTHORED_BY"
    );

    logInfo("Neo4j graph build complete", {
      issueCount: graphDataset.issues.length,
      pullRequestCount: graphDataset.pullRequests.length,
      fileCount: graphDataset.files.length,
      componentCount: graphDataset.components.length,
      labelCount: graphDataset.labels.length,
      developerCount: graphDataset.developers.length,
      relationshipCount: graphDataset.relationships.length
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
