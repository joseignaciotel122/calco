/* Calco core — motor de lectura, interpretación y escritura de formularios PDF.
   Corre 100% en el navegador. Requiere pdf-lib y pdf.js (vendor/). */
(function(global){
'use strict';

const CalcoCore = {};

/* ================= APERTURA ================= */

// askPassword(wrong) -> Promise<string|null>; opcional (PDFs con contraseña de apertura)
CalcoCore.open = async function(bytes, askPassword){
  const state = { bytes, engine: null, libDoc: null, jsDoc: null, widgets: {} };
  try {
    const doc = await PDFLib.PDFDocument.load(bytes);
    if (doc.getForm().getFields().length){ state.engine = 'lib'; state.libDoc = doc; return state; }
  } catch(e){ /* encriptado o ilegible: seguimos con pdf.js */ }

  state.engine = 'js';
  let pw = null, tries = 0;
  for(;;){
    try {
      const opts = { data: bytes.slice(0), useSystemFonts: true };
      if (pw) opts.password = pw;
      state.jsDoc = await pdfjsLib.getDocument(opts).promise;
      return state;
    } catch(e){
      const needsPw = e && (e.name === 'PasswordException' || /password/i.test(e.message||''));
      if (!needsPw) throw e;
      if (!askPassword || tries++ > 4) throw new Error('Este PDF pide contraseña de apertura.');
      pw = await askPassword(tries > 1);
      if (pw === null) throw new Error('Necesitamos la contraseña para poder leer el formulario.');
    }
  }
};

/* ================= EXTRACCIÓN ================= */

async function extractWithPdfLib(state){
  const doc = state.libDoc;
  const form = doc.getForm(), ctx = doc.context, d2p = new Map();
  doc.getPages().forEach((p,i) => {
    const an = p.node.Annots(); if (!an) return;
    for (let k=0;k<an.size();k++){ const d = ctx.lookup(an.get(k)); if (d) d2p.set(d,i); }
  });
  const items = [];
  for (const f of form.getFields()){
    // instanceof y no constructor.name: la versión minificada de pdf-lib
    // cambia los nombres de las clases y con .name se descartaba todo.
    let type;
    if (f instanceof PDFLib.PDFRadioGroup) type = 'radio';
    else if (f instanceof PDFLib.PDFCheckBox) type = 'checkbox';
    else if (f instanceof PDFLib.PDFDropdown || f instanceof PDFLib.PDFOptionList) type = 'select';
    else if (f instanceof PDFLib.PDFSignature) type = 'signature';
    else if (f instanceof PDFLib.PDFTextField) type = 'text';
    else continue;
    const ws = f.acroField.getWidgets(); if (!ws.length) continue;
    const r0 = ws[0].getRectangle();
    let options = null;
    try { if (type==='radio'||type==='select') options = f.getOptions(); } catch(e){}
    items.push({
      id: f.getName(), type, page: d2p.get(ws[0].dict) ?? 0,
      x: Math.round(r0.x), y: Math.round(r0.y), w: Math.round(r0.width), h: Math.round(r0.height),
      options,
      spots: ws.map(w => { const r=w.getRectangle(); return { x:Math.round(r.x), y:Math.round(r.y) }; })
    });
  }
  return items;
}

async function extractWithPdfjs(state){
  const doc = state.jsDoc;
  const items = []; state.widgets = {};
  for (let p = 1; p <= doc.numPages; p++){
    const page = await doc.getPage(p);
    const annots = await page.getAnnotations({ intent: 'any' });
    const groups = {};
    for (const a of annots){
      if (a.subtype !== 'Widget' || a.readOnly) continue;
      const name = a.fieldName; if (!name) continue;
      (groups[name] = groups[name] || []).push(a);
      (state.widgets[name] = state.widgets[name] || []).push({
        wid: a.id, page: p-1, buttonValue: a.buttonValue, exportValue: a.exportValue, rect: a.rect,
        chOptions: a.fieldType === 'Ch' && a.options
          ? a.options.map(o => ({ d: o.displayValue, e: o.exportValue })) : null
      });
    }
    for (const name in groups){
      const g = groups[name], a = g[0];
      let type = 'text';
      if (a.radioButton) type = 'radio';
      else if (a.checkBox) type = 'checkbox';
      else if (a.fieldType === 'Ch') type = 'select';
      else if (a.fieldType === 'Sig') type = 'signature';
      else if (a.fieldType !== 'Tx') continue;
      const r = a.rect;
      items.push({
        id: name, type, page: p-1,
        x: Math.round(Math.min(r[0],r[2])), y: Math.round(Math.min(r[1],r[3])),
        w: Math.round(Math.abs(r[2]-r[0])), h: Math.round(Math.abs(r[3]-r[1])),
        options: type==='radio' ? g.map(x=>x.buttonValue)
               : (a.options ? a.options.map(o=>o.displayValue||o.exportValue) : null),
        spots: g.map(x => ({ x: Math.round(Math.min(x.rect[0],x.rect[2])), y: Math.round(Math.min(x.rect[1],x.rect[3])) }))
      });
    }
  }
  return items;
}

CalcoCore.extract = function(state){
  return state.engine === 'lib' ? extractWithPdfLib(state) : extractWithPdfjs(state);
};

CalcoCore.pageCount = function(state){
  return state.engine === 'js' ? state.jsDoc.numPages : state.libDoc.getPageCount();
};

CalcoCore.extractTexts = async function(state){
  const doc = state.engine === 'js' ? state.jsDoc
    : await pdfjsLib.getDocument({ data: state.bytes.slice(0) }).promise;
  const texts = [];
  for (let p = 1; p <= doc.numPages; p++){
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const arr = [];
    for (const it of tc.items){
      const s = (it.str||'').trim(); if (!s) continue;
      arr.push({ s, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) });
    }
    texts.push(arr);
  }
  return texts;
};

/* ================= INTERPRETACIÓN (heurística local) ================= */

// Marcas de "esto no lo llena el cliente": encabezados tipo
// "PARA SER COMPLETADO POR EL AGENTE", "USO EXCLUSIVO/INTERNO", "OFFICE USE ONLY".
const INTERNAL_RE = /para\s+ser\s+(llenado|completado)\s+por|uso\s+(exclusivo|interno)|for\s+(office|internal|company)\s+use|office\s+use\s+only|s[oó]lo\s+para\s+uso|uso\s+de\s+la\s+(compa[ñn][ií]a|aseguradora|oficina)|no\s+(llenar|completar|escribir)\b/i;
const INTERNAL_LABEL_RE = /\bdel\s+agente\b|\bdel\s+corredor\b|\bbroker\b|c[oó]digo\s+del?\s+agente|firma\s+del\s+agente/i;

CalcoCore.internalMarkers = function(texts){
  return texts.map(page =>
    (page||[]).filter(t => INTERNAL_RE.test(t.s)).map(t => t.y)
  );
};

CalcoCore.buildQuestions = function(items, texts){
  // y en baldes de 4px: campos de una misma fila suelen bailar 1-2px y
  // el orden de lectura (y el agrupado de casillas vecinas) se rompía.
  items.sort((a,b) => a.page-b.page || Math.round(b.y/4)-Math.round(a.y/4) || a.x-b.x);
  const fillable = items.filter(i => i.type !== 'signature');

  const groups = [];
  for (const f of fillable){
    const g = groups[groups.length-1];
    const prev = g && g.fields[g.fields.length-1];
    if (g && prev && f.type==='text' && prev.type==='text' &&
        f.page===prev.page && Math.abs(f.y-prev.y)<=4 && f.w<=32 && prev.w<=32 &&
        (f.x-(prev.x+prev.w))<=20 && (f.x-(prev.x+prev.w))>=-4){
      g.fields.push(f);
    } else {
      groups.push({ fields:[f] });
    }
  }
  const splitGroups = [];
  for (const g of groups){
    if (g.fields.length < 6){ splitGroups.push(g); continue; }
    const gaps = g.fields.slice(1).map((f,i)=> f.x - (g.fields[i].x + g.fields[i].w));
    const sorted = gaps.slice().sort((a,b)=>a-b);
    const med = sorted[Math.floor(sorted.length/2)] || 0;
    let cur=[g.fields[0]];
    for (let i=1;i<g.fields.length;i++){
      if (gaps[i-1] > 11 && gaps[i-1] > 2.5*Math.max(med,1)){ splitGroups.push({fields:cur}); cur=[]; }
      cur.push(g.fields[i]);
    }
    if (cur.length) splitGroups.push({fields:cur});
  }
  const qs = [];
  for (const g of splitGroups){
    if (g.fields.length===1) qs.push({ f:g.fields[0], comb:null });
    else if (g.fields.length>=3) qs.push({ f:g.fields[0], comb:g.fields });
    else { g.fields.forEach(f=>qs.push({ f, comb:null })); }
  }

  // Casillas vecinas en la misma línea (Sexo: [M] [F], unidades [kg] [lbs]…)
  // se agrupan en UNA pregunta de opciones: el cliente elige una, no ve dos casillas sueltas.
  const merged = [];
  for (let i = 0; i < qs.length; i++){
    const cur = qs[i];
    if (cur.comb || cur.f.type !== 'checkbox'){ merged.push(cur); continue; }
    const grp = [cur.f];
    while (i + 1 < qs.length){
      const nf = qs[i+1].f;
      if (qs[i+1].comb || nf.type !== 'checkbox') break;
      const last = grp[grp.length-1];
      if (nf.page !== last.page || Math.abs(nf.y - last.y) > 6 || (nf.x - last.x) > 45 || nf.x <= last.x) break;
      grp.push(nf); i++;
    }
    merged.push(grp.length > 1 ? { f: grp[0], cbGroup: grp } : cur);
  }
  qs.length = 0; qs.push(...merged);

  const T = p => texts[p]||[];
  const isLabelish = s => /[:：]\s*$/.test(s) || /\?\s*$/.test(s) || /^\s*¿/.test(s) || /^\s*\d+\s*[.)]/.test(s);
  function joinLine(frs){ return frs.slice().sort((a,b)=>a.x-b.x).map(t=>t.s).join(' ').replace(/\s+/g,' ').trim(); }

  function bestChunk(frs, x0){
    const fs = frs.slice().sort((a,b)=>a.x-b.x);
    const chunks = [];
    for (const t of fs){
      const prev = chunks[chunks.length-1];
      const starts = /^\s*(\d+|[a-z])\s*[.)]/i.test(t.s) || /^\s*¿/.test(t.s);
      if (!prev || starts || /[:：?]\s*$/.test(prev.txt)) chunks.push({ x:t.x, txt:t.s });
      else prev.txt += ' ' + t.s;
    }
    let best = null;
    for (const c of chunks) if (c.x <= x0+35 && (!best || c.x > best.x)) best = c;
    return best ? best.txt.replace(/\s+/g,' ').trim() : joinLine(frs);
  }

  function labelFor(f, bbox){
    const p = f.page, x0=bbox.x0, x1=bbox.x1, y1=bbox.y1, y0=bbox.y0;
    const cands = [];
    const above = T(p).filter(t => t.y > y1-2 && t.y <= y1+40);
    const ys = [...new Set(above.map(t=>t.y))].sort((a,b)=>a-b);
    for (const yy of ys){
      const frs = above.filter(t=>Math.abs(t.y-yy)<=2 && t.x >= x0-25 && t.x <= x1);
      const s = bestChunk(frs, x0);
      if (s && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(s)) cands.push({ s, pri: isLabelish(s)?0:2, d: yy-y1 });
    }
    const left = T(p).filter(t => t.y >= y0-4 && t.y <= y1+6 && t.x < x0 && x0-t.x < 520);
    const sL = bestChunk(left, x0);
    if (sL && isLabelish(sL) && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(sL)) cands.push({ s:sL, pri:1, d:0 });
    if (!cands.some(c=>c.pri<=1)){
      for (const yy of ys){
        const frs = above.filter(t=>Math.abs(t.y-yy)<=2 && t.x >= x0-360 && t.x <= x1+30);
        const s = bestChunk(frs, x0);
        if (s && isLabelish(s) && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(s)) cands.push({ s, pri:0.5, d: yy-y1 });
      }
    }
    if (!cands.length && f.type==='checkbox'){
      const l2 = T(p).filter(t => t.y >= y0-5 && t.y <= y1+6 && t.x < x0 && x0-t.x < 190);
      const s2 = joinLine(l2);
      if (s2 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(s2)) cands.push({ s:s2, pri:2, d:0 });
      const r2 = T(p).filter(t => t.y >= y0-5 && t.y <= y1+6 && t.x > x1 && t.x-x1 < 190);
      const s3 = joinLine(r2);
      if (s3 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(s3)) cands.push({ s:s3, pri:2.5, d:0 });
    }
    if (!cands.length && (f.type==='radio' || f.type==='select')){
      const l3 = T(p).filter(t => t.y >= y0-3 && t.y <= y1+5 && t.x < x0 && x0-t.x < 560);
      const s4 = bestChunk(l3, x0);
      if (s4 && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{4}/.test(s4)) cands.push({ s:s4, pri:4, d:0 });
    }
    cands.sort((a,b)=>a.pri-b.pri || a.d-b.d);
    if (!cands.length) return null;
    let best = cands[0].s;
    if (/^[a-záéíóúñ]/.test(best)){
      const upY = T(p).filter(t => t.y > y1+8 && t.y <= y1+56);
      const ys2 = [...new Set(upY.map(t=>t.y))].sort((a,b)=>a-b);
      for (const yy of ys2){
        const frs = upY.filter(t=>Math.abs(t.y-yy)<=2 && t.x >= x0-360 && t.x <= x1+30);
        const s = bestChunk(frs, x0);
        if (s && /[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(s) && !s.startsWith(best)){ best = s + ' ' + best; break; }
      }
    }
    return best;
  }

  const ALL_SPOTS = {};
  for (const it of fillable){
    (ALL_SPOTS[it.page] = ALL_SPOTS[it.page] || []).push(...(it.spots||[{x:it.x,y:it.y}]));
  }
  function optionLabels(p, spots){
    const sp = spots.slice().sort((a,b)=> (Math.abs(a.y-b.y)<=6 ? a.x-b.x : b.y-a.y));
    const others = ALL_SPOTS[p]||[];
    return sp.map((s) => {
      let next = Infinity;
      for (const o of others)
        if (Math.abs(o.y-s.y)<=8 && o.x > s.x+4 && o.x < next) next = o.x;
      const frs = T(p).filter(t => t.y >= s.y-5 && t.y <= s.y+14 && t.x > s.x+6 &&
                                   t.x < Math.min(s.x+200, next-4));
      return joinLine(frs) || null;
    });
  }

  const clean = s => s ? s.replace(/^\s*\d+\s*[.)-]?\s*/,'').replace(/[:：]\s*$/,'').trim() : s;

  // Rótulo pegado a la DERECHA de una casilla, cortado donde empieza el
  // próximo widget de la línea (así "Cédula  [ ] Pasaporte" no se mezcla).
  function rightLabel(f){
    const others = ALL_SPOTS[f.page] || [];
    let next = Infinity;
    for (const o of others)
      if (Math.abs(o.y - f.y) <= 8 && o.x > f.x + 4 && o.x < next) next = o.x;
    const frs = T(f.page).filter(t => t.y >= f.y - 5 && t.y <= f.y + f.h + 6 &&
                                      t.x > f.x + f.w - 2 && t.x < Math.min(f.x + f.w + 170, next - 4));
    const s = joinLine(frs);
    return (s && /[a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]/.test(s)) ? s : null;
  }

  const markers = CalcoCore.internalMarkers(texts);
  const out = [];
  for (const {f, comb, cbGroup} of qs){
    if (cbGroup){
      const bbox = {
        x0: Math.min(...cbGroup.map(z=>z.x)), x1: Math.max(...cbGroup.map(z=>z.x+z.w)),
        y0: Math.min(...cbGroup.map(z=>z.y)), y1: Math.max(...cbGroup.map(z=>z.y+z.h))
      };
      const options = cbGroup.map((z,i) => clean(rightLabel(z)) || ('Opción ' + (i+1)));
      let gl = clean(labelFor(f, bbox));
      // si el rótulo de arriba es una de las opciones, una máscara de fecha o basura,
      // usamos las opciones como título
      const basura = !gl || gl.length < 3 || options.some(o => gl === o)
                     || /^[\sDMAY/.\-*]+$/i.test(gl) || !/[a-zA-ZáéíóúñÁÉÍÓÚÑ]{2}/.test(gl)
                     || /\b(D\s?D|M\s?M|A\s?A(\s?A\s?A)?)\b/.test(gl);
      if (basura) gl = options.join(' / ');
      out.push({ label: gl, type:'choice', fields: cbGroup.map(z=>z.id), options,
                 page: f.page,
                 internal: (markers[f.page]||[]).some(my => my > bbox.y1 - 2) || INTERNAL_LABEL_RE.test(gl) });
      continue;
    }
    const flds = comb || [f];
    const bbox = {
      x0: Math.min(...flds.map(z=>z.x)), x1: Math.max(...flds.map(z=>z.x+z.w)),
      y0: Math.min(...flds.map(z=>z.y)), y1: Math.max(...flds.map(z=>z.y+z.h))
    };
    let label = clean(labelFor(f, bbox));
    if (f.type==='radio'){
      const opts = optionLabels(f.page, f.spots||[]);
      const ok = opts.every(Boolean) && opts.length===(f.spots||[]).length;
      const options = ok ? opts.map(clean)
        : (f.options||[]).map(o=>String(o??'')).filter(Boolean);
      out.push({ label: label || clean(String(f.id)), type:'choice', fields:[f.id],
                 options: options.length?options:['Sí','No'] });
    } else if (f.type==='checkbox'){
      const rl = clean(rightLabel(f));
      out.push({ label: rl || label || clean(String(f.id)) || 'Casilla', type:'choice', fields:[f.id], options:['Marcar'] });
    } else if (f.type==='select'){
      out.push({ label: label || clean(String(f.id)), type:'choice', fields:[f.id],
                 options:(f.options||[]).map(o=>String(o??'')).filter(Boolean) });
    } else if (comb){
      // solo fragmentos que son máscara pura (MM, DD, AAAA, A A…): así "Edad"
      // u otros rótulos dentro del área no contaminan el orden de la fecha
      const maskToks = T(f.page)
        .filter(t => t.x>=bbox.x0-8 && t.x<=bbox.x1+8 && t.y>=bbox.y0-4 && t.y<=bbox.y1+8
                     && /^[DMAY\s/]{1,6}$/i.test(t.s) && /[DMAY]/i.test(t.s))
        .sort((a,b)=>a.x-b.x)
        .map(t => t.s.replace(/[^DMAYdmay]/g,'').toUpperCase().replace(/Y/g,'A'))
        .filter(Boolean);
      const maskSeq = maskToks.map(t=>t[0]).join('');
      const pos = ['D','M','A'].map(c => ({ c, i: maskSeq.indexOf(c) })).filter(p => p.i >= 0);
      const hasMask = pos.length === 3;
      const isDate = hasMask || /fecha/i.test(label||'');
      const dateOrder = hasMask ? pos.sort((a,b)=>a.i-b.i).map(p=>p.c).join('') : 'DMA';
      // ¿la máscara reparte un dígito por cajita (M M D D A A A A) o un grupo
      // entero por cajita (DD | MM | AAAA)? Depende de cuántas letras hay por token.
      const letras = maskToks.reduce((a,t)=>a+t.length, 0);
      const dateTokens = (hasMask && letras !== comb.length && maskToks.length <= comb.length)
        ? maskToks.map(t=>t[0]) : undefined;
      out.push({ label: label || 'Dato', type: isDate?'date':'text', fields: comb.map(z=>z.id),
                 dateOrder: isDate ? dateOrder : undefined,
                 dateTokens: isDate ? dateTokens : undefined,
                 dayFirst: isDate ? dateOrder.startsWith('D') : undefined,
                 hint: (!isDate && comb.length>2) ? `Un carácter por casilla (${comb.length} casillas)` : '' });
    } else {
      const lt = f.h>34 || /expli|detall|describ|coment/i.test(label||'');
      // campo simple rotulado como fecha: calendario para el cliente y formato correcto al escribir
      if (!lt && /\bfecha\b/i.test(label||'') && f.w < 260){
        out.push({ label: label || clean(String(f.id)), type: 'date', fields:[f.id],
                   dateFmt: /mes\s*\/\s*d[ií]a|mm\s*\/\s*dd/i.test(label||'') ? 'MDY' : 'DMY' });
      } else {
        out.push({ label: label || clean(String(f.id)), type: lt?'longtext':'text', fields:[f.id] });
      }
    }
    // ¿Este dato está debajo de un encabezado de uso interno, o su rótulo delata que es del agente?
    const q = out[out.length-1];
    if (q){
      q.page = f.page;
      q.internal = (markers[f.page]||[]).some(my => my > bbox.y1 - 2)
                   || INTERNAL_LABEL_RE.test(q.label||'');
    }
  }
  return out;
};

