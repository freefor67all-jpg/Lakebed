const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

const PORT = process.env.PORT || 10000;
const MAGIC_HOUR_API_KEY = process.env.MAGIC_HOUR_API_KEY;
const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "";

const MAGIC_HOUR_API = "https://api.magichour.ai";

const uploadDir = path.join(__dirname, "uploads");
const videoDir = path.join(__dirname, "videos");
const audioDir = path.join(__dirname, "audio");

for (const dir of [uploadDir, videoDir, audioDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));
app.use("/videos", express.static(videoDir));
app.use("/audio", express.static(audioDir));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

/* ---------------------------------------------------------
   BASIC HELPERS
--------------------------------------------------------- */

function requireApiKey(res) {
  if (!MAGIC_HOUR_API_KEY) {
    res.status(500).json({
      error: "MAGIC_HOUR_API_KEY is missing in Render Environment Variables."
    });
    return false;
  }

  return true;
}

function extensionFromMime(mime) {
  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a"
  };

  return map[mime] || null;
}

async function magicHourRequest(endpoint, options = {}) {
  const response = await fetch(`${MAGIC_HOUR_API}${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${MAGIC_HOUR_API_KEY}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      message: text || "Unknown Magic Hour response"
    };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error?.message ||
      `Magic Hour request failed with HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

/* ---------------------------------------------------------
   UPLOAD FILE TO MAGIC HOUR STORAGE
--------------------------------------------------------- */

async function uploadToMagicHour(buffer, extension, type) {
  const response = await magicHourRequest("/v1/files/upload-urls", {
    method: "POST",
    body: JSON.stringify({
      items: [
        {
          extension,
          type
        }
      ]
    })
  });

  if (!response.items || !response.items[0]) {
    throw new Error("Magic Hour did not return an upload URL.");
  }

  const item = response.items[0];

  const putResponse = await fetch(item.upload_url, {
    method: "PUT",
    body: buffer
  });

  if (!putResponse.ok) {
    const message = await putResponse.text();

    throw new Error(
      `Magic Hour file upload failed: ${message || putResponse.status}`
    );
  }

  return item.file_path;
}

/* ---------------------------------------------------------
   WAIT FOR VIDEO
--------------------------------------------------------- */

async function waitForVideo(projectId, timeoutMs = 10 * 60 * 1000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const result = await magicHourRequest(
      `/v1/video-projects/${encodeURIComponent(projectId)}`
    );

    if (result.status === "complete") {
      if (!result.downloads || !result.downloads[0]?.url) {
        throw new Error("Video completed but no download URL was returned.");
      }

      return result;
    }

    if (
      result.status === "error" ||
      result.status === "canceled"
    ) {
      const apiError =
        result?.error?.message ||
        result?.error?.code ||
        "Magic Hour video generation failed.";

      throw new Error(apiError);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error("Video generation timed out.");
}

/* ---------------------------------------------------------
   WAIT FOR AUDIO
--------------------------------------------------------- */

async function waitForAudio(projectId, timeoutMs = 5 * 60 * 1000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const result = await magicHourRequest(
      `/v1/audio-projects/${encodeURIComponent(projectId)}`
    );

    if (result.status === "complete") {
      if (!result.downloads || !result.downloads[0]?.url) {
        throw new Error("Audio completed but no download URL was returned.");
      }

      return result;
    }

    if (
      result.status === "error" ||
      result.status === "canceled"
    ) {
      const apiError =
        result?.error?.message ||
        result?.error?.code ||
        "Magic Hour audio generation failed.";

      throw new Error(apiError);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error("Audio generation timed out.");
}

/* ---------------------------------------------------------
   DOWNLOAD REMOTE FILE
--------------------------------------------------------- */

async function downloadBuffer(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Could not download generated file. HTTP ${response.status}`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

/* ---------------------------------------------------------
   MERGE AUDIO + VIDEO
--------------------------------------------------------- */

function mergeAudioWithVideo(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",

      "-i",
      videoPath,

      "-i",
      audioPath,

      "-map",
      "0:v:0",

      "-map",
      "1:a:0",

      "-c:v",
      "copy",

      "-c:a",
      "aac",

      "-b:a",
      "192k",

      "-af",
      "apad",

      "-t",
      "6",

      "-movflags",
      "+faststart",

      outputPath
    ];

    const process = spawn(ffmpegPath, args);

    let stderr = "";

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("error", (error) => {
      reject(error);
    });

    process.on("close", (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg failed with code ${code}: ${stderr.slice(-1500)}`
          )
        );
      }
    });
  });
}

