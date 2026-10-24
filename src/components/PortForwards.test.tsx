import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ForwardInfo } from "../api";
import { handlers } from "../test/tauriMock";
import { ForwardTarget, PortForwardDialog, predictProtocol } from "./PortForwards";

const target: ForwardTarget = { cluster: "c", kind: "service", namespace: "web", name: "frontend", port: 80, portName: "http" };
let started: any[] = [];
let stopped: string[] = [];

beforeEach(() => {
  localStorage.clear();
  started = [];
  stopped = [];
  vi.mocked(openUrl).mockClear();
  handlers.port_forward_start = (args) => {
    started.push(args);
    return { id: `c|service/web/frontend:${args.remotePort}`, cluster: "c", kind: "service", namespace: "web", name: "frontend", remotePort: args.remotePort, localPort: args.localPort ?? 54321, protocol: args.protocol };
  };
  handlers.port_forward_stop = ({ id }) => void stopped.push(id);
  handlers.port_forward_list = () => [];
});

const dialog = (extra: { existing?: ForwardInfo } = {}) => {
  const onClose = vi.fn();
  render(<PortForwardDialog target={target} onClose={onClose} notify={() => {}} {...extra} />);
  return { onClose };
};
const checkbox = (label: string) => screen.getByText(label).previousElementSibling as HTMLInputElement;

describe("port forward dialog", () => {
  it("predicts https from the port", () => {
    expect(predictProtocol("https-web", 8080)).toBe("https");
    expect(predictProtocol(undefined, 443)).toBe("https");
    expect(predictProtocol("http", 80)).toBe("http");
  });

  it("starts on a random port and opens it in the browser", async () => {
    const { onClose } = dialog();
    expect(screen.getByPlaceholderText("Random")).toBeTruthy();
    expect(checkbox("Open in Browser").checked).toBe(true);
    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(started[0]).toMatchObject({ cluster: "c", kind: "service", namespace: "web", name: "frontend", remotePort: 80, protocol: "http" });
    expect(started[0].localPort).toBeUndefined();
    expect(openUrl).toHaveBeenCalledWith("http://localhost:54321");
  });

  it("uses the chosen local port and https, and doesn't open the browser when unticked", async () => {
    const { onClose } = dialog();
    fireEvent.change(screen.getByPlaceholderText("Random"), { target: { value: "8443" } });
    fireEvent.click(checkbox("https"));
    fireEvent.click(checkbox("Open in Browser"));
    fireEvent.click(screen.getByText("Start"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(started[0]).toMatchObject({ localPort: 8443, protocol: "https" });
    expect(openUrl).not.toHaveBeenCalled();
    // The choice is remembered for next time.
    expect(localStorage.getItem("portForwardOpenInBrowser")).toBe("0");
  });

  it("modifies a running forward by restarting it on the new port", async () => {
    const existing: ForwardInfo = { id: "c|service/web/frontend:80", cluster: "c", kind: "service", namespace: "web", name: "frontend", remotePort: 80, localPort: 40000, protocol: "http" };
    const { onClose } = dialog({ existing });
    expect((screen.getByPlaceholderText("Random") as HTMLInputElement).value).toBe("40000");
    fireEvent.change(screen.getByPlaceholderText("Random"), { target: { value: "9000" } });
    fireEvent.click(checkbox("Open in Browser"));
    fireEvent.click(screen.getByText("Modify"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(stopped).toEqual([existing.id]);
    expect(started[0]).toMatchObject({ localPort: 9000 });
  });

  it("rejects an invalid port", () => {
    dialog();
    fireEvent.change(screen.getByPlaceholderText("Random"), { target: { value: "70000" } });
    expect(screen.getByText(/between 1 and 65535/)).toBeTruthy();
    expect((screen.getByText("Start") as HTMLButtonElement).disabled).toBe(true);
  });
});
