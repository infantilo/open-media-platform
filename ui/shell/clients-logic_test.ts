import { assertEquals } from "jsr:@std/assert@1";
import { shortBrowser, showAddress } from "./clients-logic.ts";

Deno.test("shortBrowser: gängige Kennungen", () => {
  assertEquals(
    shortBrowser("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36"),
    "Chrome (headless) 156 · Linux",
  );
  assertEquals(
    shortBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0"),
    "Edge 120 · Windows",
  );
  assertEquals(
    shortBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"),
    "Safari 17 · macOS",
  );
  assertEquals(shortBrowser("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0"), "Firefox 121 · Linux");
  assertEquals(shortBrowser(""), "–");
  assertEquals(shortBrowser("curl/8.0"), "curl/8.0");
});

Deno.test("showAddress: Loopback als localhost", () => {
  assertEquals(showAddress("::1"), "localhost");
  assertEquals(showAddress("10.1.2.3"), "10.1.2.3");
});

import { matchesClient } from "./clients-logic.ts";

Deno.test("matchesClient: Begriffe, Geräte, Stichworte", () => {
  const a = {
    user: "Anna",
    remoteIp: "10.0.0.5",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36",
    devices: { midi: [{ name: "iCON Platform M+" }], streamDeck: [{ name: "Stream Deck XL (Simulator)", simulated: true }] },
  };
  const b = { user: "bob", remoteIp: "::1", userAgent: "Mozilla/5.0 (Windows NT 10.0) Firefox/121.0" };
  assertEquals(matchesClient(a, ""), true);
  assertEquals(matchesClient(a, "anna"), true);
  assertEquals(matchesClient(a, "ANNA chrome"), true);
  assertEquals(matchesClient(a, "anna firefox"), false);
  assertEquals(matchesClient(a, "icon"), true);
  assertEquals(matchesClient(a, "midi"), true);
  assertEquals(matchesClient(b, "midi"), false);
  assertEquals(matchesClient(a, "stream deck"), true);
  assertEquals(matchesClient(b, "streamdeck"), false);
  assertEquals(matchesClient(a, "simulator"), true);
  assertEquals(matchesClient(b, "localhost"), true);
  assertEquals(matchesClient(a, "10.0.0"), true);
});