// Rótulo impreso junto a un campo de firma: primero el texto pegado al campo
// (arriba, abajo o apenas a la izquierda); si por ahí no aparece la palabra
// "firma", se prueba con una ventana más ancha.
function sigLabelFor(texts, s){
  const T = texts[s.page] || [];
  const x0 = s.x, x1 = s.x + s.w, yTop = s.y + s.h, yBot = s.y;
  function scan(leftPad){
    const cands = [];
    const ys = [...new Set(T.map(t => t.y))];
    for (const yy of ys){
      if (yy > yTop + 45 || yy < yBot - 28) continue;
      const frs = T.filter(t => Math.abs(t.y - yy) <= 2 && t.x > x0 - leftPad && t.x < x1 + 15)
                   .sort((a,b) => a.x - b.x);
      const txt = frs.map(t => t.s).join(' ').replace(/\s+/g,' ').trim();
      if (!txt || !/[a-zA-ZáéíóúñÁÉÍÓÚÑ]{3}/.test(txt)) continue;
      const dist = Math.min(Math.abs(yy - yTop), Math.abs(yy - yBot));
      cands.push({ txt, dist, firma: /firma/i.test(txt) ? 1 : 0 });
    }
    cands.sort((a,b) => (b.firma - a.firma) || (a.dist - b.dist));
    return cands.length ? cands[0] : null;
  }
  let best = scan(45);
  if (!best || !best.firma){
    const wide = scan(280);
    if (wide && wide.firma) best = wide;
  }
  if (!best) return null;
  let out = best.txt;
  // si en la misma línea sigue otro rótulo ("Firma del titular: 3. Lugar y fecha…"),
  // nos quedamos con lo de antes de los dos puntos
  const cut = out.split(/[:：]/)[0];
  if (/firma/i.test(cut)) out = cut;
  return out.replace(/^\s*\d+\s*[.)-]?\s*/,'').replace(/[:：]\s*$/,'').trim();
}

