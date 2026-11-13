function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function reportIdentity(url) {
  if (typeof url !== "string" || !URL.canParse(url)) {
    throw new Error("The JSON file has an invalid source_report URL.");
  }
  const report = new URL(url);
  const quizId = report.searchParams.get("id");
  if (!report.pathname.endsWith("/mod/quiz/report.php") || !/^\d+$/.test(quizId ?? "")) {
    throw new Error("The JSON file has an invalid Moodle report URL.");
  }
  return `${report.origin}${report.pathname}?id=${quizId}`;
}

function attemptId(value) {
  return typeof value === "string" || Number.isSafeInteger(value) ? String(value) : "";
}

function questionNumbers(questions) {
  const numbers = questions.map((question) => String(question?.question_number ?? ""));
  if (numbers.some((number) => !/^[1-9]\d*$/.test(number)) || new Set(numbers).size !== numbers.length) {
    throw new Error("The exam contains invalid or duplicate question numbers.");
  }
  return new Set(numbers);
}

function checkQuestions(expected, captured) {
  if (!Array.isArray(expected) || expected.length === 0) return;
  const numbers = questionNumbers(expected);
  if (numbers.size !== captured.size || [...numbers].some((number) => !captured.has(number))) {
    throw new Error("The review and JSON file have different question numbers. Check that the complete review and the correct exam file are selected.");
  }
}

export function prepareExport(text, capture) {
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("The selected file is not valid JSON.");
  }
  if (!isObject(data) || !Array.isArray(data.attempts)) {
    throw new Error('Choose an exam JSON file with an "attempts" array.');
  }

  const source = reportIdentity(capture.source_report);
  if (Object.hasOwn(data, "source_report") && reportIdentity(data.source_report) !== source) {
    throw new Error("This JSON file is for a different Moodle quiz. Choose the export for the open review.");
  }
  if (data.attempts.some((attempt) => !isObject(attempt) || typeof attempt.student !== "string" || !attempt.student.trim())) {
    throw new Error("The JSON file contains a record without a student name.");
  }

  const incoming = structuredClone(capture.attempts ?? [capture.attempt]);
  if (!incoming.length || incoming.some((attempt) => typeof attempt?.student !== "string" ||
      !attempt.student.trim() || !Array.isArray(attempt.questions) || !attempt.questions.length)) {
    throw new Error("A Moodle review is missing its student name or questions.");
  }
  if (new Set(incoming.map((attempt) => attempt.student)).size !== incoming.length) {
    throw new Error("The report contains multiple reviews with the same student name. Filter the report to one review per name before exporting.");
  }
  const capturedNumbers = questionNumbers(incoming[0].questions);
  for (const attempt of incoming) checkQuestions(attempt.questions, capturedNumbers);
  if (data.question_prompts != null && !Array.isArray(data.question_prompts)) {
    throw new Error("The JSON file has an invalid question_prompts array.");
  }
  checkQuestions(data.question_prompts, capturedNumbers);

  if (!data.question_prompts?.length) {
    if (capture.prompt_error) throw new Error(capture.prompt_error);
    const prompts = capture.question_prompts;
    if (!prompts?.length || prompts.some((question) => typeof question.prompt !== "string" || !question.prompt.trim())) {
      throw new Error("The Moodle review did not provide all question prompts.");
    }
    checkQuestions(prompts, capturedNumbers);
    data.question_prompts = structuredClone(prompts);
    data.shared_instructions ??= structuredClone(capture.shared_instructions ?? []);
    if (capture.prompt_figures) {
      const figures = data.prompt_figures ?? {};
      if (!isObject(figures)) throw new Error("The JSON file has invalid prompt figures.");
      for (const [id, figure] of Object.entries(capture.prompt_figures)) {
        if (Object.hasOwn(figures, id) && JSON.stringify(figures[id]) !== JSON.stringify(figure)) {
          throw new Error(`The JSON file already contains a different prompt figure named ${id}.`);
        }
        figures[id] = structuredClone(figure);
      }
      data.prompt_figures = figures;
    }
  }

  if (data.attempts.length === 0) {
    data.exam ??= capture.exam;
    data.source_report ??= capture.source_report;
  }
  let added = 0;
  let updated = 0;
  const matched = new Set();
  for (const attempt of incoming) {
    const legacyId = attemptId(attempt.attempt_id);
    const indexes = data.attempts.flatMap((previous, index) =>
      previous.student === attempt.student || (legacyId && attemptId(previous.attempt_id) === legacyId) ? [index] : []
    );
    const [index] = indexes;
    if (indexes.length > 1 || matched.has(index)) {
      throw new Error("A student matches more than one record in the JSON file. Resolve the duplicate records before updating.");
    }
    if (index === undefined) {
      matched.add(data.attempts.length);
      data.attempts.push(attempt);
      added += 1;
      continue;
    }
    matched.add(index);
    const previous = data.attempts[index];
    checkQuestions(previous.questions, capturedNumbers);
    const previousQuestions = new Map((previous.questions ?? []).map((question) =>
      [String(question.question_number), question]
    ));
    data.attempts[index] = {
      ...previous,
      ...attempt,
      questions: attempt.questions.map((question) => ({
        ...previousQuestions.get(String(question.question_number)),
        ...question,
      })),
    };
    updated += 1;
  }
  const { exam, source_report, attempts, ...metadata } = data;
  const students = attempts.map(({ student, attempt_id, ...details }) => ({ student, ...details }));
  const operation = updated === 0 ? "add" : added === 0 ? "update" : "merge";
  return { data: { exam, source_report, ...metadata, attempts: students }, operation };
}

export async function saveExport(handle, capture) {
  const original = await (await handle.getFile()).text();
  const { data, operation } = prepareExport(original, capture);
  const writable = await handle.createWritable({ mode: "exclusive" });
  try {
    await writable.write(JSON.stringify(data, null, 2) + "\n");
    if (await (await handle.getFile()).text() !== original) {
      throw new Error("The JSON file changed while saving. Try saving again.");
    }
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return operation;
}
