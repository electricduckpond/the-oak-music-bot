jest.mock("axios");

const axios = require("axios");
const { search } = require("../search");

const config = { youtubeApiKey: "test-key", maxResults: 5 };

afterEach(() => {
  jest.clearAllMocks();
});

test("returns the video id directly for a YouTube URL without hitting the API", async () => {
  const id = await search(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"], config);
  expect(id).toBe("dQw4w9WgXcQ");
  expect(axios.get).not.toHaveBeenCalled();
});

test("falls back to the YouTube Data API for a text query", async () => {
  axios.get.mockResolvedValue({
    data: { items: [{ id: { videoId: "abc123" } }] },
  });

  const id = await search(["never", "gonna", "give", "you", "up"], config);

  expect(id).toBe("abc123");
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining("q=never%20gonna%20give%20you%20up"));
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining("key=test-key"));
  expect(axios.get).toHaveBeenCalledWith(expect.stringContaining("maxResults=5"));
});

test("returns null when the API call fails", async () => {
  axios.get.mockRejectedValue(new Error("network error"));
  const id = await search(["some", "query"], config);
  expect(id).toBeNull();
});

test("returns null when the API returns no results", async () => {
  axios.get.mockResolvedValue({ data: { items: [] } });
  const id = await search(["obscure", "query"], config);
  expect(id).toBeNull();
});