const SIG_AGENT_RE = /agente|corredor|broker|productor|agencia|representante de ventas/i;
const SIG_CLIENT_RE = /titular|solicitante|asegurad|contratante|c[oó]nyuge|conyuge|cliente|propuest|dependiente|padre|madre|tutor/i;

// Análisis completo para el paso de revisión del agente:
// preguntas + firmas con rótulo impreso y clasificación (cliente / agente / a revisar).
CalcoCore.analyze = function(items, texts){
  const markers = CalcoCore.internalMarkers(texts);
  const questions = CalcoCore.buildQuestions(items, texts);
  const sigs = items.filter(i => i.type === 'signature').map(s => {
    const label = sigLabelFor(texts, s);
    const ref = (label || '') + ' ' + String(s.id);
    const belowMarker = (markers[s.page]||[]).some(my => my > s.y + s.h - 2);
    const kind = (SIG_AGENT_RE.test(ref) || belowMarker) ? 'agent'
               : SIG_CLIENT_RE.test(ref) ? 'client' : 'unknown';
    return {
      id: s.id, page: s.page, label,
      kind,
      internal: kind === 'agent' || INTERNAL_LABEL_RE.test(ref)
    };
  });
  return { questions, sigs };
};

// Arma el esquema final con las preguntas y firmas que el agente aprobó.
CalcoCore.makeSchema = function(questions, sigs){
  const PER = 8, steps = [];
  for (let i=0;i<questions.length;i+=PER)
    steps.push({ title:`Sección ${steps.length+1}`, questions: questions.slice(i,i+PER) });
  if (sigs && sigs.length) steps.push({ title:'Firma', questions:[], signatures:sigs });
  return { steps, total: questions.length };
};

