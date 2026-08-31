/* Calco para agentes — servidor.
   Guarda sesiones en disco (data/) y envía el PDF completo por correo al agente.
   Sin credenciales de correo configuradas, el envío se simula: el .eml queda en
   data/outbox/ y el agente descarga el PDF desde su panel. */
'use strict';
require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;
// En Render, RENDER_EXTERNAL_URL viene sola con la URL pública del servicio.
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const DATA = path.join(__dirname, 'data');
const OUTBOX = path.join(DATA, 'outbox');
fs.mkdirSync(OUTBOX, { recursive: true });

const MAX_PDF = 25 * 1024 * 1024;

/* ---------- correo ----------
   Prioridad: Brevo por API HTTPS (funciona en cualquier host, incluso donde
   el SMTP saliente está bloqueado, como el plan free de Render). Si no hay
   BREVO_API_KEY, se intenta Gmail SMTP; sin nada, se simula en data/outbox. */
const brevoReady = !!process.env.BREVO_API_KEY;
const smtpReady = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.GMAIL_USER || 'no-reply@calco.local';

const transporter = smtpReady
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000
    })
  : nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });

function mailBody(meta){
  return `Hola${meta.agentName ? ' ' + meta.agentName : ''}:

${meta.clientName} terminó de completar la solicitud. Va adjunta en este correo, con las respuestas estampadas en el PDF original de la aseguradora.

Revísala, completa lo que falte y preséntala.

Tu panel de seguimiento: ${BASE_URL}/s/${meta.id}/${meta.adminKey}

— CalcoForms`;
}
function attachName(meta){
  return `solicitud-${meta.clientName.replace(/[^\wáéíóúñÁÉÍÓÚÑ -]/g,'').replace(/\s+/g,'-')}.pdf`;
}

