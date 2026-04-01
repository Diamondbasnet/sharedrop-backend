require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

const app = express();
const port = Number(process.env.PORT) || 3000;
const upload = multer({ storage: multer.memoryStorage() });
const corsOrigin = process.env.CORS_ORIGIN;

const CLIP_TYPE = {
  TEXT: "text",
  FILE: "file",
};

const CLOUDINARY_RESOURCE_TYPES = ["image", "video", "raw"];

const cloudinaryConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
};

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
      filename: { type: String, default: null },
      mimetype: { type: String, default: null },
      size: { type: Number, default: null },
      url: { type: String, default: null },
      publicId: { type: String, default: null },
      resourceType: { type: String, default: null },
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

app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));
app.use(express.json({ limit: "10mb" }));

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
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
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

function uploadBufferToCloudinary(fileBuffer, mimetype, originalName) {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured.");
  }

  const base64 = fileBuffer.toString("base64");
  const dataUri = `data:${mimetype};base64,${base64}`;

  return cloudinary.uploader.upload(dataUri, {
    resource_type: "auto",
    folder: "sharedrop",
    use_filename: true,
    unique_filename: true,
    filename_override: originalName,
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
    const remoteDeleted = await destroyCloudinaryFile(
      clip.file?.publicId,
      clip.file?.resourceType
    );

    if (!remoteDeleted) {
      return false;
    }
  }

  await Clip.deleteOne({ _id: clip._id });
  return true;
}

app.post("/api/clip", upload.single("file"), async (req, res) => {
  try {
    const textContent = getRequestText(req.body);
    const expiryHours = getRequestExpiryHours(req.body);
    const uploadedFile = req.file;

    const hasText = textContent.length > 0;
    const hasFile = Boolean(uploadedFile);

    if ((hasText && hasFile) || (!hasText && !hasFile)) {
      return res.status(400).json({
        error: "Provide exactly one of text content or file upload.",
      });
    }

    if (hasFile && !isCloudinaryConfigured()) {
      return res.status(503).json({
        error: "File uploads are not configured on this server.",
      });
    }

    const hours = parseExpiryHours(expiryHours);
    if (hours === null) {
      return res.status(400).json({
        error: "expiryHours must be a positive number.",
      });
    }

    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const code = await createUniqueCode();

    const clipData = {
      code,
      type: hasFile ? CLIP_TYPE.FILE : CLIP_TYPE.TEXT,
      expiresAt,
    };

    if (hasFile) {
      const cloudinaryResult = await uploadBufferToCloudinary(
        uploadedFile.buffer,
        uploadedFile.mimetype,
        uploadedFile.originalname
      );

      clipData.file = {
        filename: uploadedFile.originalname,
        mimetype: uploadedFile.mimetype,
        size: uploadedFile.size,
        url: cloudinaryResult.secure_url,
        publicId: cloudinaryResult.public_id,
        resourceType: cloudinaryResult.resource_type ?? null,
      };
    } else {
      clipData.textContent = textContent;
    }

    const clip = await Clip.create(clipData);

    return res.status(201).json({
      code: clip.code,
      type: clip.type,
      expiresAt: clip.expiresAt,
      fileUrl: clip.type === CLIP_TYPE.FILE ? clip.file.url : null,
    });
  } catch (error) {
    console.error("Failed to create clip:", error.message);
    return res.status(500).json({ error: "Failed to create clip." });
  }
});

app.get("/api/clip/:code", async (req, res) => {
  try {
    const { code } = req.params;
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

    return res.json({
      code: clip.code,
      type: clip.type,
      fileUrl: clip.file.url,
      file: {
        filename: clip.file.filename,
        mimetype: clip.file.mimetype,
        size: clip.file.size,
        url: clip.file.url,
      },
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
    const cleanupInterval = setInterval(cleanupExpiredClips, 60 * 60 * 1000);
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
