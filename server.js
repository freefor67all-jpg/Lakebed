const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const app = express();

const PORT = Number(process.env.PORT) || 10000;

const MAGIC_HOUR_API_KEY =
  process.env.MAGIC_HOUR_API_KEY || "";

const BASE_URL = (
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ""
).replace(/\/$/, "");

const PREMIUM_ACCESS_KEY =
  process.env.PREMIUM_ACCESS_KEY || "";

const ADMIN_KEY =
  process.env.ADMIN_KEY || "";

const MAGIC_HOUR_API =
  "https://api.magichour.ai";

const DEFAULT_VOICE =
  "Morgan Freeman";

const DEFAULT_MODEL =
  "default";

const DEFAULT_RESOLUTION =
  "480p";

const VIDEO_DURATION =
  6;


/* =========================================================
   DIRECTORIES
========================================================= */

const uploadDir =
  path.join(__dirname, "uploads");

const videoDir =
  path.join(__dirname, "videos");

const audioDir =
  path.join(__dirname, "audio");


for (const dir of [
  uploadDir,
  videoDir,
  audioDir
]) {
  fs.mkdirSync(dir, {
    recursive: true
  });
}


/* =========================================================
   EXPRESS
========================================================= */

app.use(
  express.json({
    limit: "10mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);


app.use(
  "/uploads",
  express.static(uploadDir)
);

app.use(
  "/videos",
  express.static(videoDir)
);

app.use(
  "/audio",
  express.static(audioDir)
);


/* =========================================================
   UPLOAD
========================================================= */

const upload =
  multer({
    storage: multer.memoryStorage(),

    limits: {
      fileSize:
        25 * 1024 * 1024
    },

    fileFilter:
      (req, file, cb) => {

        const allowed = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        cb(
          null,
          allowed.includes(
            file.mimetype
          )
        );
      }
  });


/* =========================================================
   HELPERS
========================================================= */

function publicUrl(
  req,
  folder,
  filename
) {

  const base =
    BASE_URL ||
    `${req.protocol}://${req.get("host")}`;

  return (
    `${base}/${folder}/${encodeURIComponent(filename)}`
  );
}


function sendError(
  res,
  status,
  message,
  extra = {}
) {

  return res
    .status(status)
    .json({
      success: false,
      error: message,
      ...extra
    });
}


function requireMagicHour(res) {

  if (!MAGIC_HOUR_API_KEY) {

    sendError(
      res,
      500,
      "MAGIC_HOUR_API_KEY is missing in Render Environment Variables."
    );

    return false;
  }

  return true;
}


function extensionFromMime(mime) {

  const map = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp"
  };

  return map[mime] || null;
}


/* =========================================================
   MAGIC HOUR REQUEST
========================================================= */

async function magicHourRequest(
  endpoint,
  options = {}
) {

  const headers = {

    Accept:
      "application/json",

    Authorization:
      `Bearer ${MAGIC_HOUR_API_KEY}`,

    ...(options.body
      ? {
          "Content-Type":
            "application/json"
        }
      : {}),

    ...(options.headers || {})
  };


  const response =
    await fetch(
      `${MAGIC_HOUR_API}${endpoint}`,
      {
        ...options,
        headers
      }
    );


  const text =
    await response.text();


  let data;


  try {

    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {

    data = {
      message:
        text ||
        "Unknown Magic Hour response"
    };
  }


  if (!response.ok) {

    const detail =
      data?.message ||
      data?.error?.message ||
      data?.error ||
      `Magic Hour returned HTTP ${response.status}`;


    const error =
      new Error(
        String(detail)
      );


    error.status =
      response.status;

    error.data =
      data;


    throw error;
  }


  return data;
}


/* =========================================================
   UPLOAD TO MAGIC HOUR
========================================================= */

async function uploadToMagicHour(
  buffer,
  extension,
  type = "image"
) {

  const result =
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


  const item =
    result?.items?.[0];


  if (
    !item?.upload_url ||
    !item?.file_path
  ) {

    throw new Error(
      "Magic Hour did not return a valid upload URL."
    );
  }


  const put =
    await fetch(
      item.upload_url,
      {
        method: "PUT",
        body: buffer
      }
    );


  if (!put.ok) {

    throw new Error(
      `Magic Hour file upload failed with HTTP ${put.status}.`
    );
  }


  return item.file_path;
}


/* =========================================================
   POLL MAGIC HOUR JOB
========================================================= */

async function pollProject(
  endpoint,
  timeoutMs,
  intervalMs
) {

  const started =
    Date.now();


  while (
    Date.now() - started <
    timeoutMs
  ) {

    const result =
      await magicHourRequest(
        endpoint
      );


    const status =
      String(
        result?.status || ""
      ).toLowerCase();


    if (
      status === "complete" ||
      status === "completed"
    ) {

      const url =
        result?.downloads?.[0]?.url;


      if (!url) {

        throw new Error(
          "Magic Hour completed the job but returned no download URL."
        );
      }


      return result;
    }


    if (
      [
        "error",
        "failed",
        "canceled",
        "cancelled"
      ].includes(status)
    ) {

      const detail =
        result?.error?.message ||
        result?.error?.code ||
        result?.message ||
        "Magic Hour generation failed.";


      throw new Error(
        String(detail)
      );
    }


    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          intervalMs
        )
    );
  }


  throw new Error(
    "Magic Hour generation timed out. Please try again."
  );
}


/* =========================================================
   DOWNLOAD GENERATED FILE
========================================================= */

async function downloadBuffer(url) {

  const response =
    await fetch(url);


  if (!response.ok) {

    throw new Error(
      `Could not download generated file (HTTP ${response.status}).`
    );
  }


  return Buffer.from(
    await response.arrayBuffer()
  );
}


/* =========================================================
   FFMPEG
========================================================= */

function mergeAudioWithVideo(
  videoPath,
  audioPath,
  outputPath
) {

  return new Promise(
    (resolve, reject) => {

      if (!ffmpegPath) {

        return reject(
          new Error(
            "FFmpeg is not available. Check package.json for ffmpeg-static."
          )
        );
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
        "1:a:0?",

        "-c:v",
        "copy",

        "-c:a",
        "aac",

        "-b:a",
        "192k",

        "-af",
        "apad",

        "-t",
        String(VIDEO_DURATION),

        "-movflags",
        "+faststart",

        outputPath
      ];


      const child =
        spawn(
          ffmpegPath,
          args
        );


      let stderr =
        "";


      child.stderr.on(
        "data",
        chunk => {
          stderr +=
            chunk.toString();
        }
      );


      child.on(
        "error",
        reject
      );


      child.on(
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
                `FFmpeg failed with code ${code}: ${stderr.slice(-1800)}`
              )
            );
          }
        }
      );
    }
  );
}