/* ---------------------------------------------------------
   HEALTH CHECK
--------------------------------------------------------- */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "DE Venom",
    magicHourConfigured: Boolean(MAGIC_HOUR_API_KEY),
    ffmpegConfigured: Boolean(ffmpegPath),
    time: new Date().toISOString()
  });
});

/* ---------------------------------------------------------
   HOME
--------------------------------------------------------- */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ---------------------------------------------------------
   CREATE AI VIDEO
--------------------------------------------------------- */

app.post("/api/create-video", upload.single("image"), async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    if (!req.file) {
      return res.status(400).json({
        error: "Please upload an image."
      });
    }

    const movement =
      String(
        req.body.motion ||
        req.body.movement ||
        req.body.prompt ||
        ""
      ).trim();

    if (!movement) {
      return res.status(400).json({
        error: "Please enter a movement command."
      });
    }

    /*
      Supported resolutions:
      480p
      720p
      1080p
      4k
    */

    const requestedResolution =
      String(req.body.resolution || "720p").toLowerCase();

    const validResolutions = [
      "480p",
      "720p",
      "1080p",
      "4k"
    ];

    const resolution = validResolutions.includes(requestedResolution)
      ? requestedResolution
      : "720p";

    /*
      Kling 3.0 supports:
      480p, 720p, 1080p, 4k
      and supports 6 seconds.
    */

    const model = "kling-3.0";

    const extension = extensionFromMime(req.file.mimetype);

    if (!extension) {
      return res.status(400).json({
        error: "Please upload a JPG, PNG, or WebP image."
      });
    }

    console.log(
      `Creating video: model=${model}, resolution=${resolution}`
    );

    /* Upload image to Magic Hour */
    const imageFilePath = await uploadToMagicHour(
      req.file.buffer,
      extension,
      "image"
    );

    /* Create 6-second video */
    const videoJob = await magicHourRequest(
      "/v1/image-to-video",
      {
        method: "POST",
        body: JSON.stringify({
          name: "DE Venom Cinematic Video",
          end_seconds: 6,
          model,
          resolution,

          /*
            Keep native Magic Hour audio OFF here.
            We generate the requested AI voice separately,
            then combine it with this video using FFmpeg.
          */
          audio: false,

          style: {
            prompt: movement
          },

          assets: {
            image_file_path: imageFilePath
          }
        })
      }
    );

    console.log("Video job:", videoJob.id);

    const completedVideo = await waitForVideo(videoJob.id);

    const videoBuffer = await downloadBuffer(
      completedVideo.downloads[0].url
    );

    const videoId = crypto.randomUUID();

    const rawVideoPath = path.join(
      videoDir,
      `${videoId}-raw.mp4`
    );

    const finalVideoPath = path.join(
      videoDir,
      `${videoId}.mp4`
    );

    fs.writeFileSync(rawVideoPath, videoBuffer);

    /*
      OPTIONAL AI VOICE
      The user can leave audio text empty if they want
      a video without separately generated voice.
    */

    const audioText = String(
      req.body.audioText ||
      req.body.voiceText ||
      ""
    ).trim();

    let finalVideoUrl;

    if (audioText) {
      /*
        NEVER send "default" as voice_name.

        If the user doesn't select a voice,
        automatically use Morgan Freeman.
      */
      const voiceName =
        String(req.body.voiceName || "Morgan Freeman").trim() ||
        "Morgan Freeman";

      console.log(`Creating AI voice: ${voiceName}`);

      const audioJob = await magicHourRequest(
        "/v1/ai-voice-generator",
        {
          method: "POST",
          body: JSON.stringify({
            name: "DE Venom AI Voice",
            style: {
              prompt: audioText,
              voice_name: voiceName
            }
          })
        }
      );

      console.log("Audio job:", audioJob.id);

      const completedAudio = await waitForAudio(audioJob.id);

      const audioBuffer = await downloadBuffer(
        completedAudio.downloads[0].url
      );

      const audioId = crypto.randomUUID();

      const audioPath = path.join(
        audioDir,
        `${audioId}.mp3`
      );

      fs.writeFileSync(audioPath, audioBuffer);

      /*
        Combine the generated voice with the 6-second video.
        If speech is shorter than 6 seconds, silence is added.
        If speech is longer, it is cut to 6 seconds.
      */
      await mergeAudioWithVideo(
        rawVideoPath,
        audioPath,
        finalVideoPath
      );

      try {
        fs.unlinkSync(rawVideoPath);
        fs.unlinkSync(audioPath);
      } catch {}

      finalVideoUrl = `${BASE_URL || `${req.protocol}://${req.get("host")}`}/videos/${path.basename(finalVideoPath)}`;
    } else {
      /*
        No voice text supplied.
        Return the generated video by itself.
      */

      fs.renameSync(rawVideoPath, finalVideoPath);

      finalVideoUrl = `${BASE_URL || `${req.protocol}://${req.get("host")}`}/videos/${path.basename(finalVideoPath)}`;
    }

    return res.json({
      success: true,
      message: audioText
        ? "6-second video with AI audio created successfully."
        : "6-second video created successfully.",

      video: finalVideoUrl,

      resolution,

      model,

      duration: 6,

      audioIncluded: Boolean(audioText)
    });
  } catch (error) {
    console.error("CREATE VIDEO ERROR:", error);

    return res.status(500).json({
      error: error.message || "Video generation failed."
    });
  }
});

