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
const PREMIUM_ACCESS_KEY = process.env.PREMIUM_ACCESS_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";

const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "";

const MAGIC_HOUR_API = "https://api.magichour.ai";

/* ---------------------------------------------------------
   DIRECTORIES
--------------------------------------------------------- */

const uploadDir = path.join(__dirname, "uploads");
const videoDir = path.join(__dirname, "videos");
const audioDir = path.join(__dirname, "audio");

for (const dir of [uploadDir, videoDir, audioDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ---------------------------------------------------------
   APP
--------------------------------------------------------- */

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
   PRICES
--------------------------------------------------------- */

let prices = {
  monthly: Number(process.env.MONTHLY_PRICE || 1000),
  yearly: Number(process.env.YEARLY_PRICE || 15000)
};

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */

function publicBase(req) {
  return (
    BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/$/, "");
}

function requireMagicHourKey(res) {
  if (!MAGIC_HOUR_API_KEY) {
    res.status(500).json({
      error:
        "MAGIC_HOUR_API_KEY is missing in Render Environment Variables."
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
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a"
  };

  return map[mime] || null;
}

async function magicHourRequest(endpoint, options = {}) {
  if (!MAGIC_HOUR_API_KEY) {
    throw new Error("MAGIC_HOUR_API_KEY is not configured.");
  }

  const response = await fetch(
    `${MAGIC_HOUR_API}${endpoint}`,
    {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${MAGIC_HOUR_API_KEY}`,
        ...(options.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...(options.headers || {})
      }
    }
  );

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
      data?.error ||
      `Magic Hour request failed with HTTP ${response.status}`;

    throw new Error(message);
  }

  return data;
}

/* ---------------------------------------------------------
   MAGIC HOUR FILE UPLOAD
--------------------------------------------------------- */

async function uploadToMagicHour(
  buffer,
  extension,
  type
) {
  const response = await magicHourRequest(
    "/v1/files/upload-urls",
    {
      method: "POST",
      body: JSON.stringify({
        items: [
          {
            extension,
            type
          }
        ]
      })
    }
  );

  if (
    !response.items ||
    !response.items[0] ||
    !response.items[0].upload_url
  ) {
    throw new Error(
      "Magic Hour did not return an upload URL."
    );
  }

  const item = response.items[0];

  const putResponse = await fetch(
    item.upload_url,
    {
      method: "PUT",
      body: buffer
    }
  );

  if (!putResponse.ok) {
    const message = await putResponse.text();

    throw new Error(
      `Magic Hour file upload failed: ${
        message || putResponse.status
      }`
    );
  }

  return item.file_path;
}

/* ---------------------------------------------------------
   WAIT FOR VIDEO
--------------------------------------------------------- */

async function waitForVideo(
  projectId,
  timeoutMs = 10 * 60 * 1000
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const result = await magicHourRequest(
      `/v1/video-projects/${encodeURIComponent(projectId)}`
    );

    if (result.status === "complete") {
      const url = result?.downloads?.[0]?.url;

      if (!url) {
        throw new Error(
          "Video completed but no download URL was returned."
        );
      }

      return result;
    }

    if (
      result.status === "error" ||
      result.status === "canceled"
    ) {
      throw new Error(
        result?.error?.message ||
        result?.error?.code ||
        "Magic Hour video generation failed."
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );
  }

  throw new Error("Video generation timed out.");
}

/* ---------------------------------------------------------
   WAIT FOR AUDIO
--------------------------------------------------------- */

async function waitForAudio(
  projectId,
  timeoutMs = 5 * 60 * 1000
) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const result = await magicHourRequest(
      `/v1/audio-projects/${encodeURIComponent(projectId)}`
    );

    if (result.status === "complete") {
      const url = result?.downloads?.[0]?.url;

      if (!url) {
        throw new Error(
          "Audio completed but no download URL was returned."
        );
      }

      return result;
    }

    if (
      result.status === "error" ||
      result.status === "canceled"
    ) {
      throw new Error(
        result?.error?.message ||
        result?.error?.code ||
        "Magic Hour audio generation failed."
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 2000)
    );
  }

  throw new Error("Audio generation timed out.");
}

/* ---------------------------------------------------------
   DOWNLOAD FILE
--------------------------------------------------------- */

async function downloadBuffer(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Could not download generated file. HTTP ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

/* ---------------------------------------------------------
   VOICE NORMALIZATION
--------------------------------------------------------- */

function getVoiceName(value) {
  const requested = String(value || "").trim();

  /*
    The old index was sending "default".
    Never send "default" to Magic Hour.
  */

  if (
    !requested ||
    requested.toLowerCase() === "default"
  ) {
    return "Morgan Freeman";
  }

  return requested;
}

/* ---------------------------------------------------------
   MERGE AUDIO + VIDEO
--------------------------------------------------------- */

function mergeAudioWithVideo(
  videoPath,
  audioPath,
  outputPath
) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(
        new Error(
          "FFmpeg is not installed. Add ffmpeg-static to package.json."
        )
      );
   
