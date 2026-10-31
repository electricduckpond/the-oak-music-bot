const { secondsToTime, totalQueueTime, extractVideoId } = require("../utils");

describe("secondsToTime", () => {
  test("formats hours, minutes, and seconds", () => {
    expect(secondsToTime(3661)).toBe("01:01:01");
  });

  test("formats zero", () => {
    expect(secondsToTime(0)).toBe("00:00:00");
  });

  test("pads single digits", () => {
    expect(secondsToTime(65)).toBe("00:01:05");
  });

  test("accepts numeric strings", () => {
    expect(secondsToTime("125")).toBe("00:02:05");
  });

  test.each([undefined, null, NaN, "not-a-number", -5])(
    "falls back to 00:00:00 for invalid input %p",
    (input) => {
      expect(secondsToTime(input)).toBe("00:00:00");
    }
  );
});

describe("totalQueueTime", () => {
  test("sums durations across songs", () => {
    const songs = [{ duration: 60 }, { duration: 120 }, { duration: 30 }];
    expect(totalQueueTime(songs)).toBe("00:03:30");
  });

  test("treats missing or invalid durations as zero", () => {
    const songs = [{ duration: 60 }, { duration: undefined }, { duration: "oops" }];
    expect(totalQueueTime(songs)).toBe("00:01:00");
  });

  test("an empty queue is zero", () => {
    expect(totalQueueTime([])).toBe("00:00:00");
  });
});

describe("extractVideoId", () => {
  test.each([
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=abc",
    "https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
  ])("extracts the id from %s", (url) => {
    expect(extractVideoId([url])).toBe("dQw4w9WgXcQ");
  });

  test.each([
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/watch?v=bad%20id",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
  ])("returns null for %s", (url) => {
    expect(extractVideoId([url])).toBeNull();
  });

  test("extracts the id from a standard watch URL", () => {
    expect(extractVideoId(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"])).toBe("dQw4w9WgXcQ");
  });

  test("strips trailing params like &t=30s", () => {
    expect(extractVideoId(["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s"])).toBe("dQw4w9WgXcQ");
  });

  test("extracts the id from a youtu.be short link", () => {
    expect(extractVideoId(["https://youtu.be/dQw4w9WgXcQ"])).toBe("dQw4w9WgXcQ");
  });

  test("strips query params off a youtu.be link", () => {
    expect(extractVideoId(["https://youtu.be/dQw4w9WgXcQ?si=abc123"])).toBe("dQw4w9WgXcQ");
  });

  test("returns null for a plain search term", () => {
    expect(extractVideoId(["never", "gonna", "give", "you", "up"])).toBeNull();
  });

  test("returns null for no args", () => {
    expect(extractVideoId([])).toBeNull();
  });
});
