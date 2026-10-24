import { readFileSync } from "node:fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { describe, expect, it, vi } from "vitest";
import { api, onApiError } from "./api";

describe("opening links in the browser", () => {
  // Regression: with only "opener:allow-open-url" and no URL scope, Tauri refused every link.
  it("is allowed for http and https URLs", () => {
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
    expect(capability.permissions).toEqual(expect.arrayContaining(["opener:allow-open-url", "opener:allow-default-urls"]));
  });

  it("reports a failure instead of swallowing it", async () => {
    vi.mocked(openUrl).mockRejectedValueOnce("Not allowed to open url http://localhost:3000");
    const errors: string[] = [];
    const off = onApiError((m) => errors.push(m));
    await api.openUrl("http://localhost:3000");
    off();
    expect(errors).toEqual(["Couldn't open http://localhost:3000: Not allowed to open url http://localhost:3000"]);
  });
});
