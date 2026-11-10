import { setTimeout as sleep } from "node:timers/promises";

// GitHub sometimes answers an Electron release download with a 5xx or drops
// the connection, and Packager fails on the first error. Each file (the ZIP
// and its checksums) gets a few more tries, each after a longer wait. A 4xx
// other than 408 or 429 means a wrong URL, so it fails at once.
export function retryDownloads(
  downloader,
  { attempts = 4, delayMs = 10_000, log = console.warn } = {},
) {
  return {
    async download(url, target, options) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await downloader.download(url, target, options);
        } catch (error) {
          const status = error?.response?.status;
          const lasting =
            status >= 400 && status < 500 && status !== 408 && status !== 429;
          if (lasting || attempt >= attempts) throw error;
          const wait = attempt * delayMs;
          log(
            `${error.message}; try ${attempt + 1} of ${attempts} in ${wait / 1000}s`,
          );
          await sleep(wait);
        }
      }
    },
  };
}
