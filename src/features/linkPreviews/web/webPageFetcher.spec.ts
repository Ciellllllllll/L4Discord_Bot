import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFetchableUrl, fetchWebPage, guardedLookup, isBlockedAddress } from "./webPageFetcher.js";

void test("blocks private, loopback, link-local and reserved addresses", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "::1", "::", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "not-an-ip",
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

void test("only fetches https URLs on the default port without internal hosts", () => {
  assert.ok(checkFetchableUrl("https://example.com/") instanceof URL);
  assert.ok(checkFetchableUrl("https://example.com:443/") instanceof URL);
  assert.equal(checkFetchableUrl("http://example.com/"), "unsupported_url");
  assert.equal(checkFetchableUrl("https://example.com:8080/"), "unsupported_url");
  assert.equal(checkFetchableUrl("https://user:pass@example.com/"), "unsupported_url");
  assert.equal(checkFetchableUrl("not a url"), "unsupported_url");
  assert.equal(checkFetchableUrl("https://127.0.0.1/"), "blocked_address");
  assert.equal(checkFetchableUrl("https://2130706433/"), "blocked_address");
  assert.equal(checkFetchableUrl("https://[::1]/"), "blocked_address");
  assert.equal(checkFetchableUrl("https://localhost/"), "blocked_address");
  assert.equal(checkFetchableUrl("https://metadata.google.internal/"), "blocked_address");
});

void test("refuses internal targets before opening a connection", async () => {
  assert.deepEqual(await fetchWebPage("https://169.254.169.254/latest/meta-data/"), { status: "error", reason: "blocked_address" });
  assert.deepEqual(await fetchWebPage("http://example.com/"), { status: "error", reason: "unsupported_url" });
});

void test("rejects host names that resolve to internal addresses", async () => {
  // localhost は名前解決が端末内で完結するので、ネットワークに出ずに検査できる
  for (const all of [false, true]) {
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup("localhost", { all }, (err) => resolve(err));
    });
    assert.match(String(error), /Blocked address/);
  }
});
