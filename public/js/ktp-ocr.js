/* Modul bersama: kamera + OCR KTP berbasis KOTAK POSISI TETAP.
   Dipakai oleh scan.html (petugas) dan self-scan.html (peserta mandiri).

   Berbeda dari pendekatan "baca semua teks lalu tebak urutan baris" (rapuh --
   kalau satu baris gagal terbaca, semua baris di bawahnya ikut kacau), di sini
   setiap field di-crop dari area kartu yang SUDAH DIPOSISIKAN peserta/petugas
   di dalam kotak panduan di layar, lalu di-OCR TERPISAH per kotak. Jauh lebih
   tahan terhadap kegagalan baca sebagian kartu.

   Semua proses (kamera, crop, OCR) berjalan 100% di browser (client-side) --
   tidak ada gambar/foto KTP yang dikirim ke server, hanya hasil teks akhir.

   Posisi kotak (fraksi 0-1 relatif terhadap kotak panduan KTP di layar)
   dikalibrasi dari analisis piksel contoh KTP asli. */

const KTP_ASPECT = 1.586; // rasio standar kartu ID (ID-1): 85.6mm x 53.98mm

const FIELD_BOXES = {
  nik:      { x: 0.03, y: 0.150, w: 0.65, h: 0.090, label: 'NIK' },
  nama:     { x: 0.03, y: 0.245, w: 0.65, h: 0.058, label: 'Nama' },
  alamat:   { x: 0.03, y: 0.398, w: 0.65, h: 0.048, label: 'Alamat' },
  rtKelKec: { x: 0.03, y: 0.446, w: 0.65, h: 0.1395, label: 'RT/RW, Kel/Desa, Kecamatan' },
  agmStKer: { x: 0.03, y: 0.5855, w: 0.65, h: 0.1425, label: 'Agama, Status, Pekerjaan' },
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

/* Hitung kotak panduan berbentuk KTP (rasio ID-1) yang dipusatkan di dalam
   frame kamera, seberapa pun rasio aspek kamera itu sendiri. */
function computeGuideRect(videoWidth, videoHeight, widthFrac) {
  widthFrac = widthFrac || 0.92;
  const containerAspect = videoWidth / videoHeight;
  const w = widthFrac;
  const h = w * (containerAspect / KTP_ASPECT);
  const x = (1 - w) / 2;
  const y = (1 - h) / 2;
  return { x, y, w, h };
}

/* Render kotak panduan + kotak-kotak field ke dalam elemen overlay (div
   position:relative yang menutupi video). Dipanggil sekali setelah kamera
   siap (videoWidth/videoHeight sudah diketahui). */
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

/* Ubah status visual kotak panduan (mis. hijau saat NIK sudah terkunci). */
function setGuideState(overlayEl, state) {
  const guideDiv = overlayEl.querySelector('.ktp-guide');
  if (guideDiv) guideDiv.className = 'ktp-guide ' + (state || '');
}

/* ---------- CROP & OCR PER-FIELD ---------- */

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

/* Crop area kecil dari video lalu perbesar (upscale) -- teks kecil jauh lebih
   mudah dibaca OCR setelah diperbesar & kontrasnya dinaikkan. */
function cropRegionCanvas(videoEl, rectPx, scale) {
  scale = scale || 3;
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

function valueAfterColon(line) {
  if (!line) return '';
  const idx = line.lastIndexOf(':');
  return (idx !== -1 ? line.slice(idx + 1) : line).trim();
}

function extractSingleValue(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  return lines.length ? valueAfterColon(lines[0]) : '';
}

function extractMultiValues(text, count) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out = [];
  for (let i = 0; i < count; i++) out.push(valueAfterColon(lines[i] || ''));
  return out;
}

/* Fase 1 (cepat): hanya crop & baca kotak NIK. Dipakai berulang-ulang saat
   peserta masih memposisikan KTP -- jauh lebih ringan daripada membaca semua
   kotak tiap siklus. */
async function scanNikOnly(worker, videoEl, guideRect) {
  const text = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.nik);
  return extractNik(text);
}

/* Fase 2: setelah NIK terkunci (stabil), baru baca kotak-kotak lainnya. */
async function scanOtherFields(worker, videoEl, guideRect) {
  const namaText = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.nama);
  const alamatText = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.alamat);
  const rtKelKecText = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.rtKelKec);
  const agmText = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.agmStKer);

  const nama = extractSingleValue(namaText);
  const alamat = extractSingleValue(alamatText);
  const [rtrwLine, kelurahan, kecamatan] = extractMultiValues(rtKelKecText, 3);
  const [agama, status_kawin, pekerjaan] = extractMultiValues(agmText, 3);

  let rt = '', rw = '';
  const m = (rtrwLine || '').match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (m) { rt = m[1]; rw = m[2]; }

  return {
    nama: nama.toUpperCase(),
    alamat: alamat.toUpperCase(),
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
