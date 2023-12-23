const { Client, Events, GatewayIntentBits } = require('discord.js');
const { prefix, token, youtubeApiKey, maxResults } = require("./config.json");
const ytdl = require("ytdl-core");
const axios = require('axios');
const { joinVoiceChannel,createAudioResource, getVoiceConnection, AudioPlayerStatus,
  createAudioPlayer } = require('@discordjs/voice');

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

  var songInfo;

  try {
      songInfo = await ytdl.getInfo(`https://www.youtube.com/watch?v=${songUrl}`);
      console.log(songInfo);
  }
  catch (e) {
    console.log(e);
    return message.channel.send({ content: e.toString()});
  }

  if (!songInfo?.videoDetails) {
    return message.channel.send({ content: "Faild to fetch song"});
  }
  
  const song = {
    title: songInfo?.videoDetails?.title,
    url: songInfo?.videoDetails?.video_url,
    duration: songInfo?.videoDetails?.lengthSeconds
  };

  if (!serverQueue) {
    const queueContruct = {
      textChannel: message.channel,
      voiceChannel: null,
      connection: null,
      songs: [],
      volume: 5,
      playing: true
    };

    queue.set(message.guild.id, queueContruct);

    queueContruct.songs.push(song);

    try {
      queueContruct.connection = connection;
      await play(message.guild, queueContruct.songs[0]);
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

async function play(guild, song) {
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
 const stream = ytdl(song.url, {filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1<<25}, {highWaterMark: 1});
 const player = createAudioPlayer();
 const resource = createAudioResource(stream);
 player.play(resource);
 serverQueue.connection.subscribe(player);

  player.on("error", async (error) => {
    serverQueue.songs.shift();
    await play(guild, serverQueue.songs[0]);
    console.error(error.toString());      
  });

  player.on(AudioPlayerStatus.Idle, async () => {
    serverQueue.songs.shift();
    await play(guild, serverQueue.songs[0]);
  });

  serverQueue.textChannel.send({ content: `Start playing: **${song.title}**`});
}

client.login(token);
