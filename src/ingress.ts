//! Ingress routes as links, like Lens' Rules column and details.

import type { KubeObject } from "./api";

export interface IngressRoute {
  host: string;
  path: string;
  url: string;
  /** Backend as `service:port`, or `Kind/name` for a resource backend. */
  backend: string;
  /** False for wildcard or missing hosts, which can't be opened. */
  link: boolean;
}

function backendText(b: any): string {
  if (!b) return "";
  if (b.service) return `${b.service.name}:${b.service.port?.number ?? b.service.port?.name ?? ""}`;
  if (b.serviceName) return `${b.serviceName}:${b.servicePort ?? ""}`;
  if (b.resource) return `${b.resource.kind}/${b.resource.name}`;
  return "";
}

/** Whether a TLS entry covers a host (`*.example.com` covers `a.example.com`). */
function tlsCovers(tls: any[], host: string): boolean {
  return tls.some((t) => {
    const hosts: string[] = t.hosts ?? [];
    if (!hosts.length) return true;
    return hosts.some((h) => h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)) && !host.slice(0, -h.length + 1).includes(".")));
  });
}

export function ingressRoutes(ingress: KubeObject): IngressRoute[] {
  const tls: any[] = ingress.spec?.tls ?? [];
  const routes = ((ingress.spec?.rules ?? []) as any[]).flatMap((rule) => {
    const host: string = rule.host ?? "*";
    const scheme = host !== "*" && tlsCovers(tls, host) ? "https" : tls.length && host === "*" ? "https" : "http";
    const paths: any[] = rule.http?.paths ?? [];
    return paths.map((p) => {
      const path: string = p.path ?? "/";
      return { host, path, url: `${scheme}://${host}${path}`, backend: backendText(p.backend), link: !host.includes("*") };
    });
  });
  const fallback = backendText(ingress.spec?.defaultBackend ?? ingress.spec?.backend);
  if (fallback && !routes.length) routes.push({ host: "*", path: "/", url: "*", backend: fallback, link: false });
  return routes;
}

/** The load balancer's addresses (status.loadBalancer.ingress). */
export const ingressPoints = (o: KubeObject): string[] =>
  ((o.status?.loadBalancer?.ingress ?? []) as any[]).map((i) => i.hostname ?? i.ip).filter(Boolean);