/* ================= ESCRITURA ================= */

const CM={'\u2018':"'",'\u2019':"'",'\u201C':'"','\u201D':'"','\u2013':'-','\u2014':'-','\u2026':'...','\u00A0':' ','\u2022':'-'};
function clean_(v){
  let s = v==null?'':String(v);
  s = s.replace(/[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0\u2022]/g, c=>CM[c]||' ');
  return s.replace(/[^\u0000-\u00FF]/g,'');
}

function qKey(q, n){ return 'q'+n+'_'+(q.fields[0]||'x'); }
CalcoCore.qKey = qKey;

function applyAnswers(schema, answers, write){
  schema.steps.forEach((step,si) => {
    (step.questions||[]).forEach((q,idx) => {
      const val = answers[qKey(q, si*100+idx)];
      if (val===undefined || val==='') return;
      if (q.type==='choice'){
        if (q.fields.length > 1){
          // grupo de casillas (Sexo M/F): se marca la casilla de la opción elegida
          const id = q.fields[Number(val)];
          if (id !== undefined) write.choice(id, 0);
        } else {
          write.choice(q.fields[0], Number(val));
        }
      } else if (q.type==='date' && q.fields.length>1){
        const p = String(val).split('-'); if (p.length<3) return;    // p = [AAAA, MM, DD]
        const part = { A: p[0], M: p[1], D: p[2] };
        if (q.dateTokens){
          // un grupo por cajita: DD | MM | AAAA
          q.fields.forEach((id,i)=>{ const c = q.dateTokens[i]; write.text(id, c ? (part[c]||'') : ''); });
        } else {
          const order = q.dateOrder || (q.dayFirst ? 'DMA' : 'MDA');
          const digits = order.split('').map(c => part[c] || '').join('');
          q.fields.forEach((id,i)=>write.text(id, digits[i]||''));
        }
      } else if (q.type==='date' && q.fields.length===1 && /^\d{4}-\d{2}-\d{2}$/.test(String(val))){
        const [a,m,d] = String(val).split('-');
        write.text(q.fields[0], q.dateFmt === 'MDY' ? `${m}/${d}/${a}` : `${d}/${m}/${a}`);
      } else if (q.fields.length>1){
        const digits = String(val).replace(/\s/g,'');
        q.fields.forEach((id,i)=>write.text(id, digits[i]||''));
      } else {
        write.text(q.fields[0], val);
      }
    });
  });
}

