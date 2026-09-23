import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  deleteStagedRecordRange,
  deleteStagedSession,
  getStagedRecord,
  putStagedRecord,
} from "../src/internal/record-store.js";

describe("upload record staging", () => {
  it("stores, retrieves, and clears one window of a session", async () => {
    const session = crypto.randomUUID();
    for (const index of [0, 1, 2]) await putStagedRecord(session, index, Uint8Array.of(index, 3, 3, 7));
    expect(await getStagedRecord(session, 1)).toEqual(Uint8Array.of(1, 3, 3, 7));
    await deleteStagedRecordRange(session, 0, 2);
    await expect(getStagedRecord(session, 0)).rejects.toThrow(/is missing/);
    await expect(getStagedRecord(session, 1)).rejects.toThrow(/is missing/);
    expect(await getStagedRecord(session, 2)).toEqual(Uint8Array.of(2, 3, 3, 7));
    await deleteStagedSession(session);
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
