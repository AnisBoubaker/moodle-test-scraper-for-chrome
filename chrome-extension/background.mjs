chrome.action.onClicked.addListener((tab) => {
  const exporter = new URL(chrome.runtime.getURL("export.html"));
  const source = URL.canParse(tab.url) ? new URL(tab.url) : null;
  if (Number.isInteger(tab.id) && source && /^https?:$/.test(source.protocol)) {
    const review = source.pathname.endsWith("/mod/quiz/review.php") && /^\d+$/.test(source.searchParams.get("attempt") ?? "");
    const report = source.pathname.endsWith("/mod/quiz/report.php");
    if (review || report) {
      source.hash = "";
      exporter.hash = new URLSearchParams({ tab: String(tab.id), source: source.href }).toString();
    }
  }
  void chrome.tabs.create({ url: exporter.href });
});
