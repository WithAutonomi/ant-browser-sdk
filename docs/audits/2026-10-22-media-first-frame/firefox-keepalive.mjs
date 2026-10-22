// Firefox stops a service worker 30 s after its last event, even one still
// answering a request. With those limits lowered to 15 s and 1 s, a block that
// takes 22 s outlasts them. The SDK's own MediaBridge and packaged worker serve
// it from a reader that is slow on purpose; no network is involved.
// Usage: node firefox-keepalive.mjs name=url ...
import { firefox } from "/Users/mick/RustroverProjects/try-autonomi-manifests/node_modules/playwright/index.mjs";

const results = [];
for (const item of process.argv.slice(2)) {
  const [name, url] = item.split("=");
  const browser = await firefox.launch({
    firefoxUserPrefs: { "dom.serviceWorkers.idle_timeout": 15_000, "dom.serviceWorkers.idle_extended_timeout": 1_000 },
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${url}/bridge.html`);
    const result = await page.evaluate(async () => {
      const { MediaBridge } = await import("./sdk/internal/media.js");
      const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index & 255);
      let awake = 0;
      const post = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function (message, ...rest) {
        if (message?.type === "autonomi-stream-awake") awake++;
        return post.call(this, message, ...rest);
      };
      const reader = {
        address: "ab".repeat(32), name: "slow.mp4", size: bytes.length, contentType: "video/mp4",
        async read(start, length) {
          await new Promise(resolve => setTimeout(resolve, 22_000));
          return bytes.slice(start, start + length);
        },
        close() {},
      };
      const bridge = new MediaBridge();
      const source = await bridge.attach(reader, {});
      const started = performance.now();
      let answer;
      try {
        const response = await fetch(source.url, { headers: { Range: "bytes=100-109" } });
        answer = { status: response.status, body: [...new Uint8Array(await response.arrayBuffer())] };
      } catch (error) {
        answer = { error: String(error) };
      }
      answer.seconds = (performance.now() - started) / 1000;
      source.close();
      const whileOpen = awake;
      await new Promise(resolve => setTimeout(resolve, 12_000));
      bridge.close();
      return { answer, whileOpen, afterClose: awake - whileOpen };
    });
    results.push({ name, browser: browser.version(), ...result });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    await browser.close();
  }
}
