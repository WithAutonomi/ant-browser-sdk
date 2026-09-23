import { describe, expect, it, vi } from "vitest";
import { WindowStager, type EncryptedRecord } from "../src/internal/window-stager.js";

function records(...sizes: number[]): EncryptedRecord[] {
  return sizes.map((size, index) => ({ address: String(index).repeat(64), content: new Uint8Array(size) }));
}

function stager(
  source: EncryptedRecord[],
  put = vi.fn(async (_index: number, _content: Uint8Array) => {}),
  withholdDataMap = false,
) {
  const pending = [...source];
  const next = vi.fn(() => pending.shift());
  return { stager: new WindowStager(next, put, { withholdDataMap }), next, put };
}

const quotaExceeded = () => Object.assign(new Error("quota"), { name: "QuotaExceededError" });

describe("windowed record staging", () => {
  it("fills windows up to the byte budget and opens the next with the record that did not fit", async () => {
    const { stager: windows, next, put } = stager(records(3, 3, 3, 2));
    expect(await windows.stage({ bytes: 7 })).toEqual({
      firstIndex: 0, records: [{ address: "0".repeat(64), size: 3 }, { address: "1".repeat(64), size: 3 }], complete: false,
    });
    expect(put.mock.calls.map(([index]) => index)).toEqual([0, 1]);
    expect(await windows.stage({ bytes: 7 })).toMatchObject({ firstIndex: 2, records: [{ size: 3 }, { size: 2 }], complete: true });
    expect(put.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3]);
    // Each record is encrypted once; the held-back record is not produced again.
    expect(next).toHaveBeenCalledTimes(5);
  });

  it("stages a whole file in one window when the budget is unbounded", async () => {
    const { stager: windows } = stager(records(4, 4, 4));
    expect(await windows.stage({ bytes: Number.POSITIVE_INFINITY }))
      .toMatchObject({ firstIndex: 0, records: [{}, {}, {}], complete: true });
  });

  it("ends a window early when IndexedDB runs out of quota before the estimate", async () => {
    const put = vi.fn(async (index: number) => { if (index === 1) throw quotaExceeded(); });
    const { stager: windows } = stager(records(3, 3, 3), put);
    expect(await windows.stage({ bytes: 100 })).toMatchObject({ records: [{}], complete: false });
    put.mockResolvedValue(undefined);
    expect(await windows.stage({ bytes: 100 })).toMatchObject({ firstIndex: 1, records: [{}, {}], complete: true });
  });

  it("fails rather than stage an empty window", async () => {
    await expect(stager(records(8)).stager.stage({ bytes: 7 })).rejects.toThrow(/Not enough browser storage/);
    const put = vi.fn(async () => { throw quotaExceeded(); });
    await expect(stager(records(3), put).stager.stage({ bytes: 7 })).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("restores a checkpoint's exact window after skipping stored records", async () => {
    const { stager: windows, put } = stager(records(3, 3, 3, 3, 3));
    const skipped = vi.fn();
    windows.skip(2, skipped);
    expect(skipped).toHaveBeenLastCalledWith(2);
    expect(put).not.toHaveBeenCalled();
    expect(await windows.stage({ records: 2 })).toMatchObject({ firstIndex: 2, records: [{}, {}], complete: false });
    // An exact window ignores quota errors' early-end rule and fails instead.
    put.mockRejectedValueOnce(quotaExceeded());
    await expect(windows.stage({})).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  it("withholds a private upload's DataMap record instead of staging it", async () => {
    const source = records(3, 3, 3, 2);
    const { stager: windows, put } = stager(source, undefined, true);
    const window = await windows.stage({ bytes: 100 });
    expect(window).toMatchObject({ firstIndex: 0, records: [{}, {}, {}], complete: true });
    expect(window.dataMap).toBe(source[3]!.content);
    expect(put.mock.calls.map(([index]) => index)).toEqual([0, 1, 2]);
  });

  it("completes a full window with the withheld DataMap rather than open another", async () => {
    const { stager: windows } = stager(records(3, 3, 2), undefined, true);
    expect(await windows.stage({ bytes: 6 })).toMatchObject({ records: [{}, {}], complete: true, dataMap: expect.any(Uint8Array) });
  });

  it("rejects a checkpoint window beyond the end of the selected file", () => {
    expect(() => stager(records(3)).stager.skip(2)).toThrow(/ended before the resumed upload window/);
  });
});
