import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from "dotenv";

// Cargar variables de entorno desde .env si existe
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_TTL_DAYS = Number(process.env.TOKEN_TTL_DAYS || 365);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASS = process.env.ADMIN_PASS || "";
const BASE_URL = process.env.BASE_URL || ""; // opcional para enlaces externos
const PURGE_INTERVAL_MINUTES = Number(process.env.PURGE_INTERVAL_MINUTES || 360); // 6h
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || "";
const AWS_S3_PREFIX = (process.env.AWS_S3_PREFIX || "uploads").replace(/^\/+|\/+$/g, "");

// Cliente S3
const s3 = new S3Client({ region: AWS_REGION });

// Detrás de proxy (Heroku/Render/Nginx), confía en X-Forwarded-*
app.set("trust proxy", 1);

// Carpeta para guardar PDFs y metadatos (configurable por env)
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Archivo único de metadatos persistentes
const metadataPath = path.join(uploadDir, "metadata.json");
if (!fs.existsSync(metadataPath)) {
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({ byFile: {}, byToken: {} }, null, 2),
    "utf8"
  );
}

// Helpers para leer/grabar metadatos de manera segura
const readMetadata = () => {
  try {
    const raw = fs.readFileSync(metadataPath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    return { byFile: {}, byToken: {}, ...parsed };
  } catch {
    return { byFile: {}, byToken: {} };
  }
};
const writeMetadata = (data) => {
  const safe = { byFile: {}, byToken: {}, ...data };
  fs.writeFileSync(metadataPath, JSON.stringify(safe, null, 2), "utf8");
};

// --- Helpers S3 para metadatos de tokens ---
const TOKENS_PREFIX = (process.env.AWS_TOKENS_PREFIX || `tokens`).replace(/^\/+|\/+$/g, "");
async function s3PutJson(key, obj) {
  if (!AWS_S3_BUCKET) return;
  const body = Buffer.from(JSON.stringify(obj));
  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: "application/json",
    CacheControl: "no-store",
  }));
}
async function s3GetJson(key) {
  if (!AWS_S3_BUCKET) return null;
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
    const buf = await out.Body.transformToByteArray();
    return JSON.parse(Buffer.from(buf).toString("utf8"));
  } catch {
    return null;
  }
}
async function s3ListTokenEntries(limit = 200) {
  if (!AWS_S3_BUCKET) return [];
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  let tokenEntries = [];
  let ContinuationToken;
  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: `${TOKENS_PREFIX}/`,
      ContinuationToken,
      MaxKeys: Math.min(1000, limit - tokenEntries.length),
    }));
    const keys = (resp.Contents || [])
      .filter(o => o.Key && o.Key.endsWith('.json'))
      .map(o => o.Key);
    for (const k of keys) {
      const e = await s3GetJson(k);
      if (e) tokenEntries.push(e);
      if (tokenEntries.length >= limit) break;
    }
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (ContinuationToken && tokenEntries.length < limit);
  return tokenEntries;
}

// Utilidad para construir URL pública correcta
function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL.replace(/\/$/, "");
  const protoHdr = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString();
  const proto = Array.isArray(protoHdr) ? protoHdr[0] : String(protoHdr).split(",")[0];
  const host = (req.headers["x-forwarded-host"] || req.get("host") || "localhost").toString();
  return `${proto}://${host}`;
}

// Autenticación básica opcional para rutas sensibles
function requireAdmin(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) return next(); // sin protección si no está configurado
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Basic\s+(.+)$/i);
  if (!m) {
    res.setHeader("WWW-Authenticate", "Basic realm=admin");
    return res.status(401).send("Auth requerida");
  }
  const [u, p] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  res.setHeader("WWW-Authenticate", "Basic realm=admin");
  return res.status(401).send("Credenciales inválidas");
}

