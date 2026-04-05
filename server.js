require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

const app = express();
const port = Number(process.env.PORT) || 3000;
const corsOrigin = process.env.CORS_ORIGIN;
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB) || 25;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_FILES_PER_CLIP = Number(process.env.MAX_FILES_PER_CLIP) || 10;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";
const MIN_EXPIRY_HOURS = 1 / 60;
const MAX_EXPIRY_HOURS = 7 * 24;
const CREATE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CREATE_RATE_LIMIT_MAX = Number(process.env.CREATE_RATE_LIMIT_MAX) || 30;
const FETCH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const FETCH_RATE_LIMIT_MAX = Number(process.env.FETCH_RATE_LIMIT_MAX) || 240;
const RATE_LIMITER_CACHE_LIMIT = 5000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: MAX_FILES_PER_CLIP,
  },
});

const CLIP_TYPE = {
  TEXT: "text",
  FILE: "file",
};

const CLOUDINARY_RESOURCE_TYPES = ["image", "video", "raw"];
const CLEANUP_INTERVAL_MS = 60 * 1000;
const rateLimitStore = new Map();

const cloudinaryConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
};

const storedFileSchema = new mongoose.Schema(
  {
    filename: { type: String, default: null },
    mimetype: { type: String, default: null },
    size: { type: Number, default: null },
    url: { type: String, default: null },
    publicId: { type: String, default: null },
    resourceType: { type: String, default: null },
  },
  { _id: false }
);

const clipSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      index: true,
      minlength: 6,
      maxlength: 6,
    },
    type: {
      type: String,
      enum: [CLIP_TYPE.TEXT, CLIP_TYPE.FILE],
      required: true,
    },
    textContent: {
      type: String,
      default: null,
    },
    file: {
      type: storedFileSchema,
      default: null,
    },
    files: {
      type: [storedFileSchema],
      default: undefined,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

const Clip = mongoose.model("Clip", clipSchema);

cloudinary.config(cloudinaryConfig);

app.disable("x-powered-by");
app.set("trust proxy", 1);

function parseAllowedOrigins(rawOrigins) {
  if (!rawOrigins) {
    return [];
  }

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins(corsOrigin);

function createCorsOptions() {
  if (allowedOrigins.length === 0) {
    if (process.env.NODE_ENV === "production") {
      return { origin: false };
    }

    return undefined;
  }

  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
  };
}

function getClientIdentifier(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(",")[0];

  return (req.ip || forwardedValue || "unknown").trim();
}

function pruneRateLimitStore(now) {
  if (rateLimitStore.size < RATE_LIMITER_CACHE_LIMIT) {
    return;
  }

  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt <= now) {
      rateLimitStore.delete(key);
    }
  }

  while (rateLimitStore.size >= RATE_LIMITER_CACHE_LIMIT) {
    const oldestKey = rateLimitStore.keys().next().value;
    if (!oldestKey) {
      break;
    }

    rateLimitStore.delete(oldestKey);
  }
}

function createRateLimiter({ scope, windowMs, maxRequests }) {
  return (req, res, next) => {
    const now = Date.now();
    pruneRateLimitStore(now);

    const key = `${scope}:${getClientIdentifier(req)}`;
    const currentEntry = rateLimitStore.get(key);

    if (!currentEntry || currentEntry.resetAt <= now) {
      rateLimitStore.set(key, {
        count: 1,
        resetAt: now + windowMs,
      });
      next();
      return;
    }

    if (currentEntry.count >= maxRequests) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((currentEntry.resetAt - now) / 1000)
      );
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Too many requests. Please try again later.",
      });
      return;
    }

    currentEntry.count += 1;
    next();
  };
}

const createClipRateLimiter = createRateLimiter({
  scope: "create-clip",
  windowMs: CREATE_RATE_LIMIT_WINDOW_MS,
  maxRequests: CREATE_RATE_LIMIT_MAX,
});

