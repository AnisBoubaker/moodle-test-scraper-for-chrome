# Moodle exam exports

## Chrome extension

1. In desktop Chrome, open `chrome://extensions`, turn on **Developer mode**, and choose **Load unpacked**.
2. Select this workspace's `chrome-extension` folder.
3. Open the quiz’s **Results** overview and set the page size so it lists every student you want to export. The extension follows the review links on that page. You can also open an individual attempt with **Relecture de cette tentative**.
4. Click **Moodle Attempt Exporter** from Chrome’s Extensions menu. Once the reviews are collected, click **Create JSON file** to download a new exam file with the prompts and attempts.
5. To update an existing exam file, click **Choose JSON file**, then save. The extension remembers the last file it saved for that quiz and closes its export tab after a successful write. Chrome asks for permission when the file needs a fresh write grant.

The extension captures the open review's answers, CodeRunner feedback, and response history with the student's name as Moodle displays it. It updates by exact student name within the selected exam file and checks the quiz ID when the file has a `source_report` URL. Older files can also match a record by its Moodle attempt ID. The saved JSON starts with `exam` and `source_report`, puts `student` first in each record, and omits `attempt_id`.

If you created an exam file with an older version of the extension, select it from the same student's review and click **Update attempt** to fill in the missing prompts.

Finish saving attempts before using the Python script to pseudonymize the names.

## Anonymize Moodle exam exports

Use Python 3.8 or newer. The script runs offline with the Python standard library.

Run this command from the workspace root.

```sh
python3 anonymize.py
```

The script looks for Moodle exam JSON files in section folders. It creates `anonymization_key.csv` first, then rewrites the JSON files **in place**, replacing each `attempts[].student` value with `student 1`, `student 2`, and so on.

Each section starts its own numbering. A name gets the same label in the all evaluations within that section. The full folder name identifies the section. Matching uses the exact name recorded by Moodle.

The CSV has three columns, `section`, `student_id`, and `student_name`. Keep it private because it contains the original names. Use the same CSV when rerunning the script or adding exports. Existing labels are reused and new names receive the next available number in their section.

To process a single section with the same workspace key, pass its folder.

```sh
python3 anonymize.py folder_name
```

Pass a different path with `--key` to store the key in a private local folder. If a run is interrupted after the key is saved, rerun with that same key. If a forced stop leaves a `.lock` file next to the key, remove it after verifying that no anonymization process is running.

This is reversible pseudonymization of the student-name field. Answers and response histories can contain identifying text.
