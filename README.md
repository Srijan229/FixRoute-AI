# FixRoute AI

Knowledge graph MVP for ticket routing and investigation support on `microsoft/vscode`.

Current scope:

- GitHub issue and pull request ingestion
- GitHub issue comments and timeline ingestion
- Pull request review and review comment ingestion
- Pull request patch hunk extraction with line ranges
- Graph construction in Neo4j
- Local raw and processed data storage
- No LLM, frontend, or Supabase yet

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the environment file:

```bash
cp .env.example .env
```

3. Fill in:

- `GITHUB_TOKEN`
- `NEO4J_URI`
- `NEO4J_USERNAME`
- `NEO4J_PASSWORD`

Optional defaults are already provided for:

- `GITHUB_OWNER=microsoft`
- `GITHUB_REPO=vscode`
- `GITHUB_API_BASE_URL=https://api.github.com`
- `ISSUE_FETCH_LIMIT=500`
- `ISSUE_COMMENTS_FETCH_LIMIT=0`
- `ISSUE_TIMELINE_FETCH_LIMIT=0`
- `PULL_REQUEST_REVIEWS_FETCH_LIMIT=0`
- `PULL_REQUEST_REVIEW_COMMENTS_FETCH_LIMIT=0`
- `PULL_REQUESTS_PER_PAGE=100`
- `PULL_REQUEST_FETCH_PAGE_LIMIT=20`
- `TIMELINE_ISSUE_LIMIT=0`
- `LOG_LEVEL=info`

## Scripts

```bash
npm run fetch:issues
npm run fetch:prs
npm run fetch:issue-comments
npm run fetch:issue-timeline
npm run fetch:pr-reviews
npm run fetch:pr-review-comments
npm run clone:target-repo
npm run extract:patch-hunks
npm run index:code
npm run normalize:rich
npm run normalize:graph
npm run build:graph
npm run create:embeddings
npm run create:rich-semantic-index
npm run create:code-semantic-index
npm run query:semantic -- --query "terminal crash when stopping node process" --top-k 5
npm run query:code -- --query "layout controls title bar editor actions" --top-k 5
npm run create:embeddings -- --reset
npm run build:benchmark -- --limit 50
npm run evaluate:agent -- --limit 20
npm run build:holdout
npm run evaluate:product -- --limit 20
npm run normalize:graph -- --holdout train
npm run create:embeddings -- --holdout train --reset
npm run create:rich-semantic-index -- --holdout train
npm run serve:api
npm run query:graph -- --issue-number 153829
npm run query:graph -- --title "snippet session"
npm run recommend:ticket -- --title "Cannot read properties of undefined" --description "Snippet session crashes while applying edits"
npm run validate:graph
npm run typecheck
```

## API

Start the local API:

```bash
npm run serve:api
```

Health check:

```bash
GET /health
```

Recommendation endpoint:

```bash
POST /api/recommend
Content-Type: application/json

{
  "title": "Cannot read properties of undefined",
  "description": "Snippet session crashes while applying edits",
  "topK": 5
}
```

## Notes

- This repo intentionally excludes local secrets, checkpoints, and generated datasets from version control.
- The graph is built from one selected repository only: `microsoft/vscode`.
- Semantic retrieval defaults to a local embedding provider. Set `EMBEDDING_PROVIDER=gemini` and `GEMINI_API_KEY` to use Gemini embeddings instead. Gemini embeddings API reference: https://ai.google.dev/api/embeddings