/* =========================================================
   MODEL VALIDATION
========================================================= */

function validateModel(
  value
) {

  const allowed = [

    "default",

    "ltx-2.3",

    "wan-2.2",

    "kling-2.6",

    "kling-3.0",

    "veo3.1-lite",

    "veo3.1",

    "seedance-1.5",

    "seedance-2.0-mini",

    "seedance-2.0",

    "seedance-2.5",

    "sora-2"
  ];


  return allowed.includes(value)
    ? value
    : DEFAULT_MODEL;
}


/* =========================================================
   RESOLUTION VALIDATION
========================================================= */

function validateResolution(
  value
) {

  const allowed = [
    "480p",
    "720p",
    "1080p",
    "4k"
  ];


  return allowed.includes(value)
    ? value
    : DEFAULT_RESOLUTION;
}


/* =========================================================
   MODEL / RESOLUTION COMPATIBILITY
========================================================= */

function modelSupportsResolution(
  model,
  resolution
) {

  const map = {

    "default": [
      "480p",
      "720p",
      "1080p",
      "4k"
    ],

    "ltx-2.3": [
      "480p",
      "720p",
      "1080p"
    ],

    "wan-2.2": [
      "480p",
      "720p",
      "1080p"
    ],

    "kling-2.6": [
      "720p",
      "1080p"
    ],

    "kling-3.0": [
      "720p",
      "1080p",
      "4k"
    ],

    "veo3.1-lite": [
      "720p",
      "1080p"
    ],

    "veo3.1": [
      "720p",
      "1080p"
    ],

    "seedance-1.5": [
      "480p",
      "720p",
      "1080p"
    ],

    "seedance-2.0-mini": [
      "480p",
      "720p"
    ],

    "seedance-2.0": [
      "480p",
      "720p"
    ],

    "seedance-2.5": [
      "480p",
      "720p"
    ],

    "sora-2": [
      "720p"
    ]
  };


  return (
    map[model] ||
    map.default
  ).includes(
    resolution
  );
}


