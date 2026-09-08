import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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

let renderer: ReactTestRenderer;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<Grid />);
  });
});
afterEach(async () => {
  await act(async () => {
    renderer.unmount();
  });
  vi.unstubAllGlobals();
});

function cardButtons() {
  return renderer.root
    .findAllByType("button")
    .filter((button) => button.props["aria-pressed"] !== undefined);
}
function toggleButton() {
  return renderer.root
    .findAllByType("button")
    .find((button) => button.props["aria-pressed"] === undefined)!;
}

describe("device grid interactions", () => {
  it("starts on all devices and returns there after a device selection", async () => {
    const selected = () => cardButtons().filter((button) => button.props["aria-pressed"]);
    expect(selected().map((button) => button.props["aria-label"])).toEqual([
      "All environments: Counts unknown",
    ]);
    await act(async () => {
      cardButtons()[1]!.props.onClick();
    });
    expect(selected().map((button) => button.props["aria-label"])).toEqual(["a: Counts unknown"]);
    await act(async () => {
      cardButtons()[0]!.props.onClick();
    });
    expect(selected().map((button) => button.props["aria-label"])).toEqual([
      "All environments: Counts unknown",
    ]);
  });

  it("can expand and collapse repeatedly while keeping the selected device visible", async () => {
    expect(cardButtons()).toHaveLength(4);
    await act(async () => {
      toggleButton().props.onClick();
    });
    expect(cardButtons()).toHaveLength(6);
    await act(async () => {
      cardButtons()[5]!.props.onClick();
    });
    await act(async () => {
      toggleButton().props.onClick();
    });
    expect(cardButtons()).toHaveLength(4);
    expect(cardButtons().at(-1)!.props["aria-label"]).toBe("e: Counts unknown");
    expect(cardButtons().at(-1)!.props["aria-pressed"]).toBe(true);
    await act(async () => {
      toggleButton().props.onClick();
    });
    expect(cardButtons()).toHaveLength(6);
  });
});
