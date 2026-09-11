/* Modul bersama: kamera + OCR KTP berbasis KOLOM-NILAI + POLA ANCHOR.
   Dipakai oleh scan.html (petugas) dan self-scan.html (peserta mandiri).

   Riwayat pendekatan:
   v1: baca semua teks kartu sekaligus, tebak field dari urutan baris -> rapuh.
   v2: kotak SEMPIT per-baris (posisi presisi, termasuk label) -> akurat kalau
       kartu persis pas di kotak, tapi meleset kalau KTP (dipegang tangan)
       sedikit bergeser.
   v3: zona longgar + cari berdasarkan label teks per zona -> lebih toleran,
       tapi label ikut ter-crop jadi masih ada noise & kadang label salah baca.
   v4 (sekarang): crop HANYA KOLOM NILAI (tanpa kolom label sama sekali) --
       satu kotak untuk NIK, satu kotak besar untuk "Nama" s.d. "Berlaku
       Hingga". Karena tidak ada label, field dikenali dari POLA ISINYA
       (anchor): baris RT/RW dikenali dari pola "angka/angka", Agama dari
       daftar kata baku, Status Perkawinan dari kata "KAWIN", dst -- Nama
       dan Alamat lalu diturunkan dari POSISI RELATIF terhadap anchor-anchor
       itu (bukan dari nomor baris mutlak), jadi tetap tahan kalau satu baris
       (misal Tempat/Tgl Lahir) gagal terbaca sama sekali.

   Semua proses (kamera, crop, OCR) berjalan 100% di browser (client-side) --
   tidak ada gambar/foto KTP yang dikirim ke server, hanya hasil teks akhir. */

const KTP_ASPECT = 1.586; // rasio standar kartu ID (ID-1): 85.6mm x 53.98mm

/* Kotak (fraksi 0-1 relatif terhadap kotak panduan KTP di layar), dikalibrasi
   dari analisis piksel KTP asli -- HANYA kolom nilai, kolom label dikecualikan. */
const FIELD_BOXES = {
  nik:        { x: 0.223, y: 0.112, w: 0.481, h: 0.112, label: 'NIK' },
  dataValues: { x: 0.275, y: 0.222, w: 0.404, h: 0.565, label: 'Nama s.d. Berlaku Hingga' },
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

/* ---------- CROP & OCR ---------- */

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

/* ---------- KLASIFIKASI NILAI BERBASIS POLA (ANCHOR) ---------- */

const AGAMA_RE = /\b(ISLAM|KRISTEN|PROTESTAN|KATOLIK|HINDU|BUDDHA|BUDHA|KONGHUCU)\b/i;
const STATUS_RE = /\b(BELUM\s*KAWIN|KAWIN|CERAI\s*HIDUP|CERAI\s*MATI)\b/i;
const JK_RE = /\b(LAKI\s*-?\s*LAKI|PEREMPUAN)\b/i;
const RTRW_RE = /(\d{1,3})\s*\/\s*(\d{1,3})/;
const DATE_RE = /\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{2,4}/;
const WARGA_RE = /^WN[AI]$/i;

function toValueLines(text) {
  return text
    .split('\n')
    .map((l) => l.trim().replace(/^[:.\-\s]+/, '').trim())
    .filter((l) => l.length > 0);
}

/* Cari baris Alamat: 1-2 baris tepat sebelum baris RT/RW (alamat kadang
   membelah 2 baris kalau panjang). Berhenti kalau mundur sampai ketemu baris
   Jenis Kelamin/tanggal lahir, atau sampai baris Nama (index 0) -- tidak
   pernah ikut "memakan" baris Nama. */
function findAlamat(lines, rtrwIdx) {
  if (rtrwIdx <= 0) {
    return lines[3] || lines[2] || lines[1] || '';
  }
  const candidates = [];
  let idx = rtrwIdx - 1;
  while (idx >= 1 && candidates.length < 2) {
    const line = lines[idx];
    if (JK_RE.test(line) || DATE_RE.test(line)) break;
    candidates.unshift(line);
    idx--;
  }
  return candidates.join(' ').trim();
}

/* Klasifikasikan daftar baris (hasil OCR kolom nilai, TANPA label) menjadi
   field-field KTP, memakai baris Agama / RT-RW / Status Perkawinan sebagai
   "jangkar" lalu menurunkan field lain dari posisi relatif terhadap jangkar
   itu -- bukan dari nomor baris mutlak, sehingga tahan kalau ada baris yang
   gagal terbaca (mis. Tempat/Tgl Lahir hilang). */
function classifyValueLines(lines) {
  if (lines.length === 0) return { ...EMPTY_PARSED, nik: undefined };

  const agamaIdx = lines.findIndex((l) => AGAMA_RE.test(l));
  const searchEndForRtRw = agamaIdx !== -1 ? agamaIdx : lines.length;

  let rtrwIdx = -1;
  for (let i = 0; i < searchEndForRtRw; i++) {
    if (RTRW_RE.test(lines[i])) { rtrwIdx = i; break; }
  }

  const nama = lines[0] || '';
  const alamat = findAlamat(lines, rtrwIdx);

  let rt = '', rw = '';
  if (rtrwIdx !== -1) {
    const m = lines[rtrwIdx].match(RTRW_RE);
    if (m) { rt = m[1]; rw = m[2]; }
  }

  let kelurahan = '', kecamatan = '';
  if (rtrwIdx !== -1) {
    const afterRtRw = lines.slice(rtrwIdx + 1, agamaIdx !== -1 ? agamaIdx : rtrwIdx + 3);
    kelurahan = afterRtRw[0] || '';
    kecamatan = afterRtRw[1] || '';
  }

  const agama = agamaIdx !== -1 ? (lines[agamaIdx].match(AGAMA_RE) || [''])[0] : '';

  let statusIdx = -1;
  const statusSearchStart = agamaIdx !== -1 ? agamaIdx + 1 : 0;
  for (let i = statusSearchStart; i < lines.length; i++) {
    if (STATUS_RE.test(lines[i])) { statusIdx = i; break; }
  }
  const status_kawin = statusIdx !== -1 ? lines[statusIdx] : '';

  let pekerjaan = '';
  if (statusIdx !== -1 && lines[statusIdx + 1] && !WARGA_RE.test(lines[statusIdx + 1])) {
    pekerjaan = lines[statusIdx + 1];
  }

  return {
    nama: nama.toUpperCase(),
    alamat: alamat.toUpperCase(),
    rt, rw,
    kelurahan: kelurahan.toUpperCase(),
    kecamatan: kecamatan.toUpperCase(),
    agama: agama.toUpperCase(),
    status_kawin: status_kawin.toUpperCase(),
    pekerjaan: pekerjaan.toUpperCase(),
  };
}

/* Fase 1 (cepat): hanya crop & baca kotak NIK. Dipakai berulang-ulang saat
   peserta masih memposisikan KTP -- jauh lebih ringan daripada membaca kotak
   nilai besar tiap siklus. */
async function scanNikOnly(worker, videoEl, guideRect) {
  const text = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.nik);
  return extractNik(text);
}

/* Fase 2: setelah NIK terkunci (stabil), baru baca kotak nilai besar. */
async function scanOtherFields(worker, videoEl, guideRect) {
  const text = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.dataValues);
  const lines = toValueLines(text);
  return classifyValueLines(lines);
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