async function generateWithPdfLib(state, schema, answers, sigs, flags){
  const { PDFDocument, StandardFonts, PDFName, PDFBool } = PDFLib;
  const doc = await PDFDocument.load(state.bytes.slice(0));
  const form = doc.getForm();
  const touched = new Set();

  applyAnswers(schema, answers, {
    text: (id,v) => { try{
      const tf = form.getTextField(id);
      const s = clean_(v);
      tf.setText(s); touched.add(id);
      // respuesta larga en casillero chico: achicamos la letra para que no se corte
      try {
        const r = tf.acroField.getWidgets()[0].getRectangle();
        const cabe = Math.max(4, Math.floor(r.width / 5.5));
        if (s.length > cabe) tf.setFontSize(Math.min(9, Math.max(5, Math.floor((r.width * 1.7) / s.length))));
      } catch(e){}
    }catch(e){} },
    choice: (id,i) => {
      try{
        const rg = form.getRadioGroup(id), o = rg.getOptions();
        if (i>=0 && i<o.length){ rg.select(o[i]); touched.add(id); }
        return;
      }catch(e){}
      try{
        const dd = form.getDropdown(id), o = dd.getOptions();
        if (i>=0 && i<o.length){ dd.select(o[i]); touched.add(id); }
        return;
      }catch(e){}
      try{
        const cb = form.getCheckBox(id);
        if (i===0){ cb.check(); touched.add(id); }
      }catch(e){}
    }
  });

  const ctx = doc.context, d2p = new Map();
  doc.getPages().forEach((p,i)=>{ const an=p.node.Annots(); if(!an)return;
    for(let k=0;k<an.size();k++){const dd=ctx.lookup(an.get(k)); if(dd) d2p.set(dd,i);} });
  for (const f of form.getFields()){
    const url = sigs[f.getName()]; if (!url) continue;
    const w = f.acroField.getWidgets()[0]; if (!w) continue;
    const png = await doc.embedPng(url), r = w.getRectangle();
    const pg = doc.getPage(d2p.get(w.dict) ?? 0), dim = png.scale(1);
    const k = Math.min(r.width/dim.width, r.height/dim.height);
    pg.drawImage(png, { x:r.x+(r.width-dim.width*k)/2, y:r.y+(r.height-dim.height*k)/2,
                        width:dim.width*k, height:dim.height*k });
  }

  try { form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True); } catch(e){}
  let font=null; try{ font = await doc.embedFont(StandardFonts.Helvetica); }catch(e){}
  touched.forEach(id=>{ try{ const f=form.getField(id);
    if(f&&f.defaultUpdateAppearances) f.defaultUpdateAppearances(font); }catch(e){} });

  return await doc.save({ updateFieldAppearances:false });
}

