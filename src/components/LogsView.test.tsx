import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, LogEvent } from "../api";
import { ClusterContext } from "../clusterContext";
import { FakeChannel, handlers } from "../test/tauriMock";
import { LogsView } from "./LogsView";

const pod: KubeObject = {
  metadata: { name: "api", namespace: "web", uid: "api" },
  spec: { containers: [{ name: "app" }] },
};
let channel: FakeChannel<LogEvent>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  handlers.stream_logs = ({ onEvent }) => { channel = onEvent; };
  window.getSelection()?.removeAllRanges();
});

afterEach(() => vi.unstubAllGlobals());

async function openLogs() {
  const view = render(<ClusterContext.Provider value="c"><LogsView source={{ pod }} /></ClusterContext.Provider>);
  const box = screen.getByLabelText("Logs");
  await emit(["2026-11-16T00:00:00Z first line"]);
  await waitFor(() => expect(box.textContent).toBe("first line"));
  return { ...view, box };
}

async function emit(lines: string[]) {
  act(() => channel.send({ type: "lines", lines }));
  await act(async () => { await new Promise(requestAnimationFrame); });
}

describe("copying live logs", () => {
  it("preserves selected DOM nodes and scroll position while incoming logs reorder and trim the live buffer", async () => {
    const { box } = await openLogs();
    fireEvent.pointerDown(box, { button: 0 });
    const node = box.firstChild;
    const range = document.createRange();
    range.selectNodeContents(box);
    window.getSelection()!.addRange(range);
    box.scrollTop = 12;

    await emit(["2026-11-15T00:00:00Z older line"]);
    await emit(Array.from({ length: 20_001 }, (_, i) => `2026-11-17T00:00:00Z latest ${i}`));

    expect(box.firstChild).toBe(node);
    expect(window.getSelection()!.toString()).toBe("first line");
    expect(box.scrollTop).toBe(12);
    expect(screen.getByTitle("Resume live logs")).toBeTruthy();

    fireEvent.click(screen.getByText("Latest"));
    expect(box.textContent).toContain("latest 20000");
    expect(box.textContent).not.toContain("first line");
    expect(screen.queryByText("Latest")).toBeNull();
  });

  it("keeps the view paused after scrolling back down until explicitly resumed", async () => {
    const { box } = await openLogs();
    Object.defineProperties(box, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
    fireEvent.scroll(box, { target: { scrollTop: 500 } });
    fireEvent.scroll(box, { target: { scrollTop: 800 } });
    await emit(["2026-11-16T00:00:01Z second line"]);
    expect(box.textContent).toBe("first line");

    fireEvent.click(screen.getByTitle("Resume live logs"));
    expect(box.textContent).toBe("first line\nsecond line");
    expect(box.scrollTop).toBe(1000);
  });

  it("pauses with the toolbar or keyboard and keeps filtering available", async () => {
    const { box } = await openLogs();
    fireEvent.click(screen.getByTitle("Pause live logs"));
    await emit(["2026-11-16T00:00:01Z second line"]);
    expect(box.textContent).toBe("first line");
    fireEvent.change(screen.getByPlaceholderText("Filter…"), { target: { value: "second" } });
    expect(box.textContent).toBe("");
    fireEvent.click(screen.getByText("Latest"));
    expect(box.textContent).toBe("second line");

    fireEvent.keyDown(box, { key: "a", metaKey: true });
    await emit(["2026-11-16T00:00:02Z second match"]);
    expect(box.textContent).toBe("second line");
  });

  it("copies the displayed snapshot and reports clipboard failures", async () => {
    const { box } = await openLogs();
    fireEvent.click(screen.getByTitle("Pause live logs"));
    await emit(["2026-11-16T00:00:01Z second line"]);
    // jsdom has no rendered innerText.
    Object.defineProperty(box, "innerText", { get: () => box.textContent });
    fireEvent.click(screen.getByTitle("Copy shown lines"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied logs"));
    expect(writeText).toHaveBeenCalledWith("first line");

    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    fireEvent.click(screen.getByTitle("Copy shown lines"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Clipboard denied"));
  });

  it("resets the paused snapshot when switching the log source", async () => {
    const { box, rerender } = await openLogs();
    fireEvent.click(screen.getByTitle("Pause live logs"));
    const next = { ...pod, metadata: { ...pod.metadata, name: "worker" } };
    rerender(<ClusterContext.Provider value="c"><LogsView source={{ pod: next }} /></ClusterContext.Provider>);
    expect(box.textContent).toBe("");
    expect(screen.queryByText("Latest")).toBeNull();
    await emit(["2026-11-16T00:00:02Z worker line"]);
    expect(box.textContent).toBe("worker line");
  });
});
