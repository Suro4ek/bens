import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceInfo } from "../api";
import { ClusterContext } from "../clusterContext";
import { handlers } from "../test/tauriMock";
import { CreateConfigMapDialog, CreateSecretDialog, parseEnv } from "./CreateDialogs";

const R = (kind: string, plural: string): ResourceInfo => ({ key: `/v1/${plural}`, group: "", version: "v1", kind, plural, namespaced: true });
const SECRETS = R("Secret", "secrets");
const CONFIGMAPS = R("ConfigMap", "configmaps");

const b64 = (s: string) => btoa(s);
const decode = (s: string) => atob(s);

let created: { cluster: string; key: string; namespace: string; object: any }[] = [];

function renderDialog(Dialog: typeof CreateSecretDialog, resource: ResourceInfo) {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <ClusterContext.Provider value="/kube/config#prod">
      <Dialog resource={resource} namespace="payments" namespaces={["default", "payments"]} onClose={onClose} onCreated={onCreated} notify={() => {}} />
    </ClusterContext.Provider>,
  );
  return { onCreated, onClose };
}

const type = (placeholder: string, value: string, index = 0) =>
  fireEvent.change(screen.getAllByPlaceholderText(placeholder)[index], { target: { value } });
const fillName = (value: string) => fireEvent.change(screen.getByPlaceholderText("my-config"), { target: { value } });
const submit = () => fireEvent.click(screen.getByText("Create"));

beforeEach(() => {
  created = [];
  handlers.create_resource = (args) => {
    created.push(args);
    return args.object;
  };
});

describe("parseEnv", () => {
  it("reads KEY=value lines", () => {
    expect(parseEnv('# comment\nexport A=1\nB = "two words"\nC=\'x=y\'\n\nnot a pair')).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", "x=y"],
    ]);
  });
});

describe("Create Secret", () => {
  it("creates an Opaque secret with base64 values in the list's namespace", async () => {
    const { onCreated } = renderDialog(CreateSecretDialog, SECRETS);
    fillName("api-keys");
    type("Key", "TOKEN");
    type("Value", "s3cr3t ✓");
    submit();

    await waitFor(() => expect(created).toHaveLength(1));
    const [{ cluster, key, namespace, object }] = created;
    expect({ cluster, key, namespace }).toEqual({ cluster: "/kube/config#prod", key: "/v1/secrets", namespace: "payments" });
    expect(object).toMatchObject({ kind: "Secret", type: "Opaque", metadata: { name: "api-keys", namespace: "payments" } });
    expect(new TextDecoder().decode(Uint8Array.from(decode(object.data.TOKEN), (c) => c.charCodeAt(0)))).toBe("s3cr3t ✓");
    expect(onCreated).toHaveBeenCalledWith("payments", "api-keys");
  });

  it("adds many entries at once from .env lines", async () => {
    renderDialog(CreateSecretDialog, SECRETS);
    fillName("env");
    fireEvent.click(screen.getByTitle("Paste KEY=value lines (.env)"));
    fireEvent.change(screen.getByPlaceholderText(/DATABASE_URL/), { target: { value: "A=1\nB=2" } });
    fireEvent.click(screen.getByText("Add 2 entries"));
    submit();

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].object.data).toEqual({ A: b64("1"), B: b64("2") });
  });

  it("builds .dockerconfigjson for a registry secret", async () => {
    renderDialog(CreateSecretDialog, SECRETS);
    fillName("regcred");
    fireEvent.change(screen.getByDisplayValue("Opaque"), { target: { value: "kubernetes.io/dockerconfigjson" } });
    fireEvent.change(screen.getByDisplayValue("https://index.docker.io/v1/"), { target: { value: "cr.yandex" } });
    type("username", "json_key");
    type("password", "p@ss");
    submit();

    await waitFor(() => expect(created).toHaveLength(1));
    const { object } = created[0];
    expect(object.type).toBe("kubernetes.io/dockerconfigjson");
    const config = JSON.parse(decode(object.data[".dockerconfigjson"]));
    expect(config.auths["cr.yandex"]).toEqual({ username: "json_key", password: "p@ss", auth: b64("json_key:p@ss") });
  });

  it("requires tls.crt and tls.key keys for a TLS secret", async () => {
    renderDialog(CreateSecretDialog, SECRETS);
    fillName("tls");
    fireEvent.change(screen.getByDisplayValue("Opaque"), { target: { value: "kubernetes.io/tls" } });
    expect(screen.getByDisplayValue("tls.crt")).toHaveProperty("readOnly", true);
    type("-----BEGIN CERTIFICATE----- (or load the file)", "CERT");
    type("-----BEGIN PRIVATE KEY----- (or load the file)", "KEY");
    submit();

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].object.data).toEqual({ "tls.crt": b64("CERT"), "tls.key": b64("KEY") });
  });

  it("does not create with an invalid name or duplicate keys", () => {
    renderDialog(CreateSecretDialog, SECRETS);
    fillName("Bad_Name");
    expect(screen.getByText(/Name: lowercase letters/)).toBeTruthy();
    fillName("good");
    type("Key", "A");
    fireEvent.click(screen.getByTitle("Add data entry"));
    type("Key", "A", 1);
    expect(screen.getByText(/"A" is used twice/)).toBeTruthy();
    expect((screen.getByText("Create") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's error (e.g. the secret already exists) and stays open", async () => {
    handlers.create_resource = () => Promise.reject("Secret api-keys already exists");
    const notify = vi.fn();
    const onClose = vi.fn();
    render(
      <ClusterContext.Provider value="c">
        <CreateSecretDialog resource={SECRETS} namespace={null} namespaces={[]} onClose={onClose} onCreated={() => {}} notify={notify} />
      </ClusterContext.Provider>,
    );
    fillName("api-keys");
    submit();
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Secret api-keys already exists", "bad"));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Create ConfigMap", () => {
  it("creates a ConfigMap with data, labels and annotations", async () => {
    renderDialog(CreateConfigMapDialog, CONFIGMAPS);
    fillName("app-config");
    type("Key", "app.yaml");
    type("Value", "port: 8080\nlog: debug");
    fireEvent.click(screen.getByTitle("Add labels entry"));
    type("Key", "app", 1);
    type("Value", "web", 1);
    submit();

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0].object).toEqual({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "app-config", namespace: "payments", labels: { app: "web" } },
      data: { "app.yaml": "port: 8080\nlog: debug" },
    });
  });
});
