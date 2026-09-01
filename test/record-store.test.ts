import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  deleteStagedRecords,
  getStagedRecord,
  putStagedRecord,
} from "../src/internal/record-store.js";

describe("upload record staging", () => {
  it("stores, retrieves, and clears isolated session records", async () => {
    const session = crypto.randomUUID();
    const content = Uint8Array.of(1, 3, 3, 7);
    await putStagedRecord(session, 0, content);
    expect(await getStagedRecord(session, 0)).toEqual(content);
    await deleteStagedRecords(session, 1);
    await expect(getStagedRecord(session, 0)).rejects.toThrow(/is missing/);
  });
});
