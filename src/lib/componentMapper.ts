export function mapFilePathToComponent(filePath: string): string {
  const normalized = filePath.toLowerCase();

  if (normalized.includes("/terminal/")) return "Terminal";
  if (normalized.includes("/debug/")) return "Debug";
  if (normalized.includes("/search/")) return "Search";
  if (normalized.includes("/notebook/")) return "Notebook";
  if (normalized.includes("/editor/")) return "Editor";
  if (normalized.includes("/extensions/")) return "Extensions";
  if (normalized.includes("/authentication/")) return "Authentication";
  if (normalized.includes("/settings/")) return "Settings";

  return "Unknown";
}