async function sendWithBrevo(meta, pdfPath){
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: 'CalcoForms', email: FROM_EMAIL },
      to: [{ email: meta.agentEmail }],
      subject: `Formulario completo: ${meta.clientName}`,
      textContent: mailBody(meta),
      attachment: [{ name: attachName(meta), content: fs.readFileSync(pdfPath).toString('base64') }]
    })
  });
  if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${(await res.text()).slice(0,200)}`);
  return { emailed: true };
}

async function sendCompletedEmail(meta, pdfPath){
  if (brevoReady) return sendWithBrevo(meta, pdfPath);
  const info = await transporter.sendMail({
    from: smtpReady ? `"CalcoForms" <${process.env.GMAIL_USER}>` : '"CalcoForms (simulado)" <no-reply@calco.local>',
    to: meta.agentEmail,
    subject: `Formulario completo: ${meta.clientName}`,
    text: mailBody(meta),
    attachments: [{ filename: attachName(meta), path: pdfPath, contentType: 'application/pdf' }]
  });
  if (!smtpReady){
    fs.writeFileSync(path.join(OUTBOX, `${meta.id}.eml`), info.message);
    return { emailed: false };
  }
  return { emailed: true };
}

/* ---------- sesiones en disco ---------- */
function sessionDir(id){ return path.join(DATA, 'sessions', id); }
function readMeta(id){
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir(id), 'meta.json'), 'utf8')); }
  catch(e){ return null; }
}
function writeMeta(meta){
  fs.writeFileSync(path.join(sessionDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2));
}
const validId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{8,32}$/.test(s);

/* ---------- app ---------- */
const app = express();
app.use(require('compression')());        // gzip: las librerías PDF pasan de ~1.9MB a ~570KB
app.use(express.json({ limit: '40mb' }));
app.use(express.raw({ type: 'application/pdf', limit: '40mb' }));
// vendor no cambia nunca: cache de 1 año; el resto 5 min; los HTML siempre revalidan
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '365d', immutable: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }
}));

// El agente crea una sesión: PDF original + esquema de preguntas + su correo
app.post('/api/sessions', (req, res) => {
  try {
    const { agentEmail, agentName, clientName, schema, pdf } = req.body || {};
    if (!agentEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(agentEmail))
      return res.status(400).json({ error: 'correo del agente inválido' });
    if (!clientName || typeof clientName !== 'string' || clientName.length > 120)
      return res.status(400).json({ error: 'nombre del cliente inválido' });
    if (!schema || !Array.isArray(schema.steps) || !schema.total)
      return res.status(400).json({ error: 'esquema inválido' });
    if (!pdf || typeof pdf !== 'string') return res.status(400).json({ error: 'falta el PDF' });
    const bytes = Buffer.from(pdf, 'base64');
    if (!bytes.length || bytes.length > MAX_PDF) return res.status(400).json({ error: 'PDF vacío o demasiado grande' });
    if (bytes.subarray(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'el archivo no es un PDF' });

    const id = crypto.randomBytes(9).toString('base64url');
    const adminKey = crypto.randomBytes(12).toString('base64url');
    fs.mkdirSync(sessionDir(id), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(id), 'original.pdf'), bytes);
    fs.writeFileSync(path.join(sessionDir(id), 'schema.json'), JSON.stringify(schema));
    const meta = {
      id, adminKey,
      agentEmail: String(agentEmail).slice(0, 200),
      agentName: String(agentName || '').slice(0, 120),
      clientName: String(clientName).slice(0, 120),
      createdAt: new Date().toISOString(),
      completed: false, completedAt: null, emailed: null
    };
    writeMeta(meta);
    res.json({
      id,
      clientUrl: `${BASE_URL}/f/${id}`,
      panelUrl: `${BASE_URL}/s/${id}/${adminKey}`
    });
  } catch(e){
    res.status(500).json({ error: 'no se pudo crear la sesión' });
  }
});

// Datos que necesita el cliente (esquema + nombres; nunca el correo del agente)
app.get('/api/sessions/:id/meta', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'no existe' });
  let schema;
  try { schema = JSON.parse(fs.readFileSync(path.join(sessionDir(meta.id), 'schema.json'), 'utf8')); }
  catch(e){ return res.status(500).json({ error: 'sesión dañada' }); }
  res.json({ clientName: meta.clientName, agentName: meta.agentName, schema });
});

app.get('/api/sessions/:id/pdf', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).end();
  const f = path.join(sessionDir(req.params.id), 'original.pdf');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.type('application/pdf').send(fs.readFileSync(f));
});

// El cliente terminó: guardamos el PDF completo y avisamos al agente
app.post('/api/sessions/:id/complete', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  const meta = readMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: 'no existe' });
  const bytes = req.body;
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PDF)
    return res.status(400).json({ error: 'PDF inválido' });
  if (bytes.subarray(0, 5).toString() !== '%PDF-')
    return res.status(400).json({ error: 'el archivo no es un PDF' });

  const pdfPath = path.join(sessionDir(meta.id), 'completo.pdf');
  fs.writeFileSync(pdfPath, bytes);
  meta.completed = true;
  meta.completedAt = new Date().toISOString();
  meta.emailed = null;
  writeMeta(meta);

  // Respondemos ya: el cliente no tiene por qué esperar al servidor de correo.
  res.json({ ok: true, emailed: null });

  sendCompletedEmail(meta, pdfPath)
    .then(r => { meta.emailed = r.emailed; writeMeta(meta); console.log(`email enviado a ${meta.agentEmail} (${meta.id})`); })
    .catch(e => { meta.emailed = false; writeMeta(meta); console.error('email error:', e.message); });
});

// Panel del agente (protegido por adminKey)
app.get('/api/sessions/:id/status', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  const meta = readMeta(req.params.id);
  if (!meta || req.query.key !== meta.adminKey) return res.status(404).json({ error: 'no existe' });
  res.json({
    clientName: meta.clientName, agentEmail: meta.agentEmail,
    completed: meta.completed, completedAt: meta.completedAt, emailed: meta.emailed
  });
});

app.get('/api/sessions/:id/completed', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).end();
  const meta = readMeta(req.params.id);
  if (!meta || req.query.key !== meta.adminKey) return res.status(404).end();
  const f = path.join(sessionDir(meta.id), 'completo.pdf');
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Content-Disposition', `attachment; filename="solicitud-completa.pdf"`);
  res.type('application/pdf').send(fs.readFileSync(f));
});

/* páginas */
app.get('/f/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'form.html')));
app.get('/s/:id/:key', (req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));

app.listen(PORT, () => {
  console.log(`Calco escuchando en ${BASE_URL}`);
  console.log(brevoReady
    ? `Correo: Brevo API como ${FROM_EMAIL}`
    : smtpReady
      ? `Correo: Gmail SMTP como ${process.env.GMAIL_USER} (ojo: algunos hosts bloquean SMTP saliente)`
      : 'Correo: SIMULADO (configurá BREVO_API_KEY, o GMAIL_USER + GMAIL_APP_PASSWORD; los .eml quedan en data/outbox/)');
});
