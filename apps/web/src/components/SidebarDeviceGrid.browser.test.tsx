import { useState, type ReactNode } from "react";
import { act, render } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { SidebarDeviceGrid, type SidebarDeviceCard } from "./SidebarDeviceGrid";

// Keep tooltip portals out of this renderer; exercise the actual grid and its state.
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

const cards: SidebarDeviceCard[] = [null, "a", "b", "c", "d", "e"].map((key) => ({
  key,
  label: key ?? "All environments",
  machine: null,
  connectionPhase: null,
  countsState: { kind: "unknown" },
}));

function Grid() {
  const [selectedKey, onSelect] = useState<string | null>(null);
  return <SidebarDeviceGrid cards={cards} selectedKey={selectedKey} onSelect={onSelect} />;
}

function cardButtons(host: HTMLElement) {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"));
}
function toggleButton(host: HTMLElement) {
  return host.querySelector<HTMLButtonElement>("button:not([aria-pressed])")!;
}

describe("device grid interactions", () => {
  it("starts on all devices and returns there after a device selection", async () => {
    await using screen = await render(<Grid />);
    const host = screen.container;
    const selected = () =>
      cardButtons(host).filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(selected().map((button) => button.getAttribute("aria-label"))).toEqual([
      "All environments: Counts unknown",
    ]);
    await act(async () => {
      cardButtons(host)[1]!.click();
    });
    expect(selected().map((button) => button.getAttribute("aria-label"))).toEqual([
      "a: Counts unknown",
    ]);
    await act(async () => {
      cardButtons(host)[0]!.click();
    });
    expect(selected().map((button) => button.getAttribute("aria-label"))).toEqual([
      "All environments: Counts unknown",
    ]);
  });

  it("can expand and collapse repeatedly while keeping the selected device visible", async () => {
    await using screen = await render(<Grid />);
    const host = screen.container;
    expect(cardButtons(host)).toHaveLength(4);
    await act(async () => {
      toggleButton(host).click();
    });
    expect(cardButtons(host)).toHaveLength(6);
    await act(async () => {
      cardButtons(host)[5]!.click();
    });
    await act(async () => {
      toggleButton(host).click();
    });
    expect(cardButtons(host)).toHaveLength(4);
    expect(cardButtons(host).at(-1)!.getAttribute("aria-label")).toBe("e: Counts unknown");
    expect(cardButtons(host).at(-1)!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      toggleButton(host).click();
    });
    expect(cardButtons(host)).toHaveLength(6);
  });
});
