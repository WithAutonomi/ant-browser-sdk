import { AutonomiError, wrapError } from "./errors.js";
import type { DownloadResult, SaveOptions, SaveResult } from "./types.js";

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<{
      write(data: Blob): Promise<void>;
      close(): Promise<void>;
      abort(reason?: unknown): Promise<void>;
    }>;
  }>;
}

/** Save a completed download through the File System Access API or an anchor fallback. */
export async function saveDownload(
  download: DownloadResult,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const name = options.suggestedName ?? download.file.name;
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new AutonomiError("SAVE_FAILED", "Saving a file requires a browser document");
  }
  const browserWindow = window as SaveFilePickerWindow;
  try {
    if (options.useFilePicker !== false && browserWindow.showSaveFilePicker) {
      const handle = await browserWindow.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      try {
        await writable.write(download.blob);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort(error);
        } catch {
          // Keep the original write failure.
        }
        throw error;
      }
      return { method: "file-picker", name };
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
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw wrapError("SAVE_FAILED", `Could not save ${name}`, error);
  }
}
