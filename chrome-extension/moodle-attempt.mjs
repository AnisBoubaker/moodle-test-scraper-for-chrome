// Chrome injects this function into the review tab without its module scope.
export async function scrapeMoodleAttempt(expectedUrl, { reviewUrl, includePrompts = true } = {}) {
  const current = new URL(location.href);
  current.hash = "";
  const review = reviewUrl ? new URL(reviewUrl) : current;
  const expected = new URL(expectedUrl);
  const attemptId = review.searchParams.get("attempt");
  const visibleText = (node) => (node?.innerText ?? node?.textContent ?? "").trim();
  const viewPath = new URL("view.php", review).pathname;
  const columnKeys = {
    "Affichage de votre programme": "Program output",
    Attendu: "Expected result",
    Entrée: "Input",
    Obtenu: "Actual result",
    "Résultat attendu": "Expected result",
    "Résultat obtenu": "Actual result",
    Saisie: "Input",
    Test: "Test",
    Input: "Input",
    Expected: "Expected result",
    Got: "Actual result",
    "Expected result": "Expected result",
    "Actual result": "Actual result",
    "Program output": "Program output",
  };

  function linkUrl(link) {
    const href = link.getAttribute("href");
    return URL.canParse(href, review) ? new URL(href, review) : null;
  }

  async function fetchReview(url) {
    const response = await fetch(url, {
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Moodle returned HTTP ${response.status}.`);
    const template = document.createElement("template");
    template.innerHTML = await response.text();
    return template.content;
  }

  async function completeReview(page) {
    const pageLinks = [...page.querySelectorAll("a[href]")].map(linkUrl).filter((url) =>
      url?.origin === review.origin && url.pathname === review.pathname &&
      url.searchParams.get("attempt") === attemptId
    );
    const showsAll = review.searchParams.get("showall") === "1";
    if (showsAll) return page;

    if (pageLinks.some((url) => url.searchParams.get("showall") === "1")) {
      const fullUrl = new URL(review.pathname, review.origin);
      fullUrl.searchParams.set("attempt", attemptId);
      fullUrl.searchParams.set("showall", "1");
      try {
        return await fetchReview(fullUrl);
      } catch {
        throw new Error("Could not load all questions. Open the full review in Moodle and try again.");
      }
    }

    const pageNumber = review.searchParams.get("page") ?? "0";
    if (pageNumber !== "0" || pageLinks.some((url) => (url.searchParams.get("page") ?? "0") !== pageNumber)) {
      throw new Error("Open the review with all questions on one page in Moodle and try again.");
    }
    return page;
  }

  function findQuizId(page) {
    const finishLinks = [...page.querySelectorAll("a[href]")].filter((link) =>
      link.matches(".mod_quiz-next-nav, .endtestlink") || /^(Terminer la relecture|Finish review)$/i.test(visibleText(link))
    );
    const quizLinks = [...finishLinks, ...page.querySelectorAll(".breadcrumb a[href]")];
    const quizIds = new Set(quizLinks.map(linkUrl).filter((url) =>
      url?.origin === review.origin && url.pathname === viewPath
    ).map((url) => url.searchParams.get("id")).filter((id) => /^\d+$/.test(id ?? "")));
    const pageQuizId = review.searchParams.get("cmid");
    if (/^\d+$/.test(pageQuizId ?? "")) quizIds.add(pageQuizId);
    if (quizIds.size !== 1) {
      throw new Error("Could not identify the Moodle quiz for this review. Open it from the exam results report.");
    }
    return [...quizIds][0];
  }

  function readStudent(page) {
    const links = page.querySelectorAll(".quizreviewsummary td a[href]");
    const profile = [...links].find((link) => {
      const url = linkUrl(link);
      return url?.origin === review.origin && /\/user\/(view|profile)\.php$/.test(url.pathname) && visibleText(link);
    });
    const student = visibleText(profile);
    if (!student) throw new Error("Moodle did not display a student name. Open the student's attempt from the results report.");
    return student;
  }

  function choiceText(input) {
    const label = input.labels?.[0];
    return visibleText(label) || visibleText(input.parentElement.querySelector("[data-region=answer-label]")) || input.value;
  }

  function readResponse(block, number, errors) {
    const form = block.querySelector(".formulation");
    if (form && block.classList.contains("coderunner")) {
      const answer = form.querySelector("textarea.coderunner-answer");
      if (answer) return { question_type: "CodeRunner", response: answer.value };
    } else if (form && block.classList.contains("multianswer")) {
      const fields = [...form.querySelectorAll(".subquestion")];
      if (!fields.length) throw new Error(`Moodle did not display the answer fields for question ${number}.`);
      const response = fields.map((field, index) => {
        const control = field.querySelector('input[type="text"], input[type="number"], select');
        const radio = field.querySelector('input[type="radio"]:checked');
        const state = [control, radio, field].find((node) =>
          node?.classList.contains("incorrect") || node?.classList.contains("partiallycorrect")
        );
        if (state) {
          errors.push({
            type: "Champ de réponse",
            field: index + 1,
            status: state.classList.contains("incorrect") ? "Incorrect" : "Partiellement correct",
          });
        }
        if (control?.tagName === "SELECT") return control.value ? visibleText(control.selectedOptions[0]) : "";
        if (control) return control.value;
        if (radio) return choiceText(radio);
        if (field.querySelector('input[type="radio"]')) return "";
        throw new Error(`Could not read answer field ${index + 1} of question ${number}.`);
      });
      return { question_type: "Réponses intégrées", response };
    } else if (form) {
      const type = block.classList[1];
      if (type === "shortanswer" || type === "numerical") {
        const answer = form.querySelector('.answer input[type="text"], .answer input[type="number"]');
        if (answer) return { question_type: type, response: answer.value };
      }
      if (type === "essay") {
        const answer = form.querySelector(".answer textarea, .qtype_essay_response");
        if (answer) return { question_type: type, response: answer.value ?? visibleText(answer) };
      }
      if (type === "multichoice" || type === "truefalse") {
        const choices = [...form.querySelectorAll('.answer input[type="radio"], .answer input[type="checkbox"]')];
        if (choices.length) {
          const selected = choices.filter((choice) => choice.checked).map(choiceText);
          return { question_type: type, response: choices[0].type === "checkbox" ? selected : selected[0] ?? "" };
        }
      }
    }
    throw new Error(`Could not read the response for question ${number}. Check that Moodle displays the submitted answer.`);
  }

  function readCodeRunnerErrors(question) {
    const errors = [];
    for (const pre of question.querySelectorAll(".coderunner-test-results pre")) {
      if (pre.closest("table")) continue;
      const title = visibleText(pre.closest(".coderunner-test-results").querySelector("h3, h4, h5, h6"));
      errors.push({
        type: title === "La question comporte une erreur" ? "Erreur de question" : "Diagnostic de compilation",
        title,
        message: pre.textContent,
      });
    }
    for (const table of question.querySelectorAll(".coderunner-test-results table, table.coderunner-test-results")) {
      const columns = [...table.querySelectorAll("thead th")].map((header) => [header.cellIndex, visibleText(header)]);
      const visibleColumns = columns.filter(([, label]) => label);
      for (const row of table.querySelectorAll("tbody tr")) {
        const icons = [...row.querySelectorAll("[title], img[alt]")].filter((icon) => {
          const cell = icon.closest("td");
          return cell?.cellIndex === 0 || cell?.cellIndex === row.cells.length - 1;
        });
        const statuses = [...new Set(icons.map((icon) => icon.getAttribute("title") || icon.getAttribute("alt")).filter(Boolean))];
        if (!statuses.some((label) => /incorrect|échec|erreur|failed|error/i.test(label)) &&
            !/incorrect|failed|error/i.test(row.className)) continue;
        const cellText = (cell) => cell?.querySelector("pre")?.textContent ?? visibleText(cell);
        const status = statuses.join(", ") || null;
        const resultKeys = visibleColumns.map(([, label]) => Object.hasOwn(columnKeys, label) ? columnKeys[label] : null);
        if (resultKeys.length && resultKeys.every(Boolean) && new Set(resultKeys).size === resultKeys.length) {
          const results = Object.fromEntries(visibleColumns.map(([index], column) =>
            [resultKeys[column], cellText(row.cells[index])]
          ));
          errors.push({ type: "Test échoué", status, results });
        } else {
          errors.push({
            type: "Test échoué", status,
            columns: columns.map(([, label]) => label),
            values: [...row.cells].map(cellText),
          });
        }
      }
    }
    const messages = [...new Set([...question.querySelectorAll(".coderunner-test-results p")]
      .filter((paragraph) => !paragraph.closest("table"))
      .map(visibleText)
      .filter((text) => text && !/^(Tous les tests ont été réussis|All tests passed)/i.test(text)))];
    if (messages.length) errors.push({ type: "Résumé des tests", messages });
    return errors;
  }

  function readHistory(block, number) {
    const table = block.querySelector(".history table");
    const rows = table ? [...table.tBodies].flatMap((body) => [...body.rows]) : [];
    const headings = table ? [...table.querySelectorAll("thead th")].map(visibleText) : [];
    const standardHeadings = ["Étape|Heure|Action|État", "Step|Time|Action|State"];
    if (!rows.length || !standardHeadings.includes(headings.slice(0, 4).join("|"))) {
      throw new Error(`Moodle did not display the response history for question ${number}.`);
    }
    return rows.map((row) => {
      const [stepCell, time, action, state, marks] = row.cells;
      const step = Number(visibleText(stepCell));
      if (!Number.isInteger(step) || step < 1 || !action || !state) {
        throw new Error(`Could not read a response history row for question ${number}.`);
      }
      const markText = visibleText(marks);
      const decimal = markText.replace(/\s/g, "").replace(",", ".");
      return {
        step,
        time: visibleText(time),
        action: action.textContent,
        state: visibleText(state),
        marks: !markText ? null : /^-?\d+(?:\.\d+)?$/.test(decimal) ? Number(decimal) : markText,
      };
    });
  }

  function readExamPrompts(items) {
    const question_prompts = [];
    const shared_instructions = [];
    const images = new Map();
    const excluded = ".accesshide, .visually-hidden, .feedbacktrigger, .formulation > .prompt, " +
      ".coderunner-examples, .for-example-para, .ui_wrapper, .im-controls, .ace_editor, " +
      "script, style, input, textarea, select, button, [hidden]";
    const paragraphs = new Set(["ADDRESS", "BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "P", "UL", "OL"]);

    for (const [index, { block, number }] of items.entries()) {
      const form = block.querySelector(".formulation");
      const cloze = block.classList.contains("multianswer");
      // CodeRunner's prompt is a sibling of its answer editor.
      const root = (cloze ? form : form?.querySelector(".qtext") ?? form?.querySelector(":scope > .clearfix")) ??
        (number === null ? form : null);
      if (!root) throw new Error(`Moodle did not display the prompt for question ${number}.`);

      const blanks = new Map([...root.querySelectorAll(".subquestion")].map((blank, i) => [blank, i + 1]));
      const codeBlocks = [];
      const formulas = [];
      const figureIds = [];

      function render(node, inCode = false) {
        if (node.nodeType === Node.TEXT_NODE) {
          return inCode ? node.data : node.data.replace(/[ \t\r\n\f]+/g, " ");
        }
        if (node.nodeType !== Node.ELEMENT_NODE || node.matches(excluded)) return "";
        if (blanks.has(node)) return `[Case ${blanks.get(node)}]`;
        if (node.tagName === "BR") return "\n";
        if (node.tagName === "IMG") {
          const src = node.currentSrc || node.getAttribute("src");
          if (!src || !URL.canParse(src, review)) return node.alt;
          const url = new URL(src, review);
          const formula = readMathML(url);
          if (formula) {
            formulas.push({ mathml: formula, alt: node.alt });
            return `[Formule ${formulas.length}]`;
          }
          if (!/^https?:$/.test(url.protocol) && !url.href.startsWith("data:image/")) return node.alt;
          if (!images.has(url.href)) {
            images.set(url.href, { id: `figure_${images.size + 1}`, url, alt: node.alt });
          }
          const { id } = images.get(url.href);
          figureIds.push(id);
          return `[Figure ${figureIds.length}]`;
        }
        const children = [...node.childNodes];
        if (node.tagName === "PRE") {
          codeBlocks.push(children.map((child) => render(child, true)).join(""));
          return `\n\n\u0000${codeBlocks.length - 1}\u0000\n\n`;
        }
        const text = children.map((child) => render(child, inCode)).join("");
        if (inCode) return text;
        if (node.tagName === "LI") return `\n- ${text.trim()}\n`;
        if (node.tagName === "TD" || node.tagName === "TH") return `${text.trim()}\t`;
        if (node.tagName === "TR") return `${text.trim()}\n`;
        if (paragraphs.has(node.tagName)) return `\n\n${text.trim()}\n\n`;
        return text;
      }

      let prompt = render(root).replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
        .replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);
      if (figureIds.length === 1) prompt = prompt.replace("[Figure 1]", "[Figure]");
      if (!prompt) throw new Error(`Moodle did not display ${number === null ? "the shared instructions" : `the prompt for question ${number}`}.`);

      const links = [...root.querySelectorAll("a[href]")].flatMap((link) => {
        const url = linkUrl(link);
        const text = visibleText(link);
        return url && /^https?:$/.test(url.protocol) && text && !link.closest(`${excluded}, .subquestion`)
          ? [{ text, url: url.href }] : [];
      });
      const entry = { prompt };
      if (figureIds.length === 1) entry.figure_id = figureIds[0];
      if (figureIds.length > 1) entry.figure_ids = figureIds;
      if (formulas.length) entry.formulas = formulas;
      if (number === null) {
        const before = items.slice(index + 1).find((item) => item.number !== null)?.number;
        if (links.length === 1) entry.reference_url = links[0].url;
        else if (links.length) entry.links = links;
        shared_instructions.push({ ...(before ? { before_question: before } : {}), ...entry });
        continue;
      }
      if (links.length) entry.links = links;
      const examples = [...form.querySelectorAll(".coderunner-examples tr")].map((row) =>
        [...row.cells].map((cell) => cell.querySelector("pre")?.textContent ?? visibleText(cell))
      );
      if (examples.length > 1) {
        entry.examples = { heading: visibleText(form.querySelector(".for-example-para")), columns: examples[0], rows: examples.slice(1) };
      }
      question_prompts.push({ question_number: number, ...entry });
    }
    return { question_prompts, shared_instructions, images };
  }

  function readMathML(url) {
    if (!url.href.startsWith("data:image/svg+xml")) return null;
    const separator = url.href.indexOf(",");
    if (separator < 0) return null;
    try {
      const contents = decodeURIComponent(url.href.slice(separator + 1));
      const svg = url.href.slice(0, separator).endsWith(";base64")
        ? new TextDecoder().decode(Uint8Array.from(atob(contents), (byte) => byte.charCodeAt(0)))
        : contents;
      return svg.match(/<!--\s*MathML:\s*(<math\b[\s\S]*?<\/math>)\s*-->/)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async function readFigure({ url, alt }) {
    const linked = { source_url: url.href, alt };
    // Read Moodle images with the current session. External images remain links.
    if (url.origin !== review.origin && url.protocol !== "data:") return linked;
    try {
      const response = await fetch(url, { credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) return linked;
      const image = await response.blob();
      if (!image.type.startsWith("image/")) return linked;
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(image);
      });
      return { media_type: image.type, data_base64: dataUrl.slice(dataUrl.indexOf(",") + 1), alt };
    } catch {
      return linked;
    }
  }

  try {
    const expectedReview = reviewUrl ? new URL("review.php", expected).pathname : expected.pathname;
    const sameSource = reviewUrl ? current.href === expected.href :
      current.origin === expected.origin && current.pathname === expected.pathname && attemptId === expected.searchParams.get("attempt");
    if (!sameSource || review.origin !== expected.origin || review.pathname !== expectedReview ||
        !review.pathname.endsWith("/mod/quiz/review.php") || !/^\d+$/.test(attemptId ?? "")) {
      throw new Error("The source tab changed. Open the intended Moodle review and click the extension again.");
    }
    const page = await completeReview(reviewUrl ? await fetchReview(review) : document);
    const student = readStudent(page);
    const quizId = findQuizId(page);
    const items = [...page.querySelectorAll(".que")].map((block) => {
      if (block.matches(".description, .informationitem")) return { block, number: null };
      const number = Number(visibleText(block.querySelector(".info h3, .info .qno")).match(/\d+/)?.[0]);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error("Could not identify a Moodle question number.");
      return { block, number };
    });
    const questions = items.filter(({ number }) => number !== null).map(({ block, number }) => {
      const errors = readCodeRunnerErrors(block);
      const response = readResponse(block, number, errors);
      return { question_number: number, ...response, errors, response_history: readHistory(block, number) };
    });
    if (!questions.length) throw new Error("No reviewed questions were found in Moodle.");
    const report = new URL("report.php", review);
    report.search = new URLSearchParams({ id: quizId, mode: "overview" }).toString();
    const capture = {
      exam: visibleText(page.querySelector("#region-main h2, main h2, h2")) || `Moodle quiz ${quizId}`,
      source_report: report.href,
      attempt: { student, attempt_id: attemptId, questions },
    };
    if (!includePrompts) return capture;
    try {
      const { question_prompts, shared_instructions, images } = readExamPrompts(items);
      capture.question_prompts = question_prompts;
      capture.shared_instructions = shared_instructions;
      if (images.size) {
        const figures = await Promise.all([...images.values()].map(async (figure) => [figure.id, await readFigure(figure)]));
        capture.prompt_figures = Object.fromEntries(figures);
      }
    } catch (error) {
      capture.prompt_error = error instanceof Error ? error.message : "Could not read the exam prompts.";
    }
    return capture;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Could not read the Moodle attempt." };
  }
}
