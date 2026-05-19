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
  patch?: string;
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

export type GitHubPullRequestReview = {
  id: number;
  html_url?: string;
  body: string | null;
  state: string;
  submitted_at: string | null;
  commit_id?: string;
  user?: { login: string } | null;
};

export type GitHubPullRequestReviewComment = {
  id: number;
  pull_request_review_id: number | null;
  path: string;
  diff_hunk: string;
  body: string | null;
  html_url: string;
  commit_id?: string;
  original_commit_id?: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  original_start_line?: number | null;
  side?: string | null;
  start_side?: string | null;
  created_at: string;
  updated_at: string;
  user?: { login: string } | null;
};

export type PullRequestReviewRecord = {
  pullRequestNumber: number;
  reviews: GitHubPullRequestReview[];
};

export type PullRequestReviewCommentRecord = {
  pullRequestNumber: number;
  reviewComments: GitHubPullRequestReviewComment[];
};

export type GitHubIssueComment = {
  id: number;
  issue_url: string;
  html_url: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  user?: { login: string } | null;
};

export type GitHubTimelineEvent = {
  id?: number | string;
  event?: string;
  created_at?: string;
  actor?: { login: string } | null;
  source?: {
    issue?: {
      number?: number;
      pull_request?: {
        url?: string;
      };
      html_url?: string;
    };
  };
  commit_id?: string | null;
  label?: { name?: string } | null;
};

export type IssueCommentRecord = {
  issueNumber: number;
  comments: GitHubIssueComment[];
};

export type IssueTimelineRecord = {
  issueNumber: number;
  events: GitHubTimelineEvent[];
};

export type PatchHunk = {
  filePath: string;
  pullRequestNumber: number;
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  patchText: string;
};

export type RichIssueRecord = {
  issue: GitHubIssue;
  comments: GitHubIssueComment[];
  timelineEvents: GitHubTimelineEvent[];
};

export type RichPullRequestRecord = LinkedPullRequestRecord & {
  reviews: GitHubPullRequestReview[];
  reviewComments: GitHubPullRequestReviewComment[];
  patchHunks: PatchHunk[];
};

export type RichDataset = {
  issues: RichIssueRecord[];
  pullRequests: RichPullRequestRecord[];
  metadata: {
    issueCount: number;
    pullRequestCount: number;
    issueCommentCount: number;
    issueTimelineEventCount: number;
    pullRequestReviewCount: number;
    pullRequestReviewCommentCount: number;
    patchHunkCount: number;
    generatedAt: string;
  };
};

export type CodeChunk = {
  id: string;
  repoOwner: string;
  repoName: string;
  filePath: string;
  component: string;
  language: string;
  chunkType: "symbol" | "block" | "file";
  symbolName: string | null;
  startLine: number;
  endLine: number;
  text: string;
};

export type CodeChunkDataset = {
  chunks: CodeChunk[];
  metadata: {
    repoOwner: string;
    repoName: string;
    sourcePath: string;
    fileCount: number;
    chunkCount: number;
    generatedAt: string;
  };
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

export type GraphIssueCommentNode = {
  id: number;
  issueNumber: number;
  body: string | null;
  url: string;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GraphPatchHunkNode = {
  id: string;
  filePath: string;
  pullRequestNumber: number;
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  patchText: string;
};

export type GraphRelationship =
  | { type: "HAS_LABEL"; issueNumber: number; labelName: string }
  | { type: "FIXED_BY"; issueNumber: number; pullRequestNumber: number }
  | { type: "CHANGES"; pullRequestNumber: number; filePath: string }
  | { type: "TOUCHES_HUNK"; pullRequestNumber: number; patchHunkId: string }
  | { type: "HUNK_IN_FILE"; patchHunkId: string; filePath: string }
  | { type: "BELONGS_TO"; filePath: string; componentName: string }
  | { type: "ASSIGNED_TO"; issueNumber: number; developerLogin: string }
  | { type: "AUTHORED_BY"; pullRequestNumber: number; developerLogin: string }
  | { type: "HAS_COMMENT"; issueNumber: number; commentId: number }
  | { type: "COMMENTED_BY"; commentId: number; developerLogin: string };

export type GraphDataset = {
  issues: GraphIssueNode[];
  pullRequests: GraphPullRequestNode[];
  files: GraphFileNode[];
  components: GraphComponentNode[];
  labels: GraphLabelNode[];
  developers: GraphDeveloperNode[];
  issueComments: GraphIssueCommentNode[];
  patchHunks: GraphPatchHunkNode[];
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

export type SemanticRecordType =
  | "issue"
  | "issue_comment"
  | "pull_request"
  | "commit"
  | "review"
  | "review_comment"
  | "patch_hunk"
  | "code_chunk";

export type RichSemanticRecord = {
  id: string;
  type: SemanticRecordType;
  issueNumber?: number;
  pullRequestNumber?: number;
  commitSha?: string;
  filePath?: string;
  title?: string;
  url?: string;
  labels?: string[];
  metadata: Record<string, string | number | boolean | null>;
  text: string;
  vector: number[];
};

export type RichSemanticIndex = {
  metadata: {
    provider: string;
    dimension: number;
    generatedAt: string;
    sourcePath: string;
    recordCount: number;
    countsByType: Record<string, number>;
  };
  records: RichSemanticRecord[];
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
    line_ranges?: Array<{
      start_line: number;
      end_line: number;
      source: string;
    }>;
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
