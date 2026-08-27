# Calco para agentes de seguro

Convertí la solicitud en PDF de cualquier aseguradora en un formulario web simple.
Le mandás un link a tu cliente y, cuando termina, el PDF original llega completo a tu correo.

## Cómo correrlo

```bash
npm install
cp .env.example .env    # opcional: completá tu Gmail para envío real
npm start
```

Abrí http://localhost:3000

## El flujo

1. **El agente** abre la página, sube la solicitud en PDF (funciona con PDFs protegidos),
   pone el nombre del cliente y su propio correo, y genera dos links:
   uno **para el cliente** y uno **de panel** (privado, para seguimiento y descarga).
2. **El cliente** abre su link y responde el formulario paso a paso desde cualquier
   dispositivo. Nada es obligatorio; puede firmar dibujando en pantalla.
3. Al enviar, el navegador del cliente estampa las respuestas en el PDF original
   y lo sube al servidor, que **se lo manda por correo al agente** y lo deja
   disponible en el panel.

La lectura del PDF, la interpretación de los campos y la escritura de las
respuestas ocurren **en el navegador** (motores pdf-lib y pdf.js, incluidos en
`public/vendor/`). El servidor solo guarda archivos y manda el correo.

## Correo (Gmail)

Con `GMAIL_USER` y `GMAIL_APP_PASSWORD` en `.env`, el correo sale de verdad por
SMTP de Gmail (necesitás una [contraseña de aplicación](https://myaccount.google.com/apppasswords);
la contraseña normal de la cuenta no funciona). Sin credenciales, el envío se
simula: el `.eml` queda en `data/outbox/` y el agente descarga el PDF desde su panel.

## Deploy

Cualquier host de Node sirve (Render, Railway, Fly.io, un VPS):

- Comando: `npm start` · Node 18+
- Variables: `BASE_URL` (tu dominio público), `GMAIL_USER`, `GMAIL_APP_PASSWORD`
- Persistencia: la carpeta `data/` guarda las sesiones — montá un disco persistente
  si el host tiene sistema de archivos efímero.

## Estructura

```
server.js            servidor Express: sesiones, archivos, correo
public/index.html    landing + flujo del agente
public/form.html     formulario del cliente (/f/:id)
public/panel.html    panel del agente (/s/:id/:clave)
public/calco-core.js motor PDF compartido (lectura, interpretación, escritura)
public/vendor/       pdf-lib y pdf.js
data/                sesiones y outbox (se crea sola; no la subas a git)
```

## Limitaciones del prototipo

- Sin cuentas de usuario: el panel se protege con una clave larga en el link.
- Las sesiones no vencen solas; borrá `data/sessions/` cuando quieras limpiar.
- La interpretación de rótulos es heurística: en formularios muy enrevesados
  alguna pregunta puede salir con el nombre técnico del campo. El agente
  siempre revisa el PDF final antes de presentarlo.