// Helpers de gestión/eliminación
const safeJoin = (base, file) => {
  const p = path.join(base, file);
  if (!p.startsWith(base)) throw new Error("Ruta no permitida");
  return p;
};
const removeByToken = async (token) => {
  const meta = readMetadata();
  let entry = meta.byToken[token];
  if (!entry) {
    // intenta cargar desde S3 si no está en memoria local
    entry = await s3GetJson(`${TOKENS_PREFIX}/${token}.json`);
  }
  if (!entry) return { ok: false, reason: "not_found" };

  // Eliminar en S3 si existe
  try { if (entry.s3Bucket && entry.s3Key) await s3.send(new DeleteObjectCommand({ Bucket: entry.s3Bucket, Key: entry.s3Key })); } catch {}
  try { if (entry.s3Bucket && entry.qrS3Key) await s3.send(new DeleteObjectCommand({ Bucket: entry.s3Bucket, Key: entry.qrS3Key })); } catch {}
  // Intentar también localmente (modo desarrollo)
  try { const pdfPath = safeJoin(uploadDir, entry.filename); if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
  try { const qrPath = safeJoin(uploadDir, `${entry.filename}-qr.png`); if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath); } catch {}

  delete meta.byToken[token];
  delete meta.byFile[entry.filename];
  writeMetadata(meta);
  // Borrar metadato de token en S3
  try { await s3.send(new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: `${TOKENS_PREFIX}/${token}.json` })); } catch {}
  return { ok: true, entry };
};

// Configuración de Multer (memoria). file.buffer contendrá el PDF
const storage = multer.memoryStorage();

// Servir archivos subidos
// Servir archivos subidos con control de caché (QR puede cachearse largo)
app.use(
  "/files",
  express.static(uploadDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("-qr.png")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Encabezados de seguridad básicos
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-XSS-Protection", "0");
  next();
});
// Validar que sea PDF y limitar tamaño
const fileFilter = (req, file, cb) => {
  if (
    file.mimetype === "application/pdf" ||
    (file.originalname || "").toLowerCase().endsWith(".pdf")
  ) {
    cb(null, true);
  } else {
    cb(new Error("Solo se permiten archivos PDF."));
  }
};
const upload = multer({ storage, limits: { fileSize: MAX_FILE_BYTES }, fileFilter });

// Página principal
app.get("/", (req, res) => {
  res.send(`
    <h1>📄 Generador de QR para PDFs</h1>
    <form action="/upload" method="post" enctype="multipart/form-data">
      <label>Selecciona tu PDF:</label><br/>
      <input type="file" name="pdf" accept="application/pdf" required />
      <br/><br/>
      <button type="submit">Subir y Generar QR</button>
    </form>
    <p style="margin-top:16px">
      <a href="/tokens">Ver tokens guardados</a>
    </p>
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
      form { border: 1px solid #ddd; padding: 20px; display: inline-block; border-radius: 10px; }
      button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
      button:hover { background: #0056b3; }
    </style>
  `);
});

// Redirigir GET /upload al formulario (evita confusión al refrescar)
app.get("/upload", (req, res) => res.redirect("/"));

// ✅ Subir PDF y generar token + QR con expiración de 1 año
app.post("/upload", upload.single("pdf"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("No se subió ningún archivo.");
  if (!AWS_S3_BUCKET) return res.status(500).send("Falta configurar AWS_S3_BUCKET.");

  const meta = readMetadata();
  const token = nanoid(60);
  const createdAt = new Date();
    const ttlDays = Number(TOKEN_TTL_DAYS);
    const expiresAt = ttlDays > 0
      ? new Date(createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1000)
      : null; // sin vencimiento si <= 0

  // Crear nombre único y subir a S3
  const uniqueName = `${Date.now()}-${file.originalname}`;
  const s3Key = `${AWS_S3_PREFIX}/${uniqueName}`;
  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: s3Key,
    Body: file.buffer,
    ContentType: file.mimetype || "application/pdf",
  }));

  const entry = {
    token,
    originalName: file.originalname,
    size: file.size,
    mime: file.mimetype,
    createdAt: createdAt.toISOString(),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    s3Bucket: AWS_S3_BUCKET,
    s3Key,
    filename: uniqueName,
  };
  // Persistir local (fallback) y en S3 por token
  meta.byFile[uniqueName] = { ...entry };
  meta.byToken[token] = { ...entry };
  writeMetadata(meta);
  await s3PutJson(`${TOKENS_PREFIX}/${token}.json`, { ...entry, token });

  const viewUrl = `${getBaseUrl(req)}/view/${token}`;

  // Generar QR a buffer y subir a S3
  const qrBuffer = await QRCode.toBuffer(viewUrl, { type: "png", width: 300, margin: 2 });
  const qrS3Key = `${AWS_S3_PREFIX}/${uniqueName}-qr.png`;
  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: qrS3Key,
    Body: qrBuffer,
    ContentType: "image/png",
    CacheControl: "public, max-age=31536000, immutable",
  }));
  meta.byFile[uniqueName].qrS3Key = qrS3Key;
  meta.byToken[token].qrS3Key = qrS3Key;
  writeMetadata(meta);
  await s3PutJson(`${TOKENS_PREFIX}/${token}.json`, { ...entry, qrS3Key, token });

  // Respuesta visual
  res.send(`
    <div style="text-align:center; font-family: Arial, sans-serif; margin: 40px;">
      <h2>✅ Archivo subido correctamente</h2>
      <p>
        <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">➕ Subir otro PDF</a>
      </p>
      <p><strong>Archivo:</strong> ${file.originalname}</p>
        <p><strong>Vencimiento:</strong> ${expiresAt ? expiresAt.toLocaleString() : 'Sin vencimiento'}</p>
      <p><strong>URL del documento:</strong> <a href="${viewUrl}" target="_blank">${viewUrl}</a></p>

  <h3>Vista previa del QR</h3>
  <img src="/qr/${encodeURIComponent(token)}" alt="QR Code" width="300" style="border:1px solid #ccc; padding:10px; border-radius:10px"/><br/><br/>

  <a href="/qr/${encodeURIComponent(token)}?download=1">⬇️ Descargar QR (PNG)</a><br/><br/>
      <p>
        <a href="/delete/${encodeURIComponent(token)}" onclick="return confirm('¿Eliminar este PDF y su QR?');" style="color:#dc3545; font-weight:600;">🗑️ Eliminar este PDF</a>
      </p>
      <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">➕ Subir otro PDF</a>
      <div style="margin-top:12px"><a href="/manage">📂 Administrar archivos</a></div>
    </div>
  `);
});

