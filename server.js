const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

const PORT = process.env.PORT || 10000;

const MAGIC_HOUR_API_KEY =
  process.env.MAGIC_HOUR_API_KEY || "";

const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "";

const MAGIC_HOUR_API =
  "https://api.magichour.ai";

/* ---------------------------------------------------------
   DIRECTORIES
--------------------------------------------------------- */

const uploadDir = path.join(__dirname, "uploads");
const videoDir = path.join(__dirname, "videos");
const audioDir = path.join(__dirname, "audio");

for (const dir of [
  uploadDir,
  videoDir,
  audioDir
]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ---------------------------------------------------------
   EXPRESS
--------------------------------------------------------- */

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/uploads", express.static(uploadDir));
app.use("/videos", express.static(videoDir));
app.use("/audio", express.static(audioDir));

/* ---------------------------------------------------------
   MULTER
--------------------------------------------------------- */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */

function publicBase(req) {
  return (
    BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  );
}

function requireApiKey(res) {
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
    "image/avif": "avif",

    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mp4": "m4a"
  };

  return map[mime] || null;
}

/*
  IMPORTANT:

  The frontend may send:

  default
  ""
  undefined
  Morgan Freeman

  We NEVER send "default" to Magic Hour.

  Magic Hour requires an actual voice name.
*/

function normalizeVoiceName(value) {
  const requested =
    String(value || "")
      .trim();

  if (
    !requested ||
    requested.toLowerCase() === "default"
  ) {
    return "Morgan Freeman";
  }

  return requested;
}

/*
  IMPORTANT:

  Do not allow the frontend to send 4k.

  Current Magic Hour image-to-video API
  supports these resolutions depending on model:

  480p
  720p
  1080p

  We use 720p as the safe default.
*/

function normalizeResolution(value) {
  const requested =
    String(value || "720p")
      .trim()
      .toLowerCase();

  const allowed = [
    "480p",
    "720p",
    "1080p"
  ];

  if (allowed.includes(requested)) {
    return requested;
  }

  return "720p";
}

/*
  The previous code forced Kling 3.0.

  That caused:

  "kling-3.0 is not available for your subscription tier"

  So we now use Magic Hour's "default" model.

  Magic Hour chooses a model available to the
  current account instead of us forcing an unavailable one.
*/

function normalizeModel(value) {
  const requested =
    String(value || "default")
      .trim()
      .toLowerCase();

  const allowed = [
    "default",
    "ltx-2",
    "wan-2.2",
    "seedance",
    "seedance-2.0",
    "kling-2.5",
    "kling-3.0",
    "veo3.1",
    "veo3.1-lite",
    "sora-2",
    "kling-1.6"
  ];

  if (allowed.includes(requested)) {
    return requested;
  }

  return "default";
}

/* ---------------------------------------------------------
   MAGIC HOUR REQUEST
--------------------------------------------------------- */

