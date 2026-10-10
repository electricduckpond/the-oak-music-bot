jest.mock("@discordjs/voice", () => ({
  joinVoiceChannel: jest.fn(),
  createAudioResource: jest.fn(),
  createAudioPlayer: jest.fn(() => ({
    on: jest.fn(),
    play: jest.fn(),
  })),
  entersState: jest.fn(),
  AudioPlayerStatus: { Idle: "idle" },
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Signalling: "signalling",
    Connecting: "connecting",
  },
}));

jest.mock("../ytdlp", () => ({
  createYtDlpAudioStream: jest.fn(),
}));

const { joinVoiceChannel, entersState } = require("@discordjs/voice");
const { enqueue, skip, stop, pause, resume, remove, checkQueue, getAllQueues } = require("../queue");

function makeMessage({ guildId = "guild-1", inVoice = true } = {}) {
  return {
    guildId,
    guild: { id: guildId },
    member: {
      voice: {
        channel: inVoice
          ? { id: "voice-1", guild: { voiceAdapterCreator: jest.fn() } }
          : null,
      },
    },
    channel: { send: jest.fn() },
  };
}

beforeEach(() => {
  getAllQueues().clear();
  jest.clearAllMocks();
});

describe("skip", () => {
  test("asks the user to join a voice channel first", async () => {
    const message = makeMessage({ inVoice: false });
    await skip(message);
    expect(message.channel.send).toHaveBeenCalledWith({
      content: "You have to be in a voice channel to skip the music!",
    });
  });

  test("reports nothing to skip when there's no queue", async () => {
    const message = makeMessage();
    await skip(message);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "There is no song that I could skip!" });
  });

  test("removes the current song and attempts to play the next one", async () => {
    const message = makeMessage();
    getAllQueues().set(message.guildId, {
      textChannel: message.channel,
      connection: {},
      songs: [{ title: "Song A" }, { title: "Song B" }],
      player: null,
      ytdlpProcess: null,
      idleTimeout: null,
    });
    entersState.mockRejectedValueOnce(new Error("timeout")); // short-circuits play()

    await skip(message);

    expect(getAllQueues().get(message.guildId).songs).toEqual([{ title: "Song B" }]);
    expect(message.channel.send).toHaveBeenCalledWith({
      content: "Couldn't establish a stable voice connection.",
    });
  });
});

describe("stop", () => {
  test("asks the user to join a voice channel first", () => {
    const message = makeMessage({ inVoice: false });
    stop(message);
    expect(message.channel.send).toHaveBeenCalledWith({
      content: "You have to be in a voice channel to stop the music!",
    });
  });

  test("reports nothing to stop when there's no active queue", () => {
    const message = makeMessage();
    stop(message);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "There is no song that I could stop!" });
  });

  test("clears the queue, kills yt-dlp, destroys the connection, and removes the guild entry", () => {
    const message = makeMessage();
    const destroy = jest.fn();
    const kill = jest.fn();
    getAllQueues().set(message.guildId, {
      textChannel: message.channel,
      connection: { destroy },
      songs: [{ title: "Song A" }],
      player: null,
      ytdlpProcess: { killed: false, kill },
      idleTimeout: setTimeout(() => {}, 10_000),
    });

    stop(message);

    expect(destroy).toHaveBeenCalled();
    expect(kill).toHaveBeenCalled();
    expect(getAllQueues().has(message.guildId)).toBe(false);
  });
});

describe("pause / resume", () => {
  test("pause reports nothing playing when there is no player", () => {
    const message = makeMessage();
    pause(message);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "Nothing is playing right now!" });
  });

  test("pause pauses the current player", () => {
    const message = makeMessage();
    const pauseFn = jest.fn();
    getAllQueues().set(message.guildId, { player: { pause: pauseFn }, songs: [] });

    pause(message);

    expect(pauseFn).toHaveBeenCalled();
    expect(message.channel.send).toHaveBeenCalledWith({ content: "⏸️ Paused." });
  });

  test("resume reports nothing playing when there is no player", () => {
    const message = makeMessage();
    resume(message);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "Nothing is playing right now!" });
  });

  test("resume unpauses the current player", () => {
    const message = makeMessage();
    const unpause = jest.fn();
    getAllQueues().set(message.guildId, { player: { unpause }, songs: [] });

    resume(message);

    expect(unpause).toHaveBeenCalled();
    expect(message.channel.send).toHaveBeenCalledWith({ content: "▶️ Resumed." });
  });
});

