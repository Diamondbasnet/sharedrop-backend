# ShareDrop Backend

Express + MongoDB backend for ShareDrop.

## Environment variables

Required:

- `MONGODB_URI` — MongoDB connection string (MongoDB Atlas works well on Render)
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

Optional:

- `CORS_ORIGIN` — comma-separated frontend URLs (required in production so the browser can call the API)
- `MAX_UPLOAD_SIZE_MB` (default: 25)
- `CREATE_RATE_LIMIT_MAX` (default: 30)
- `FETCH_RATE_LIMIT_MAX` (default: 240)

`PORT` is set automatically by Render. Do not hardcode it.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

## Deploy on Render (from Railway)

Your app does not use Railway-specific code. Migration is mostly copying env vars and pointing your frontend at the new URL.

### 1. Export settings from Railway

In the Railway project dashboard, copy these values:

- `MONGODB_URI`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CORS_ORIGIN` (your frontend URL, e.g. `https://your-app.vercel.app`)

If MongoDB was hosted on Railway, export or back up data first, then use [MongoDB Atlas](https://www.mongodb.com/atlas) (free tier) and set `MONGODB_URI` to the Atlas connection string.

### 2. Create the Render service

**Option A — Blueprint (recommended)**

1. Push this repo to GitHub.
2. In [Render](https://dashboard.render.com), click **New** → **Blueprint**.
3. Connect the repo. Render reads `render.yaml` and creates the web service.
4. When prompted, enter the secret env vars from step 1.

**Option B — Manual**

1. **New** → **Web Service** → connect your GitHub repo.
2. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Health check path:** `/health`
3. Add env vars under **Environment** (same list as above, plus `NODE_ENV=production`).

### 3. Verify deployment

After deploy finishes, open:

`https://<your-service>.onrender.com/health`

You should see: `{"status":"ok"}`

### 4. Update your frontend

Replace the old Railway API base URL with your Render URL, for example:

`https://<your-service>.onrender.com`

Ensure `CORS_ORIGIN` on Render includes your frontend origin exactly (scheme + host, no trailing slash).

### 5. Shut down Railway

Once the frontend works against Render, delete or pause the Railway service to avoid confusion and extra cost.

### Render free tier notes

- The service sleeps after ~15 minutes of no traffic; the first request after sleep can take 30–60 seconds (cold start).
- For always-on hosting, upgrade to a paid plan or use a free uptime ping service sparingly (not ideal for production).

## Useful routes

- `GET /health`
- `POST /api/clip`
- `GET /api/clip/:code`
