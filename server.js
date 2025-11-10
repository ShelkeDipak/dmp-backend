// server.js
// Secure version: No local serviceAccountKey.json loading
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const googleTTS = require("google-tts-api");
const fetch = require("node-fetch");
const ffmpeg = require("fluent-ffmpeg");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

// -------- CORS --------
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------- firebase-admin init --------
// 🔒 Only from env variable
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  try {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    console.log("✅ Firebase Admin initialized from env");
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", err);
  }
} else {
  console.warn(
    "⚠️ Firebase Admin not initialized. Set FIREBASE_SERVICE_ACCOUNT_JSON in your environment."
  );
}

// -------- Multer config --------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${unique}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const mimetypeOk = allowed.test(file.mimetype);
  const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
  if (mimetypeOk && extOk) cb(null, true);
  else cb(new Error("Only image files are allowed (jpg, jpeg, png, webp)."));
};

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

// ---------- Helper ----------
async function downloadToFile(url, filepath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(filepath);
    res.body.pipe(dest);
    res.body.on("error", reject);
    dest.on("finish", resolve);
  });
}

// ---------- Auth middleware ----------
async function verifyFirebaseToken(req, res, next) {
  if (!admin.apps || admin.apps.length === 0) {
    return res.status(500).json({
      error: "Server misconfiguration: Firebase Admin not initialized",
    });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer (.*)$/);
    if (!match) {
      return res.status(401).json({ error: "Missing Authorization header" });
    }
    const idToken = match[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    return next();
  } catch (err) {
    console.error("Token verification failed:", err);
    return res.status(401).json({ error: "Unauthorized: invalid token" });
  }
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.send(
    "Digital Medical Prescription - Backend. POST /generate (form-data: instructions, title, images[])"
  );
});

app.post(
  "/generate",
  verifyFirebaseToken,
  upload.array("images", 12),
  async (req, res) => {
    const {
      instructions = "",
      title = "Digital_Med_Prescription",
      lang = "en",
    } = req.body;
    const images = req.files || [];

    if (!instructions || images.length === 0) {
      (req.files || []).forEach((f) => {
        try {
          fs.unlinkSync(f.path);
        } catch {}
      });
      return res.status(400).json({
        error: "Provide instructions text and at least one image.",
      });
    }

    const jobId = uuidv4();
    const tmpDir = path.join(__dirname, "tmp", jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const maxChunk = 200;
      const chunks = [];
      for (let i = 0; i < instructions.length; i += maxChunk) {
        chunks.push(instructions.substring(i, i + maxChunk));
      }

      const audioFiles = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i].trim();
        if (!chunk) continue;
        const url = googleTTS.getAudioUrl(chunk, {
          lang: lang || "en",
          slow: false,
          host: "https://translate.google.com",
        });
        const audioPath = path.join(tmpDir, `tts_${i}.mp3`);
        await downloadToFile(url, audioPath);
        audioFiles.push(audioPath);
      }

      const finalAudio = path.join(tmpDir, "final_tts.mp3");
      if (audioFiles.length === 0) {
        throw new Error("No TTS audio generated for instructions.");
      } else if (audioFiles.length === 1) {
        fs.copyFileSync(audioFiles[0], finalAudio);
      } else {
        await new Promise((resolve, reject) => {
          const merged = ffmpeg();
          audioFiles.forEach((f) => merged.input(f));
          merged
            .on("error", (err) => reject(err))
            .on("end", resolve)
            .mergeToFile(finalAudio, tmpDir);
        });
      }

      const slideImgs = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = path.extname(img.originalname) || ".jpg";
        const dest = path.join(tmpDir, `img_${i}${ext}`);
        fs.renameSync(img.path, dest);
        slideImgs.push(dest);
      }

      const audioDuration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(finalAudio, (err, metadata) => {
          if (err) return reject(err);
          resolve(metadata.format.duration || 0);
        });
      });

      const perImage = Math.max(3, audioDuration / Math.max(1, slideImgs.length));

      const imageVideos = [];
      for (let i = 0; i < slideImgs.length; i++) {
        const img = slideImgs[i];
        const iv = path.join(tmpDir, `iv_${i}.mp4`);
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(img)
            .inputOptions(["-loop 1"])
            .outputOptions(["-vf scale=1280:720", "-pix_fmt yuv420p"])
            .duration(perImage)
            .on("error", (err) => reject(err))
            .on("end", resolve)
            .save(iv);
        });
        imageVideos.push(iv);
      }

      const listFile = path.join(tmpDir, "list.txt");
      const listContent = imageVideos
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");
      fs.writeFileSync(listFile, listContent);

      const concatVideo = path.join(tmpDir, "slides.mp4");
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(["-f concat", "-safe 0"])
          .outputOptions(["-c copy"])
          .on("error", reject)
          .on("end", resolve)
          .save(concatVideo);
      });

      const videoPath = path.join(tmpDir, "output_video.mp4");
      await new Promise((resolve, reject) => {
        ffmpeg()
          .addInput(concatVideo)
          .addInput(finalAudio)
          .outputOptions(["-c:v libx264", "-c:a aac", "-shortest", "-pix_fmt yuv420p"])
          .on("error", reject)
          .on("end", resolve)
          .save(videoPath);
      });

      res.download(videoPath, `${title.replace(/\s+/g, "_")}_${jobId}.mp4`, (err) => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
        if (err) console.error("Error sending file:", err);
      });
    } catch (err) {
      console.error("Error generating video:", err);
      (req.files || []).forEach((f) => {
        try {
          fs.unlinkSync(f.path);
        } catch {}
      });
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      res.status(500).json({ error: err.message || "Server error" });
    }
  }
);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
