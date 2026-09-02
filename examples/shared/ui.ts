export function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Example is missing #${id}`);
  return value;
}

export function createLogger(log: HTMLPreElement): {
  write(message: string): void;
  writeError(error: unknown): void;
} {
  const write = (message: string): void => {
    log.textContent += `\n${message}`;
    log.scrollTop = log.scrollHeight;
  };
  return {
    write,
    writeError(error: unknown): void {
      write(errorMessage(error));
      console.error(error);
    },
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
