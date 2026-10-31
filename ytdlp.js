const path = require("path");
const fs = require("fs");
const youtubedl = require("youtube-dl-exec");

const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const cookiesOption = fs.existsSync(COOKIES_PATH) ? { cookies: COOKIES_PATH } : {};

const jsRuntimeOption = { jsRuntimes: "node" };

const YTDLP_BASE_OPTS = {
  preferFreeFormats: true,
  noPlaylist: true, // don't dump/stream an entire playlist if a playlist URL slips through
  ...jsRuntimeOption,
  ...cookiesOption,
};

const INFO_TIMEOUT_MS = 30_000; // per client, so a hung yt-dlp can't stall !play forever

const YTDLP_CLIENT_FALLBACKS = [
  undefined,
  "youtube:player_client=android",
  "youtube:player_client=tv",
  "youtube:player_client=ios",
];

function ytdlpOptsFor(clientArg, extra) {
  const opts = { ...YTDLP_BASE_OPTS, ...extra };
  if (clientArg) opts.extractorArgs = clientArg;
  return opts;
}

// Puts the preferred client first (if any), then the rest of the fallback
// list, with duplicates removed.
function resolveClientOrder(preferredClientArg) {
  return [preferredClientArg, ...YTDLP_CLIENT_FALLBACKS].filter(
    (client, index, arr) => arr.indexOf(client) === index
  );
}

async function getSongInfo(url) {
  let lastErr;
  for (const clientArg of YTDLP_CLIENT_FALLBACKS) {
    try {
      const info = await youtubedl(
        url,
        ytdlpOptsFor(clientArg, { dumpSingleJson: true, format: "bestaudio/best" }),
        { timeout: INFO_TIMEOUT_MS }
      );
      return { info, clientArg };
    } catch (err) {
      lastErr = err;
      console.warn(`[yt-dlp] client "${clientArg ?? "default"}" failed for info lookup:`);
      console.warn(err.stderr || err.message || err);
    }
  }
  throw lastErr;
}

function spawnYtDlpAudio(url, clientArg) {
  const subprocess = youtubedl.exec(
    url,
    ytdlpOptsFor(clientArg, {
      output: "-",
      format: "bestaudio/best",
    }),
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  // exec() returns a promise that rejects on any non-zero exit, including when we
  // kill it. Failures are handled through the events below, and without this
  // catch the rejection would take the whole process down.
  subprocess.catch(() => {});

  const stderrLines = [];
  subprocess.stderr?.on("data", (chunk) => {
    const text = chunk.toString().trim();
    stderrLines.push(text);
    console.error(`[yt-dlp] ${text}`);
  });
  subprocess.once("error", (err) => {
    // fires if the yt-dlp binary itself couldn't be spawned at all
    console.error("[yt-dlp] failed to start:", err);
  });
  subprocess.stdout.once("error", (err) => {
    console.error("[yt-dlp] stdout stream error:", err);
  });

  return { subprocess, stderrLines };
}

function waitForAudioOrFail(subprocess, stderrLines, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      subprocess.stdout.removeListener("data", onData);
      subprocess.removeListener("exit", onExit);
    };
    const onData = (chunk) => {
      if (settled) return;
      settled = true;
      cleanup();
      subprocess.stdout.pause();
      subprocess.stdout.unshift(chunk);
      resolve();
    };
    const onExit = (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`yt-dlp exited (code ${code}) before producing audio: ${stderrLines.join(" ")}`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(); // slow start on an otherwise healthy stream - let it play
    }, timeoutMs);

    subprocess.stdout.once("data", onData);
    subprocess.once("exit", onExit);
  });
}

async function createYtDlpAudioStream(url, preferredClientArg) {
  const clientsToTry = resolveClientOrder(preferredClientArg);

  let lastErr;
  for (const clientArg of clientsToTry) {
    const { subprocess, stderrLines } = spawnYtDlpAudio(url, clientArg);
    try {
      await waitForAudioOrFail(subprocess, stderrLines);
      return { stream: subprocess.stdout, process: subprocess };
    } catch (err) {
      lastErr = err;
      console.warn(`[yt-dlp] client "${clientArg ?? "default"}" failed to produce audio, trying next client...`);
      subprocess.kill();
    }
  }
  throw lastErr;
}

module.exports = {
  getSongInfo,
  createYtDlpAudioStream,
  ytdlpOptsFor,
  resolveClientOrder,
  YTDLP_CLIENT_FALLBACKS,
};
