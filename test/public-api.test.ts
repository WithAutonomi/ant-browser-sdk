import { expectTypeOf, it } from "vitest";
// Exercise the published declarations rather than the source-only internal factory.
import type {
  AutonomiClient, PublicFileReader, NetworkConnectionOptions, NetworkDefaults, getNetworkDefaults,
  PrivateDownloadResult, PrivateFile, PrivateFileReference, PublicFile, UploadResult, DownloadResult,
} from "@withautonomi/browser-sdk";

it("types private uploads and reads by the DataMap their holder keeps", () => {
  const uploadPublic = (client: AutonomiClient, bytes: Uint8Array) => client.upload(bytes);
  const uploadPrivate = (client: AutonomiClient, bytes: Uint8Array) => client.upload(bytes, { visibility: "private" });
  const downloadPrivate = (client: AutonomiClient, file: PrivateFile) => client.download(file);
  const downloadDataMap = (client: AutonomiClient, dataMap: Uint8Array) => client.download({ dataMap });
  expectTypeOf<Awaited<ReturnType<typeof downloadDataMap>>>().toEqualTypeOf<PrivateDownloadResult>();
  expectTypeOf<PrivateFile>().toMatchTypeOf<PrivateFileReference>();
  const saveEither = (client: AutonomiClient, file: string | PrivateFileReference) => client.downloadAndSave(file);
  expectTypeOf<Awaited<ReturnType<typeof saveEither>>["download"]>().toEqualTypeOf<DownloadResult | PrivateDownloadResult>();
  const downloadPublic = (client: AutonomiClient, address: string) => client.download(address);
  expectTypeOf<Awaited<ReturnType<typeof uploadPublic>>>().toEqualTypeOf<UploadResult>();
  expectTypeOf<Awaited<ReturnType<typeof uploadPrivate>>>().toEqualTypeOf<UploadResult<PrivateFile>>();
  expectTypeOf<Awaited<ReturnType<typeof downloadPrivate>>>().toEqualTypeOf<PrivateDownloadResult>();
  expectTypeOf<Awaited<ReturnType<typeof downloadPublic>>>().toEqualTypeOf<DownloadResult>();
  expectTypeOf<Awaited<ReturnType<AutonomiClient["resumeUpload"]>>["file"]>().toEqualTypeOf<PublicFile | PrivateFile>();
  expectTypeOf<PrivateFile["dataMap"]>().toEqualTypeOf<Uint8Array>();
  expectTypeOf<"address">().not.toMatchTypeOf<keyof PrivateFile>();
});

it("exposes typed network defaults and both connection forms", () => {
  expectTypeOf<Awaited<ReturnType<typeof getNetworkDefaults>>>().toEqualTypeOf<NetworkDefaults>();
  expectTypeOf<typeof AutonomiClient.connect>().toMatchTypeOf<(options?: NetworkConnectionOptions) => Promise<AutonomiClient>>();
  expectTypeOf<typeof AutonomiClient.connect>().toMatchTypeOf<(multiaddr: string) => Promise<AutonomiClient>>();
});

it("exposes readers through openFile without a public constructor or factory", () => {
  expectTypeOf<Awaited<ReturnType<AutonomiClient["openFile"]>>>().toEqualTypeOf<PublicFileReader>();
  expectTypeOf<typeof PublicFileReader>().not.toMatchTypeOf<new (...args: never[]) => unknown>();
  expectTypeOf<keyof typeof PublicFileReader>().toEqualTypeOf<"prototype">();
  expectTypeOf<"createPublicFileReader">().not.toMatchTypeOf<keyof typeof import("@withautonomi/browser-sdk")>();
});

it("exports camelCase metadata across the published API", () => {
  type PublicFile = import("@withautonomi/browser-sdk").PublicFile;
  type PaymentNetwork = import("@withautonomi/browser-sdk").PaymentNetwork;
  type HelloInfo = import("@withautonomi/browser-sdk").HelloInfo;
  type NetworkNode = import("@withautonomi/browser-sdk").NetworkNode;
  type ChunkInfo = import("@withautonomi/browser-sdk").ChunkInfo;
  expectTypeOf<Extract<keyof PublicFile | keyof PaymentNetwork | keyof HelloInfo | keyof NetworkNode | keyof ChunkInfo, `${string}_${string}`>>().toBeNever();
  expectTypeOf<PublicFile["contentType"]>().toBeString();
  expectTypeOf<PaymentNetwork["paymentTokenAddress"]>().toBeString();
});
