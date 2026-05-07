const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── CORS ──────────────────────────────────────────────────────────────────────
// In produzione sostituisci con il tuo dominio Figma plugin
app.use(cors({ origin: "*" }));

// ── Multer: upload in memoria (max 100 MB) ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Solo file PDF sono accettati"));
    }
    cb(null, true);
  },
});

// ── Profili Ghostscript ───────────────────────────────────────────────────────
//
// Ghostscript mantiene il testo e i vettori intatti in tutti i profili.
// Le impostazioni agiscono SOLO sulle immagini raster embedded (foto, bitmap).
//
//  none    → nessuna elaborazione, file restituito invariato
//  light   → /printer  300 dpi — compressione lossless, qualità massima
//  medium  → /ebook    150 dpi — buon equilibrio qualità/dimensione
//  extreme → /screen    72 dpi — dimensione minima, immagini ridotte
//
const PROFILES = {
  none: null,
  light: {
    settings: "/printer",
    colorDpi: 300,
    grayDpi: 300,
  },
  medium: {
    settings: "/ebook",
    colorDpi: 150,
    grayDpi: 150,
  },
  extreme: {
    settings: "/screen",
    colorDpi: 72,
    grayDpi: 72,
  },
};

// ── Ghostscript wrapper ───────────────────────────────────────────────────────
function compressWithGhostscript(inputPath, outputPath, profile) {
  return new Promise((resolve, reject) => {
    const args = [
      "-q",
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.5",
      // Preserva testo e vettori
      "-dNOCACHE",
      "-dSubsetFonts=true",
      "-dCompressFonts=true",
      "-dEmbedAllFonts=true",
      // Profilo compressione
      `-dPDFSETTINGS=${profile.settings}`,
      // Qualità immagini raster
      `-dColorImageResolution=${profile.colorDpi}`,
      `-dGrayImageResolution=${profile.grayDpi}`,
      `-dMonoImageResolution=${profile.grayDpi}`,
      // Metodi di compressione immagini
      "-dColorImageDownsampleType=/Bicubic",
      "-dGrayImageDownsampleType=/Bicubic",
      "-dMonoImageDownsampleType=/Bicubic",
      "-dAutoFilterColorImages=false",
      "-dAutoFilterGrayImages=false",
      "-dColorImageFilter=/DCTEncode",
      "-dGrayImageFilter=/DCTEncode",
      // Output
      `-sOutputFile=${outputPath}`,
      inputPath,
    ];

    execFile("gs", args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Ghostscript error: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });
}

// ── Endpoint principale: POST /compress ──────────────────────────────────────
app.post("/compress", upload.single("file"), async (req, res) => {
  const { compression = "none" } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: "Nessun file ricevuto" });
  }

  if (!PROFILES.hasOwnProperty(compression)) {
    return res.status(400).json({
      error: `Compressione non valida. Valori accettati: ${Object.keys(PROFILES).join(", ")}`,
    });
  }

  // Compressione "none" → restituiamo il file originale senza elaborazione
  if (compression === "none") {
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="export.pdf"`,
      "Content-Length": req.file.buffer.length,
      "X-Original-Size": req.file.buffer.length,
      "X-Compressed-Size": req.file.buffer.length,
      "X-Compression-Ratio": "1.00",
    });
    return res.send(req.file.buffer);
  }

  // Crea file temporanei
  const tmpId = crypto.randomBytes(8).toString("hex");
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `tiesporto-in-${tmpId}.pdf`);
  const outputPath = path.join(tmpDir, `tiesporto-out-${tmpId}.pdf`);

  try {
    // Scrivi input su disco
    fs.writeFileSync(inputPath, req.file.buffer);

    const originalSize = req.file.buffer.length;
    const profile = PROFILES[compression];

    // Comprimi
    await compressWithGhostscript(inputPath, outputPath, profile);

    // Leggi output
    const compressed = fs.readFileSync(outputPath);
    const compressedSize = compressed.length;
    const ratio = (compressedSize / originalSize).toFixed(2);

    console.log(
      `[compress] ${compression} | ${(originalSize / 1024).toFixed(0)} KB → ${(compressedSize / 1024).toFixed(0)} KB (${ratio}x)`
    );

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="export-${compression}.pdf"`,
      "Content-Length": compressedSize,
      "X-Original-Size": originalSize,
      "X-Compressed-Size": compressedSize,
      "X-Compression-Ratio": ratio,
    });

    res.send(compressed);
  } catch (err) {
    console.error("[compress] Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Pulizia file temporanei
    for (const f of [inputPath, outputPath]) {
      try { fs.unlinkSync(f); } catch {}
    }
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  execFile("gs", ["--version"], (err, stdout) => {
    res.json({
      status: "ok",
      ghostscript: err ? "not found" : stdout.trim(),
      profiles: Object.keys(PROFILES),
    });
  });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File troppo grande (max 100 MB)" });
  }
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Tiesporto backend running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