/* =========================================================
   HEALTH
========================================================= */

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

      time:
        new Date().toISOString()
    });
  }
);


/* =========================================================
   HOME
========================================================= */

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


/* =========================================================
   FRONTEND CONFIG
========================================================= */

app.get(
  "/api/config",
  (req, res) => {

    res.json({

      success: true,

      defaultVoice:
        DEFAULT_VOICE,

      defaultModel:
        DEFAULT_MODEL,

      defaultResolution:
        DEFAULT_RESOLUTION,

      duration:
        VIDEO_DURATION
    });
  }
);


/* =========================================================
   CREATE VIDEO
========================================================= */

app.post(
  "/api/create-video",
  upload.single("image"),
  async (req, res) => {

    let rawVideoPath =
      null;

    let audioPath =
      null;

    let finalVideoPath =
      null;


    try {

      if (
        !requireMagicHour(res)
      ) {
        return;
      }


      if (!req.file) {

        return sendError(
          res,
          400,
          "Please upload a JPG, PNG, or WebP image."
        );
      }


      const movement =
        String(
          req.body.motion ||
          req.body.movement ||
          req.body.prompt ||
          ""
        ).trim();


      if (!movement) {

        return sendError(
          res,
          400,
          "Please enter a movement command."
        );
      }


      const model =
        validateModel(
          String(
            req.body.model ||
            DEFAULT_MODEL
          ).toLowerCase()
        );


      let resolution =
        validateResolution(
          String(
            req.body.resolution ||
            DEFAULT_RESOLUTION
          ).toLowerCase()
        );


      if (
        !modelSupportsResolution(
          model,
          resolution
        )
      ) {

        return sendError(
          res,
          400,
          `${resolution} is not supported by ${model}. Choose a supported resolution.`
        );
      }


      const extension =
        extensionFromMime(
          req.file.mimetype
        );


      if (!extension) {

        return sendError(
          res,
          400,
          "Please upload a JPG, PNG, or WebP image."
        );
      }


      console.log(
        `Creating video: model=${model}, resolution=${resolution}, duration=${VIDEO_DURATION}s`
      );


      /* -----------------------------------------
         UPLOAD IMAGE
      ----------------------------------------- */

      const imageFilePath =
        await uploadToMagicHour(
          req.file.buffer,
          extension,
          "image"
        );


      /* -----------------------------------------
         CREATE VIDEO
      ----------------------------------------- */

      const videoJob =
        await magicHourRequest(
          "/v1/image-to-video",
          {

            method:
              "POST",

            body:
              JSON.stringify({

                name:
                  "DE Venom Cinematic Video",

                end_seconds:
                  VIDEO_DURATION,

                model,

                resolution,

                audio:
                  false,

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


      if (!videoJob?.id) {

        throw new Error(
          "Magic Hour did not return a video project ID."
        );
      }


      console.log(
        `Video project created: ${videoJob.id}`
      );


      const completedVideo =
        await pollProject(
          `/v1/video-projects/${encodeURIComponent(videoJob.id)}`,
          12 * 60 * 1000,
          3000
        );


      const videoBuffer =
        await downloadBuffer(
          completedVideo.downloads[0].url
        );


      const videoId =
        crypto.randomUUID();


      rawVideoPath =
        path.join(
          videoDir,
          `${videoId}-raw.mp4`
        );


      finalVideoPath =
        path.join(
          videoDir,
          `${videoId}.mp4`
        );


      fs.writeFileSync(
        rawVideoPath,
        videoBuffer
      );


      /* -----------------------------------------
         OPTIONAL AI VOICE
      ----------------------------------------- */

      const audioText =
        String(
          req.body.audioText ||
          req.body.voiceText ||
          ""
        ).trim();


      let audioIncluded =
        false;


      let voice =
        null;


      if (audioText) {

        voice =
          String(
            req.body.voiceName ||
            DEFAULT_VOICE
          ).trim() ||
          DEFAULT_VOICE;


        /*
          NEVER allow the word "default"
          to reach Magic Hour as the voice.
        */

        if (
          voice.toLowerCase() ===
          "default"
        ) {

          voice =
            DEFAULT_VOICE;
        }


        console.log(
          `Creating AI voice: ${voice}`
        );


        const audioJob =
          await magicHourRequest(
            "/v1/ai-voice-generator",
            {

              method:
                "POST",

              body:
                JSON.stringify({

                  name:
                    "DE Venom AI Voice",

                  style: {

                    prompt:
                      audioText,

                    voice_name:
                      voice
                  }
                })
            }
          );


        if (!audioJob?.id) {

          throw new Error(
            "Magic Hour did not return an audio project ID."
          );
        }


        console.log(
          `Audio project created: ${audioJob.id}`
        );


        const completedAudio =
          await pollProject(
            `/v1/audio-projects/${encodeURIComponent(audioJob.id)}`,
            8 * 60 * 1000,
            2000
          );


        const audioBuffer =
          await downloadBuffer(
            completedAudio.downloads[0].url
          );


        audioPath =
          path.join(
            audioDir,
            `${crypto.randomUUID()}.mp3`
          );


        fs.writeFileSync(
          audioPath,
          audioBuffer
        );


        /* -----------------------------------------
           MERGE AUDIO + VIDEO
        ----------------------------------------- */

        await mergeAudioWithVideo(
          rawVideoPath,
          audioPath,
          finalVideoPath
        );


        audioIncluded =
          true;

      } else {

        /*
          No audio text:
          return the video without voice.
        */

        fs.renameSync(
          rawVideoPath,
          finalVideoPath
        );

        rawVideoPath =
          null;
      }


      return res.json({

        success:
          true,

        message:
          audioIncluded
            ? "6-second video with AI voice created successfully."
            : "6-second video created successfully.",

        video:
          publicUrl(
            req,
            "videos",
            path.basename(
              finalVideoPath
            )
          ),

        model,

        resolution,

        duration:
          VIDEO_DURATION,

        audioIncluded,

        voice
      });


    } catch (error) {

      console.error(
        "CREATE VIDEO ERROR:",
        error
      );


      if (
        error.status ===
        402
      ) {

        return sendError(
          res,
          402,
          `Magic Hour requires more credits for this video configuration. ${error.message}`
        );
      }


      return sendError(
        res,
        error.status &&
        error.status >= 400
          ? error.status
          : 500,
        error.message ||
          "Video generation failed."
      );


    } finally {

      for (
        const file of [
          rawVideoPath,
          audioPath
        ]
      ) {

        if (file) {

          try {

            fs.unlinkSync(
              file
            );

          } catch {}
        }
      }
    }
  }
);


/* =========================================================
   CREATE AUDIO ONLY
========================================================= */

app.post(
  "/api/create-audio",
  async (req, res) => {

    let audioPath =
      null;


    try {

      if (
        !requireMagicHour(res)
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

        return sendError(
          res,
          400,
          "Please enter text for the AI voice."
        );
      }


      let voice =
        String(
          req.body.voiceName ||
          DEFAULT_VOICE
        ).trim() ||
        DEFAULT_VOICE;


      /*
        NEVER send "default"
        as a Magic Hour voice.
      */

      if (
        voice.toLowerCase() ===
        "default"
      ) {

        voice =
          DEFAULT_VOICE;
      }


      console.log(
        `Creating audio: ${voice}`
      );


      const job =
        await magicHourRequest(
          "/v1/ai-voice-generator",
          {

            method:
              "POST",

            body:
              JSON.stringify({

                name:
                  "DE Venom AI Audio",

                style: {

                  prompt:
                    text,

                  voice_name:
                    voice
                }
              })
          }
        );


      if (!job?.id) {

        throw new Error(
          "Magic Hour did not return an audio project ID."
        );
      }


      const completed =
        await pollProject(
          `/v1/audio-projects/${encodeURIComponent(job.id)}`,
          8 * 60 * 1000,
          2000
        );


      const audioBuffer =
        await downloadBuffer(
          completed.downloads[0].url
        );


      audioPath =
        path.join(
          audioDir,
          `${crypto.randomUUID()}.mp3`
        );


      fs.writeFileSync(
        audioPath,
        audioBuffer
      );


      return res.json({

        success:
          true,

        audio:
          publicUrl(
            req,
            "audio",
            path.basename(
              audioPath
            )
          ),

        voice
      });


    } catch (error) {

      console.error(
        "CREATE AUDIO ERROR:",
        error
      );


      if (
        error.status ===
        402
      ) {

        return sendError(
          res,
          402,
          `Magic Hour requires more credits for this voice generation. ${error.message}`
        );
      }


      return sendError(
        res,
        error.status &&
        error.status >= 400
          ? error.status
          : 500,
        error.message ||
          "Audio generation failed."
      );
    }
  }
);


/* =========================================================
   PREMIUM
========================================================= */

app.post(
  "/api/premium/activate",
  (req, res) => {

    if (!PREMIUM_ACCESS_KEY) {

      return sendError(
        res,
        500,
        "PREMIUM_ACCESS_KEY is missing in Render Environment Variables."
      );
    }


    const key =
      String(
        req.body.key || ""
      ).trim();


    if (
      !key ||
      key !==
        PREMIUM_ACCESS_KEY
    ) {

      return sendError(
        res,
        401,
        "Invalid Premium access key."
      );
    }


    const token =
      crypto
        .createHash("sha256")
        .update(
          `${key}:${process.env.SESSION_SECRET || "de-venom"}`
        )
        .digest("hex");


    return res.json({

      success:
        true,

      token,

      message:
        "Premium activated."
    });
  }
);


/* =========================================================
   PRICES
========================================================= */

app.get(
  "/api/prices",
  (req, res) => {

    res.json({

      success:
        true,

      monthly:
        Number(
          process.env.MONTHLY_PRICE ||
          1000
        ),

      yearly:
        Number(
          process.env.YEARLY_PRICE ||
          15000
        )
    });
  }
);


/* =========================================================
   ADMIN PRICE UPDATE
========================================================= */

app.post(
  "/api/prices",
  (req, res) => {

    if (!ADMIN_KEY) {

      return sendError(
        res,
        500,
        "ADMIN_KEY is missing in Render Environment Variables."
      );
    }


    const key =
      String(
        req.body.adminKey ||
        req.body.key ||
        ""
      ).trim();


    if (
      !key ||
      key !== ADMIN_KEY
    ) {

      return sendError(
        res,
        401,
        "Invalid admin key."
      );
    }


    const monthly =
      Number(
        req.body.monthly
      );


    const yearly =
      Number(
        req.body.yearly
      );


    if (
      !Number.isFinite(
        monthly
      ) ||
      monthly < 0 ||
      !Number.isFinite(
        yearly
      ) ||
      yearly < 0
    ) {

      return sendError(
        res,
        400,
        "Monthly and yearly prices must be valid numbers."
      );
    }


    return res.json({

      success:
        true,

      monthly,

      yearly,

      message:
        "Prices accepted for this running instance. To persist them across redeploys, store them in a database or environment variables."
    });
  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {

    sendError(
      res,
      404,
      "Route not found."
    );
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `DE Venom running on port ${PORT}`
    );

    console.log(
      `Magic Hour API key configured: ${Boolean(MAGIC_HOUR_API_KEY)}`
    );

    console.log(
      `FFmpeg configured: ${Boolean(ffmpegPath)}`
    );
  }
);
