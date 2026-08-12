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
  process.env.MAGIC_HOUR_API_KEY;

const BASE_URL =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  "";

const MAGIC_HOUR_API =
  "https://api.magichour.ai";

/* ---------------------------------------------------------
   DIRECTORIES
--------------------------------------------------------- */

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

/* ---------------------------------------------------------
   EXPRESS
--------------------------------------------------------- */

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
   API KEY CHECK
--------------------------------------------------------- */

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

/* ---------------------------------------------------------
   MIME EXTENSIONS
--------------------------------------------------------- */

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

/* ---------------------------------------------------------
   MAGIC HOUR REQUEST
--------------------------------------------------------- */

async function magicHourRequest(
  endpoint,
  options = {}
) {

  const response = await fetch(
    `${MAGIC_HOUR_API}${endpoint}`,
    {
      ...options,

      headers: {

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
   UPLOAD IMAGE TO MAGIC HOUR
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
        `/v1/video-projects/${encodeURIComponent(projectId)}`
      );

    if (
      result.status ===
      "complete"
    ) {

      const download =
        result.downloads?.find(
          item => item?.url
        );

      if (!download) {

        throw new Error(
          "Video completed but Magic Hour returned no download URL."
        );
      }

      return result;
    }

    if (
      result.status ===
        "error" ||
      result.status ===
        "canceled"
    ) {

      const apiError =

        result?.error?.message ||

        result?.error?.code ||

        "Magic Hour video generation failed.";

      throw new Error(apiError);
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
        `/v1/audio-projects/${encodeURIComponent(projectId)}`
      );

    if (
      result.status ===
      "complete"
    ) {

      const download =
        result.downloads?.find(
          item => item?.url
        );

      if (!download) {

        throw new Error(
          "Audio completed but Magic Hour returned no download URL."
        );
      }

      return result;
    }

    if (
      result.status ===
        "error" ||
      result.status ===
        "canceled"
    ) {

      const apiError =

        result?.error?.message ||

        result?.error?.code ||

        "Magic Hour audio generation failed.";

      throw new Error(apiError);
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
   DOWNLOAD GENERATED FILE
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
   VALID VOICES
---------------------------------------------------------

   IMPORTANT:

   "default" is NEVER sent to Magic Hour.

   If the website sends:
   - default
   - empty
   - undefined
   - null
   - unsupported voice

   the server automatically uses Morgan Freeman.

--------------------------------------------------------- */

const VALID_VOICES = new Set([

  "Elon Musk",
  "Mark Zuckerberg",
  "Joe Rogan",
  "Barack Obama",
  "Morgan Freeman",
  "Kanye West",
  "Donald Trump",
  "Joe Biden",
  "Kim Kardashian",
  "Taylor Swift",
  "James Earl Jones",
  "Samuel L. Jackson",
  "Jeff Goldblum",
  "David Attenborough",
  "Sean Connery",
  "Cillian Murphy",
  "Anne Hathaway",
  "Julia Roberts",
  "Natalie Portman",
  "Steve Carell",
  "Amy Poehler",
  "Stephen Colbert",
  "Jimmy Fallon",
  "David Letterman",
  "Alex Trebek",
  "Katy Perry",
  "Prince",
  "Kevin Bacon",
  "Tom Hiddleston",
  "Adam Driver",
  "Alan Rickman",
  "Alexz Johnson",
  "Ana Gasteyer",
  "Andrew Rannells",
  "Arden Cho",
  "Bear Grylls",
  "Ben McKenzie",
  "Ben Stiller",
  "Ben Whishaw",
  "Billie Joe Armstrong",
  "Bingbing Li",
  "Booboo Stewart",
  "Bradley Steven Perry",
  "Bruno Mars",
  "Cameron Boyce",
  "Candice Accola",
  "Carrie Underwood",
  "Casey Affleck",
  "Caterina Scorsone",
  "Cedric the Entertainer"

]);

function getSafeVoice(
  requestedVoice
) {

  const voice =
    String(
      requestedVoice || ""
    ).trim();

  /*
    Fix the old "default" value.
  */

  if (
    !voice ||
    voice.toLowerCase() ===
      "default"
  ) {

    return "Morgan Freeman";
  }

  /*
    Only send a known valid
    Magic Hour voice.
  */

  if (
    VALID_VOICES.has(voice)
  ) {

    return voice;
  }

  /*
    Unknown voice =
    safe automatic default.
  */

  return "Morgan Freeman";
}

/* ---------------------------------------------------------
   RESOLUTION
--------------------------------------------------------- */

function getSafeResolution(
  requested
) {

  const value =
    String(
      requested || "720p"
    ).toLowerCase();

  /*
    LTX-2 supports:
    480p
    720p
    1080p

    It does NOT support 4K.

    Therefore 4K is safely converted
    to 1080p instead of causing an API error.
  */

  if (
    value === "480p"
  ) {

    return "480p";
  }

  if (
    value === "1080p"
  ) {

    return "1080p";
  }

  if (
    value === "4k"
  ) {

    return "1080p";
  }

  return "720p";
}

/* ---------------------------------------------------------
   MERGE AUDIO + VIDEO
--------------------------------------------------------- */

function mergeAudioWithVideo(
  videoPath,
  audioPath,
  outputPath
) {

  return new Promise(
    (resolve, reject) => {

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

      const process =
        spawn(
          ffmpegPath,
          args
        );

      let stderr = "";

      process.stderr.on(
        "data",
        data => {

          stderr +=
            data.toString();
        }
      );

      process.on(
        "error",
        error => {

          reject(error);
        }
      );

      process.on(
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
                `FFmpeg failed with code ${code}: ${stderr.slice(-2000)}`
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
        Boolean(ffmpegPath),

      time:
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

        return res.status(400)
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

        return res.status(400)
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

        return res.status(400)
          .json({
            error:
              "Please upload a JPG, PNG, or WebP image."
          });
      }

      /*
        We deliberately use LTX-2
        instead of hard-coding Kling 3.0.

        This prevents the exact:
        "kling-3.0 is not available
        for your subscription tier"
        problem.
      */

      const model =
        "ltx-2";

      const requestedResolution =
        req.body.resolution ||
        "720p";

      const resolution =
        getSafeResolution(
          requestedResolution
        );

      console.log(
        "DE VENOM VIDEO REQUEST"
      );

      console.log(
        "Model:",
        model
      );

      console.log(
        "Resolution:",
        resolution
      );

      /* Upload image */

      const imageFilePath =
        await uploadToMagicHour(
          req.file.buffer,
          extension,
          "image"
        );

      /* Create video */

      const videoJob =
        await magicHourRequest(
          "/v1/image-to-video",
          {

            method: "POST",

            body:
              JSON.stringify({

                name:
                  "DE Venom Cinematic Video",

                end_seconds:
                  6,

                model,

                resolution,

                /*
                  We generate the voice separately
                  so the user's written voice text
                  can become the actual audio.
                */

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

      console.log(
        "Video job:",
        videoJob.id
      );

      const completedVideo =
        await waitForVideo(
          videoJob.id
        );

      const videoDownload =
        completedVideo.downloads.find(
          item => item?.url
        );

      const videoBuffer =
        await downloadBuffer(
          videoDownload.url
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

      /*
        OPTIONAL VOICE
      */

      const audioText =
        String(
          req.body.audioText ||
          req.body.voiceText ||
          ""
        ).trim();

      let finalVideoUrl;

      if (audioText) {

        /*
          THIS IS THE IMPORTANT FIX.

          If the website sends:
          default

          it becomes:
          Morgan Freeman

          before Magic Hour receives it.
        */

        const voiceName =
          getSafeVoice(
            req.body.voiceName
          );

        console.log(
          "Requested voice:",
          req.body.voiceName
        );

        console.log(
          "Actual voice:",
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

        const audioDownload =
          completedAudio.downloads.find(
            item => item?.url
          );

        const audioBuffer =
          await downloadBuffer(
            audioDownload.url
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

        /*
          Merge voice with video.
        */

        await mergeAudioWithVideo(
          rawVideoPath,
          audioPath,
          finalVideoPath
        );

        try {

          fs.unlinkSync(
            rawVideoPath
          );

          fs.unlinkSync(
            audioPath
          );

        } catch {}

        const publicBase =
          BASE_URL ||
          `${req.protocol}://${req.get("host")}`;

        finalVideoUrl =
          `${publicBase}/videos/${path.basename(finalVideoPath)}`;

      } else {

        /*
          No audio text =
          video without added voice.
        */

        fs.renameSync(
          rawVideoPath,
          finalVideoPath
        );

        const publicBase =
          BASE_URL ||
          `${req.protocol}://${req.get("host")}`;

        finalVideoUrl =
          `${publicBase}/videos/${path.basename(finalVideoPath)}`;
      }

      return res.json({

        success:
          true,

        message:
          audioText
            ? "6-second video with AI voice created successfully."
            : "6-second video created successfully.",

        video:
          finalVideoUrl,

        model,

        resolution,

        requestedResolution,

        duration:
          6,

        audioIncluded:
          Boolean(audioText)
      });

    } catch (error) {

      console.error(
        "CREATE VIDEO ERROR:",
        error
      );

      return res.status(500)
        .json({

          error:
            error.message ||
            "Video generation failed."
        });
    }
  }
);

/* ---------------------------------------------------------
   CREATE AUDIO ONLY
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

        return res.status(400)
          .json({
            error:
              "Please enter text for the AI voice."
          });
      }

      /*
        IMPORTANT VOICE FIX

        The browser may send:
        default

        This function changes it to:
        Morgan Freeman
      */

      const voiceName =
        getSafeVoice(
          req.body.voiceName
        );

      console.log(
        "Audio requested voice:",
        req.body.voiceName
      );

      console.log(
        "Audio actual voice:",
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

      const download =
        completed.downloads.find(
          item => item?.url
        );

      const audioBuffer =
        await downloadBuffer(
          download.url
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

      const publicBase =
        BASE_URL ||
        `${req.protocol}://${req.get("host")}`;

      return res.json({

        success:
          true,

        audio:
          `${publicBase}/audio/${path.basename(audioPath)}`,

        voice:
          voiceName
      });

    } catch (error) {

      console.error(
        "CREATE AUDIO ERROR:",
        error
      );

      return res.status(500)
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
      `Magic Hour API key configured: ${Boolean(MAGIC_HOUR_API_KEY)}`
    );

    console.log(
      `FFmpeg configured: ${Boolean(ffmpegPath)}`
    );

  }
);
