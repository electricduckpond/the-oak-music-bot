jest.mock("youtube-dl-exec", () => {
  const fn = jest.fn();
  fn.exec = jest.fn();
  return fn;
});

const youtubedl = require("youtube-dl-exec");
const {
  getSongInfo,
  createYtDlpAudioStream,
  ytdlpOptsFor,
  resolveClientOrder,
  YTDLP_CLIENT_FALLBACKS,
} = require("../ytdlp");

function makeFakeSubprocess() {
  const { EventEmitter } = require("events");
  const subprocess = new EventEmitter();
  subprocess.stdout = new EventEmitter();
  subprocess.stdout.pause = jest.fn();
  subprocess.stdout.unshift = jest.fn();
  subprocess.stderr = new EventEmitter();
  subprocess.killed = false;
  subprocess.kill = jest.fn(() => {
    subprocess.killed = true;
  });
  return subprocess;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ytdlpOptsFor", () => {
  test("merges base opts with the extra opts passed in", () => {
    const opts = ytdlpOptsFor(undefined, { format: "bestaudio/best" });
    expect(opts).toMatchObject({
      noCheckCertificate: true,
      preferFreeFormats: true,
      noPlaylist: true,
      jsRuntimes: "node",
      format: "bestaudio/best",
    });
    expect(opts.extractorArgs).toBeUndefined();
  });

  test("sets extractorArgs when a client is given", () => {
    const opts = ytdlpOptsFor("youtube:player_client=android", {});
    expect(opts.extractorArgs).toBe("youtube:player_client=android");
  });
});

describe("resolveClientOrder", () => {
  test("puts the preferred client first without duplicating it", () => {
    const order = resolveClientOrder("youtube:player_client=ios");
    expect(order[0]).toBe("youtube:player_client=ios");
    expect(order.filter((c) => c === "youtube:player_client=ios")).toHaveLength(1);
    YTDLP_CLIENT_FALLBACKS.forEach((client) => expect(order).toContain(client));
  });

  test("matches the default fallback order when no preferred client is given", () => {
    expect(resolveClientOrder(undefined)).toEqual(YTDLP_CLIENT_FALLBACKS);
  });
});

describe("getSongInfo", () => {
  beforeEach(() => youtubedl.mockReset());

  test("returns info and clientArg on the first successful client", async () => {
    youtubedl.mockResolvedValueOnce({ title: "Song A" });

    const result = await getSongInfo("https://example.com/watch");

    expect(result.info).toEqual({ title: "Song A" });
    expect(result.clientArg).toBeUndefined(); // first fallback entry is the default client
    expect(youtubedl).toHaveBeenCalledTimes(1);
  });

  test("falls back to the next client after a failure", async () => {
    youtubedl.mockRejectedValueOnce(new Error("blocked")).mockResolvedValueOnce({ title: "Song B" });

    const result = await getSongInfo("https://example.com/watch");

    expect(result.info).toEqual({ title: "Song B" });
    expect(result.clientArg).toBe("youtube:player_client=android");
    expect(youtubedl).toHaveBeenCalledTimes(2);
  });

  test("throws the last error if every client fails", async () => {
    youtubedl.mockRejectedValue(new Error("all clients blocked"));

    await expect(getSongInfo("https://example.com/watch")).rejects.toThrow("all clients blocked");
    expect(youtubedl).toHaveBeenCalledTimes(YTDLP_CLIENT_FALLBACKS.length);
  });
});

describe("createYtDlpAudioStream", () => {
  beforeEach(() => youtubedl.exec.mockReset());
  afterEach(() => jest.useRealTimers());

  test("resolves with the stream once yt-dlp emits data", async () => {
    const subprocess = makeFakeSubprocess();
    youtubedl.exec.mockReturnValue(subprocess);

    const streamPromise = createYtDlpAudioStream("https://example.com/watch", undefined);
    // listeners are attached synchronously before the first await, so this is safe
    subprocess.stdout.emit("data", Buffer.from("audio-bytes"));

    const result = await streamPromise;

    expect(result.stream).toBe(subprocess.stdout);
    expect(result.process).toBe(subprocess);
    expect(youtubedl.exec).toHaveBeenCalledTimes(1);
  });

  test("tries the next client if one exits before producing audio", async () => {
    const failing = makeFakeSubprocess();
    const working = makeFakeSubprocess();
    youtubedl.exec.mockReturnValueOnce(failing).mockReturnValueOnce(working);

    const streamPromise = createYtDlpAudioStream("https://example.com/watch", undefined);

    failing.emit("exit", 1);
    // give the retry loop a couple of ticks to spawn the next client and
    // attach its listeners before we emit on it
    await tick();
    await tick();
    working.stdout.emit("data", Buffer.from("ok"));

    const result = await streamPromise;

    expect(result.process).toBe(working);
    expect(youtubedl.exec).toHaveBeenCalledTimes(2);
    expect(failing.kill).toHaveBeenCalled();
  });

  test("resolves anyway if yt-dlp is just slow to start", async () => {
    jest.useFakeTimers();
    const slow = makeFakeSubprocess();
    youtubedl.exec.mockReturnValue(slow);

    const streamPromise = createYtDlpAudioStream("https://example.com/watch", undefined);
    jest.advanceTimersByTime(10_000);

    const result = await streamPromise;

    expect(result.process).toBe(slow);
  });

  test("throws the last error if every client fails to produce audio", async () => {
    youtubedl.exec.mockImplementation(() => makeFakeSubprocess());

    const streamPromise = createYtDlpAudioStream("https://example.com/watch", undefined);

    // fail every spawned subprocess in turn
    for (let i = 0; i < YTDLP_CLIENT_FALLBACKS.length; i++) {
      await tick();
      const subprocess = youtubedl.exec.mock.results[i].value;
      subprocess.emit("exit", 1);
    }

    await expect(streamPromise).rejects.toThrow(/yt-dlp exited/);
  });
});
