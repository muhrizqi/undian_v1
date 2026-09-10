/* Modul bersama: kamera + OCR KTP berbasis ZONA + LABEL SEARCH.
   Dipakai oleh scan.html (petugas) dan self-scan.html (peserta mandiri).

   Riwayat pendekatan:
   v1: baca semua teks kartu sekaligus, tebak field dari urutan baris -> rapuh,
       satu baris gagal baca bikin semua baris di bawahnya ikut kacau.
   v2: kotak SEMPIT per-baris (posisi presisi) -> akurat kalau kartu persis
       pas di kotak, tapi meleset kalau KTP (dipegang tangan) sedikit saja
       bergeser -- makin ke bawah kartu, makin melenceng.
   v3 (sekarang): ZONA LONGGAR (beberapa baris sekaligus + padding besar),
       lalu di dalam tiap zona dicari berdasarkan LABEL teks ("Nama", "Alamat",
       dst), bukan posisi baris persis. Jauh lebih toleran terhadap pergeseran
       posisi KTP di tangan, sekaligus tetap lebih akurat & cepat daripada OCR
       satu kartu penuh karena tiap zona sudah terisolasi (lebih sedikit baris
       yang berpotensi mengacaukan pencarian label).

   Semua proses (kamera, crop, OCR) berjalan 100% di browser (client-side) --
   tidak ada gambar/foto KTP yang dikirim ke server, hanya hasil teks akhir. */

const KTP_ASPECT = 1.586; // rasio standar kartu ID (ID-1): 85.6mm x 53.98mm

/* Zona (fraksi 0-1 relatif terhadap kotak panduan KTP di layar), dikalibrasi
   dari analisis piksel KTP asli lalu diberi padding ekstra supaya toleran
   terhadap KTP yang dipegang tangan (tidak presisi menempel kotak panduan). */
const FIELD_BOXES = {
  nik:      { x: 0.02, y: 0.13, w: 0.70, h: 0.12, label: 'NIK' },
  dataDiri: { x: 0.02, y: 0.22, w: 0.70, h: 0.24, label: 'Nama & Alamat' },
  dataLain: { x: 0.02, y: 0.43, w: 0.70, h: 0.31, label: 'RT/Kel/Kec/Agama/Status/Kerja' },
};

const EMPTY_PARSED = {
  nik: '', nama: '', alamat: '', rt: '', rw: '',
  kelurahan: '', kecamatan: '', agama: '', status_kawin: '', pekerjaan: '',
};

let currentStream = null;

async function startCamera(videoEl, facingMode = 'environment') {
  stopCamera();
  currentStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 960 } },
    audio: false,
  });
  videoEl.srcObject = currentStream;
  await videoEl.play();
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
}

/* Buat SATU worker Tesseract yang dipakai berulang-ulang (bukan dibuat ulang
   tiap crop) -- jauh lebih cepat karena tidak reload data bahasa tiap kali. */
async function createOcrWorker() {
  return await Tesseract.createWorker('ind+eng');
}

/* ---------- GEOMETRI KOTAK PANDUAN ---------- */

function computeGuideRect(videoWidth, videoHeight, widthFrac) {
  widthFrac = widthFrac || 0.92;
  const containerAspect = videoWidth / videoHeight;
  const w = widthFrac;
  const h = w * (containerAspect / KTP_ASPECT);
  const x = (1 - w) / 2;
  const y = (1 - h) / 2;
  return { x, y, w, h };
}

function renderGuideOverlay(overlayEl, guideRect) {
  overlayEl.innerHTML = '';
  const guideDiv = document.createElement('div');
  guideDiv.className = 'ktp-guide';
  guideDiv.style.left = guideRect.x * 100 + '%';
  guideDiv.style.top = guideRect.y * 100 + '%';
  guideDiv.style.width = guideRect.w * 100 + '%';
  guideDiv.style.height = guideRect.h * 100 + '%';

  Object.values(FIELD_BOXES).forEach((f) => {
    const fb = document.createElement('div');
    fb.className = 'field-box';
    fb.style.left = f.x * 100 + '%';
    fb.style.top = f.y * 100 + '%';
    fb.style.width = f.w * 100 + '%';
    fb.style.height = f.h * 100 + '%';
    guideDiv.appendChild(fb);
  });

  overlayEl.appendChild(guideDiv);
}

function setGuideState(overlayEl, state) {
  const guideDiv = overlayEl.querySelector('.ktp-guide');
  if (guideDiv) guideDiv.className = 'ktp-guide ' + (state || '');
}

/* ---------- CROP & OCR PER-ZONA ---------- */

function fieldRectPx(guideRect, field, videoWidth, videoHeight) {
  const xFrac = guideRect.x + field.x * guideRect.w;
  const yFrac = guideRect.y + field.y * guideRect.h;
  const wFrac = field.w * guideRect.w;
  const hFrac = field.h * guideRect.h;
  return {
    x: Math.max(0, Math.round(xFrac * videoWidth)),
    y: Math.max(0, Math.round(yFrac * videoHeight)),
    w: Math.max(1, Math.round(wFrac * videoWidth)),
    h: Math.max(1, Math.round(hFrac * videoHeight)),
  };
}

/* Crop area dari video lalu perbesar (upscale) & naikkan kontras -- teks
   jauh lebih mudah dibaca OCR setelah diperbesar. */
