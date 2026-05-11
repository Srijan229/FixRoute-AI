export function mapFilePathToComponent(filePath: string): string {
  const normalized = filePath.toLowerCase();

  if (normalized.includes("src/vs/sessions/")) {
    return "Sessions";
  }

  if (
    normalized.includes("/chat/") ||
    normalized.includes("copilotchat") ||
    normalized.includes("agentsessions") ||
    normalized.includes("agenthost") ||
    normalized.includes("agentplugin") ||
    normalized.includes("aicustomization") ||
    normalized.includes("chatediting") ||
    normalized.includes("chatsetup")
  ) {
    return "Chat";
  }

  if (
    normalized.includes("/sessions/") ||
    normalized.includes("sessionslistmodelservice") ||
    normalized.includes("sessiontypepicker") ||
    normalized.includes("titlebarpart") ||
    normalized.includes("sessionstitlebarwidget")
  ) {
    return "Sessions";
  }

  if (
    normalized.includes("/terminal/") ||
    normalized.includes("terminalcontrib") ||
    normalized.includes("terminalquickaccess") ||
    normalized.includes("/xterm/")
  ) {
    return "Terminal";
  }

  if (
    normalized.includes("/debug/") ||
    normalized.includes("debugcontrib") ||
    normalized.includes("/breakpoints/")
  ) {
    return "Debug";
  }

  if (
    normalized.includes("/search/") ||
    normalized.includes("searcheditor") ||
    normalized.includes("searchview") ||
    normalized.includes("/ripgrep/")
  ) {
    return "Search";
  }

  if (
    normalized.includes("/notebook/") ||
    normalized.includes("notebookcontrib") ||
    normalized.includes("notebookeditor")
  ) {
    return "Notebook";
  }

  if (
    normalized.includes("/editor/") ||
    normalized.includes("/snippet/") ||
    normalized.includes("snippetcontroller") ||
    normalized.includes("snippetsession") ||
    normalized.includes("/suggest/")
  ) {
    return "Editor";
  }

  if (
    normalized.includes("/extensions/") ||
    normalized.includes("/extensionmanagement/") ||
    normalized.includes("/ext host/") ||
    normalized.includes("extensiongallery")
  ) {
    return "Extensions";
  }

  if (
    normalized.includes("/authentication/") ||
    normalized.includes("authprovider") ||
    normalized.includes("authenticationservice")
  ) {
    return "Authentication";
  }

  if (
    normalized.includes("/settings/") ||
    normalized.includes("preferences") ||
    normalized.includes("configuration") ||
    normalized.includes("settingseditor")
  ) {
    return "Settings";
  }

  if (
    normalized.includes("/update/") ||
    normalized.includes("updateservice") ||
    normalized.includes("updatetitlebarentry")
  ) {
    return "Update";
  }

  if (
    normalized.includes("/issue/") ||
    normalized.includes("issuereporter")
  ) {
    return "IssueReporter";
  }

  if (
    normalized.includes("/tasks/") ||
    normalized.includes("taskservice")
  ) {
    return "Tasks";
  }

  if (
    normalized.includes("gettingstarted") ||
    normalized.includes("/welcomegettingstarted/")
  ) {
    return "GettingStarted";
  }

  return "Unknown";
}
