import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, ResourceInfo } from "../api";
import { eventText } from "../clipboard";
import { ClusterContext } from "../clusterContext";
import { handlers } from "../test/tauriMock";
import type { DockActions } from "./DetailsPanel";
import { ResourceTable } from "./ResourceTable";

const R = (kind: string, plural: string): ResourceInfo => ({ key: `/v1/${plural}`, group: "", version: "v1", kind, plural, namespaced: true });
const EVENTS = R("Event", "events");
const ACCOUNTS = R("ServiceAccount", "serviceaccounts");

const event: KubeObject = {
  kind: "Event",
  type: "Warning",
  reason: "BackOff",
  message: "Back-off restarting failed container api",
  count: 3,
  involvedObject: { kind: "Pod", name: "api-7c9d", namespace: "payments" },
  metadata: { name: "api-7c9d.17f", namespace: "payments", uid: "e1" },
};

const actions = {} as DockActions;
let clipboard = "";

function renderTable(resource: ResourceInfo, items: KubeObject[], extra: Partial<Parameters<typeof ResourceTable>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ClusterContext.Provider value="c">
      <ResourceTable
        resource={resource}
        watch={{ items, loading: false }}
        allNamespaces
        onSelect={onSelect}
        notify={() => {}}
        actions={actions}
        {...extra}
      />
    </ClusterContext.Provider>,
  );
  return { onSelect };
}

/** Selects the text of an element, as dragging the mouse over it would. */
function selectTextOf(el: Element) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

const menuLabels = () => [...document.querySelectorAll(".ctx-menu > .ctx-item > .grow")].map((e) => e.textContent);
const openCopySubmenu = () => [...document.querySelectorAll(".ctx-item.has-sub .ctx-sub .ctx-item")];

beforeEach(() => {
  clipboard = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async (t: string) => void (clipboard = t)) },
  });
  window.getSelection()?.removeAllRanges();
});

describe("eventText", () => {
  it("puts an event on one line, like kubectl get events", () => {
    expect(eventText(event)).toBe("Warning BackOff Pod/payments/api-7c9d: Back-off restarting failed container api");
  });
});

describe("selecting and copying in lists", () => {
  it("a click opens the details, but selecting text with the mouse doesn't", () => {
    const { onSelect } = renderTable(EVENTS, [event]);
    const cell = screen.getByText("Back-off restarting failed container api");

    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledTimes(1);

    selectTextOf(cell);
    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("right-click on selected text offers Copy first", async () => {
    renderTable(EVENTS, [event]);
    const cell = screen.getByText("Back-off restarting failed container api");
    selectTextOf(cell);
    fireEvent.contextMenu(cell);

    expect(menuLabels()[0]).toBe("Copy");
    fireEvent.click(document.querySelector(".ctx-menu > .ctx-item")!);
    await waitFor(() => expect(clipboard).toBe("Back-off restarting failed container api"));
  });

  it("copies an event's message, or the whole event on one line", async () => {
    renderTable(EVENTS, [event]);
    fireEvent.contextMenu(screen.getByText("BackOff"));
    const labels = openCopySubmenu().map((e) => e.textContent);
    expect(labels).toEqual(["Name", "Namespace/name", "Message", "Event (one line)", "YAML"]);

    fireEvent.click(openCopySubmenu().find((e) => e.textContent === "Message")!);
    await waitFor(() => expect(clipboard).toBe(event.message));
  });

  it("copies an object's YAML", async () => {
    handlers.get_yaml = ({ name }: { name: string }) => `kind: Event\nmetadata:\n  name: ${name}\n`;
    renderTable(EVENTS, [event]);
    fireEvent.contextMenu(screen.getByText("BackOff"));
    fireEvent.click(openCopySubmenu().find((e) => e.textContent === "YAML")!);
    await waitFor(() => expect(clipboard).toContain("name: api-7c9d.17f"));
  });

  it("offers Kubeconfig on service accounts", () => {
    const openKubeconfig = vi.fn();
    const account: KubeObject = { kind: "ServiceAccount", metadata: { name: "deployer", namespace: "ci", uid: "sa1" } };
    renderTable(ACCOUNTS, [account], { openKubeconfig });
    fireEvent.contextMenu(screen.getByText("deployer"));
    fireEvent.click(screen.getByText("Kubeconfig"));
    expect(openKubeconfig).toHaveBeenCalledWith(account);
  });
});