describe("remove", () => {
  function seedQueue(guildId, songs, textChannel) {
    getAllQueues().set(guildId, { textChannel, connection: {}, songs, player: null, ytdlpProcess: null, idleTimeout: null });
  }

  test("rejects a non-numeric index", () => {
    const message = makeMessage();
    remove(message, "abc");
    expect(message.channel.send).toHaveBeenCalledWith({ content: "Could not parse to integer" });
  });

  test("reports when there's no queue", () => {
    const message = makeMessage();
    remove(message, "1");
    expect(message.channel.send).toHaveBeenCalledWith({ content: "No songs in queue or not in a server" });
  });

  test("rejects an out-of-range index", () => {
    const message = makeMessage();
    seedQueue(message.guildId, [{ title: "Song A" }], message.channel);
    remove(message, "5");
    expect(message.channel.send).toHaveBeenCalledWith({ content: "Queue is not that long" });
  });

  test("removes a song from the middle of the queue", () => {
    const message = makeMessage();
    seedQueue(
      message.guildId,
      [{ title: "Song A" }, { title: "Song B" }, { title: "Song C" }],
      message.channel
    );

    remove(message, "2");

    expect(getAllQueues().get(message.guildId).songs.map((s) => s.title)).toEqual(["Song A", "Song C"]);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "Song removed: Song B at index 2" });
  });

  test("removing index 1 defers to skip instead of splicing", async () => {
    const message = makeMessage();
    seedQueue(message.guildId, [{ title: "Song A" }, { title: "Song B" }], message.channel);
    entersState.mockRejectedValueOnce(new Error("timeout")); // short-circuits play()

    await remove(message, "1");

    expect(getAllQueues().get(message.guildId).songs).toEqual([{ title: "Song B" }]);
  });
});

describe("checkQueue", () => {
  test("reports an empty queue", () => {
    const message = makeMessage();
    checkQueue(message);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "The queue is empty." });
  });

  test("lists songs with total and per-song time", () => {
    const message = makeMessage();
    getAllQueues().set(message.guildId, {
      songs: [
        { title: "Song A", duration: 60 },
        { title: "Song B", duration: 125 },
      ],
    });

    checkQueue(message);

    expect(message.channel.send).toHaveBeenCalledWith({
      content:
        "Total Time: (00:03:05) \nCurrent Queue:\n1.  Song A  --  (00:01:00)\n2.  Song B  --  (00:02:05)\n",
    });
  });
});

describe("enqueue", () => {
  test("adds to an existing, active queue instead of joining again", async () => {
    const message = makeMessage();
    getAllQueues().set(message.guildId, {
      textChannel: message.channel,
      connection: { state: { status: "ready" } },
      songs: [{ title: "Song A" }],
    });

    await enqueue(message, { title: "Song B" });

    expect(joinVoiceChannel).not.toHaveBeenCalled();
    expect(getAllQueues().get(message.guildId).songs).toHaveLength(2);
    expect(message.channel.send).toHaveBeenCalledWith({ content: "Song B has been added to the queue!" });
  });

  test("joins the voice channel and starts a new queue when none exists", async () => {
    const message = makeMessage();
    const connection = { on: jest.fn(), state: { status: "ready" } };
    joinVoiceChannel.mockReturnValue(connection);
    entersState.mockRejectedValueOnce(new Error("timeout")); // short-circuits play()

    await enqueue(message, { title: "Song A" });

    expect(joinVoiceChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "voice-1", guildId: message.guildId })
    );
    expect(getAllQueues().get(message.guildId).songs).toEqual([{ title: "Song A" }]);
  });

  test("re-joins if the previous connection for the guild was destroyed", async () => {
    const message = makeMessage();
    getAllQueues().set(message.guildId, {
      textChannel: message.channel,
      connection: { state: { status: "destroyed" } },
      songs: [{ title: "Old Song" }],
    });
    const connection = { on: jest.fn(), state: { status: "ready" } };
    joinVoiceChannel.mockReturnValue(connection);
    entersState.mockRejectedValueOnce(new Error("timeout"));

    await enqueue(message, { title: "New Song" });

    expect(joinVoiceChannel).toHaveBeenCalled();
    expect(getAllQueues().get(message.guildId).songs).toEqual([{ title: "New Song" }]);
  });
});
