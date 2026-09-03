import { AutonomiError, wrapError } from "./errors.js";
import { abortable, isAbort, throwIfAborted } from "./internal/abort.js";
import type {
  DownloadResult,
  SaveFileHandle,
  SaveFileWritable,
  SaveOptions,
  SaveResult,
} from "./types.js";

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<SaveFileHandle>;
}

/** Save a completed download through the File System Access API or an anchor fallback. */
export async function saveDownload(
  download: DownloadResult,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const name = options.suggestedName ?? download.file.name;
  try {
    throwIfAborted(options.signal);
    const handle =
      options.fileHandle ??
      (options.useFilePicker === false
        ? undefined
        : await requestSaveFileHandle(name, options.signal));
    if (handle) {
      throwIfAborted(options.signal);
      const writable = await abortable(
        handle.createWritable(),
        options.signal,
        undefined,
        (lateWritable) => quietlyAbortWritable(lateWritable, options.signal?.reason),
      );
      try {
        await abortable(
          writable.write(download.blob),
          options.signal,
          (reason) => quietlyAbortWritable(writable, reason),
        );
        await abortable(
          writable.close(),
          options.signal,
          (reason) => quietlyAbortWritable(writable, reason),
        );
      } catch (error) {
        try {
          await writable.abort(error);
        } catch {
          // Keep the original write failure.
        }
        throw error;
      }
      return { method: "file-picker", name: handle.name ?? name };
    }

    if (typeof document === "undefined") {
      throw new AutonomiError("SAVE_FAILED", "Saving a file requires a browser document");
    }

    const url = URL.createObjectURL(download.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { method: "download", name };
  } catch (error) {
    if (isAbort(error, options.signal)) throw error;
    throw wrapError("SAVE_FAILED", `Could not save ${name}`, error);
  }
}

/** Request a destination while transient user activation is still available. */
export async function requestSaveFileHandle(
  suggestedName?: string,
  signal?: AbortSignal,
): Promise<SaveFileHandle | undefined> {
  throwIfAborted(signal);
  if (typeof window === "undefined") return undefined;
  const browserWindow = window as SaveFilePickerWindow;
  if (!browserWindow.showSaveFilePicker) return undefined;

  try {
    return await abortable(
      browserWindow.showSaveFilePicker(
        suggestedName === undefined ? {} : { suggestedName },
      ),
      signal,
    );
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    // A picker invoked without transient activation cannot open. The ordinary
    // browser download remains usable, so let the caller take that path.
    if (hasErrorName(error, "SecurityError")) return undefined;
    throw wrapError("SAVE_FAILED", "Could not choose a save destination", error);
  }
}

function hasErrorName(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === name
  );
}

function quietlyAbortWritable(writable: SaveFileWritable, reason: unknown): void {
  void writable.abort(reason).catch(() => undefined);
}
