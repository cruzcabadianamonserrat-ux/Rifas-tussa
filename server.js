const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const nodemailer = require("nodemailer");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "CHANGE_ME_IN_PRODUCTION",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 8
  }
}));

const db = new sqlite3.Database(path.join(ROOT, "database.db"));
db.configure("busyTimeout", 5000);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
async function transaction(fn) {
  await run("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    await run("COMMIT");
    return result;
  } catch (e) {
    try { await run("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

db.serialize(() => {
  db.run(`PRAGMA foreign_keys = ON`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rifas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    image TEXT,
    totalBoletos INTEGER NOT NULL CHECK(totalBoletos > 0),
    precioBoleto INTEGER NOT NULL CHECK(precioBoleto > 0),
    minCompra INTEGER NOT NULL DEFAULT 1,
    limiteBoletos INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS boletos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rifaId INTEGER NOT NULL,
    number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'available'
      CHECK(status IN ('available','pending','sold')),
    UNIQUE(rifaId, number),
    FOREIGN KEY(rifaId) REFERENCES rifas(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS solicitudes (
    id TEXT PRIMARY KEY,
    rifaId INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    tickets TEXT NOT NULL,
    total INTEGER NOT NULL,
    receipt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pendiente de verificación'
      CHECK(status IN ('Pendiente de verificación','Aprobado','Rechazado')),
    motivoRechazo TEXT,
    createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(rifaId) REFERENCES rifas(id)
  )`);
});

const OFFER_LEVELS = [
  { quantity: 7, discount: 0.10 },
  { quantity: 14, discount: 0.20 },
  { quantity: 21, discount: 0.28 },
  { quantity: 50, discount: 0.38 },
  { quantity: 100, discount: 0.45 }
];

function commercialRound(value) {
  // Redondeo a RD$10 para evitar precios extraños.
  return Math.max(0, Math.round(value / 10) * 10);
}
function calculatePrice(qty, unitPrice, limit) {
  if (!Number.isInteger(qty) || qty < 1 || qty > limit) {
    throw new Error("Cantidad de boletos inválida.");
  }
  const offer = OFFER_LEVELS.find(x => x.quantity === qty && x.quantity <= limit);
  const normal = qty * unitPrice;
  return offer ? commercialRound(normal * (1 - offer.discount)) : normal;
}
function calculateOfferPreview(unitPrice, limit) {
  return OFFER_LEVELS
    .filter(x => x.quantity <= limit)
    .map(x => ({
      quantity: x.quantity,
      normal: x.quantity * unitPrice,
      price: commercialRound(x.quantity * unitPrice * (1 - x.discount)),
      discountPct: Math.round(x.discount * 100)
    }));
}
function makeRequestId() {
  return "RIFA-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
      return cb(new Error("El comprobante debe ser JPG, PNG o WEBP."));
    }
    cb(null, true);
  }
});

const smtpReady = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const transporter = smtpReady ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

async function sendMail(options) {
  if (!transporter) {
    console.warn("SMTP no configurado; correo omitido:", options.subject);
    return;
  }
  await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    ...options
  });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: "No autorizado." });
}

app.get("/api/rifas", async (_, res) => {
  try {
    const rifas = await all("SELECT * FROM rifas ORDER BY id DESC");
    for (const r of rifas) {
      r.tickets = await all(
        "SELECT number, status FROM boletos WHERE rifaId=? ORDER BY number",
        [r.id]
      );
      r.offers = calculateOfferPreview(r.precioBoleto, r.limiteBoletos);
    }
    res.json(rifas);
  } catch (e) {
    res.status(500).json({ error: "Error al cargar las rifas." });
  }
});

app.get("/api/rifas/:id", async (req, res) => {
  try {
    const r = await get("SELECT * FROM rifas WHERE id=?", [req.params.id]);
    if (!r) return res.status(404).json({ error: "Rifa no encontrada." });
    r.tickets = await all("SELECT number,status FROM boletos WHERE rifaId=? ORDER BY number", [r.id]);
    r.offers = calculateOfferPreview(r.precioBoleto, r.limiteBoletos);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: "Error." });
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true, smtpConfigured: smtpReady }));

app.post("/api/admin/login", async (req, res) => {
  const password = String(req.body.password || "");
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return res.status(500).json({ error: "ADMIN_PASSWORD no está configurada en el servidor." });
  // bcrypt hash opcional: si ADMIN_PASSWORD empieza con $2a/$2b/$2y, se interpreta como hash.
  const valid = configured.startsWith("$2")
    ? await bcrypt.compare(password, configured)
    : crypto.timingSafeEqual(Buffer.from(password), Buffer.from(configured));
  if (!valid) return res.status(401).json({ error: "Contraseña incorrecta." });
  req.session.isAdmin = true;
  res.json({ success: true });
});
app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});
app.get("/api/admin/me", (req, res) => res.json({ authenticated: Boolean(req.session?.isAdmin) }));

app.post("/api/admin/rifas", requireAdmin, async (req, res) => {
  try {
    const { title, description, image, totalBoletos, precioBoleto, minCompra, limiteBoletos } = req.body;
    const total = Number(totalBoletos), price = Number(precioBoleto), min = Number(minCompra), limit = Number(limiteBoletos);
    if (!title || !description || !Number.isInteger(total) || total < 1 ||
        !Number.isInteger(price) || price < 1 || !Number.isInteger(min) || min < 1 ||
        !Number.isInteger(limit) || limit < min || limit > total) {
      return res.status(400).json({ error: "Configuración de rifa inválida." });
    }
    const result = await transaction(async () => {
      const ins = await run(
        `INSERT INTO rifas(title,description,image,totalBoletos,precioBoleto,minCompra,limiteBoletos)
         VALUES(?,?,?,?,?,?,?)`,
        [title.trim(), description.trim(), image || "", total, price, min, limit]
      );
      for (let n = 1; n <= total; n++) {
        await run("INSERT INTO boletos(rifaId,number,status) VALUES(?,?,?)", [ins.lastID, n, "available"]);
      }
      return ins.lastID;
    });
    res.json({ success: true, rifaId: result });
  } catch (e) {
    res.status(500).json({ error: "No se pudo crear la rifa." });
  }
});

app.post("/api/comprar", upload.single("receipt"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Debes adjuntar un comprobante." });
    const { rifaId, name, phone, email } = req.body;
    const qty = Number(req.body.qty);
    if (!name?.trim() || !phone?.trim() || !email?.trim()) {
      return res.status(400).json({ error: "Completa todos los datos." });
    }
    const r = await get("SELECT * FROM rifas WHERE id=?", [Number(rifaId)]);
    if (!r) return res.status(404).json({ error: "Rifa no encontrada." });
    if (!Number.isInteger(qty) || qty < r.minCompra || qty > r.limiteBoletos) {
      return res.status(400).json({ error: "Cantidad de boletos fuera del rango permitido." });
    }

    const total = calculatePrice(qty, r.precioBoleto, r.limiteBoletos);
    const result = await transaction(async () => {
      const available = await all(
        "SELECT id,number FROM boletos WHERE rifaId=? AND status='available' ORDER BY RANDOM() LIMIT ?",
        [r.id, qty]
      );
      if (available.length !== qty) throw new Error("No hay suficientes boletos disponibles.");
      const ids = available.map(x => x.id);
      const numbers = available.map(x => x.number);
      const placeholders = ids.map(() => "?").join(",");
      const upd = await run(
        `UPDATE boletos SET status='pending' WHERE rifaId=? AND status='available' AND id IN (${placeholders})`,
        [r.id, ...ids]
      );
      if (upd.changes !== qty) throw new Error("Los boletos cambiaron de estado. Intenta nuevamente.");
      const id = makeRequestId();
      await run(
        `INSERT INTO solicitudes(id,rifaId,name,phone,email,tickets,total,receipt)
         VALUES(?,?,?,?,?,?,?,?)`,
        [id, r.id, name.trim(), phone.trim(), email.trim().toLowerCase(),
         JSON.stringify(numbers), total, path.basename(req.file.filename)]
      );
      return { id, numbers };
    });

    await sendMail({
      to: email.trim(),
      subject: `Recibimos tu solicitud ${result.id}`,
      text: `Hola ${name.trim()}, recibimos tu comprobante. Tu solicitud ${result.id} está PENDIENTE de verificación. Boletos reservados: ${result.numbers.join(", ")}. Total: RD$ ${total}.`
    });
    res.json({ success: true, reqId: result.id, tickets: result.numbers, total });
  } catch (e) {
    if (req.file) fs.rm(req.file.path, () => {});
    res.status(400).json({ error: e.message || "No se pudo procesar la solicitud." });
  }
});

app.get("/api/admin/solicitudes", requireAdmin, async (_, res) => {
  try {
    const rows = await all(
      `SELECT s.*, r.title AS rifaTitle
       FROM solicitudes s JOIN rifas r ON s.rifaId=r.id
       ORDER BY CASE WHEN s.status='Pendiente de verificación' THEN 0 ELSE 1 END, s.createdAt DESC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Error al cargar solicitudes." });
  }
});

app.get("/api/admin/receipt/:filename", requireAdmin, (req, res) => {
  const safe = path.basename(req.params.filename);
  const full = path.join(UPLOAD_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.sendFile(full);
});

app.post("/api/admin/accion", requireAdmin, async (req, res) => {
  try {
    const { reqId, accion, motivo } = req.body;
    const sol = await get("SELECT * FROM solicitudes WHERE id=?", [reqId]);
    if (!sol) return res.status(404).json({ error: "Solicitud no encontrada." });
    if (sol.status !== "Pendiente de verificación") {
      return res.status(409).json({ error: "Esta solicitud ya fue procesada." });
    }
    const tickets = JSON.parse(sol.tickets);
    const result = await transaction(async () => {
      const placeholders = tickets.map(() => "?").join(",");
      const states = await all(
        `SELECT number,status FROM boletos WHERE rifaId=? AND number IN (${placeholders})`,
        [sol.rifaId, ...tickets]
      );
      if (states.length !== tickets.length || states.some(x => x.status !== "pending")) {
        throw new Error("Uno o más boletos ya no están pendientes.");
      }
      if (accion === "aprobar") {
        await run("UPDATE solicitudes SET status='Aprobado' WHERE id=?", [reqId]);
        await run(
          `UPDATE boletos SET status='sold' WHERE rifaId=? AND number IN (${placeholders})`,
          [sol.rifaId, ...tickets]
        );
        return "Aprobado";
      }
      if (accion === "rechazar") {
        await run("UPDATE solicitudes SET status='Rechazado', motivoRechazo=? WHERE id=?",
          [String(motivo || "No especificado").slice(0, 500), reqId]);
        await run(
          `UPDATE boletos SET status='available' WHERE rifaId=? AND number IN (${placeholders})`,
          [sol.rifaId, ...tickets]
        );
        return "Rechazado";
      }
      throw new Error("Acción no válida.");
    });

    if (result === "Aprobado") {
      await sendMail({
        to: sol.email,
        subject: `¡Tu compra fue aprobada! ${reqId}`,
        text: `Hola ${sol.name}, tu pago fue verificado. Tus boletos ${tickets.join(", ")} están APROBADOS. ¡Mucha suerte!`
      });
    } else {
      await sendMail({
        to: sol.email,
        subject: `Tu solicitud fue rechazada - ${reqId}`,
        text: `Hola ${sol.name}, tu solicitud fue rechazada. Motivo: ${motivo || "No especificado"}. Los boletos fueron liberados.`
      });
    }
    res.json({ success: true, status: result });
  } catch (e) {
    res.status(400).json({ error: e.message || "No se pudo procesar." });
  }
});

app.get("/api/verificar", async (req, res) => {
  try {
    const q = String(req.query.query || "").trim().toLowerCase();
    if (!q) return res.status(400).json({ error: "Introduce un dato." });
    const rows = await all(
      `SELECT s.id,s.name,s.email,s.phone,s.tickets,s.total,s.status,s.motivoRechazo,s.createdAt,
              r.title AS rifaTitle
       FROM solicitudes s JOIN rifas r ON s.rifaId=r.id
       WHERE lower(s.email)=? OR s.phone=? OR lower(s.id)=?
       ORDER BY s.createdAt DESC`,
      [q, q, q]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: "Error al consultar." });
  }
});

app.use(express.static(PUBLIC_DIR));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes("comprobante")) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Error interno del servidor." });
});

app.listen(PORT, () => {
  console.log(`Rifas Luxury RD: http://localhost:${PORT}`);
  console.log(`SMTP: ${smtpReady ? "configurado" : "NO configurado"}`);
});
