import { prepareExport, reportIdentity, saveExport } from "./export-data.mjs";
import { scrapeMoodleAttempt } from "./moodle-attempt.mjs";
import { readMoodleReport } from "./moodle-report.mjs";
import { recentFile } from "./recent-file.mjs";

const chooseButton = document.querySelector("#choose");
const saveButton = document.querySelector("#save");
const createLink = document.querySelector("#create");
const status = document.querySelector("#status");
const filename = document.querySelector("#filename");
let capture;
let destination;
let busy = false;
let bulk = false;

function showStatus(message, error = false) {
  status.textContent = message;
  status.toggleAttribute("data-error", error);
}

function syncButtons() {
  chooseButton.disabled = busy || !capture;
  saveButton.disabled = busy || !destination;
}

async function readCapture(tabId, source, read, ...args) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId }, func: read, args: [source, ...args],
  });
  const result = injection?.result;
  if (!result || result.error) throw new Error(result?.error ?? "Moodle did not return any data.");
  return result;
}

async function collectReport(tabId, source) {
  const report = await readCapture(tabId, source, readMoodleReport);
  const attempts = [];
  let first;
  for (const [index, reviewUrl] of report.reviews.entries()) {
    showStatus(`Reading review ${index + 1} of ${report.reviews.length}…`);
    let result;
    try {
      result = await readCapture(tabId, source, scrapeMoodleAttempt, { reviewUrl, includePrompts: index === 0 });
      if (reportIdentity(result.source_report) !== reportIdentity(report.source_report)) {
        throw new Error("The review belongs to a different quiz.");
      }
    } catch (error) {
      throw new Error(`Could not read review ${index + 1} of ${report.reviews.length}. ${error.message}`);
    }
    first ??= result;
    attempts.push(result.attempt);
  }
  return { ...first, attempts };
}

function selectDestination(handle, operation) {
  destination = handle;
  filename.textContent = handle.name;
  saveButton.textContent = bulk ? "Save all attempts" : operation === "add" ? "Add attempt" : operation === "update" ? "Update attempt" : "Save attempt";
}

async function loadReview() {
  const params = new URLSearchParams(location.hash.slice(1));
  const tabId = Number(params.get("tab"));
  const source = params.get("source");
  if (!URL.canParse(source ?? "") || !Number.isInteger(tabId) || tabId < 1) {
    showStatus("Open a Moodle quiz results page or a student's attempt review and click the extension again.", true);
    return;
  }
  if (typeof window.showOpenFilePicker !== "function") {
    showStatus("This Chrome window does not support the local file picker.", true);
    return;
  }

  bulk = new URL(source).pathname.endsWith("/mod/quiz/report.php");
  if (bulk) document.querySelector("h1").textContent = "Export Moodle quiz results";
  try {
    capture = bulk ? await collectReport(tabId, source) : await readCapture(tabId, source, scrapeMoodleAttempt);
  } catch (error) {
    showStatus(error.message, true);
    return;
  }
  document.querySelector("#exam").textContent = capture.exam;
  if (bulk) document.querySelector("#student-label").textContent = "Reviews";
  document.querySelector("#student").textContent = bulk ? capture.attempts.length : capture.attempt.student;
  document.querySelector("#question-count").textContent = capture.attempt.questions.length;
  document.querySelector("#attempt").hidden = false;
  syncButtons();
  try {
    const initialExport = prepareExport('{"attempts":[]}', capture).data;
    const basename = capture.exam.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").slice(0, 120).trim() || "Moodle exam";
    createLink.download = `${basename}.json`;
    createLink.href = URL.createObjectURL(new Blob([JSON.stringify(initialExport, null, 2) + "\n"], {
      type: "application/json",
    }));
    createLink.hidden = false;
    showStatus("Create a JSON file for this exam or choose an existing one.");
  } catch (error) {
    showStatus(`${error.message} You can still choose a file that already contains the exam prompts.`, true);
  }
  busy = true;
  syncButtons();
  try {
    const handle = await recentFile(reportIdentity(capture.source_report));
    if (handle?.kind === "file") {
      selectDestination(handle);
      showStatus("Using the last JSON file saved for this exam.");
    }
  } catch {
    // The picker remains available if local browser storage is unavailable.
  } finally {
    busy = false;
    syncButtons();
  }
}

createLink.addEventListener("click", () => {
  showStatus("Chrome will download the new exam JSON file.");
});

chooseButton.addEventListener("click", async () => {
  busy = true;
  syncButtons();
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Moodle exam JSON", accept: { "application/json": [".json"] } }],
      excludeAcceptAllOption: true,
    });
    destination = undefined;
    filename.textContent = handle.name;
    const text = await (await handle.getFile()).text();
    const { operation } = prepareExport(text, capture);
    selectDestination(handle, operation);
    showStatus(bulk ? "The collected reviews are ready to save." : operation === "add" ? "This attempt will be added." : "This attempt will be updated.");
  } catch (error) {
    if (error.name !== "AbortError") showStatus(error.message, true);
  } finally {
    busy = false;
    syncButtons();
  }
});

saveButton.addEventListener("click", async () => {
  busy = true;
  syncButtons();
  try {
    const options = { mode: "readwrite" };
    if (await destination.queryPermission(options) !== "granted" && await destination.requestPermission(options) !== "granted") {
      showStatus("Grant write access to save to the selected JSON file.", true);
      return;
    }
    showStatus("Saving the JSON file…");
    await navigator.locks.request("moodle-attempt-export", () => saveExport(destination, capture));
    showStatus(`Saved ${destination.name}.`);
    await recentFile(reportIdentity(capture.source_report), destination).catch(() => {});
    const tab = await chrome.tabs.getCurrent().catch(() => null);
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  } catch (error) {
    showStatus(error.name === "NoModificationAllowedError" ? "The selected file is busy. Try saving again." : error.message, true);
  } finally {
    busy = false;
    syncButtons();
  }
});

void loadReview();
