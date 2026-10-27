// A real <video> plays through the SDK's MediaBridge and packaged worker in
// each browser, with the worker's response headers as shipped. The bytes are a
// playable test pattern served from memory; no network is involved.
import { chromium, firefox, webkit } from "/Users/mick/RustroverProjects/try-autonomi-manifests/node_modules/playwright/index.mjs";

const url = process.argv[2];
for (const [name, type] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  const browser = await type.launch(name === "chromium" ? { args: ["--autoplay-policy=no-user-gesture-required"] } : {});
  try {
    const page = await browser.newPage();
    await page.goto(`${url}/bridge.html`);
    const result = await page.evaluate(async () => {
      const { MediaBridge } = await import("./sdk/internal/media.js");
      const bytes = new Uint8Array(await (await fetch("./test-pattern.mp4")).arrayBuffer());
      const reader = { address: "ab".repeat(32), name: "test-pattern.mp4", size: bytes.length, contentType: "video/mp4",
        async read(start, length) { return bytes.slice(start, start + length); }, close() {} };
      const bridge = new MediaBridge();
      const source = await bridge.attach(reader, {});
      const head = await fetch(source.url, { headers: { Range: "bytes=0-15" } });
      const video = document.createElement("video");
      video.muted = true;
      document.body.append(video);
      video.src = source.url;
      await video.play();
      await new Promise((resolve, reject) => {
        const check = () => (video.currentTime > 0.5 ? resolve() : video.error ? reject(new Error(`media error ${video.error.code}`)) : setTimeout(check, 100));
        check();
      });
      const played = video.currentTime;
      source.close();
      bridge.close();
      return { played, status: head.status, nosniff: head.headers.get("x-content-type-options"), csp: head.headers.get("content-security-policy") };
    });
    console.log(JSON.stringify({ browser: name, version: browser.version(), ...result }));
  } catch (error) {
    console.log(JSON.stringify({ browser: name, error: String(error.message ?? error) }));
  } finally {
    await browser.close();
  }
}
