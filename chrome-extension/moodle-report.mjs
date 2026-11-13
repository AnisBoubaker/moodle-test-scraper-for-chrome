// This runs in the report tab. Only review links from the results table are used.
export function readMoodleReport(expectedUrl) {
  const page = new URL(location.href);
  page.hash = "";
  if (page.href !== expectedUrl) return { error: "The Moodle report changed. Open the extension again from the intended report." };

  const quizId = document.querySelector('select[name="attempts"]')?.form?.querySelector('input[name="id"]')?.value;
  const id = page.searchParams.get("id") ?? quizId;
  if (!/^\d+$/.test(id ?? "")) return { error: "Could not identify the quiz on this results page." };
  const source = new URL(page.pathname, page.origin);
  source.search = new URLSearchParams({ id, mode: "overview" });
  const table = document.querySelector("table:has(a.reviewlink)");
  if (!table) return { error: "No attempt review links were found. Open the quiz's Results overview in Moodle." };

  const paginated = [...document.querySelectorAll(".pagination a[href], .paging a[href], .paging-bar a[href]")].some((link) => {
    const url = new URL(link.href, page);
    return url.origin === page.origin && url.pathname === page.pathname && Number(url.searchParams.get("page")) > 0;
  });
  if (paginated || Number(page.searchParams.get("page")) > 0) {
    return { error: "The report has multiple pages. Increase Moodle's page size so all students you want to export are listed on one page." };
  }

  const reviewPath = new URL("review.php", page).pathname;
  const attempts = new Map();
  for (const link of table.querySelectorAll("a.reviewlink[href]")) {
    const url = new URL(link.href, page);
    const attempt = url.searchParams.get("attempt");
    if (url.origin === page.origin && url.pathname === reviewPath && /^\d+$/.test(attempt ?? "")) {
      const review = new URL(reviewPath, page.origin);
      review.searchParams.set("attempt", attempt);
      attempts.set(attempt, review.href);
    }
  }
  return attempts.size ? { source_report: source.href, reviews: [...attempts.values()] }
    : { error: "No valid Moodle attempt review links were found on this page." };
}
