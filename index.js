const { Client, Events, GatewayIntentBits } = require("discord.js");
const { prefix, token, youtubeApiKey, maxResults } = require("./config.json");

process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require("ffmpeg-static");

const { getSongInfo } = require("./ytdlp");
const { search } = require("./search");
const { enqueue, skip, stop, pause, resume, remove, checkQueue, destroyAllQueues } = require("./queue");

const client = new Client({
  intents: [
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
  ],
  allowedMentions: { parse: [] }, // video titles are untrusted, don't let them ping anyone
});

client.on(Events.Error, (err) => {
  console.error("[client] error:", err);
});

// A failed send (missing permissions, say) shouldn't take the bot down for every server.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

client.once(Events.ClientReady, () => {
  console.log("Ready!");
});

// Note: these fire on the shard, not the client, in discord.js v14.
client.on(Events.ShardReconnecting, () => {
  console.log("Reconnecting!");
});

client.on(Events.ShardDisconnect, () => {
  console.log("Disconnect!");
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const [command, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);

  switch (command?.toLowerCase()) {
    case "play":
      return execute(message, args);
    case "skip":
      return skip(message);
    case "stop":
      return stop(message);
    case "pause":
      return pause(message);
    case "resume":
      return resume(message);
    case "queue":
      return checkQueue(message);
    case "remove":
      return remove(message, args[0]);
    default:
      return;
  }
});

async function execute(message, args) {
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) {
    return message.channel.send({ content: "You need to be in a voice channel to play music!" });
  }

  if (!args.length) {
    return message.channel.send({ content: `Usage: ${prefix}play <song name or YouTube link>` });
  }

  const songId = await search(args, { youtubeApiKey, maxResults });
  if (!songId) {
    return message.channel.send({ content: "Could not find the song" });
  }

  let songInfo, workingClientArg;
  try {
    ({ info: songInfo, clientArg: workingClientArg } = await getSongInfo(
      `https://www.youtube.com/watch?v=${songId}`
    ));
  } catch (e) {
    console.error(e);
    // the full error is too long for Discord and contains local paths
    return message.channel.send({ content: "Couldn't load that song." });
  }

  if (!songInfo?.title) {
    return message.channel.send({ content: "Failed to fetch song" });
  }

  const song = {
    title: songInfo.title,
    url: songInfo.webpage_url ?? `https://www.youtube.com/watch?v=${songId}`,
    duration: songInfo.duration,
    clientArg: workingClientArg,
  };

  return enqueue(message, song);
}

function shutdown() {
  console.log("Shutting down, cleaning up voice connections and yt-dlp processes...");
  destroyAllQueues();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(token);
