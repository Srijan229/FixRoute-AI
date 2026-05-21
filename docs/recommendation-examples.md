# Recommendation Examples

These examples are compact snapshots of the recommendation shape. They are meant
for demos, README references, and product explanation, not as fixed golden test
outputs. Exact files and scores can change as the indexes are rebuilt.

## Existing Bug

Input:

```text
Title: Chat input crashes when pressing Enter
Description: Expected the message to send. Actual behavior is an error with a stack trace when pressing Enter in chat.
```

Expected routing shape:

```json
{
  "mode": "bug_localization",
  "resolution_type": "existing_bug",
  "routing": {
    "new_file_likelihood": "unlikely",
    "requires_new_files": false,
    "output_guidance": "Use likely existing files as investigation starting points, not guaranteed bug locations."
  },
  "likely_components": ["Chat", "Terminal"],
  "output_focus": [
    "likely existing files",
    "similar historical issues",
    "fix PR evidence paths"
  ]
}
```

Interpretation:

This is an existing-code investigation. The system should recommend files and
areas to inspect, but should not claim that a specific file is guaranteed to be
the bug location.

## Enhancement

Input:

```text
Title: Allow chat export to include timestamps
Description: The export feature already exists, but users need an option to include timestamps in exported chat history.
```

Expected routing shape:

```json
{
  "mode": "enhancement_planning",
  "resolution_type": "enhancement",
  "routing": {
    "new_file_likelihood": "unlikely",
    "requires_new_files": false
  },
  "likely_components": ["Chat"],
  "output_focus": [
    "existing feature area",
    "files to inspect",
    "files to extend",
    "similar enhancements"
  ]
}
```

Interpretation:

This is not a pure new feature. It is an extension to an existing capability, so
the recommended output should prioritize current implementation files and tests.

## Enhancement With Possible New Files

Input:

```text
Title: Expand terminal tool output compression: more commands + subcommand parsing
Description: Extend the existing terminal output compression to support more commands and subcommand parsing. This may need parser helpers and tests.
```

Example routing shape:

```json
{
  "mode": "enhancement_planning",
  "resolution_type": "enhancement",
  "routing": {
    "new_file_likelihood": "possible",
    "new_file_probability": 0.58,
    "requires_new_files": false
  },
  "possible_new_files": [
    "src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/titleExpandTerminalTool.ts",
    "src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/test/titleExpandTerminalTool.test.ts"
  ],
  "output_focus": [
    "existing terminal tool area",
    "files to inspect or extend",
    "possible helper/test files"
  ]
}
```

Interpretation:

This is the important middle case. The issue is still an enhancement, but the
system can separately say that new helper or test files may be needed. It should
not force the issue into `new_feature` just because file creation is plausible.

## New Feature

Input:

```text
Title: Add export button for chat history
Description: Feature request: there is no way for users to export chat history from the chat UI. Add a visible export action.
```

Example routing shape:

```json
{
  "mode": "feature_planning",
  "resolution_type": "new_feature",
  "routing": {
    "new_file_likelihood": "likely",
    "new_file_probability": 0.9,
    "requires_new_files": true,
    "output_guidance": "Use likely implementation areas, files to inspect, possible new files, and similar patterns. Not enough evidence for exact file prediction."
  },
  "likely_components": ["Chat"],
  "likely_new_files": [
    "src/vs/workbench/contrib/chat/browser/actions/titleExportButtonChat.ts",
    "src/vs/workbench/contrib/chat/browser/actions/test/titleExportButtonChat.test.ts"
  ],
  "output_focus": [
    "implementation area",
    "files to inspect",
    "likely new files",
    "similar implementation patterns"
  ]
}
```

Interpretation:

This is missing capability work. Exact final file prediction is not the right
claim; the useful output is a component, area, files to inspect, likely new
files/directories, and implementation patterns.
