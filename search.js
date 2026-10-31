const axios = require("axios");
const { extractVideoId } = require("./utils");

// Resolves a !play query to a YouTube video ID - either lifted straight out
// of a pasted URL, or found via the YouTube Data API search endpoint.
// `config` is passed in explicitly (rather than required from config.json)
// so this module has no dependency on a file that doesn't exist in tests.
async function search(args, config) {
  const idFromUrl = extractVideoId(args);
  if (idFromUrl) return idFromUrl;

  const { youtubeApiKey, maxResults } = config;

  try {
    const response = await axios.get("https://youtube.googleapis.com/youtube/v3/search", {
      params: { key: youtubeApiKey, part: "snippet", type: "video", maxResults, q: args.join(" ") },
    });
    return response?.data?.items?.[0]?.id?.videoId ?? null;
  } catch (error) {
    // only the message - the full axios error includes the API key
    console.error(`YouTube search failed: ${error.message}`);
    return null;
  }
}

module.exports = { search };
