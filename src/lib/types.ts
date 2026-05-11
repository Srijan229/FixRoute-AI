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

export type PullRequestCommit = {
  sha: string;
  commit: {
    message: string;
  };
  html_url?: string;
};

export type LinkedPullRequestRecord = {
  pullRequest: GitHubPullRequest;
  linkedIssueNumbers: number[];
  files: PullRequestFile[];
  commits?: PullRequestCommit[];
};

export type GitHubTimelineCrossReferenceEvent = {
  event?: string;
  source?: {
    issue?: {
      number?: number;
      pull_request?: {
        url?: string;
      };
      html_url?: string;
    };
  };
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

export type IssueSummary = {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  assignees: string[];
};

export type QueryIssueResult = {
  issue: IssueSummary;
  linkedPullRequests: Array<{
    number: number;
    title: string;
    url: string;
    authors: string[];
    changedFiles: Array<{
      path: string;
      component: string;
    }>;
  }>;
  likelyFiles: Array<{
    path: string;
    component: string;
    linkedPullRequests: number[];
  }>;
  evidencePaths: string[][];
};

export type IssueEmbeddingRecord = {
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  text: string;
  vector: number[];
};

export type RecommendationResult = {
  ticket_type: string;
  suggested_component: string;
  suggested_team: string;
  confidence: number;
  similar_tickets: Array<{
    issue_number: number;
    title: string;
    similarity_score: number;
    labels: string[];
    url: string;
  }>;
  likely_impacted_files: Array<{
    file_path: string;
    component: string;
    reason: string;
  }>;
  past_fix_pattern: string;
  possible_duplicate: {
    issue_number: number | string;
    title: string;
    confidence: number;
  };
  evidence_path: string[][];
  missing_information: string[];
  suggested_questions_for_reporter: string[];
};

export type BenchmarkCase = {
  issue_number: number;
  title: string;
  body: string;
  labels: string[];
  difficulty: "easy" | "medium" | "hard";
  expected: {
    component: string;
    files: string[];
    pull_requests: number[];
  };
};

export type HoldoutSplit = {
  train_issue_numbers: number[];
  test_cases: BenchmarkCase[];
  metadata: {
    eligible_case_count: number;
    train_case_count: number;
    test_case_count: number;
    split_ratio: number;
    train_closed_at_range: {
      start: string;
      end: string;
    } | null;
    test_closed_at_range: {
      start: string;
      end: string;
    } | null;
  };
};

export type EvaluationReport = {
  evaluated_cases: number;
  component_accuracy: number;
  duplicate_top1_accuracy: number;
  file_recall_at_5: number;
  file_recall_at_10: number;
  file_precision_at_5: number;
  focused_file_recall_at_5: number;
  focused_file_recall_at_10: number;
  component_top3_accuracy: number;
  unknown_component_rate: number;
  narrow_case_count: number;
  narrow_file_recall_at_5: number;
  narrow_focused_file_recall_at_5: number;
  broad_pr_case_count: number;
  broad_file_recall_at_5: number;
  broad_focused_file_recall_at_5: number;
  broad_pr_component_accuracy: number;
  component_aligned_file_hit_rate: number;
  failures: Array<{
    issue_number: number;
    expected_component: string;
    predicted_component: string;
    expected_files: string[];
    focused_expected_files: string[];
    predicted_files: string[];
    predicted_duplicate: number | string;
  }>;
};
