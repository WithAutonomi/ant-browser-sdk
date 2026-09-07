import { expectTypeOf, it } from "vitest";
// Exercise the published declarations rather than the source-only internal factory.
import type { AutonomiClient, PublicFileReader } from "@autonomi/browser-sdk";

it("exposes readers through openFile without a public constructor or factory", () => {
  expectTypeOf<Awaited<ReturnType<AutonomiClient["openFile"]>>>().toEqualTypeOf<PublicFileReader>();
  expectTypeOf<typeof PublicFileReader>().not.toMatchTypeOf<new (...args: never[]) => unknown>();
  expectTypeOf<keyof typeof PublicFileReader>().toEqualTypeOf<"prototype">();
  expectTypeOf<"createPublicFileReader">().not.toMatchTypeOf<keyof typeof import("@autonomi/browser-sdk")>();
});
