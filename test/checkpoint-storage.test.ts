import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import { saveUploadCheckpoint, storedUploadCheckpoints, deleteUploadCheckpoint } from "../src/internal/record-store.js";
it("retains the latest journal until explicit completion cleanup", async () => {
  await saveUploadCheckpoint("journal-test", "prepared");
  await saveUploadCheckpoint("journal-test", "submitted");
  expect(await storedUploadCheckpoints()).toContainEqual({ id: "journal-test", checkpoint: "submitted" });
  await deleteUploadCheckpoint("journal-test");
  expect((await storedUploadCheckpoints()).some(entry => entry.id === "journal-test")).toBe(false);
});
