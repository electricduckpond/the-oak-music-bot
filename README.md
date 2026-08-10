# The Oak Music Bot

A Discord music bot built with Discord.js, Discord Player, yt‑dlp, and ffmpeg.  
Supports YouTube playback, search, queueing, and high‑quality audio streaming.

---

## Features

- 🎵 Play music from YouTube using `yt-dlp`
- 🔍 Search YouTube with API integration
- 🔊 High‑quality audio via `@discordjs/voice` + ffmpeg
- 📦 Docker support for easy deployment
- ⚙️ Automatic ffmpeg + yt‑dlp setup
- 🍪 Optional cookies.txt support for region‑locked videos

---

## Requirements

### Local Installation
- Node.js **24 LTS**  
- npm (comes with Node)
- ffmpeg (optional — the bot uses `ffmpeg-static` automatically)
- A Discord bot token  
- A YouTube API key (for search)

### Docker Installation
- Docker Engine 20+
- Docker Compose (optional)

---

## Clone the Repository

```bash
git clone https://github.com/your-username/the-oak-music-bot.git
cd the-oak-music-bot
```

## Getting Your Discord Bot Token

To run the bot, you need a **Discord Bot Token**. This token allows your bot to log in to Discord’s API.

### 1. Create a Discord Application
1. Go to the Discord Developer Portal:  
   https://discord.com/developers/applications
2. Click **New Application**
3. Give it a name (e.g., *Oak Music Bot*)
4. Click **Create**

### 2. Create a Bot User
1. In your application, open the **Bot** tab
2. Click **Add Bot**
3. Confirm by clicking **Yes, do it!**

### 3. Get the Bot Token
1. Under the **Bot** tab, find the **Token** section
2. Click **Reset Token** (if needed)
3. Click **Copy** to copy your bot token

> ⚠️ **Important:**  
> Never share your bot token.  
> Anyone with this token can control your bot.

### 4. Invite the Bot to Your Server
1. Go to the **OAuth2 → URL Generator** tab  
2. Under **Scopes**, select:
   - `bot`
3. Under **Bot Permissions**, select:
   - `Connect`
   - `Speak`
   - `Read Messages/View Channels`
4. Copy the generated URL and open it in your browser
5. Choose your server and click **Authorize**

---

## Getting Your YouTube API Key

The bot uses the YouTube Data API to perform searches.

### 1. Open Google Cloud Console
https://console.cloud.google.com/

### 2. Create a Project
1. Click **Select a project**
2. Click **New Project**
3. Name it (e.g., *Oak Music Bot*)
4. Click **Create**

### 3. Enable the YouTube Data API
1. In the left sidebar, go to **APIs & Services → Library**
2. Search for **YouTube Data API v3**
3. Click **Enable**

### 4. Create API Credentials
1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials**
3. Choose **API Key**
4. Copy the generated key

### 5. (Optional) Restrict Your API Key
To prevent abuse:
1. Click your API key in the list
2. Under **API restrictions**, select:
   - **YouTube Data API v3**
3. Save changes

---

Place both keys in your `config.json`:

```json
{
  "prefix": "!",
  "token": "YOUR_DISCORD_BOT_TOKEN",
  "youtubeApiKey": "YOUR_YOUTUBE_API_KEY",
  "maxResults": 10
}
```

## Optional: cookies.txt
Some YouTube videos require authentication (age‑restricted, region‑locked, or personalised recommendations).
To allow the bot to access these videos, you can provide a cookies.txt file.

### Recommended Method: Browser Extensions
Use one of these trusted extensions to export your browser cookies:

Get cookies.txt LOCALLY (Chrome)

cookies.txt (Firefox)

These extensions export your cookies in the correct format for yt‑dlp.

⚠️ Security Warning  
If you previously installed the Chrome extension named “Get cookies.txt” (without “LOCALLY”), uninstall it immediately.
It has been reported as malware and was removed from the Chrome Web Store.

### Required Format
Your cookies.txt file must follow the Mozilla/Netscape cookie format.

The first line must be exactly one of:

```bash
# HTTP Cookie File
```
or

```bash
# Netscape HTTP Cookie File
```

If this line is missing, yt‑dlp will reject the file.

### Where to Put the File
Place cookies.txt in the root of your project:

```bash
the-oak-music-bot/
 ├── index.js
 ├── config.json
 ├── cookies.txt   ← optional
```

## Install Dependencies
```bash
npm install
```
If you changed Node versions:

```bash
rm -rf node_modules package-lock.json
npm install
```

## Running the Bot (Local)
```bash
npm run bot
```
The bot will log in and respond to commands using your configured prefix.

## Running the Bot with Docker
Build the image
```bash
docker build -t oak-music-bot .
```

Then run:

```bash
docker run -d --name oak-bot oak-music-bot
```
## Commands
| Command | Description |
| --- | --- |
| ``!play <query>`` | Plays a song or adds it to the queue either with a search term or url |
| ``!skip`` | Skips the current track |
| ``!stop`` | Stops playback and clears the queue |
| ``!queue`` | Shows the current queue |
| ``!pause`` | Pauses playback |
| ``!resume`` | Resumes playback |

(Prefix is configurable in config.json.)

## Troubleshooting

### Bot doesn’t join voice channels
Make sure the bot has:

Connect

Speak
permissions in the server.

### yt‑dlp errors
Ensure:

cookies.txt is valid (if used)

You are not rate‑limited by YouTube

## Contributing
Pull requests are welcome.
Please open an issue first to discuss major changes.