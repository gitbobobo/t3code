import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ClipboardApiUnavailableError, writeTextToClipboard } from "./useCopyToClipboard";

// The unit project has no DOM; stub a minimal document so the execCommand
// fallback can be exercised. `result` controls whether execCommand "succeeds".
function stubDocumentWithExecCommand(result: boolean) {
  const textarea = {
    value: "",
    style: {} as Record<string, string>,
    select: vi.fn(),
  };
  const execCommand = vi.fn().mockReturnValue(result);
  vi.stubGlobal("document", {
    createElement: vi.fn(() => textarea),
    execCommand,
    getSelection: vi.fn(() => ({ rangeCount: 0, removeAllRanges: vi.fn(), addRange: vi.fn() })),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  });
  return { execCommand, textarea };
}

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports unavailable when neither the Async Clipboard API nor the legacy fallback work", async () => {
    vi.stubGlobal("navigator", {});
    stubDocumentWithExecCommand(false);

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("falls back to the legacy clipboard path when the Async Clipboard API is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const { execCommand, textarea } = stubDocumentWithExecCommand(true);

    await expect(writeTextToClipboard("copied via fallback", "plan")).resolves.toBe(true);
    expect(textarea.value).toBe("copied via fallback");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to the legacy clipboard path when the Async Clipboard API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubDocumentWithExecCommand(true);

    await expect(writeTextToClipboard("copied via fallback", "plan")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("copied via fallback");
  });

  it("throws when the Async Clipboard API rejects and the legacy fallback also fails", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubDocumentWithExecCommand(false);

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "error-message",
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("keeps empty values as a no-op", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
