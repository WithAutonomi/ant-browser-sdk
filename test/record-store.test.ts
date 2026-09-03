import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  deleteStagedRecords,
  deleteStagedSession,
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

  it("clears all records left by a terminated staging worker", async () => {
    const session = crypto.randomUUID();
    const otherSession = crypto.randomUUID();
    await putStagedRecord(session, 0, Uint8Array.of(1));
    await putStagedRecord(session, 7, Uint8Array.of(2));
    await putStagedRecord(otherSession, 0, Uint8Array.of(3));

    await deleteStagedSession(session);

    await expect(getStagedRecord(session, 0)).rejects.toThrow(/is missing/);
    await expect(getStagedRecord(session, 7)).rejects.toThrow(/is missing/);
    expect(await getStagedRecord(otherSession, 0)).toEqual(Uint8Array.of(3));
    await deleteStagedSession(otherSession);
  });
});
