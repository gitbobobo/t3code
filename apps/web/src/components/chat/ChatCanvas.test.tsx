// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { PopoverCreateHandle } from "../ui/popover";
import { useRightPanelStore } from "../../rightPanelStore";
import { ChatCanvas } from "./ChatCanvas";
import { useChatCanvas } from "./ChatCanvasContext";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const threadRef = {
  environmentId: EnvironmentId.make("canvas-test"),
  threadId: ThreadId.make("details-test"),
};
const preview: ChatCanvasPreview = {
  key: "device:test",
  width: 240,
  position: { x: 948, y: 12 },
  source: { width: 240, height: 700 },
  lastInteraction: "drag",
};
let root: Root;
let host: HTMLDivElement;
let canvasWidth = 1200;
let layout: NonNullable<ReturnType<typeof useChatCanvas>>["layout"];
const resizeCallbacks = new Map<Element, () => void>();

function Preview({ player }: { player: ChatCanvasPreview | null }) {
  const canvas = useChatCanvas()!;
  const { reportPreview, clearPreview } = canvas;
  useLayoutEffect(() => {
    if (player) reportPreview(player);
    else clearPreview(preview.key);
  }, [player, reportPreview, clearPreview]);
  useLayoutEffect(() => {
    layout = canvas.layout;
  }, [canvas.layout]);
  return null;
}

function Workspace({ player = preview }: { player?: ChatCanvasPreview | null }) {
  const [handle] = useState(PopoverCreateHandle);
  return (
    <ChatCanvas composerOverlayElement={null}>
      <Preview player={player} />
      <ThreadDetailsCard
        threadRef={threadRef}
        anchor={{ current: null }}
        handle={handle}
        onPresentationChange={() => {}}
      >
        {() => <div>Thread controls</div>}
      </ThreadDetailsCard>
    </ChatCanvas>
  );
}

beforeEach(() => {
  canvasWidth = 1200;
  resizeCallbacks.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly targets = new Set<Element>();
      constructor(readonly callback: () => void) {}
      observe(target: Element) {
        this.targets.add(target);
        resizeCallbacks.set(target, this.callback);
      }
      unobserve(target: Element) {
        resizeCallbacks.delete(target);
      }
      disconnect() {
        for (const target of this.targets) resizeCallbacks.delete(target);
      }
    },
  );
  const getComputedStyle = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (element: Element) => {
    const styles = getComputedStyle(element);
    if (
      element.parentElement?.hasAttribute("data-chat-canvas") &&
      element.getAttribute("aria-hidden") === "true"
    ) {
      return new Proxy(styles, {
        get(target, key) {
          if (key === "width") return "768px";
          if (key === "minWidth") return "640px";
          if (key === "paddingLeft") return "20px";
          return Reflect.get(target, key);
        },
      });
    }
    return styles;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-chat-canvas") ? canvasWidth : 327;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-chat-canvas") ? 600 : 327;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(327);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  useRightPanelStore.getState().removeThread(threadRef);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("details card and floating preview layout", () => {
  it("settles when clearing a tall preview changes the chat lane", async () => {
    await act(() => root.render(<Workspace />));
    const card = host.querySelector<HTMLElement>("[data-thread-details-panel='inline']")!;
    expect(card.style.width).toBe("280px");
    expect(layout.chat.width).toBe(667);
    expect(layout.frame!.x + layout.frame!.width).toBeLessThanOrEqual(
      Number.parseFloat(card.style.left) - 12,
    );
    expect(layout.overlapsDetailsCard).toBe(false);
  });

  it("reflows on window resize and restores the layout after reopening the card", async () => {
    await act(() => root.render(<Workspace />));
    await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", false));
    expect(host.querySelector("[data-thread-details-panel='inline']")).toBeNull();
    expect(layout.frame!.x).toBe(948);
    await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadRef, "inline", true));
    expect(layout.chat.width).toBe(667);
    canvasWidth = 1600;
    await act(() => resizeCallbacks.get(host.querySelector("[data-chat-canvas]")!)!());
    expect(
      host.querySelector<HTMLElement>("[data-thread-details-panel='inline']")!.style.width,
    ).toBe("280px");
    await act(() => root.render(<Workspace player={null} />));
    expect(layout.frame).toBeNull();
    expect(layout.chat.width).toBe(768);
    expect(layout.chat.insetEnd).toBe(0);
  });
});