async function magicHourRequest(
  endpoint,
  options = {}
) {
  if (!MAGIC_HOUR_API_KEY) {
    throw new Error(
      "MAGIC_HOUR_API_KEY is not configured."
    );
  }

  const response = await fetch(
    `${MAGIC_HOUR_API}${endpoint}`,
    {
      ...options,

      headers: {
        Accept: "application/json",

        Authorization:
          `Bearer ${MAGIC_HOUR_API_KEY}`,

        ...(options.body
          ? {
              "Content-Type":
                "application/json"
            }
          }
          : {}),

        ...(options.headers || {})
      }
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      message:
        text ||
        "Unknown Magic Hour response"
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
   UPLOAD TO MAGIC HOUR
--------------------------------------------------------- */

async function uploadToMagicHour(
  buffer,
  extension,
  type
) {
  const response =
    await magicHourRequest(
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
    !response.items[0]
  ) {
    throw new Error(
      "Magic Hour did not return an upload URL."
    );
  }

  const item =
    response.items[0];

  const putResponse =
    await fetch(
      item.upload_url,
      {
        method: "PUT",
        body: buffer
      }
    );

  if (!putResponse.ok) {
    const message =
      await putResponse.text();

    throw new Error(
      `Magic Hour file upload failed: ${
        message ||
        putResponse.status
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
  const started =
    Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {
    const result =
      await magicHourRequest(
        `/v1/video-projects/${encodeURIComponent(
          projectId
        )}`
      );

    console.log(
      "Video status:",
      result.status
    );

    if (
      result.status ===
      "complete"
    ) {
      if (
        !result.downloads ||
        !result.downloads[0]?.url
      ) {
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
      const apiError =
        result?.error?.message ||
        result?.error?.code ||
        "Magic Hour video generation failed.";

      throw new Error(
        apiError
      );
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          3000
        )
    );
  }

  throw new Error(
    "Video generation timed out."
  );
}

/* ---------------------------------------------------------
   WAIT FOR AUDIO
--------------------------------------------------------- */

async function waitForAudio(
  projectId,
  timeoutMs = 5 * 60 * 1000
) {
  const started =
    Date.now();

  while (
    Date.now() - started <
    timeoutMs
  ) {
    const result =
      await magicHourRequest(
        `/v1/audio-projects/${encodeURIComponent(
          projectId
        )}`
      );

    console.log(
      "Audio status:",
      result.status
    );

    if (
      result.status ===
      "complete"
    ) {
      if (
        !result.downloads ||
        !result.downloads[0]?.url
      ) {
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
      const apiError =
        result?.error?.message ||
        result?.error?.code ||
        "Magic Hour audio generation failed.";

      throw new Error(
        apiError
      );
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          2000
        )
    );
  }

  throw new Error(
    "Audio generation timed out."
  );
}

/* ---------------------------------------------------------
   DOWNLOAD
--------------------------------------------------------- */

async function downloadBuffer(url) {
  const response =
    await fetch(url);

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
   FFMPEG MERGE
--------------------------------------------------------- */

function mergeAudioWithVideo(
  videoPath,
  audioPath,
  outputPath
) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg is not installed. Add ffmpeg-static to package.json."
          )
        );

        return;
      }

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

      console.log(
        "Running FFmpeg..."
      );

      const ffmpeg =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      ffmpeg.stderr.on(
        "data",
        data => {
          stderr +=
            data.toString();
        }
      );

      ffmpeg.on(
        "error",
        error => {
          reject(error);
        }
      );

      ffmpeg.on(
        "close",
        code => {
          if (
            code === 0 &&
            fs.existsSync(
              outputPath
            )
          ) {
            resolve();
          } else {
            reject(
              new Error(
                `FFmpeg failed with code ${code}: ${stderr.slice(
                  -2000
                )}`
              )
            );
          }
        }
      );
    }
  );
}

/* ---------------------------------------------------------
   HEALTH
--------------------------------------------------------- */

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "DE Venom",

      magicHourConfigured:
        Boolean(
          MAGIC_HOUR_API_KEY
        ),

      ffmpegConfigured:
        Boolean(
          ffmpegPath
        ),

      defaultVoice:
        "Morgan Freeman",

      defaultResolution:
        "720p",

      serverTime:
        new Date().toISOString()
    });
  }
);

/* ---------------------------------------------------------
   HOME
--------------------------------------------------------- */

app.get(
  "/",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* ---------------------------------------------------------
   CREATE VIDEO
--------------------------------------------------------- */

app.post(
  "/api/create-video",
  upload.single("image"),
  async (req, res) => {
    try {
      if (
        !requireApiKey(res)
      ) {
        return;
      }

      if (!req.file) {
        return res
          .status(400)
          .json({
            error:
              "Please upload an image."
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
        return res
          .status(400)
          .json({
            error:
              "Please enter a movement command."
          });
      }

      const extension =
        extensionFromMime(
          req.file.mimetype
        );

      if (!extension) {
        return res
          .status(400)
          .json({
            error:
              "Please upload a JPG, PNG, or WebP image."
          });
      }

      /*
        IMPORTANT:

        Default model is now "default".
        This prevents us from forcing Kling 3.0
        onto an account that cannot use it.
      */

      const model =
        normalizeModel(
          req.body.model
        );

      /*
        Default resolution is 720p.
        4K is intentionally rejected.
      */

      const resolution =
        normalizeResolution(
          req.body.resolution
        );

      console.log(
        "Creating DE Venom video..."
      );

      console.log(
        "Model:",
        model
      );

      console.log(
        "Resolution:",
        resolution
      );

      console.log(
        "Movement:",
        movement
      );

      /* Upload image */

      const imageFilePath =
        await uploadToMagicHour(
          req.file.buffer,
          extension,
          "image"
        );

      /*
        Create video.

        6 seconds.

        Audio is OFF here because our
        own AI voice is generated separately
        and then merged using FFmpeg.
      */

      const videoJob =
        await magicHourRequest(
          "/v1/image-to-video",
          {
            method: "POST",

            body: JSON.stringify({
              name:
                "DE Venom Cinematic Video",

              end_seconds: 6,

              model,

              resolution,

              audio: false,

              style: {
                prompt:
                  movement
              },

              assets: {
                image_file_path:
                  imageFilePath
              }
            })
          }
        );

      console.log(
        "Video job:",
        videoJob.id
      );

      const completedVideo =
        await waitForVideo(
          videoJob.id
        );

      const videoBuffer =
        await downloadBuffer(
          completedVideo
            .downloads[0]
            .url
        );

      const videoId =
        crypto.randomUUID();

      const rawVideoPath =
        path.join(
          videoDir,
          `${videoId}-raw.mp4`
        );

      const finalVideoPath =
        path.join(
          videoDir,
          `${videoId}.mp4`
        );

      fs.writeFileSync(
        rawVideoPath,
        videoBuffer
      );

      /* ---------------------------------------------------
         AUDIO FOR VIDEO
      --------------------------------------------------- */

      const audioText =
        String(
          req.body.audioText ||
          req.body.voiceText ||
          ""
        ).trim();

      /*
        If audio text exists:

        - Generate voice
        - Automatically select Morgan Freeman
          when frontend sends "default"
        - Merge voice with video
      */

      if (audioText) {
        const voiceName =
          normalizeVoiceName(
            req.body.voiceName
          );

        console.log(
          "AI voice:",
          voiceName
        );

        const audioJob =
          await magicHourRequest(
            "/v1/ai-voice-generator",
            {
              method: "POST",

              body:
                JSON.stringify({
                  name:
                    "DE Venom AI Voice",

                  style: {
                    prompt:
                      audioText,

                    voice_name:
                      voiceName
                  }
                })
            }
          );

        console.log(
          "Audio job:",
          audioJob.id
        );

        const completedAudio =
          await waitForAudio(
            audioJob.id
          );

        const audioBuffer =
          await downloadBuffer(
            completedAudio
              .downloads[0]
              .url
          );

        const audioId =
          crypto.randomUUID();

        const audioPath =
          path.join(
            audioDir,
            `${audioId}.mp3`
          );

        fs.writeFileSync(
          audioPath,
          audioBuffer
        );

        await mergeAudioWithVideo(
          rawVideoPath,
          audioPath,
          finalVideoPath
        );

        try {
          fs.unlinkSync(
            rawVideoPath
          );
        } catch {}

        try {
          fs.unlinkSync(
            audioPath
          );
        } catch {}

        return res.json({
          success: true,

          message:
            "6-second video with AI voice created successfully.",

          video:
            `${publicBase(
              req
            )}/videos/${path.basename(
              finalVideoPath
            )}`,

          resolution,

          model,

          duration: 6,

          audioIncluded:
            true,

          voice:
            voiceName
        });
      }

      /* ---------------------------------------------------
         VIDEO WITHOUT VOICE
      --------------------------------------------------- */

      fs.renameSync(
        rawVideoPath,
        finalVideoPath
      );

      return res.json({
        success: true,

        message:
          "6-second video created successfully.",

        video:
          `${publicBase(
            req
          )}/videos/${path.basename(
            finalVideoPath
          )}`,

        resolution,

        model,

        duration: 6,

        audioIncluded:
          false
      });
    } catch (error) {
      console.error(
        "CREATE VIDEO ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Video generation failed."
        });
    }
  }
);

/* ---------------------------------------------------------
   AI AUDIO ONLY
--------------------------------------------------------- */

app.post(
  "/api/create-audio",
  async (req, res) => {
    try {
      if (
        !requireApiKey(res)
      ) {
        return;
      }

      const text =
        String(
          req.body.text ||
          req.body.prompt ||
          ""
        ).trim();

      if (!text) {
        return res
          .status(400)
          .json({
            error:
              "Please enter text for the AI voice."
          });
      }

      /*
        THIS FIXES THE "default" ERROR.

        If index.html sends:

        voiceName = "default"

        the server changes it to:

        Morgan Freeman
      */

      const voiceName =
        normalizeVoiceName(
          req.body.voiceName
        );

      console.log(
        "Generating AI audio..."
      );

      console.log(
        "Selected voice:",
        voiceName
      );

      const job =
        await magicHourRequest(
          "/v1/ai-voice-generator",
          {
            method: "POST",

            body:
              JSON.stringify({
                name:
                  "DE Venom AI Audio",

                style: {
                  prompt:
                    text,

                  voice_name:
                    voiceName
                }
              })
          }
        );

      console.log(
        "Audio job:",
        job.id
      );

      const completed =
        await waitForAudio(
          job.id
        );

      const audioBuffer =
        await downloadBuffer(
          completed
            .downloads[0]
            .url
        );

      const audioId =
        crypto.randomUUID();

      const audioPath =
        path.join(
          audioDir,
          `${audioId}.mp3`
        );

      fs.writeFileSync(
        audioPath,
        audioBuffer
      );

      return res.json({
        success: true,

        audio:
          `${publicBase(
            req
          )}/audio/${path.basename(
            audioPath
          )}`,

        voice:
          voiceName
      });
    } catch (error) {
      console.error(
        "CREATE AUDIO ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Audio generation failed."
        });
    }
  }
);

/* ---------------------------------------------------------
   START
--------------------------------------------------------- */

app.listen(
  PORT,
  () => {
    console.log(
      `DE Venom running on port ${PORT}`
    );

    console.log(
      `Magic Hour API configured: ${Boolean(
        MAGIC_HOUR_API_KEY
      )}`
    );

    console.log(
      `FFmpeg configured: ${Boolean(
        ffmpegPath
      )}`
    );

    console.log(
      "Default voice: Morgan Freeman"
    );

    console.log(
      "Default resolution: 720p"
    );

    console.log(
      "Default video model: Magic Hour automatic"
    );
  }
);
