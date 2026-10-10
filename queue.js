const {
  joinVoiceChannel,
  createAudioResource,
  createAudioPlayer,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const { createYtDlpAudioStream } = require("./ytdlp");
const { secondsToTime, totalQueueTime } = require("./utils");

const IDLE_DISCONNECT_MS = 5 * 60 * 1000; // leave the channel after 5 idle minutes

// guildId -> { textChannel, voiceChannel, connection, songs, player, ytdlpProcess, idleTimeout }
const queue = new Map();

function clearIdleTimeout(serverQueue) {
  if (serverQueue?.idleTimeout) {
    clearTimeout(serverQueue.idleTimeout);
    serverQueue.idleTimeout = null;
  }
}

// Each guild gets its own idle timer, stored on its own queue entry - previously
// this lived in one module-level variable shared by every guild.
function scheduleIdleDisconnect(guildId, serverQueue) {
  clearIdleTimeout(serverQueue);
  serverQueue.idleTimeout = setTimeout(() => {
    serverQueue?.connection?.destroy();
    queue.delete(guildId);
  }, IDLE_DISCONNECT_MS);
}

async function play(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!serverQueue) return;

  if (!song) {
    scheduleIdleDisconnect(guild.id, serverQueue);
    return;
  }

  clearIdleTimeout(serverQueue);

  try {
    await entersState(serverQueue.connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error("Voice connection never became Ready:", err);
    serverQueue.textChannel.send({ content: "Couldn't establish a stable voice connection." });
    return;
  }

  let stream, ytdlpProcess;
  try {
    ({ stream, process: ytdlpProcess } = await createYtDlpAudioStream(song.url, song.clientArg));
  } catch (err) {
    console.error("[yt-dlp] all clients failed to produce audio:", err);
    serverQueue.textChannel.send({ content: `Couldn't get an audio stream for **${song.title}**, skipping.` });
    serverQueue.songs.shift();
    return play(guild, serverQueue.songs[0]);
  }

  const player = createAudioPlayer();
  const resource = createAudioResource(stream);

  serverQueue.player = player;
  serverQueue.ytdlpProcess = ytdlpProcess;

  player.on("stateChange", (oldState, newState) => {
    console.log(`[player] ${oldState.status} -> ${newState.status}`);
  });

  player.play(resource);
  serverQueue.connection.subscribe(player);

  const killYtDlp = () => {
    if (ytdlpProcess && !ytdlpProcess.killed) ytdlpProcess.kill();
  };

  player.on("error", async (error) => {
    console.error(error.toString());
    killYtDlp();
    serverQueue.songs.shift();
    await play(guild, serverQueue.songs[0]);
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    killYtDlp();
    serverQueue.songs.shift();
    player.stop();
    await play(guild, serverQueue.songs[0]);
  });

  serverQueue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(serverQueue.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(serverQueue.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Seems to be reconnecting to a new channel - ignore disconnect
    } catch {
      // Real disconnect which shouldn't be recovered from
      killYtDlp();
      serverQueue?.connection?.destroy();
      queue.delete(guild.id);
    }
  });

  serverQueue.textChannel.send({ content: `Start playing: **${song.title}**` });
}

async function enqueue(message, song) {
  const guildId = message.guildId;
  const voiceChannel = message.member.voice.channel;
  const existingQueue = queue.get(guildId);

  if (existingQueue && existingQueue.connection?.state?.status !== "destroyed") {
    const nothingPlaying = existingQueue.songs.length === 0;
    existingQueue.songs.push(song);

    if (nothingPlaying) {
      existingQueue.textChannel = message.channel;
      return play(message.guild, song);
    }

    return message.channel.send({ content: `${song.title} has been added to the queue!` });
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice connection] ${oldState.status} -> ${newState.status}`);
  });
  connection.on("error", (err) => {
    console.error("[voice connection] error:", err);
  });

  const serverQueue = {
    textChannel: message.channel,
    voiceChannel,
    connection,
    songs: [song],
    player: null,
    ytdlpProcess: null,
    idleTimeout: null,
  };

  queue.set(guildId, serverQueue);

  try {
    await play(message.guild, serverQueue.songs[0]);
  } catch (err) {
    console.error(err);
    queue.delete(guildId);
    connection.destroy();
    return message.channel.send({ content: err.toString() });
  }
}

async function skip(message) {
  const serverQueue = queue.get(message.guildId);
  if (!message.member.voice.channel) {
    return message.channel.send({ content: "You have to be in a voice channel to skip the music!" });
  }
  if (!serverQueue) {
    return message.channel.send({ content: "There is no song that I could skip!" });
  }
  serverQueue.songs.shift();
  await play(message.guild, serverQueue.songs[0]);
}

function stop(message) {
  const serverQueue = queue.get(message.guildId);
  if (!message.member.voice.channel) {
    return message.channel.send({ content: "You have to be in a voice channel to stop the music!" });
  }
  if (!serverQueue || !serverQueue.connection) {
    return message.channel.send({ content: "There is no song that I could stop!" });
  }
  serverQueue.songs = [];
  clearIdleTimeout(serverQueue);
  if (serverQueue.ytdlpProcess && !serverQueue.ytdlpProcess.killed) serverQueue.ytdlpProcess.kill();
  serverQueue.connection.destroy();
  queue.delete(message.guildId);
}

function pause(message) {
  const serverQueue = queue.get(message.guildId);
  if (!serverQueue?.player) {
    return message.channel.send({ content: "Nothing is playing right now!" });
  }
  serverQueue.player.pause();
  return message.channel.send({ content: "⏸️ Paused." });
}

function resume(message) {
  const serverQueue = queue.get(message.guildId);
  if (!serverQueue?.player) {
    return message.channel.send({ content: "Nothing is playing right now!" });
  }
  serverQueue.player.unpause();
  return message.channel.send({ content: "▶️ Resumed." });
}

function remove(message, indexArg) {
  const serverQueue = queue.get(message.guildId);
  const queueNumber = parseInt(indexArg, 10);

  if (!queueNumber) {
    return message.channel.send({ content: "Could not parse to integer" });
  }
  if (!serverQueue?.songs) {
    return message.channel.send({ content: "No songs in queue or not in a server" });
  }
  if (queueNumber > serverQueue.songs.length || queueNumber < 1) {
    return message.channel.send({ content: "Queue is not that long" });
  }
  if (queueNumber === 1) {
    return skip(message);
  }

  message.channel.send({
    content: `Song removed: ${serverQueue.songs[queueNumber - 1].title} at index ${queueNumber}`,
  });
  serverQueue.songs.splice(queueNumber - 1, 1);
}

function checkQueue(message) {
  const serverQueue = queue.get(message.guildId);
  if (!serverQueue?.songs?.length) {
    return message.channel.send({ content: "The queue is empty." });
  }

  let queueString = `Total Time: (${totalQueueTime(serverQueue.songs)}) \nCurrent Queue:\n`;
  serverQueue.songs.forEach((song, index) => {
    queueString += `${index + 1}.  ${song.title}  --  (${secondsToTime(song.duration)})\n`;
  });

  return message.channel.send({ content: queueString });
}

function getAllQueues() {
  return queue;
}

module.exports = { enqueue, skip, stop, pause, resume, remove, checkQueue, getAllQueues };
