# FixRoute AI

Knowledge graph MVP for ticket routing and investigation support on `microsoft/vscode`.

Current scope:

- GitHub issue and pull request ingestion
- Graph construction in Neo4j
- Local raw and processed data storage
- No embeddings, LLM, frontend, or Supabase yet

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
- `LOG_LEVEL=info`

## Scripts

```bash
npm run fetch:issues
npm run fetch:prs
npm run normalize:graph
npm run build:graph
npm run validate:graph
npm run typecheck
```

## Notes

- This repo intentionally excludes local secrets, checkpoints, and generated datasets from version control.
- The graph is built from one selected repository only: `microsoft/vscode`.
