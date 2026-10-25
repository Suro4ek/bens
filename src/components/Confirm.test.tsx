/// <reference types="vite/client" />
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, ResourceInfo } from "../api";
import { ClusterContext } from "../clusterContext";
import { handlers } from "../test/tauriMock";
import { ask, askDelete, ConfirmHost } from "./Confirm";
import type { DockActions } from "./DetailsPanel";
import { ResourceTable } from "./ResourceTable";

const R = (kind: string, plural: string, namespaced = true): ResourceInfo => ({ key: `/v1/${plural}`, group: "", version: "v1", kind, plural, namespaced });
const PODS = R("Pod", "pods");
const NAMESPACES = R("Namespace", "namespaces", false);
const pod = (name: string, namespace = "payments"): KubeObject => ({ kind: "Pod", metadata: { name, namespace, uid: `uid-${name}` } });

const button = (label: string) => screen.getByRole("button", { name: label }) as HTMLButtonElement;

describe("confirmation dialog", () => {
  beforeEach(() => render(<ConfirmHost />));

  it("resolves with the answer: OK, Cancel, Escape or a click outside", async () => {
    let answer = ask({ title: "Roll back?", ok: "Roll back" });
    fireEvent.click(await screen.findByText("Roll back"));
    await expect(answer).resolves.toBe(true);

    answer = ask({ title: "Roll back?" });
    fireEvent.click(await screen.findByText("Cancel"));
    await expect(answer).resolves.toBe(false);

    answer = ask({ title: "Roll back?" });
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    await expect(answer).resolves.toBe(false);

    answer = ask({ title: "Roll back?" });
    fireEvent.mouseDown((await screen.findByRole("alertdialog")).parentElement!);
    await expect(answer).resolves.toBe(false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("focuses Cancel for destructive actions, so Enter doesn't delete", async () => {
    act(() => void askDelete(PODS, [pod("api-1")], "prod-eu"));
    expect(await screen.findByText("Delete Pod api-1?")).toBeTruthy();
    expect(document.activeElement).toBe(button("Cancel"));
    // Where it is, so a wrong cluster or namespace stands out.
    expect(screen.getByRole("alertdialog").textContent).toContain("In namespace payments, cluster prod-eu.");
  });

  it("lists the objects of a bulk delete", async () => {
    act(() => void askDelete(PODS, [pod("api-1"), pod("web-1", "web")], "prod-eu"));
    expect(await screen.findByText("Delete 2 Pods?")).toBeTruthy();
    expect([...document.querySelectorAll(".confirm-list li")].map((li) => li.textContent)).toEqual(["payments/api-1", "web/web-1"]);
  });

  it("makes you type a namespace's name before deleting it", async () => {
    let answer!: Promise<boolean>;
    act(() => void (answer = askDelete(NAMESPACES, [{ metadata: { name: "payments", uid: "ns" } }], "prod-eu")));
    const input = await screen.findByRole("textbox");
    expect(button("Delete").disabled).toBe(true);
    // Enter in the field does nothing until the name matches.
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    fireEvent.change(input, { target: { value: "payment" } });
    expect(button("Delete").disabled).toBe(true);
    fireEvent.change(input, { target: { value: "payments" } });
    fireEvent.click(button("Delete"));
    await expect(answer).resolves.toBe(true);
  });
});

describe("deleting from a list", () => {
  let deleted: string[];
  beforeEach(() => {
    deleted = [];
    handlers.delete_resource = ({ name }) => void deleted.push(name);
    render(
      <ClusterContext.Provider value="/kube/config#prod-eu">
        <ResourceTable
          resource={PODS}
          watch={{ items: [pod("api-1"), pod("api-2")], loading: false }}
          allNamespaces
          onSelect={vi.fn()}
          notify={() => {}}
          actions={{} as DockActions}
        />
        <ConfirmHost />
      </ClusterContext.Provider>,
    );
  });

  const deleteFromMenu = async (name: string) => {
    fireEvent.contextMenu(screen.getByText(name));
    fireEvent.click(screen.getByText("Delete"));
    return screen.findByRole("alertdialog");
  };

  it("deletes nothing when the dialog is cancelled", async () => {
    const dialog = await deleteFromMenu("api-1");
    expect(dialog.textContent).toContain("cluster prod-eu");
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleted).toEqual([]);
  });

  it("deletes once confirmed", async () => {
    await deleteFromMenu("api-1");
    fireEvent.click(button("Delete"));
    await waitFor(() => expect(deleted).toEqual(["api-1"]));
  });

  it("asks before deleting the checked rows", async () => {
    for (const row of document.querySelectorAll(".tr:not(.th) input[type=checkbox]")) fireEvent.click(row);
    fireEvent.click(screen.getByTitle("Remove selected items (2)"));
    expect(await screen.findByText("Delete 2 Pods?")).toBeTruthy();
    expect(deleted).toEqual([]);
    fireEvent.click(button("Delete"));
    await waitFor(() => expect(deleted.sort()).toEqual(["api-1", "api-2"]));
  });
});

describe("window.confirm", () => {
  // Tauri's dialog plugin makes window.confirm async: its Promise is always truthy, so it can't guard anything.
  const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

  it("isn't used anywhere", () => {
    const uses = Object.entries(sources).flatMap(([file, text]) =>
      (text as string)
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/)/.test(line) && /(^|[^\w.])confirm\(|window\.confirm/.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(uses).toEqual([]);
  });
});