// ✅ Ruta protegida por token y expiración: envía el PDF si el token sigue vigente
app.get("/view/:token", async (req, res) => {
  const token = req.params.token;
  let entry = await s3GetJson(`${TOKENS_PREFIX}/${token}.json`);
  if (!entry) {
    const meta = readMetadata();
    entry = meta.byToken[token];
  }
  if (!entry) return res.status(404).send("❌ Token inválido o PDF no encontrado.");

  const now = Date.now();
  const expiresAt = Date.parse(entry.expiresAt || "");
  if (Number.isFinite(expiresAt) && now > expiresAt) {
    return res
      .status(410)
      .send(
        `<div style="font-family: Arial; margin:40px; text-align:center">
           <h2>⏰ Enlace vencido</h2>
           <p>Este enlace expiró el <strong>${new Date(expiresAt).toLocaleString()}</strong>.</p>
           <p><a href="/">Subir un nuevo PDF</a></p>
         </div>`
      );
  }

  if (entry.s3Bucket && entry.s3Key) {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: entry.s3Bucket, Key: entry.s3Key }),
      { expiresIn: 60 }
    );
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(url);
  }
  const pdfPath = path.join(uploadDir, entry.filename);
  if (!fs.existsSync(pdfPath)) return res.status(404).send("❌ El archivo PDF ya no existe.");
  res.sendFile(pdfPath);
});

