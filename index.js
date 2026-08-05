const { Client, Events, GatewayIntentBits } = require('discord.js');
const { prefix, token, youtubeApiKey, maxResults } = require("./config.json");
const youtubedl = require("youtube-dl-exec"); // wraps the yt-dlp binary, auto-installed on first run
const path = require("path");
const fs = require("fs");
const axios = require('axios');
// @discordjs/voice transcodes the yt-dlp stream via prism-media -> ffmpeg.
// Point it at the prebuilt binary from ffmpeg-static so it works even if
// ffmpeg isn't installed system-wide.
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');
const { joinVoiceChannel, createAudioResource, getVoiceConnection, AudioPlayerStatus, VoiceConnectionStatus, entersState,
  createAudioPlayer } = require('@discordjs/voice');

// yt-dlp expects cookies in Netscape cookies.txt format, not the JSON format
// ytdl-core used. Export cookies with a browser extension like "Get cookies.txt
// LOCALLY" and point this at the resulting file. Leave the file absent/empty and
// ytdl-core-style JSON cookies will simply be ignored (age-restricted / bot-check
// videos may then fail).
const COOKIES_PATH = path.join(__dirname, "cookies.txt");
const cookiesOption = fs.existsSync(COOKIES_PATH) ? { cookies: COOKIES_PATH } : {};

// yt-dlp needs an external JS runtime to solve YouTube's signature/"n"
// challenges - without one, most clients can only return thumbnail images,
// no actual media. Using the Node.js install this bot already runs on.
// (QuickJS was tried and worked, but the qjs.exe binary got flagged by
// antivirus - reverted, do not re-add it without confirming it's clean.)
const jsRuntimeOption = { jsRuntimes: "node" };

const YTDLP_BASE_OPTS = {
  noCheckCertificate: true,
  preferFreeFormats: true,
  ...jsRuntimeOption,
  ...cookiesOption,
};

// YouTube keeps A/B-testing which "player client" is allowed to fetch
// formats, and yt-dlp keeps adapting - no single client stays reliable for
// long right now, and the SAME client can return a full format list on one
// request and an empty one moments later. `undefined` first lets yt-dlp use
// its own built-in multi-client fallback logic (usually the best bet); the
// rest are extra tries if that still comes back empty for a given video.
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

