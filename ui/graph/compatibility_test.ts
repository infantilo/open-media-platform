import { assertEquals } from "jsr:@std/assert@1";
import { portsCompatible } from "./compatibility.ts";

Deno.test("identical formats are compatible", () => {
  assertEquals(
    portsCompatible("urn:x-nmos:format:video", "urn:x-nmos:format:video"),
    true,
  );
});

Deno.test("different formats are incompatible", () => {
  assertEquals(
    portsCompatible("urn:x-nmos:format:video", "urn:x-nmos:format:audio"),
    false,
  );
});

Deno.test("unknown sender format is treated as compatible", () => {
  assertEquals(portsCompatible("", "urn:x-nmos:format:video"), true);
});

Deno.test("unknown receiver format is treated as compatible", () => {
  assertEquals(portsCompatible("urn:x-nmos:format:video", ""), true);
});

Deno.test("both formats unknown is treated as compatible", () => {
  assertEquals(portsCompatible("", ""), true);
});
