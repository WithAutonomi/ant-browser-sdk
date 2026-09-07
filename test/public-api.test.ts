import { expectTypeOf, it } from "vitest";
// Exercise the published declarations rather than the source-only internal factory.
import type { AutonomiClient, PublicFileReader } from "@autonomi/browser-sdk";

it("exposes readers through openFile without a public constructor or factory", () => {
  expectTypeOf<Awaited<ReturnType<AutonomiClient["openFile"]>>>().toEqualTypeOf<PublicFileReader>();
  expectTypeOf<typeof PublicFileReader>().not.toMatchTypeOf<new (...args: never[]) => unknown>();
  expectTypeOf<keyof typeof PublicFileReader>().toEqualTypeOf<"prototype">();
  expectTypeOf<"createPublicFileReader">().not.toMatchTypeOf<keyof typeof import("@autonomi/browser-sdk")>();
});

it("exports camelCase metadata across the published API", () => {
  type PublicFile = import("@autonomi/browser-sdk").PublicFile;
  type PaymentNetwork = import("@autonomi/browser-sdk").PaymentNetwork;
  type HelloInfo = import("@autonomi/browser-sdk").HelloInfo;
  type NetworkNode = import("@autonomi/browser-sdk").NetworkNode;
  type ChunkInfo = import("@autonomi/browser-sdk").ChunkInfo;
  expectTypeOf<Extract<keyof PublicFile | keyof PaymentNetwork | keyof HelloInfo | keyof NetworkNode | keyof ChunkInfo, `${string}_${string}`>>().toBeNever();
  expectTypeOf<PublicFile["contentType"]>().toBeString();
  expectTypeOf<PaymentNetwork["paymentTokenAddress"]>().toBeString();
});
