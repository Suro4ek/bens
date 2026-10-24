import { fireEvent, render, screen } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject } from "./api";
import { IngressLinks } from "./columns";
import { ingressPoints, ingressRoutes } from "./ingress";

const ingress = (spec: any, status: any = {}): KubeObject => ({ kind: "Ingress", metadata: { name: "web", namespace: "prod" }, spec, status });

const route = (host: string | undefined, path: string, backend: any) => ({ host, http: { paths: [{ path, backend }] } });
const svc = (name: string, port: number | string) => ({ service: { name, port: typeof port === "number" ? { number: port } : { name: port } } });

beforeEach(() => vi.mocked(openUrl).mockClear());

describe("ingressRoutes", () => {
  it("builds http links, and https for hosts covered by TLS", () => {
    const o = ingress({
      tls: [{ hosts: ["shop.example.com"], secretName: "shop-tls" }],
      rules: [route("shop.example.com", "/", svc("shop", 80)), route("api.example.com", "/v1", svc("api", "http"))],
    });
    expect(ingressRoutes(o)).toEqual([
      { host: "shop.example.com", path: "/", url: "https://shop.example.com/", backend: "shop:80", link: true },
      { host: "api.example.com", path: "/v1", url: "http://api.example.com/v1", backend: "api:http", link: true },
    ]);
  });

  it("matches wildcard TLS hosts one level deep", () => {
    const o = ingress({ tls: [{ hosts: ["*.example.com"] }], rules: [route("a.example.com", "/", svc("a", 80)), route("a.b.example.com", "/", svc("b", 80))] });
    expect(ingressRoutes(o).map((r) => r.url)).toEqual(["https://a.example.com/", "http://a.b.example.com/"]);
  });

  it("doesn't link wildcard or missing hosts", () => {
    const o = ingress({ rules: [route(undefined, "/", svc("x", 80)), route("*.example.com", "/", svc("y", 80))] });
    expect(ingressRoutes(o).map((r) => r.link)).toEqual([false, false]);
  });

  it("shows the default backend when there are no rules, and the load balancer's addresses", () => {
    const o = ingress({ defaultBackend: svc("fallback", 8080) }, { loadBalancer: { ingress: [{ ip: "10.0.0.5" }, { hostname: "lb.example.com" }] } });
    expect(ingressRoutes(o)).toEqual([{ host: "*", path: "/", url: "*", backend: "fallback:8080", link: false }]);
    expect(ingressPoints(o)).toEqual(["10.0.0.5", "lb.example.com"]);
  });
});

describe("Rules column", () => {
  it("opens a route in the browser without selecting the row", () => {
    const onRow = vi.fn();
    render(
      <div onClick={onRow}>
        <IngressLinks ingress={ingress({ rules: [route("shop.example.com", "/", svc("shop", 80))] })} />
      </div>,
    );
    fireEvent.click(screen.getByText("http://shop.example.com/"));
    expect(openUrl).toHaveBeenCalledWith("http://shop.example.com/");
    expect(onRow).not.toHaveBeenCalled();
  });
});