const fetchClipRateLimiter = createRateLimiter({
  scope: "fetch-clip",
  windowMs: FETCH_RATE_LIMIT_WINDOW_MS,
  maxRequests: FETCH_RATE_LIMIT_MAX,
});

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  next();
});
app.use("/api/clip", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

app.get("/", (_req, res) => {
  res.json({
    service: "sharedrop-backend",
    status: "ok",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

function isCloudinaryConfigured() {
  return Boolean(
    cloudinaryConfig.cloud_name &&
      cloudinaryConfig.api_key &&
      cloudinaryConfig.api_secret
  );
}

function generateCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let code = "";

  for (let index = 0; index < length; index += 1) {
    code += chars[bytes[index] % chars.length];
  }

  return code;
}

async function createUniqueCode() {
  let code = "";
  let exists = true;

  while (exists) {
    code = generateCode(6);
    // eslint-disable-next-line no-await-in-loop
    exists = Boolean(await Clip.exists({ code }));
  }

  return code;
}

function parseExpiryHours(rawHours) {
  if (rawHours === undefined || rawHours === null || rawHours === "") {
    return 24;
  }

  const parsed = Number(rawHours);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_EXPIRY_HOURS ||
    parsed > MAX_EXPIRY_HOURS
  ) {
    return null;
  }

  return parsed;
}

function isValidClipCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9]{6}$/.test(value);
}

function getRequestText(body = {}) {
  if (typeof body.text === "string" && body.text.trim().length > 0) {
    return body.text.trim();
  }

  if (typeof body.content === "string" && body.content.trim().length > 0) {
    return body.content.trim();
  }

  return "";
}

function getRequestExpiryHours(body = {}) {
  if (body.expiryHours !== undefined) {
    return body.expiryHours;
  }

  if (body.expiry_hours !== undefined) {
    return body.expiry_hours;
  }

  return undefined;
}

function resolveCloudinaryResourceType(mimetype = "") {
  if (mimetype.startsWith("image/")) {
    return "image";
  }

  if (mimetype.startsWith("video/") || mimetype.startsWith("audio/")) {
    return "video";
  }

  return "raw";
}

function getUploadedFiles(req) {
  const requestFiles = req.files;

  if (!requestFiles) {
    return [];
  }

  if (Array.isArray(requestFiles)) {
    return requestFiles;
  }

  return [...(requestFiles.files || []), ...(requestFiles.file || [])];
}

function getClipFiles(clip) {
  if (Array.isArray(clip?.files) && clip.files.length > 0) {
    return clip.files;
  }

  if (clip?.file?.url) {
    return [clip.file];
  }

  return [];
}

function formatFileResponse(file) {
  if (!file) {
    return null;
  }

  return {
    filename: file.filename,
    mimetype: file.mimetype,
    size: file.size,
    url: file.url,
  };
}

function uploadBufferToCloudinary(fileBuffer, mimetype, originalName) {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured.");
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: resolveCloudinaryResourceType(mimetype),
        folder: "sharedrop",
        use_filename: true,
        unique_filename: true,
        filename_override: originalName,
      },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      }
    );

    uploadStream.end(fileBuffer);
  });
}

function getCloudinaryResourceTypes(resourceType) {
  if (!resourceType) {
    return CLOUDINARY_RESOURCE_TYPES;
  }

  return [
    resourceType,
    ...CLOUDINARY_RESOURCE_TYPES.filter((type) => type !== resourceType),
  ];
}

async function destroyCloudinaryFile(publicId, resourceType) {
  if (!publicId) {
    return true;
  }

  if (!isCloudinaryConfigured()) {
    console.warn(
      `Skipping Cloudinary cleanup for ${publicId} because Cloudinary is not configured.`
    );
    return false;
  }

  let lastError = null;

  for (const currentResourceType of getCloudinaryResourceTypes(resourceType)) {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: currentResourceType,
      });

      if (result.result === "ok" || result.result === "deleted") {
        return true;
      }

      if (result.result !== "not found") {
        console.warn(
          `Unexpected Cloudinary destroy result for ${publicId}: ${result.result}`
        );
      }
    } catch (error) {
      lastError = error;
      console.error(
        `Failed to delete Cloudinary asset ${publicId} as ${currentResourceType}:`,
        error.message
      );
    }
  }

  if (lastError) {
    return false;
  }

  return true;
}

async function deleteExpiredClip(clip) {
  if (!clip) {
    return false;
  }

  if (clip.type === CLIP_TYPE.FILE) {
    const clipFiles = getClipFiles(clip);

    for (const file of clipFiles) {
      // Retry later if any remote file cleanup fails.
      // eslint-disable-next-line no-await-in-loop
      const remoteDeleted = await destroyCloudinaryFile(
        file?.publicId,
        file?.resourceType
      );

      if (!remoteDeleted) {
        return false;
      }
    }
  }

  await Clip.deleteOne({ _id: clip._id });
  return true;
}

