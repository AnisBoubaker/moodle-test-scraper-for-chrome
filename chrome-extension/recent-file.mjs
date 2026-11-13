export async function recentFile(report, handle) {
  const open = indexedDB.open("moodle-attempt-exporter", 1);
  const database = await new Promise((resolve, reject) => {
    open.onupgradeneeded = () => open.result.createObjectStore("destinations");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction("destinations", handle ? "readwrite" : "readonly");
      const store = transaction.objectStore("destinations");
      const request = handle ? store.put(handle, report) : store.get(report);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}
