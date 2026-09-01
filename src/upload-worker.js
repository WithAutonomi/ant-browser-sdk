import initAntCore, { BrowserFileEncryptor } from "./wasm/ant_core.js";
import { deleteStagedRecords, putStagedRecord } from "./internal/record-store.js";

const ready = initAntCore();

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "stage-file") return;
  const { blob, name, contentType, sessionId } = event.data;
  let storedRecords = 0;
  let encryptor;
  try {
    await ready;
    if (typeof FileReaderSync !== "function") {
      throw new Error("This browser cannot read files inside an upload worker");
    }
    const reader = new FileReaderSync();
    encryptor = new BrowserFileEncryptor(blob.size, (offset, length) =>
      new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length))),
    );
    self.postMessage({
      type: "progress",
      message: `Self-encrypting ${name} without loading it into page memory`,
    });

    while (true) {
      const record = encryptor.nextRecord();
      if (record === undefined) break;
      await putStagedRecord(sessionId, storedRecords, record.content.slice());
      storedRecords += 1;
      self.postMessage({
        type: "progress",
        message: `Encrypted and staged record ${storedRecords}`,
      });
    }
    const staged = encryptor.finish(name, contentType);
    if (staged.records.length !== storedRecords) {
      throw new Error(
        `Encryption produced ${staged.records.length} records but staged ${storedRecords}`,
      );
    }
    self.postMessage({ type: "complete", staged });
  } catch (error) {
    try {
      await deleteStagedRecords(sessionId, storedRecords);
    } catch {
      // Preserve the encryption or storage error.
    }
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    encryptor?.free();
  }
});