app.post(
  "/api/clip",
  createClipRateLimiter,
  upload.fields([
    { name: "file", maxCount: MAX_FILES_PER_CLIP },
    { name: "files", maxCount: MAX_FILES_PER_CLIP },
  ]),
  async (req, res) => {
    const uploadedCloudinaryFiles = [];

    try {
      const textContent = getRequestText(req.body);
      const expiryHours = getRequestExpiryHours(req.body);
      const uploadedFiles = getUploadedFiles(req);

      const hasText = textContent.length > 0;
      const hasFiles = uploadedFiles.length > 0;

      if ((hasText && hasFiles) || (!hasText && !hasFiles)) {
        return res.status(400).json({
          error: "Provide exactly one of text content or file upload.",
        });
      }

      if (hasFiles && !isCloudinaryConfigured()) {
        return res.status(503).json({
          error: "File uploads are not configured on this server.",
        });
      }

      const hours = parseExpiryHours(expiryHours);
      if (hours === null) {
        return res.status(400).json({
          error: "expiryHours must be between 1 minute and 7 days.",
        });
      }

      const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      const code = await createUniqueCode();

      const clipData = {
        code,
        type: hasFiles ? CLIP_TYPE.FILE : CLIP_TYPE.TEXT,
        expiresAt,
      };

      if (hasFiles) {
        const storedFiles = [];

        for (const uploadedFile of uploadedFiles) {
          // Upload sequentially so we can clean up partial progress if one file fails.
          // eslint-disable-next-line no-await-in-loop
          const cloudinaryResult = await uploadBufferToCloudinary(
            uploadedFile.buffer,
            uploadedFile.mimetype,
            uploadedFile.originalname
          );

          const storedFile = {
            filename: uploadedFile.originalname,
            mimetype: uploadedFile.mimetype,
            size: uploadedFile.size,
            url: cloudinaryResult.secure_url,
            publicId: cloudinaryResult.public_id,
            resourceType: cloudinaryResult.resource_type ?? null,
          };

          uploadedCloudinaryFiles.push(storedFile);
          storedFiles.push(storedFile);
        }

        clipData.file = storedFiles[0];
        clipData.files = storedFiles;
      } else {
        clipData.textContent = textContent;
      }

      const clip = await Clip.create(clipData);
      const clipFiles = getClipFiles(clip);
      const primaryFile = clipFiles[0];

      return res.status(201).json({
        code: clip.code,
        type: clip.type,
        expiresAt: clip.expiresAt,
        fileUrl: clip.type === CLIP_TYPE.FILE ? primaryFile?.url ?? null : null,
        files:
          clip.type === CLIP_TYPE.FILE
            ? clipFiles.map((file) => formatFileResponse(file))
            : [],
      });
    } catch (error) {
      const filesToCleanup =
        uploadedCloudinaryFiles.length > 0 ? uploadedCloudinaryFiles : [];

      if (filesToCleanup.length > 0) {
        await Promise.allSettled(
          filesToCleanup.map((file) =>
            destroyCloudinaryFile(file.publicId, file.resourceType)
          )
        );
      }

      console.error("Failed to create clip:", error.message);
      return res.status(500).json({ error: "Failed to create clip." });
    }
  }
);

app.get("/api/clip/:code", fetchClipRateLimiter, async (req, res) => {
  try {
    const { code } = req.params;
    if (!isValidClipCode(code)) {
      return res.status(400).json({ error: "Invalid clip code." });
    }

    const clip = await Clip.findOne({ code });

    if (!clip) {
      return res.status(404).json({ error: "Clip not found." });
    }

    if (clip.expiresAt <= new Date()) {
      const deleted = await deleteExpiredClip(clip);
      if (!deleted) {
        console.warn(`Expired clip ${clip.code} could not be fully cleaned up yet.`);
      }
      return res.status(404).json({ error: "Clip has expired." });
    }

    if (clip.type === CLIP_TYPE.TEXT) {
      return res.json({
        code: clip.code,
        type: clip.type,
        text: clip.textContent,
        content: clip.textContent,
        expiresAt: clip.expiresAt,
        createdAt: clip.createdAt,
      });
    }

    const clipFiles = getClipFiles(clip);
    const primaryFile = clipFiles[0];

    return res.json({
      code: clip.code,
      type: clip.type,
      fileUrl: primaryFile?.url ?? null,
      file: formatFileResponse(primaryFile),
      files: clipFiles.map((file) => formatFileResponse(file)),
      expiresAt: clip.expiresAt,
      createdAt: clip.createdAt,
    });
  } catch (error) {
    console.error("Failed to retrieve clip:", error.message);
    return res.status(500).json({ error: "Failed to retrieve clip." });
  }
});

async function cleanupExpiredClips() {
  try {
    const expiredClips = await Clip.find({ expiresAt: { $lte: new Date() } });
    let deletedCount = 0;

    for (const clip of expiredClips) {
      // Retry later if remote file cleanup fails.
      // eslint-disable-next-line no-await-in-loop
      const deleted = await deleteExpiredClip(clip);
      if (deleted) {
        deletedCount += 1;
      } else if (clip.type === CLIP_TYPE.FILE) {
        console.warn(`Cleanup job will retry expired file clip ${clip.code}.`);
      }
    }

    if (deletedCount > 0) {
      console.log(`Cleanup job removed ${deletedCount} expired clips.`);
    }
  } catch (error) {
    console.error("Cleanup job failed:", error.message);
  }
}

app.use((error, _req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `File size exceeds the ${MAX_UPLOAD_SIZE_MB} MB limit.`,
      });
    }

    if (error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE") {
      return res.status(400).json({
        error: `You can upload up to ${MAX_FILES_PER_CLIP} files at once.`,
      });
    }

    return res.status(400).json({ error: "Invalid file upload." });
  }

  if (error?.message === "Origin not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed." });
  }

  return next(error);
});

async function startServer() {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error("MONGODB_URI is not set.");
    }

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log("Connected to MongoDB.");

    if (!isCloudinaryConfigured()) {
      console.warn(
        "Cloudinary environment variables are not fully set. File uploads are disabled until they are configured."
      );
    }

    await cleanupExpiredClips();
    const cleanupInterval = setInterval(cleanupExpiredClips, CLEANUP_INTERVAL_MS);
    cleanupInterval.unref();

    app.listen(port, () => {
      console.log(`ShareDrop backend listening on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

startServer();
