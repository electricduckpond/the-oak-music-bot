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
const MAX_MESSAGE_LENGTH = 2000; // Discord rejects anything longer

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
    destroyQueue(guildId, serverQueue);
  }, IDLE_DISCONNECT_MS);
}

// Clears the current player first, so its Idle handler knows it's been replaced
// and doesn't advance the queue a second time.
function stopPlayback(serverQueue) {
  const { player, ytdlpProcess } = serverQueue;
  serverQueue.player = null;
  serverQueue.ytdlpProcess = null;
  ytdlpProcess?.kill();
  player?.stop(true);
}

// Safe to call more than once: destroy() throws on an already destroyed
// connection, and a stale caller mustn't remove a newer queue for the guild.
function destroyQueue(guildId, serverQueue) {
  clearIdleTimeout(serverQueue);
  stopPlayback(serverQueue);
  serverQueue.songs = [];
  if (serverQueue.connection?.state?.status !== VoiceConnectionStatus.Destroyed) {
    serverQueue.connection?.destroy();
  }
  if (queue.get(guildId) === serverQueue) queue.delete(guildId);
}

// False once a skip or stop has happened during one of play()'s awaits.
function isCurrentSong(guildId, serverQueue, song) {
  return queue.get(guildId) === serverQueue && serverQueue.songs[0] === song;
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
    if (queue.get(guild.id) !== serverQueue) return;
    serverQueue.textChannel.send({ content: "Couldn't establish a stable voice connection." });
    destroyQueue(guild.id, serverQueue);
    return;
  }
  if (!isCurrentSong(guild.id, serverQueue, song)) return;

  let stream, ytdlpProcess;
  try {
    ({ stream, process: ytdlpProcess } = await createYtDlpAudioStream(song.url, song.clientArg));
  } catch (err) {
    console.error("[yt-dlp] all clients failed to produce audio:", err);
    if (!isCurrentSong(guild.id, serverQueue, song)) return;
    serverQueue.textChannel.send({ content: `Couldn't get an audio stream for **${song.title}**, skipping.` });
    serverQueue.songs.shift();
    return play(guild, serverQueue.songs[0]);
  }
  if (!isCurrentSong(guild.id, serverQueue, song)) {
    ytdlpProcess.kill();
    return;
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

  // The player always goes Idle after an error, so only the Idle handler advances.
  player.on("error", (error) => {
    console.error(error.toString());
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    if (serverQueue.player !== player) return;
    stopPlayback(serverQueue);
    serverQueue.songs.shift();
    await play(guild, serverQueue.songs[0]);
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

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Seems to be reconnecting to a new channel - ignore disconnect
    } catch {
      // Real disconnect which shouldn't be recovered from
      destroyQueue(guildId, serverQueue);
    }
  });

  queue.set(guildId, serverQueue);

  try {
    await play(message.guild, serverQueue.songs[0]);
  } catch (err) {
    console.error(err);
    destroyQueue(guildId, serverQueue);
    return message.channel.send({ content: "Something went wrong starting playback." });
  }
}

async function skip(message) {
  const serverQueue = queue.get(message.guildId);
  if (!message.member.voice.channel) {
    return message.channel.send({ content: "You have to be in a voice channel to skip the music!" });
  }
  if (!serverQueue?.songs.length) {
    return message.channel.send({ content: "There is no song that I could skip!" });
  }
  stopPlayback(serverQueue);
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
  destroyQueue(message.guildId, serverQueue);
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
  for (const [index, song] of serverQueue.songs.entries()) {
    const line = `${index + 1}.  ${song.title}  --  (${secondsToTime(song.duration)})\n`;
    if (queueString.length + line.length > MAX_MESSAGE_LENGTH - 30) { // leaves room for the "more" line
      queueString += `...and ${serverQueue.songs.length - index} more\n`;
      break;
    }
    queueString += line;
  }

  return message.channel.send({ content: queueString });
}

function getAllQueues() {
  return queue;
}

function destroyAllQueues() {
  for (const [guildId, serverQueue] of queue) {
    destroyQueue(guildId, serverQueue);
  }
}

module.exports = { enqueue, skip, stop, pause, resume, remove, checkQueue, getAllQueues, destroyAllQueues };