// QR desde S3 (URL prefirmada) para vista/descarga
app.get("/qr/:token", async (req, res) => {
  const token = req.params.token;
  const meta = readMetadata();
  const entry = meta.byToken[token];
  if (!entry || !entry.qrS3Key || !entry.s3Bucket) return res.status(404).send("QR no encontrado");
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: entry.s3Bucket, Key: entry.qrS3Key }),
    { expiresIn: 300 }
  );
  if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename=qr-${encodeURIComponent(entry.originalName || entry.filename)}.png`);
  res.setHeader("Cache-Control", "no-store");
  return res.redirect(url);
});

// Listado simple de tokens guardados
app.get("/tokens", async (req, res) => {
  if (ADMIN_USER && ADMIN_PASS) return requireAdmin(req, res, () => listTokens(req, res));
  return listTokens(req, res);
});

async function listTokens(req, res) {
  // Obtén entradas desde S3 y completa con locales si faltan
  const s3Entries = await s3ListTokenEntries(500);
  const byToken = new Map();
  for (const e of s3Entries || []) {
    if (e && e.token) byToken.set(e.token, e);
  }
  const meta = readMetadata();
  for (const [tok, info] of Object.entries(meta.byToken || {})) {
    if (!byToken.has(tok)) byToken.set(tok, { ...info, token: tok });
  }
  const combined = Array.from(byToken.values()).sort((a, b) => {
    return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
  });
  const rows = combined
    .map((info) => {
      const token = info.token;
      const expired = info.expiresAt && Date.now() > Date.parse(info.expiresAt);
      const qrRoute = `/qr/${token}`;
      const expText = info.expiresAt ? new Date(info.expiresAt).toLocaleString() : 'Sin vencimiento';
      return `
        <tr>
          <td><code>${token}</code></td>
          <td>${info.originalName || "-"}</td>
          <td><code>${info.filename}</code></td>
          <td>${info.createdAt || "-"}</td>
          <td>${expText} ${expired ? "(vencido)" : ""}</td>
          <td>
            <a href="/view/${token}" target="_blank">Ver PDF</a> |
            <a href="${qrRoute}" target="_blank">Ver QR</a> |
            <a href="/delete/${encodeURIComponent(token)}" style="color:#dc3545" onclick="return confirm('¿Eliminar este PDF y su QR?');">Eliminar</a>
          </td>
        </tr>`;
    })
    .join("");
  res.send(`
    <div style="font-family: Arial, sans-serif; margin: 30px;">
      <h2>Tokens guardados</h2>
      <p><a href="/">← Volver al formulario</a> | <a href="/manage">Administrar</a></p>
      <table border="1" cellspacing="0" cellpadding="6">
        <thead>
          <tr>
            <th>Token</th>
            <th>Nombre original</th>
            <th>Archivo</th>
            <th>Creado</th>
            <th>Expira</th>
            <th>Enlaces</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="6">Sin tokens aún</td></tr>'}
        </tbody>
      </table>
    </div>
  `);
}

// Limpieza de elementos vencidos
async function purgeExpired() {
  const meta = readMetadata();
  const now = Date.now();
  let removed = 0;
  for (const [token, info] of Object.entries(meta.byToken)) {
    const exp = Date.parse(info.expiresAt || "");
    if (Number.isFinite(exp) && now > exp) {
  try { if (info.s3Bucket && info.s3Key) await s3.send(new DeleteObjectCommand({ Bucket: info.s3Bucket, Key: info.s3Key })); } catch {}
  try { if (info.s3Bucket && info.qrS3Key) await s3.send(new DeleteObjectCommand({ Bucket: info.s3Bucket, Key: info.qrS3Key })); } catch {}
  try { fs.unlinkSync(path.join(uploadDir, info.filename)); } catch {}
  try { fs.unlinkSync(path.join(uploadDir, `${info.filename}-qr.png`)); } catch {}
      delete meta.byFile[info.filename];
      delete meta.byToken[token];
  try { await s3.send(new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: `${TOKENS_PREFIX}/${token}.json` })); } catch {}
      removed++;
    }
  }
  writeMetadata(meta);
  return removed;
}

// Endpoint para ejecutar limpieza manual
app.get("/admin/purge", requireAdmin, async (req, res) => {
  const removed = await purgeExpired();
  res.send(`Eliminados ${removed} elementos vencidos. <a href=\"/manage\">Volver</a>`);
});

// Reindexar: crear tokens/*.json para PDFs que ya existen en S3 y no tienen metadatos
app.get("/admin/reindex", requireAdmin, async (req, res) => {
  if (!AWS_S3_BUCKET) return res.status(500).send("Falta AWS_S3_BUCKET");
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  // 1) Traer lista actual de tokens desde S3
  const existingEntries = await s3ListTokenEntries(1000);
  const byFilename = new Map();
  const byToken = new Map();
  for (const e of existingEntries) {
    if (e?.filename) byFilename.set(e.filename, e);
    if (e?.token) byToken.set(e.token, e);
  }
  // 2) Traer lista de objetos bajo uploads/
  const allKeys = new Set();
  let ContinuationToken;
  let pdfKeys = [];
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: `${AWS_S3_PREFIX}/`,
      ContinuationToken,
      MaxKeys: 1000,
    }));
    for (const obj of out.Contents || []) {
      if (obj.Key) allKeys.add(obj.Key);
      if (obj.Key && obj.Key.endsWith('.pdf')) pdfKeys.push(obj.Key);
    }
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);

  const meta = readMetadata();
  let created = 0;
  let qrCreated = 0;
  for (const s3Key of pdfKeys) {
    const filename = s3Key.split('/').pop();
    let entry = byFilename.get(filename);

    if (!entry) {
      // Intenta usar local si existe
      const local = meta.byFile[filename];
      const token = local?.token || nanoid(60);
      const ttlDays = Number(TOKEN_TTL_DAYS);
      const createdAt = new Date();
      const expiresAt = ttlDays > 0 ? new Date(createdAt.getTime() + ttlDays * 24 * 60 * 60 * 1000) : null;
      const qrS3Key = `${AWS_S3_PREFIX}/${filename}-qr.png`;
      entry = {
        token,
        filename,
        originalName: local?.originalName || filename,
        size: local?.size,
        mime: local?.mime || 'application/pdf',
        createdAt: local?.createdAt || createdAt.toISOString(),
        expiresAt: local?.expiresAt || (expiresAt ? expiresAt.toISOString() : null),
        s3Bucket: AWS_S3_BUCKET,
        s3Key,
        qrS3Key,
      };
      // Persistir en S3 y local
      await s3PutJson(`${TOKENS_PREFIX}/${token}.json`, entry);
      meta.byFile[filename] = { ...entry };
      meta.byToken[token] = { ...entry };
      created++;
    }

    // Generar QR si falta
    if (entry.qrS3Key && !allKeys.has(entry.qrS3Key)) {
      const viewUrl = `${getBaseUrl(req)}/view/${entry.token}`;
      const qrBuffer = await QRCode.toBuffer(viewUrl, { type: 'png', width: 300, margin: 2 });
      await s3.send(new PutObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: entry.qrS3Key,
        Body: qrBuffer,
        ContentType: 'image/png',
        CacheControl: 'public, max-age=31536000, immutable',
      }));
      qrCreated++;
    }
  }
  writeMetadata(meta);
  res.send(`Reindex listo. Tokens creados: ${created}. QRs creados: ${qrCreated}. <a href="/tokens">Ver tokens</a>`);
});

