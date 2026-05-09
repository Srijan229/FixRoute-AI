import fs from "node:fs";
import path from "node:path";
import { mapFilePathToComponent } from "../lib/componentMapper.js";
import { logInfo } from "../lib/logger.js";
import type {
  GitHubIssue,
  GraphComponentNode,
  GraphDataset,
  GraphDeveloperNode,
  GraphFileNode,
  GraphIssueNode,
  GraphLabelNode,
  GraphPullRequestNode,
  GraphRelationship,
  LinkedPullRequestRecord
} from "../lib/types.js";

const ISSUES_PATH = path.resolve(process.cwd(), "data", "raw", "issues", "issues.json");
const PULL_REQUESTS_PATH = path.resolve(
  process.cwd(),
  "data",
  "raw",
  "pullRequests",
  "linkedPullRequests.json"
);
const OUTPUT_PATH = path.resolve(process.cwd(), "data", "processed", "graph", "graphData.json");

function loadJsonFile<T>(filePath: string, missingFileMessage: string): T {
  if (!fs.existsSync(filePath)) {
    throw new Error(missingFileMessage);
  }

  const rawContents = fs.readFileSync(filePath, "utf8");
  return JSON.parse(rawContents) as T;
}

function saveGraphDataset(dataset: GraphDataset): void {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(dataset, null, 2), "utf8");
}

function normalizeIssue(issue: GitHubIssue): GraphIssueNode {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at
  };
}

function normalizePullRequest(record: LinkedPullRequestRecord): GraphPullRequestNode {
  return {
    number: record.pullRequest.number,
    title: record.pullRequest.title,
    body: record.pullRequest.body,
    state: record.pullRequest.state,
    url: record.pullRequest.html_url,
    createdAt: record.pullRequest.created_at,
    updatedAt: record.pullRequest.updated_at,
    closedAt: record.pullRequest.closed_at,
    mergedAt: record.pullRequest.merged_at ?? null
  };
}

function main() {
  const issues = loadJsonFile<GitHubIssue[]>(
    ISSUES_PATH,
    "Missing issue dataset. Run fetch:issues first."
  );
  const linkedPullRequests = loadJsonFile<LinkedPullRequestRecord[]>(
    PULL_REQUESTS_PATH,
    "Missing pull request dataset. Run fetch:prs first."
  );

  const issueNodes = new Map<number, GraphIssueNode>();
  const pullRequestNodes = new Map<number, GraphPullRequestNode>();
  const fileNodes = new Map<string, GraphFileNode>();
  const componentNodes = new Map<string, GraphComponentNode>();
  const labelNodes = new Map<string, GraphLabelNode>();
  const developerNodes = new Map<string, GraphDeveloperNode>();
  const relationshipSet = new Set<string>();
  const relationships: GraphRelationship[] = [];

  function addRelationship(relationship: GraphRelationship): void {
    const key = JSON.stringify(relationship);

    if (relationshipSet.has(key)) {
      return;
    }

    relationshipSet.add(key);
    relationships.push(relationship);
  }

  for (const issue of issues) {
    issueNodes.set(issue.number, normalizeIssue(issue));

    for (const label of issue.labels) {
      labelNodes.set(label.name, { name: label.name });
      addRelationship({
        type: "HAS_LABEL",
        issueNumber: issue.number,
        labelName: label.name
      });
    }

    for (const assignee of issue.assignees) {
      developerNodes.set(assignee.login, { login: assignee.login });
      addRelationship({
        type: "ASSIGNED_TO",
        issueNumber: issue.number,
        developerLogin: assignee.login
      });
    }
  }

  for (const record of linkedPullRequests) {
    pullRequestNodes.set(record.pullRequest.number, normalizePullRequest(record));

    if (record.pullRequest.user?.login) {
      developerNodes.set(record.pullRequest.user.login, {
        login: record.pullRequest.user.login
      });
      addRelationship({
        type: "AUTHORED_BY",
        pullRequestNumber: record.pullRequest.number,
        developerLogin: record.pullRequest.user.login
      });
    }

    for (const issueNumber of record.linkedIssueNumbers) {
      if (issueNodes.has(issueNumber)) {
        addRelationship({
          type: "FIXED_BY",
          issueNumber,
          pullRequestNumber: record.pullRequest.number
        });
      }
    }

    for (const file of record.files) {
      fileNodes.set(file.filename, { path: file.filename });

      const componentName = mapFilePathToComponent(file.filename);
      componentNodes.set(componentName, { name: componentName });

      addRelationship({
        type: "CHANGES",
        pullRequestNumber: record.pullRequest.number,
        filePath: file.filename
      });

      addRelationship({
        type: "BELONGS_TO",
        filePath: file.filename,
        componentName
      });
    }
  }

  const dataset: GraphDataset = {
    issues: Array.from(issueNodes.values()).sort((a, b) => a.number - b.number),
    pullRequests: Array.from(pullRequestNodes.values()).sort((a, b) => a.number - b.number),
    files: Array.from(fileNodes.values()).sort((a, b) => a.path.localeCompare(b.path)),
    components: Array.from(componentNodes.values()).sort((a, b) => a.name.localeCompare(b.name)),
    labels: Array.from(labelNodes.values()).sort((a, b) => a.name.localeCompare(b.name)),
    developers: Array.from(developerNodes.values()).sort((a, b) => a.login.localeCompare(b.login)),
    relationships
  };

  saveGraphDataset(dataset);

  logInfo("Graph normalization complete", {
    issueCount: dataset.issues.length,
    pullRequestCount: dataset.pullRequests.length,
    fileCount: dataset.files.length,
    componentCount: dataset.components.length,
    labelCount: dataset.labels.length,
    developerCount: dataset.developers.length,
    relationshipCount: dataset.relationships.length,
    outputPath: OUTPUT_PATH
  });
}

main();
