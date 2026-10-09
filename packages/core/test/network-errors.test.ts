import { describe, expect, it } from "vitest";
import { errorMessage, withNetworkHint } from "../src/index.js";

describe("network error messages", () => {
  it("replaces fetch's bare 'fetch failed' with its cause", () => {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND llm.corp.example"), { code: "ENOTFOUND" }) });
    expect(errorMessage(error)).toBe("getaddrinfo ENOTFOUND llm.corp.example");
    expect(errorMessage(new Error("Cannot connect to API", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8443") }))).toBe(
      "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:8443",
    );
  });

  it("says what to do about an untrusted certificate", () => {
    const error = new TypeError("fetch failed", { cause: new Error("self-signed certificate in certificate chain") });
    expect(errorMessage(error)).toMatch(/^self-signed certificate in certificate chain\. .*company networks.*Node 22\.19\+.*NODE_EXTRA_CA_CERTS/);
    // When the system store is already trusted, the certificate must come from somewhere else.
    expect(withNetworkHint("unable to get local issuer certificate", { NODE_USE_SYSTEM_CA: "1" })).toMatch(/isn't trusted by Node or by your system.*NODE_EXTRA_CA_CERTS/);
    expect(withNetworkHint("Invalid API key")).toBe("Invalid API key");
  });
});
