import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import { PopoverCreateHandle } from "../ui/popover";
import { useRightPanelStore } from "../../rightPanelStore";
import { ChatCanvas } from "./ChatCanvas";
import { createChatCanvasStore } from "./canvasStore";
import { useChatCanvas } from "./ChatCanvasContext";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

vi.mock("../../lib/observeResize", () => ({
  observeResize: (elements: Element | readonly Element[], callback: () => void) => {
    const targets = Array.isArray(elements) ? elements : [elements];
    for (const target of targets) resizeCallbacks.set(target, callback);
    return () => {
      for (const target of targets) resizeCallbacks.delete(target);
    };
  },
}));

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
let canvasWidth = 1200;
let layout: NonNullable<ReturnType<typeof useChatCanvas>>["layout"];
const resizeCallbacks = new Map<Element, () => void>();

function Preview() {
  const canvas = useChatCanvas()!;
  useLayoutEffect(() => {
    layout = canvas.layout;
  }, [canvas.layout]);
  return null;
}

function Workspace({ player = preview }: { player?: ChatCanvasPreview | null }) {
  const [handle] = useState(PopoverCreateHandle);
  const [store] = useState(createChatCanvasStore);
  return (
    <ChatCanvas store={store} threadRef={threadRef} preview={player} composerOverlayElement={null}>
      <Preview />
      <ThreadDetailsCard
        contentKey="test"
        threadRef={threadRef}
        anchor={{ current: null }}
        handle={handle}
      >
        {() => <div>Thread controls</div>}
      </ThreadDetailsCard>
    </ChatCanvas>
  );
}

function setup() {
  const mocks: Disposable[] = [];
  canvasWidth = 1200;
  resizeCallbacks.clear();
  const getComputedStyle = window.getComputedStyle.bind(window);
  mocks.push(
    vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
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
    }),
  );
  mocks.push(
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-chat-canvas") ? canvasWidth : 327;
    }),
  );
  mocks.push(
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-chat-canvas") ? 600 : 327;
    }),
  );
  mocks.push(vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(327));
  return {
    [Symbol.dispose]() {
      for (const mock of mocks.reverse()) mock[Symbol.dispose]();
      useRightPanelStore.getState().removeThread(threadRef);
    },
  };
}

describe("details card and floating preview layout", () => {
  it("settles when clearing a tall preview changes the chat lane", async () => {
    using _fixture = setup();
    await using screen = await render(<Workspace />);
    const host = screen.container;
    const card = host.querySelector<HTMLElement>("[data-thread-details-panel='inline']")!;
    expect(card.style.width).toBe("280px");
    expect(layout.chat.width).toBe(667);
    expect(layout.frame!.x + layout.frame!.width).toBeLessThanOrEqual(
      canvasWidth - Number.parseFloat(card.style.right) - Number.parseFloat(card.style.width) - 12,
    );
    expect(layout.overlapsDetailsCard).toBe(false);
  });

  it("reflows on window resize and restores the layout after reopening the card", async () => {
    using _fixture = setup();
    await using screen = await render(<Workspace />);
    const host = screen.container;
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
    await screen.rerender(<Workspace player={null} />);
    expect(layout.frame).toBeNull();
    expect(layout.chat.width).toBe(768);
    expect(layout.chat.insetEnd).toBe(0);
  });
});
