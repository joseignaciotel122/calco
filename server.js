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

/* ---------- correo ---------- */
const smtpReady = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const transporter = smtpReady
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    })
  : nodemailer.createTransport({ streamTransport: true, newline: 'unix', buffer: true });

async function sendCompletedEmail(meta, pdfPath){
  const mail = {
    from: smtpReady ? `"Calco" <${process.env.GMAIL_USER}>` : '"Calco (simulado)" <no-reply@calco.local>',
    to: meta.agentEmail,
    subject: `Formulario completo: ${meta.clientName}`,
    text:
`Hola${meta.agentName ? ' ' + meta.agentName : ''}:

${meta.clientName} terminó de completar la solicitud. Va adjunta en este correo, con las respuestas estampadas en el PDF original de la aseguradora.

Revisala, completá lo que falte y presentala.

Tu panel de seguimiento: ${BASE_URL}/s/${meta.id}/${meta.adminKey}

— Calco`,
    attachments: [{
      filename: `solicitud-${meta.clientName.replace(/[^\wáéíóúñÁÉÍÓÚÑ -]/g,'').replace(/\s+/g,'-')}.pdf`,
      path: pdfPath, contentType: 'application/pdf'
    }]
  };
  const info = await transporter.sendMail(mail);
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
app.use(express.json({ limit: '40mb' }));
app.use(express.raw({ type: 'application/pdf', limit: '40mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

  let emailed = false;
  try {
    const r = await sendCompletedEmail(meta, pdfPath);
    emailed = r.emailed;
  } catch(e){
    console.error('email error:', e.message);
    emailed = false;
  }
  meta.emailed = emailed;
  writeMeta(meta);
  res.json({ ok: true, emailed });
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
  console.log(smtpReady
    ? `Correo: Gmail SMTP como ${process.env.GMAIL_USER}`
    : 'Correo: SIMULADO (configurá GMAIL_USER y GMAIL_APP_PASSWORD en .env para envío real; los .eml quedan en data/outbox/)');
});
