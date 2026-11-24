import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "./securityHeaders";

const directive = (csp: string, name: string) =>
  csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? "";

describe("security policy lets Disqus comments load", () => {
  it("allows the bare disqus.com domain (the comment frame lives there) as well as subdomains", () => {
    for (const name of ["script-src", "frame-src", "connect-src", "img-src"]) {
      const d = directive(CONTENT_SECURITY_POLICY, name);
      expect(d).toContain("https://disqus.com");
      expect(d).toContain("*.disqus.com");
    }
  });

  it("public/_headers has the same policy as securityHeaders.ts", () => {
    const headers = readFileSync(path.join(__dirname, "..", "..", "public", "_headers"), "utf8");
    const line = headers.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"))!;
    const fromFile = line.split("Content-Security-Policy:")[1].trim();
    const strip = (c: string) => c.replace(/;\s*upgrade-insecure-requests/, "").trim();
    expect(strip(fromFile)).toBe(strip(CONTENT_SECURITY_POLICY));
  });
});