function cropRegionCanvas(videoEl, rectPx, scale) {
  scale = scale || 2.5;
  const canvas = document.createElement('canvas');
  canvas.width = rectPx.w * scale;
  canvas.height = rectPx.h * scale;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.45) brightness(1.12)';
  ctx.drawImage(videoEl, rectPx.x, rectPx.y, rectPx.w, rectPx.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function ocrRegion(worker, videoEl, guideRect, field) {
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const rectPx = fieldRectPx(guideRect, field, vw, vh);
  const canvas = cropRegionCanvas(videoEl, rectPx);
  const { data } = await worker.recognize(canvas);
  return (data.text || '').trim();
}

function extractNik(text) {
  const m = text.match(/\d{15,17}/);
  return m ? m[0].replace(/\D/g, '').slice(0, 16) : '';
}

/* ---------- PENCARIAN BERBASIS LABEL (di dalam satu zona kecil) ---------- */

function toLines(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function valueAfterMarker(line, labelRegex) {
  let val = line.replace(labelRegex, '').replace(/^[:\-\s.]+/, '').trim();
  return val;
}

/* Cari baris yang cocok labelRegex, ambil teks setelah label itu (setelah
   ':' kalau ada). Kalau baris itu ternyata cuma label tanpa isi, coba ambil
   dari baris berikutnya (isi yang terpotong ke bawah). */
function findLabelValue(lines, labelRegex, nextLineExcludeRegex) {
  const idx = lines.findIndex((l) => labelRegex.test(l));
  if (idx === -1) return '';
  let val = valueAfterMarker(lines[idx], labelRegex);
  if (!val && lines[idx + 1] && !(nextLineExcludeRegex && nextLineExcludeRegex.test(lines[idx + 1]))) {
    val = lines[idx + 1].trim();
  }
  return val;
}

const OTHER_LABELS = /^(rt\s*\/?\s*rw|kel\s*\/?\s*desa|kecamatan|agama|status|pekerjaan|kewarganegaraan|berlaku|tempat|jenis)/i;

/* Fase 1 (cepat): hanya crop & baca zona NIK. Dipakai berulang-ulang saat
   peserta masih memposisikan KTP -- jauh lebih ringan daripada membaca semua
   zona tiap siklus. */
async function scanNikOnly(worker, videoEl, guideRect) {
  const text = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.nik);
  return extractNik(text);
}

/* Fase 2: setelah NIK terkunci (stabil), baru baca zona-zona lainnya. */
async function scanOtherFields(worker, videoEl, guideRect) {
  const dataDiriText = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.dataDiri);
  const dataLainText = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.dataLain);

  const ddLines = toLines(dataDiriText);
  const nama = findLabelValue(ddLines, /^nama\b/i, OTHER_LABELS);
  let alamat = findLabelValue(ddLines, /^alamat\b/i, OTHER_LABELS);
  // Alamat kadang membelah ke baris berikutnya (sebelum RT/RW) -- kalau baris
  // setelah "Alamat" bukan label lain, gabungkan sebagai lanjutan alamat.
  const alamatIdx = ddLines.findIndex((l) => /^alamat\b/i.test(l));
  if (alamatIdx !== -1 && ddLines[alamatIdx + 1] && !OTHER_LABELS.test(ddLines[alamatIdx + 1])) {
    const cont = ddLines[alamatIdx + 1].trim();
    if (cont && cont.toUpperCase() !== alamat.toUpperCase()) alamat = (alamat + ' ' + cont).trim();
  }

  const dlLines = toLines(dataLainText);
  const rtrwLine = dlLines.find((l) => /rt\s*\/?\s*rw/i.test(l)) || '';
  const kelurahan = findLabelValue(dlLines, /^kel\s*\/?\s*desa\b/i, OTHER_LABELS);
  const kecamatan = findLabelValue(dlLines, /^kecamatan\b/i, OTHER_LABELS);
  const agama = findLabelValue(dlLines, /^agama\b/i, OTHER_LABELS);
  const status_kawin = findLabelValue(dlLines, /^status\s*perkawinan\b/i, OTHER_LABELS);
  const pekerjaan = findLabelValue(dlLines, /^pekerjaan\b/i, OTHER_LABELS);

  let rt = '', rw = '';
  const m = rtrwLine.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (m) { rt = m[1]; rw = m[2]; }

  return {
    nama: (nama || '').toUpperCase(),
    alamat: (alamat || '').toUpperCase(),
    rt, rw,
    kelurahan: (kelurahan || '').toUpperCase(),
    kecamatan: (kecamatan || '').toUpperCase(),
    agama: (agama || '').toUpperCase(),
    status_kawin: (status_kawin || '').toUpperCase(),
    pekerjaan: (pekerjaan || '').toUpperCase(),
  };
}

/* ---------- VALIDASI ---------- */

function isPlausible(parsed) {
  return (
    parsed.nik.length === 16 &&
    parsed.nama.replace(/[^A-Z]/g, '').length >= 3 &&
    parsed.alamat.length >= 4
  );
}

function isComplete(parsed) {
  if (!isPlausible(parsed)) return false;
  const extra = [parsed.kelurahan, parsed.kecamatan, parsed.agama, parsed.status_kawin, parsed.pekerjaan];
  const filled = extra.filter((v) => v && v.length >= 2).length;
  return filled >= 3;
}

/* Gabungkan hasil beberapa kali baca (selama NIK sama / kartu tidak berubah):
   field yang masih kosong di "best" tapi berhasil terbaca di percobaan baru
   akan diisi -- menaikkan peluang mendapat data lengkap. */
function mergeParsed(best, incoming) {
  const merged = { ...best };
  for (const key of Object.keys(EMPTY_PARSED)) {
    if ((!merged[key] || merged[key].length < 2) && incoming[key] && incoming[key].length >= 2) {
      merged[key] = incoming[key];
    }
  }
  return merged;
}
