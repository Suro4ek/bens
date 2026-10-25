import { describe, expect, it } from "vitest";
import type { KubeObject } from "./api";
import { containerEnv, envSources, podField } from "./env";

const container = {
  name: "api",
  env: [
    { name: "LOG_LEVEL", value: "debug" },
    { name: "EMPTY" },
    { name: "DB_HOST", valueFrom: { configMapKeyRef: { name: "api-config", key: "db-host" } } },
    { name: "DB_PASSWORD", valueFrom: { secretKeyRef: { name: "db-creds", key: "PASSWORD" } } },
    { name: "FEATURE", valueFrom: { configMapKeyRef: { name: "api-config", key: "feature", optional: true } } },
    { name: "POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
    { name: "CPU", valueFrom: { resourceFieldRef: { resource: "limits.cpu" } } },
    { name: "MODE", value: "env" },
  ],
  envFrom: [{ configMapRef: { name: "api-config" } }, { prefix: "DB_", secretRef: { name: "db-creds" } }, { configMapRef: { name: "gone", optional: true } }],
};
const pod: KubeObject = {
  metadata: { name: "api-0", namespace: "payments", labels: { app: "api" } },
  spec: { initContainers: [{ name: "init", envFrom: [{ secretRef: { name: "init-token" } }] }], containers: [container] },
  status: { podIP: "10.1.0.4", podIPs: [{ ip: "10.1.0.4" }, { ip: "fd00::4" }] },
};

describe("envSources", () => {
  it("lists each ConfigMap and Secret once, init containers included", () => {
    expect(envSources(pod)).toEqual([
      { kind: "Secret", name: "init-token" },
      { kind: "ConfigMap", name: "api-config" },
      { kind: "Secret", name: "db-creds" },
      { kind: "ConfigMap", name: "gone" },
    ]);
  });
});

describe("podField", () => {
  it("reads fields, labels and IP lists of the pod", () => {
    expect(podField(pod, "metadata.name")).toBe("api-0");
    expect(podField(pod, "metadata.labels['app']")).toBe("api");
    expect(podField(pod, "status.podIPs")).toBe("10.1.0.4,fd00::4");
    expect(podField(pod, "spec.nodeName")).toBeUndefined();
    expect(podField(pod, "metadata")).toBeUndefined();
  });
});

describe("containerEnv", () => {
  it("shows references without values until their sources are read", () => {
    const [env, ...from] = containerEnv(pod, container, {});
    expect(env.vars.find((v) => v.name === "DB_HOST")).toEqual({ name: "DB_HOST", ref: { kind: "ConfigMap", name: "api-config", key: "db-host" }, secret: false });
    expect(from.map((g) => g.from?.loading)).toEqual([true, true, true]);
  });

  it("fills in values, says what is missing, and marks replaced variables", () => {
    const groups = containerEnv(pod, container, {
      "ConfigMap/api-config": { data: { "db-host": "postgres", MODE: "cm" } },
      "Secret/db-creds": { data: { PASSWORD: "s3cret", HOST: "db" } },
      "ConfigMap/gone": { missing: true },
    });
    const [env, cm, secret, gone] = groups;
    const byName = Object.fromEntries(env.vars.map((v) => [v.name, v]));
    expect(byName.LOG_LEVEL.value).toBe("debug");
    expect(byName.EMPTY.value).toBe("");
    expect(byName.DB_HOST.value).toBe("postgres");
    expect(byName.DB_PASSWORD).toMatchObject({ value: "s3cret", secret: true });
    expect(byName.FEATURE).toMatchObject({ problem: "key not found", ref: { optional: true } });
    expect(byName.POD_NAME).toMatchObject({ value: "api-0", field: "metadata.name" });
    expect(byName.CPU).toEqual({ name: "CPU", field: "limits.cpu" });

    // env comes after envFrom: its MODE replaces the ConfigMap's.
    expect(cm.vars).toEqual([{ name: "db-host", value: "postgres", secret: false }, { name: "MODE", value: "cm", secret: false, overridden: true }]);
    expect(byName.MODE.overridden).toBeUndefined();
    expect(secret.from).toMatchObject({ kind: "Secret", prefix: "DB_" });
    expect(secret.vars.map((v) => [v.name, v.secret])).toEqual([["DB_PASSWORD", true], ["DB_HOST", true]]);
    // The prefixed secret keys are replaced by env's DB_HOST and DB_PASSWORD.
    expect(secret.vars.every((v) => v.overridden)).toBe(true);
    expect(gone.from).toMatchObject({ problem: "ConfigMap not found", optional: true });
  });

  it("reports sources that can't be read", () => {
    const [env] = containerEnv(pod, container, { "Secret/db-creds": { error: 'secrets "db-creds" is forbidden' } });
    expect(env.vars.find((v) => v.name === "DB_PASSWORD")?.problem).toBe('secrets "db-creds" is forbidden');
  });
});
