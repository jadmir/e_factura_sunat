import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import { fileURLToPath } from "url";

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

// Detrás de proxy (Heroku/Render/Nginx), confía en X-Forwarded-*
app.set("trust proxy", 1);

// Carpeta para guardar PDFs y metadatos
const uploadDir = path.join(__dirname, "uploads");
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
const removeByToken = (token) => {
  const meta = readMetadata();
  const entry = meta.byToken[token];
  if (!entry) return { ok: false, reason: "not_found" };

  try {
    const pdfPath = safeJoin(uploadDir, entry.filename);
    const qrPath = safeJoin(uploadDir, `${entry.filename}-qr.png`);
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
  } catch (e) {
    // continúa igualmente para limpiar metadatos
  }

  delete meta.byToken[token];
  delete meta.byFile[entry.filename];
  writeMetadata(meta);
  return { ok: true, entry };
};

// Configuración de Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  },
});

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

  const meta = readMetadata();
  const token = nanoid(60);
  const createdAt = new Date();
  const expiresAt = new Date(
    createdAt.getTime() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  meta.byFile[file.filename] = {
    token,
    originalName: file.originalname,
    size: file.size,
    mime: file.mimetype,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  meta.byToken[token] = {
    filename: file.filename,
    originalName: file.originalname,
    size: file.size,
    mime: file.mimetype,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  writeMetadata(meta);

  const viewUrl = `${getBaseUrl(req)}/view/${token}`;

  // Generar QR en PNG
  const qrPath = path.join(uploadDir, `${file.filename}-qr.png`);
  await QRCode.toFile(qrPath, viewUrl, { type: "png", width: 300, margin: 2 });

  // Respuesta visual
  res.send(`
    <div style="text-align:center; font-family: Arial, sans-serif; margin: 40px;">
      <h2>✅ Archivo subido correctamente</h2>
      <p>
        <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">➕ Subir otro PDF</a>
      </p>
      <p><strong>Archivo:</strong> ${file.originalname}</p>
      <p><strong>Enlace válido hasta:</strong> ${expiresAt.toLocaleString()}</p>
      <p><strong>URL del documento:</strong> <a href="${viewUrl}" target="_blank">${viewUrl}</a></p>

      <h3>Vista previa del QR</h3>
      <img src="/files/${file.filename}-qr.png" alt="QR Code" width="300" style="border:1px solid #ccc; padding:10px; border-radius:10px"/><br/><br/>

      <a href="/files/${file.filename}-qr.png" download="qr-${file.originalname}.png">⬇️ Descargar QR (PNG)</a><br/><br/>
      <p>
        <a href="/delete/${encodeURIComponent(token)}" onclick="return confirm('¿Eliminar este PDF y su QR?');" style="color:#dc3545; font-weight:600;">🗑️ Eliminar este PDF</a>
      </p>
      <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">➕ Subir otro PDF</a>
      <div style="margin-top:12px"><a href="/manage">📂 Administrar archivos</a></div>
    </div>
  `);
});

// ✅ Ruta protegida por token y expiración: envía el PDF si el token sigue vigente
app.get("/view/:token", (req, res) => {
  const token = req.params.token;
  const meta = readMetadata();
  const entry = meta.byToken[token];
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

  const pdfPath = path.join(uploadDir, entry.filename);
  if (!fs.existsSync(pdfPath)) return res.status(404).send("❌ El archivo PDF ya no existe.");
  res.sendFile(pdfPath);
});

// Listado simple de tokens guardados
app.get("/tokens", (req, res) => {
  if (ADMIN_USER && ADMIN_PASS) return requireAdmin(req, res, () => listTokens(req, res));
  return listTokens(req, res);
});

function listTokens(req, res) {
  const meta = readMetadata();
  const rows = Object.entries(meta.byToken)
    .map(([t, info]) => {
      const expired = info.expiresAt && Date.now() > Date.parse(info.expiresAt);
      const qr = `${info.filename}-qr.png`;
      return `
        <tr>
          <td><code>${t}</code></td>
          <td>${info.originalName || "-"}</td>
          <td><code>${info.filename}</code></td>
          <td>${info.createdAt || "-"}</td>
          <td>${info.expiresAt || "-"} ${expired ? "(vencido)" : ""}</td>
          <td>
            <a href="/view/${t}" target="_blank">Ver PDF</a> |
            <a href="/files/${qr}" target="_blank">Ver QR</a> |
            <a href="/delete/${encodeURIComponent(t)}" style="color:#dc3545" onclick="return confirm('¿Eliminar este PDF y su QR?');">Eliminar</a>
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
function purgeExpired() {
  const meta = readMetadata();
  const now = Date.now();
  let removed = 0;
  for (const [token, info] of Object.entries(meta.byToken)) {
    const exp = Date.parse(info.expiresAt || "");
    if (Number.isFinite(exp) && now > exp) {
      try { fs.unlinkSync(path.join(uploadDir, info.filename)); } catch {}
      try { fs.unlinkSync(path.join(uploadDir, `${info.filename}-qr.png`)); } catch {}
      delete meta.byFile[info.filename];
      delete meta.byToken[token];
      removed++;
    }
  }
  writeMetadata(meta);
  return removed;
}

// Endpoint para ejecutar limpieza manual
app.get("/admin/purge", requireAdmin, (req, res) => {
  const removed = purgeExpired();
  res.send(`Eliminados ${removed} elementos vencidos. <a href=\"/manage\">Volver</a>`);
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
try {
  const removed = purgeExpired();
  if (removed) console.log(`🧹 Purga inicial: ${removed} elemento(s) vencido(s) eliminado(s).`);
} catch {}


// Página de administración con lista sencilla y opción de eliminar
app.get("/manage", requireAdmin, (req, res) => {
  const meta = readMetadata();
  const items = Object.entries(meta.byToken)
    .sort((a, b) => Date.parse(b[1].createdAt) - Date.parse(a[1].createdAt))
    .map(([t, info]) => {
      const created = new Date(info.createdAt).toLocaleString();
      const sizeStr = ""; // tamaño no persistido, opcional
      return `
        <tr>
          <td>${info.originalName || info.filename}</td>
          <td>${created}</td>
          <td><a href="/view/${t}" target="_blank">PDF</a> | <a href="/files/${info.filename}-qr.png" target="_blank">QR</a></td>
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
app.get("/delete/:token", requireAdmin, (req, res) => {
  const token = req.params.token;
  const result = removeByToken(token);
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
setInterval(() => {
  const removed = purgeExpired();
  if (removed) console.log(`🧹 Purga periódica: ${removed} elemento(s) vencido(s).`);
}, Math.max(1, PURGE_INTERVAL_MINUTES) * 60 * 1000).unref();
