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

// Carpeta para guardar PDFs y metadatos
const uploadDir = path.join(__dirname, "uploads");
const metaFile = path.join(uploadDir, "tokens.json");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Si no existe el archivo de tokens, crearlo vacío
if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, JSON.stringify({}), "utf8");

// Configuración de Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage });

// Servir archivos subidos
app.use("/files", express.static(uploadDir));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
    <style>
      body { font-family: Arial, sans-serif; margin: 40px; text-align: center; }
      form { border: 1px solid #ddd; padding: 20px; display: inline-block; border-radius: 10px; }
      button { background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; }
      button:hover { background: #0056b3; }
    </style>
  `);
});

// ✅ Subir PDF y generar token + QR
app.post("/upload", upload.single("pdf"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("No se subió ningún archivo.");

  // Cargar tokens existentes
  const tokens = JSON.parse(fs.readFileSync(metaFile, "utf8"));

  // Generar token único tipo SUNAT
  const token = nanoid(80);
  tokens[token] = file.filename; // Asociar token con archivo

  // Guardar metadatos actualizados
  fs.writeFileSync(metaFile, JSON.stringify(tokens, null, 2));

  // Crear URL con token (ya no muestra nombre del archivo)
  const serverUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const viewUrl = `${serverUrl}/view/${token}`;

  // Generar QR en PNG
  const qrPath = path.join(uploadDir, `${file.filename}-qr.png`);
  await QRCode.toFile(qrPath, viewUrl, {
    type: "png",
    width: 300,
    margin: 2,
  });

  // Respuesta visual
  res.send(`
    <div style="text-align:center; font-family: Arial, sans-serif; margin: 40px;">
      <h2>✅ Archivo subido correctamente</h2>
      <p><strong>Archivo:</strong> ${file.originalname}</p>
      <p><strong>Token generado:</strong> ${token}</p>
      <p><strong>URL del documento:</strong> <a href="${viewUrl}" target="_blank">${viewUrl}</a></p>

      <h3>Vista previa del QR</h3>
      <img src="/files/${file.filename}-qr.png" alt="QR Code" width="300"
        style="border:1px solid #ccc; padding:10px; border-radius:10px"/><br/><br/>

      <a href="/files/${file.filename}-qr.png" download="qr-${file.originalname}.png">
        ⬇️ Descargar QR (PNG)
      </a><br/><br/>

      <p>El PDF está disponible en: <a href="${viewUrl}" target="_blank">Ver PDF</a></p>

      <br/>
      <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">
        ➕ Subir otro PDF
      </a>
    </div>
  `);
});

// ✅ Ruta para ver PDF por token
app.get("/view/:token", (req, res) => {
  const token = req.params.token;
  const tokens = JSON.parse(fs.readFileSync(metaFile, "utf8"));

  const fileName = tokens[token];
  if (!fileName) {
    return res.status(404).send("<h2>❌ Token inválido o PDF no encontrado</h2>");
  }

  const pdfPath = path.join(uploadDir, fileName);
  if (!fs.existsSync(pdfPath)) {
    return res.status(404).send("<h2>❌ El archivo PDF ya no existe</h2>");
  }

  res.send(`
    <div style="text-align:center; font-family:Arial, sans-serif;">
      <iframe src="/files/${fileName}" width="90%" height="600px" style="border:1px solid #ccc; border-radius:8px;"></iframe>
    </div>
  `);
});

// Evitar error al recargar /upload
app.get("/upload", (req, res) => res.redirect("/"));

// Iniciar servidor
app.listen(PORT, () =>
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
);
