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

// Carpeta para guardar los PDFs
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Configuración de Multer para subir PDF
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

// Página principal con formulario
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

// Ruta para subir PDF y generar QR con URL ficticia
app.post("/upload", upload.single("pdf"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).send("No se subió ningún archivo.");

  // Crear URL ficticia tipo SUNAT
  const randomToken = nanoid(60);
  const fakeUrl = `https://e-factura.sunart.gop.pe/v1/contribuyante/gre/comprobantes/descargass?${randomToken}`;

  // Generar QR en PNG
  const qrPath = path.join(uploadDir, `${file.filename}-qr.png`);
  await QRCode.toFile(qrPath, fakeUrl, {
    type: "png",
    width: 300,
    margin: 2,
  });

  // Vista previa del QR + botón de descarga y opción de subir otro PDF
  res.send(`
    <div style="text-align:center; font-family: Arial, sans-serif; margin: 40px;">
      <h2>✅ Archivo subido correctamente</h2>
      <p>
        <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">
          ➕ Subir otro PDF
        </a>
      </p>
      <p><strong>Archivo:</strong> ${file.originalname}</p>
      <p><strong>URL Ficticia:</strong> <a href="${fakeUrl}" target="_blank">${fakeUrl}</a></p>

      <h3>Vista previa del QR</h3>
      <img src="/files/${file.filename}-qr.png" alt="QR Code" width="300" style="border:1px solid #ccc; padding:10px; border-radius:10px"/><br/><br/>

      <a href="/files/${file.filename}-qr.png" download="qr-${file.originalname}.png">
        ⬇️ Descargar QR (PNG)
      </a><br/><br/>

      <p>El PDF está disponible en: <a href="/files/${file.filename}" target="_blank">Ver PDF</a></p>

      <br/>
      <a href="/" style="display:inline-block; background:#28a745; color:white; text-decoration:none; padding:10px 16px; border-radius:6px;">
        ➕ Subir otro PDF
      </a>
    </div>
  `);
});

// Si alguien intenta entrar por GET a /upload (por ejemplo al recargar), lo mandamos al formulario
app.get("/upload", (req, res) => res.redirect("/"));

// Iniciar servidor
app.listen(PORT, () =>
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
);
