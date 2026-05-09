export type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: {
    url: string;
  };
};

export type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at?: string | null;
  user?: { login: string } | null;
};

export type PullRequestFile = {
  filename: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
};

export type LinkedPullRequestRecord = {
  pullRequest: GitHubPullRequest;
  linkedIssueNumbers: number[];
  files: PullRequestFile[];
};

export type GraphIssueNode = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type GraphPullRequestNode = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
};

export type GraphFileNode = {
  path: string;
};

export type GraphComponentNode = {
  name: string;
};

export type GraphLabelNode = {
  name: string;
};

export type GraphDeveloperNode = {
  login: string;
};

export type GraphRelationship =
  | { type: "HAS_LABEL"; issueNumber: number; labelName: string }
  | { type: "FIXED_BY"; issueNumber: number; pullRequestNumber: number }
  | { type: "CHANGES"; pullRequestNumber: number; filePath: string }
  | { type: "BELONGS_TO"; filePath: string; componentName: string }
  | { type: "ASSIGNED_TO"; issueNumber: number; developerLogin: string }
  | { type: "AUTHORED_BY"; pullRequestNumber: number; developerLogin: string };

export type GraphDataset = {
  issues: GraphIssueNode[];
  pullRequests: GraphPullRequestNode[];
  files: GraphFileNode[];
  components: GraphComponentNode[];
  labels: GraphLabelNode[];
  developers: GraphDeveloperNode[];
  relationships: GraphRelationship[];
};