async function generateWithPdfjs(state, schema, answers, sigs, flags){
  const store = state.jsDoc.annotationStorage;
  const WIDGETS = state.widgets;

  applyAnswers(schema, answers, {
    text: (name,v) => {
      const w = (WIDGETS[name]||[])[0]; if (!w) return;
      store.setValue(w.wid, { value: clean_(v) });
    },
    choice: (name,i) => {
      const ws = WIDGETS[name]||[]; if (!ws.length) return;
      if (ws[0].chOptions){
        const o = ws[0].chOptions[i]; if (!o) return;
        store.setValue(ws[0].wid, { value: o.e ?? o.d });
        return;
      }
      const w = ws[i]; if (!w) return;
      if (w.buttonValue !== undefined && w.buttonValue !== null) store.setValue(w.wid, { value: w.buttonValue });
      else store.setValue(w.wid, { value: true });
    }
  });

  // Las firmas viajan como anotaciones "stamp". OJO: pdf.js solo serializa
  // anotaciones nuevas si la clave empieza con su prefijo interno de editor.
  const stampIds = [];
  for (const name in sigs){
    const w = (WIDGETS[name]||[])[0]; if (!w) continue;
    try {
      const blob = await (await fetch(sigs[name])).blob();
      const bitmap = await createImageBitmap(blob);
      const id = 'pdfjs_internal_editor_' + (9000 + stampIds.length);
      const r = w.rect;
      const x0 = Math.min(r[0],r[2]), y0 = Math.min(r[1],r[3]);
      const x1 = Math.max(r[0],r[2]), y1 = Math.max(r[1],r[3]);
      // mantener la proporción de la firma dentro del casillero
      const bw = x1-x0, bh = y1-y0;
      const k = Math.min(bw/bitmap.width, bh/bitmap.height);
      const sw = bitmap.width*k, sh = bitmap.height*k;
      const cx = (x0+x1)/2, cy = (y0+y1)/2;
      store.setValue(id, {
        annotationType: 13, bitmap, bitmapId: 'calco_sig_' + stampIds.length, pageIndex: w.page,
        rect: [cx-sw/2, cy-sh/2, cx+sw/2, cy+sh/2],
        rotation: 0, isSvg: false, structTreeParentId: null
      });
      stampIds.push(id);
    } catch(e){ flags.sigWarning = true; }
  }

  try {
    return await state.jsDoc.saveDocument();
  } catch(e){
    stampIds.forEach(id => { try { store.remove(id); } catch(_){} });
    flags.sigWarning = true;
    return await state.jsDoc.saveDocument();
  }
}

// Devuelve { bytes, sigWarning }
CalcoCore.fill = async function(state, schema, answers, sigs){
  const flags = { sigWarning: false };
  const bytes = state.engine === 'lib'
    ? await generateWithPdfLib(state, schema, answers, sigs||{}, flags)
    : await generateWithPdfjs(state, schema, answers, sigs||{}, flags);
  return { bytes, sigWarning: flags.sigWarning };
};

global.CalcoCore = CalcoCore;
})(typeof window !== 'undefined' ? window : globalThis);