async function getSongInfo(url) {
  let lastErr;
  for (const clientArg of YTDLP_CLIENT_FALLBACKS) {
    try {
      const info = await youtubedl(
        url,
        ytdlpOptsFor(clientArg, { dumpSingleJson: true, format: "bestaudio/best" })
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

  const stderrLines = [];
  subprocess.stderr?.on("data", (chunk) => {
    // yt-dlp writes progress AND real errors (403s, bot-check, missing
    // formats, etc) to stderr - surface them instead of hiding them.
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

// Formats resolve inconsistently between requests right now (YouTube-side,
// documented flakiness), so rather than trusting the first spawn, wait to
// see actual audio bytes arrive before committing to a client. If the
// process exits first (empty format list, 403, etc), kill it and retry the
// next client. The peeked chunk is pushed back with unshift() so nothing is
// lost once playback actually starts consuming the stream.
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
  const clientsToTry = [preferredClientArg, ...YTDLP_CLIENT_FALLBACKS].filter(
    (client, index, arr) => arr.indexOf(client) === index
  );

  let lastErr;
  for (const clientArg of clientsToTry) {
    const { subprocess, stderrLines } = spawnYtDlpAudio(url, clientArg);
    try {
      await waitForAudioOrFail(subprocess, stderrLines);
      return { stream: subprocess.stdout, process: subprocess };
    } catch (err) {
      lastErr = err;
      console.warn(`[yt-dlp] client "${clientArg ?? "default"}" failed to produce audio, trying next client...`);
      if (!subprocess.killed) subprocess.kill();
    }
  }
  throw lastErr;
}

const client = new Client({ intents: [GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent] });

const queue = new Map();

let timeout;

client.once("ready", () => {
  console.log("Ready!");
});

client.once("reconnecting", () => {
  console.log("Reconnecting!");
});

client.once("disconnect", () => {
  console.log("Disconnect!");
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const serverQueue = queue.get(message.guildId);

  if (message.content.toLowerCase().startsWith(`${prefix}play`)) {
    execute(message, serverQueue);
    return;
  } else if (message.content.toLowerCase().startsWith(`${prefix}skip`)) {
    skip(message, serverQueue);
    return;
  } else if (message.content.toLowerCase().startsWith(`${prefix}stop`)) {
    stop(message, serverQueue);
    return;
  } else if (message.content.toLowerCase().startsWith(`${prefix}queue`)) {
    checkQueue(message, serverQueue);
    return;
  } else if (message.content.toLowerCase().startsWith(`${prefix}remove`)) {
    remove(message, serverQueue);
    return;
  }
});

async function search(message){

  const words = message.content.split(" ");
  words.shift();

  if (words[0]?.startsWith("https://www.youtube.com/watch?v=")) {
    return words[0]?.replace("https://www.youtube.com/watch?v=", "");
  }

  if (words[0]?.startsWith("https://youtu.be/")) {
    return words[0]?.replace("https://youtu.be/", "");
  }

  const searchStringUrlEncoded = encodeURIComponent(words.join(" "));

  try {
    const response = await axios.get(`https://youtube.googleapis.com/youtube/v3/search?key=${youtubeApiKey}&part=snippet&type=video&maxResults=${maxResults.toString()}&q=${searchStringUrlEncoded}`);

    return response?.data?.items[0]?.id?.videoId; 
  }
  catch (error) {
    message.channel.send({ content: error.message});
    console.log(error);
  }
}

async function execute(message, serverQueue) {

  const songUrl = await search(message);

  if(!songUrl){
    return message.channel.send({ content: 
      "Could not find the song"
    });
  }

  const voiceChannel = message.member.voice.channel;

  if (!voiceChannel)
    return message.channel.send({ content: 
      "You need to be in a voice channel to play music!"
    });

  console.log(songUrl);
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice connection] ${oldState.status} -> ${newState.status}`);
  });
  connection.on("debug", (message) => {
    console.log(`[voice debug] ${message}`);
  });
  connection.on("error", (err) => {
    console.error("[voice connection] error:", err);
  });

  var songInfo, workingClientArg;

  try {
      ({ info: songInfo, clientArg: workingClientArg } = await getSongInfo(`https://www.youtube.com/watch?v=${songUrl}`));
      //console.log(songInfo);
  }
  catch (e) {
    console.log(e);
    return message.channel.send({ content: e.toString()});
  }

  if (!songInfo?.title) {
    return message.channel.send({ content: "Faild to fetch song"});
  }
  
  const song = {
    title: songInfo?.title,
    url: songInfo?.webpage_url ?? `https://www.youtube.com/watch?v=${songUrl}`,
    duration: songInfo?.duration,
    clientArg: workingClientArg
  };

  if (!serverQueue || serverQueue?.connection?.state?.status === 'destroyed') {
    const queueContruct = {
      textChannel: message.channel,
      voiceChannel: voiceChannel,
      connection: null,
      songs: [],
      volume: 5,
      playing: true
    };

    queue.set(message.guild.id, queueContruct);

    queueContruct.songs.push(song);

    try {
      queueContruct.connection = connection;
      await play(message.guild, queueContruct.songs[0], queueContruct.voiceChannel);
    } catch (err) {
      console.log(err);
      queue.delete(message.guild.id);
      return message.channel.send({ content: err.toString()});
    }
  } else {
    serverQueue.songs.push(song);
    return message.channel.send({ content: `${song.title} has been added to the queue!`});
  }
}

async function getMessageContent(message) {
  let words = message.content.split(" ");
  words.shift();

  return words;
}

async function remove(message, serverQueue) {
  
  const messageContent = await getMessageContent(message);

  try {
      const queueNumber = parseInt(messageContent);

      if(!queueNumber) {
        return message.channel.send({ content: "Could not parse to integer"});
      }

      if(!serverQueue?.songs) {
        return message.channel.send({ content: "no songs in queue or not in server"});
      }

      if(queueNumber > serverQueue?.songs?.length || queueNumber < 1) {
        return message.channel.send({ content: "Queue is not that long"});
      }

      if(queueNumber == 1) {
        skip(message, serverQueue);

        return;
      }     

      message.channel.send({ content: `Song removed: ${serverQueue.songs[queueNumber - 1].title} at index ${queueNumber}`});

      serverQueue.songs.splice(queueNumber - 1, 1);

      return
  }
  catch {
    return message.channel.send({ content: "Could not parse to integer"});
  }  
}

async function skip(message, serverQueue) {
  if (!message.member.voice.channel)
    return message.channel.send({ content: 
      "You have to be in a voice channel to stop the music!"
    });
  if (!serverQueue)
    return message.channel.send({ content: "There is no song that I could skip!"});
    serverQueue.songs.shift();
    await play(message.guild, serverQueue.songs[0]);
}

function stop(message, serverQueue) {
  if (!message.member.voice.channel)
    return message.channel.send({ content: 
      "You have to be in a voice channel to stop the music!"
    });
  
    if(!serverQueue || !serverQueue.connection)
    return message.channel.send({ content: "There is no song that I could stop!"});
  serverQueue.songs = [];
  serverQueue?.connection?.destroy();
}

function secondsToTime(e){
  var h = Math.floor(e / 3600).toString().padStart(2,'0'),
      m = Math.floor(e % 3600 / 60).toString().padStart(2,'0'),
      s = Math.floor(e % 60).toString().padStart(2,'0');
  
  return h + ':' + m + ':' + s;
}

function totalQueueTime(songs){

  total = 0;
  songs.forEach(song => {
    total += parseInt(song.duration);
  })

  return secondsToTime(total);
}

function checkQueue(message, serverQueue) {
  
  if(!serverQueue?.songs) return;

  queueString = `Total Time: (${totalQueueTime(serverQueue.songs)}) \nCurrent Queue:\n`;

  serverQueue.songs.forEach((song, index) => {
    queueString += `${(index + 1).toString()}.  ${song.title}  --  (${secondsToTime(song.duration)})\n`;
  })

  return message.channel.send({ content: queueString});
}

async function play(guild, song, voiceChannel) {

  const serverQueue = queue.get(guild.id);

  console.log(serverQueue);
  if (!song) {

   timeout = setTimeout(() => {

      serverQueue?.connection?.destroy();
      queue.delete(guild.id);
    }, 300);

    return;
  }

  clearTimeout(timeout);
  console.log(song.url);

  try {
    await entersState(serverQueue.connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error("Voice connection never became Ready:", err);
    serverQueue.textChannel.send({ content: "Couldn't establish a stable voice connection." });
    return;
  }

  let stream1, ytdlpProcess;
  try {
    ({ stream: stream1, process: ytdlpProcess } = await createYtDlpAudioStream(song.url, song.clientArg));
  } catch (err) {
    console.error("[yt-dlp] all clients failed to produce audio:", err);
    serverQueue.textChannel.send({ content: `Couldn't get an audio stream for **${song.title}**, skipping.` });
    serverQueue.songs.shift();
    return play(guild, serverQueue.songs[0]);
  }

  const playerf = createAudioPlayer();
  const resource = createAudioResource(stream1);

  playerf.on("stateChange", (oldState, newState) => {
    console.log(`[player] ${oldState.status} -> ${newState.status}`);
  });

  playerf.play(resource);
  serverQueue.connection.subscribe(playerf);

  const killYtDlp = () => {
    if (!ytdlpProcess.killed) ytdlpProcess.kill();
  };

  playerf.on("error", async (error) => {
    killYtDlp();
    serverQueue.songs.shift();
    //player.stop();  
    await play(guild, serverQueue.songs[0]);
    console.error(error.toString());     
  });

  playerf.on(AudioPlayerStatus.Idle, async () => {
    killYtDlp();
    serverQueue.songs.shift();
    playerf.stop();
    await play(guild, serverQueue.songs[0]);    
  });

 serverQueue.connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
// Seems to be reconnecting to a new channel - ignore disconnect
    } catch (error) {
      // Seems to be a real disconnect which SHOULDN'T be recovered from
      serverQueue?.connection?.destroy();
    }
  });

  serverQueue.textChannel.send({ content: `Start playing: **${song.title}**`});
}

client.login(token);