/* ---------------------------------------------------------
   CREATE AI AUDIO ONLY
--------------------------------------------------------- */

app.post("/api/create-audio", async (req, res) => {
  try {
    if (!requireApiKey(res)) return;

    const text = String(
      req.body.text ||
      req.body.prompt ||
      ""
    ).trim();

    if (!text) {
      return res.status(400).json({
        error: "Please enter text for the AI voice."
      });
    }

    /*
      NEVER use "default".
      If no voice is selected, use Morgan Freeman automatically.
    */
    const voiceName =
      String(req.body.voiceName || "Morgan Freeman").trim() ||
      "Morgan Freeman";

    const job = await magicHourRequest(
      "/v1/ai-voice-generator",
      {
        method: "POST",
        body: JSON.stringify({
          name: "DE Venom AI Audio",
          style: {
            prompt: text,
            voice_name: voiceName
          }
        })
      }
    );

    const completed = await waitForAudio(job.id);

    const audioBuffer = await downloadBuffer(
      completed.downloads[0].url
    );

    const audioId = crypto.randomUUID();

    const audioPath = path.join(
      audioDir,
      `${audioId}.mp3`
    );

    fs.writeFileSync(audioPath, audioBuffer);

    const publicBase =
      BASE_URL ||
      `${req.protocol}://${req.get("host")}`;

    res.json({
      success: true,
      audio: `${publicBase}/audio/${path.basename(audioPath)}`,
      voice: voiceName
    });
  } catch (error) {
    console.error("CREATE AUDIO ERROR:", error);

    res.status(500).json({
      error: error.message || "Audio generation failed."
    });
  }
});

/* ---------------------------------------------------------
   START SERVER
--------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`DE Venom running on port ${PORT}`);
  console.log(
    `Magic Hour API key configured: ${Boolean(MAGIC_HOUR_API_KEY)}`
  );
  console.log(
    `FFmpeg configured: ${Boolean(ffmpegPath)}`
  );
});