// Health check
app.get("/healthz", (req, res) => res.send("ok"));

// Manejador de errores simple
// Nota: debe ir después de las rutas anteriores
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).send(err?.message || "Error en la solicitud");
});
// Ejecutar limpieza al iniciar
purgeExpired().then((removed) => {
  if (removed) console.log(`🧹 Purga inicial: ${removed} elemento(s) vencido(s) eliminado(s).`);
}).catch(() => {});


// Página de administración con lista sencilla y opción de eliminar
app.get("/manage", requireAdmin, async (req, res) => {
  const s3Entries = await s3ListTokenEntries(500);
  const byToken = new Map();
  for (const e of s3Entries || []) if (e && e.token) byToken.set(e.token, e);
  const meta = readMetadata();
  for (const [tok, info] of Object.entries(meta.byToken || {})) if (!byToken.has(tok)) byToken.set(tok, { ...info, token: tok });
  const combined = Array.from(byToken.values()).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const items = combined
    .map((info) => {
      const t = info.token;
      const created = new Date(info.createdAt).toLocaleString();
      const sizeStr = info.size ? ` (${(info.size/1024).toFixed(1)} KB)` : "";
      return `
        <tr>
          <td>${info.originalName || info.filename}</td>
          <td>${created}${sizeStr}</td>
          <td><a href="/view/${t}" target="_blank">PDF</a> | <a href="/qr/${t}" target="_blank">QR</a></td>
          <td><a href="/delete/${encodeURIComponent(t)}" style="color:#dc3545" onclick="return confirm('¿Eliminar ${info.originalName || info.filename}?');">Eliminar</a></td>
        </tr>`;
    })
    .join("");
  res.send(`
    <div style="font-family: Arial, sans-serif; margin: 30px;">
      <h2>📂 Administrar archivos</h2>
      <p><a href="/">← Volver al formulario</a></p>
      <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse; width:100%; max-width:1000px;">
        <thead>
          <tr style="background:#f7f7f7">
            <th>Nombre</th><th>Subido</th><th>Enlaces</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>
          ${items || '<tr><td colspan="4" style="text-align:center; color:#666">Sin archivos</td></tr>'}
        </tbody>
      </table>
    </div>
  `);
});

// Eliminar por token
app.get("/delete/:token", requireAdmin, async (req, res) => {
  const token = req.params.token;
  const result = await removeByToken(token);
  if (!result.ok) return res.status(404).send("Archivo no encontrado o ya eliminado.");
  res.redirect("/manage");
});

// Iniciar servidor
const server = app.listen(PORT, () =>
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
);

// Apagado limpio
function shutdown(signal) {
  console.log(`\n${signal} recibido, cerrando servidor...`);
  server.close(() => {
    console.log("Servidor cerrado. Bye");
    process.exit(0);
  });
  // Forzar salida si tarda > 5s
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Purga periódica de vencidos
setInterval(async () => {
  const removed = await purgeExpired();
  if (removed) console.log(`🧹 Purga periódica: ${removed} elemento(s) vencido(s).`);
}, Math.max(1, PURGE_INTERVAL_MINUTES) * 60 * 1000).unref();
