const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.MAGIC_HOUR_API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const PREMIUM_ACCESS_KEY = process.env.PREMIUM_ACCESS_KEY || "";
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || "";

const ROOT = __dirname;
const uploads = path.join(ROOT, "uploads");
const videos = path.join(ROOT, "videos");
const audio = path.join(ROOT, "audio");
for (const d of [uploads, videos, audio]) fs.mkdirSync(d, {recursive:true});

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(ROOT));
app.use("/videos", express.static(videos));
app.use("/audio", express.static(audio));

const upload = multer({
  dest: uploads,
  limits:{fileSize:15*1024*1024},
  fileFilter:(req,file,cb)=>{
    cb(null, ["image/jpeg","image/png","image/webp","image/jpg"].includes(file.mimetype));
  }
});

const MH = "https://api.magichour.ai";
function authHeaders(json=true){
  const h = {accept:"application/json", authorization:`Bearer ${API_KEY}`};
  if(json) h["content-type"]="application/json";
  return h;
}
async function mh(url, options={}){
  const r=await fetch(url,options);
  const t=await r.text();
  let d={}; try{d=t?JSON.parse(t):{}}catch{d={message:t}};
  if(!r.ok) throw new Error(d.message||d.error||`Magic Hour API error ${r.status}`);
  return d;
}
async function uploadToMagicHour(file){
  const ext = file.mimetype==="image/png"?"png":file.mimetype==="image/webp"?"webp":"jpg";
  const d=await mh(`${MH}/v1/files/upload-urls`,{
    method:"POST",headers:authHeaders(),
    body:JSON.stringify({items:[{type:"image",extension:ext}]})
  });
  const item=d.items?.[0];
  if(!item?.upload_url||!item?.file_path) throw new Error("Magic Hour did not return an upload URL.");
  const body=fs.readFileSync(file.path);
  const r=await fetch(item.upload_url,{method:"PUT",headers:{"content-type":file.mimetype},body});
  if(!r.ok) throw new Error("Image upload to Magic Hour failed.");
  return item.file_path;
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitVideo(id){
  for(let i=0;i<90;i++){
    const d=await mh(`${MH}/v1/video-projects/${id}`,{headers:authHeaders(false)});
    if(d.status==="complete") return d;
    if(["error","canceled"].includes(d.status)) throw new Error(d.error?.message||d.message||"Magic Hour video generation failed.");
    await sleep(5000);
  }
  throw new Error("Video generation timed out. Try again.");
}
async function waitAudio(id){
  for(let i=0;i<60;i++){
    const d=await mh(`${MH}/v1/audio-projects/${id}`,{headers:authHeaders(false)});
    if(d.status==="complete") return d;
    if(["error","canceled"].includes(d.status)) throw new Error(d.error?.message||d.message||"Magic Hour audio generation failed.");
    await sleep(3000);
  }
  throw new Error("Audio generation timed out. Try again.");
}
async function saveRemote(url, file){
  const r=await fetch(url);
  if(!r.ok) throw new Error("Could not download generated media.");
  fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));
}

app.post("/api/create-video",upload.single("images"),async(req,res)=>{
  let f=req.file;
  try{
    if(!API_KEY) throw new Error("MAGIC_HOUR_API_KEY is missing in Render.");
    if(!f) return res.status(400).json({error:"Please upload an image."});
    const prompt=String(req.body.motion||"").trim();
    if(!prompt) return res.status(400).json({error:"Please enter a movement command."});

    const filePath=await uploadToMagicHour(f);
    const job=await mh(`${MH}/v1/image-to-video`,{
      method:"POST",headers:authHeaders(),
      body:JSON.stringify({
        name:"DE Venom Video",
        end_seconds:6,
        resolution:"576p",
        audio:true,
        style:{prompt},
        assets:{image_file_path:filePath}
      })
    });
    if(!job.id) throw new Error("Magic Hour did not return a project ID.");
    const done=await waitVideo(job.id);
    const remote=done.downloads?.[0]?.url;
    if(!remote) throw new Error("Magic Hour returned no video download.");
    const name=`${crypto.randomUUID()}.mp4`;
    await saveRemote(remote,path.join(videos,name));

    const premium=req.headers["x-premium-token"]===PREMIUM_ACCESS_KEY && !!PREMIUM_ACCESS_KEY;
    res.json({
      success:true,
      videoUrl:`${BASE_URL}/videos/${name}`,
      projectId:job.id,
      premium,
      persistentUrl:premium?`/videos/${name}`:undefined,
      viewOnceUrl:premium?undefined:`/api/view-once/${name}`
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message||"Video generation failed."});
  }finally{
    if(f?.path) try{fs.unlinkSync(f.path)}catch{}
  }
});

const viewed=new Set();
app.get("/api/view-once/:name",(req,res)=>{
  const name=path.basename(req.params.name);
  if(viewed.has(name)) return res.status(410).send("This view-once video has already been viewed.");
  const file=path.join(videos,name);
  if(!fs.existsSync(file)) return res.status(404).send("Video not found.");
  viewed.add(name);
  res.sendFile(file);
});

app.post("/api/create-audio",async(req,res)=>{
  try{
    if(!API_KEY) throw new Error("MAGIC_HOUR_API_KEY is missing in Render.");
    const text=String(req.body.text||"").trim();
    const voice=String(req.body.voice||"").trim();
    if(!text) return res.status(400).json({error:"Please enter text for the AI voice."});

    const body={name:"DE Venom AI Voice",style:{prompt:text}};
    if(voice) body.style.voice_name=voice;

    const job=await mh(`${MH}/v1/ai-voice-generator`,{
      method:"POST",headers:authHeaders(),body:JSON.stringify(body)
    });
    if(!job.id) throw new Error("Magic Hour did not return an audio project ID.");
    const done=await waitAudio(job.id);
    const remote=done.downloads?.[0]?.url;
    if(!remote) throw new Error("Magic Hour returned no audio download.");
    const name=`${crypto.randomUUID()}.mp3`;
    await saveRemote(remote,path.join(audio,name));
    res.json({success:true,audioUrl:`${BASE_URL}/audio/${name}`,projectId:job.id});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e.message||"AI audio generation failed."});
  }
});

let prices={monthly:1000,yearly:15000};
app.get("/api/prices",(req,res)=>res.json(prices));

app.put("/api/admin/prices",(req,res)=>{
  if(!ADMIN_KEY || req.headers["x-admin-key"]!==ADMIN_KEY) return res.status(401).json({error:"Unauthorized."});
  const monthly=Number(req.body.monthly), yearly=Number(req.body.yearly);
  if(!Number.isFinite(monthly)||!Number.isFinite(yearly)||monthly<0||yearly<0) return res.status(400).json({error:"Invalid prices."});
  prices={monthly,yearly}; res.json({success:true,prices});
});

app.post("/api/premium/activate",(req,res)=>{
  if(!PREMIUM_ACCESS_KEY || String(req.body.key||"")!==PREMIUM_ACCESS_KEY) return res.status(401).json({error:"Invalid Premium access key."});
  res.json({success:true,token:PREMIUM_ACCESS_KEY});
});

app.get("/health",(req,res)=>res.json({status:"ok",service:"DE Venom",provider:"Magic Hour",apiConfigured:!!API_KEY}));

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(400).json({error:err.message||"Something went wrong."});
});

app.listen(PORT,()=>console.log(`DE Venom running on port ${PORT}`));
