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
   dari analisis piksel KTP asli -- HANYA kolom nilai, kolom label dikecualikan.
   "dataValues" adalah SATU kotak yang tampil ke pengguna (gampang diposisikan),
   tapi secara internal di-crop & di-OCR sebagai 3 bagian terpisah: Nama saja,
   Alamat saja, lalu RT/RW s.d. Pekerjaan. Alamat sengaja DIPISAH dari Nama
   dan tidak menyentuh baris Jenis Kelamin/Gol.Darah sama sekali -- baris itu
   di lapangan sering terbaca sangat kacau ("LAKHLAKI", "CAKI-CAKI") sehingga
   tidak bisa diandalkan sebagai penanda batas. Dengan memberi Alamat kotak
   sendiri yang sudah dijaga jaraknya dari baris itu, masalah itu hilang sama
   sekali tanpa perlu mendeteksinya. */
const FIELD_BOXES = {
  nik:        { x: 0.223, y: 0.112, w: 0.481, h: 0.112, label: 'NIK' },
  dataValues: { x: 0.275, y: 0.222, w: 0.404, h: 0.565, label: 'Nama s.d. Berlaku Hingga' },
};

// Titik potong (fraksi dari tinggi kotak dataValues) untuk 3 crop internal.
// Dikalibrasi presisi dari posisi baris asli (fraksi LOKAL terhadap tinggi
// dataValues, diukur langsung dari piksel KTP asli): Nama 0.028-0.089,
// Tempat/Tgl Lahir 0.109-0.172, Jenis Kelamin+Gol.Darah 0.189-0.252,
// Alamat 0.270-0.330, RT/RW mulai 0.352. Kotak Alamat sengaja dimulai
// SETELAH ujung baris Jenis Kelamin (0.252) dengan jarak aman -- baris itu
// di lapangan sering terbaca kacau ("LAKHLAKI", "CAKI-CAKI") sehingga tidak
// boleh ikut ter-crop sama sekali, bukan sekadar "diabaikan lewat deteksi".
const NAMA_BOX_H_RATIO = 0.10;      // 0 - 0.10: baris Nama + jarak aman (Nama berakhir di 0.089)
const ALAMAT_BOX_Y_RATIO = 0.26;    // mulai 0.26 (aman setelah Jenis Kelamin berakhir di 0.252)
const ALAMAT_BOX_H_RATIO = 0.09;    // s.d. 0.35 (melewati akhir Alamat di 0.330, sebelum RT/RW di 0.352)
const DATA_BOTTOM_Y_RATIO = 0.34;   // RT/RW (mulai 0.352) s.d. akhir kotak

function getNamaBox() {
  const d = FIELD_BOXES.dataValues;
  return { x: d.x, y: d.y, w: d.w, h: d.h * NAMA_BOX_H_RATIO };
}
function getAlamatBox() {
  const d = FIELD_BOXES.dataValues;
  return { x: d.x, y: d.y + d.h * ALAMAT_BOX_Y_RATIO, w: d.w, h: d.h * ALAMAT_BOX_H_RATIO };
}
function getDataBottomBox() {
  const d = FIELD_BOXES.dataValues;
  return { x: d.x, y: d.y + d.h * DATA_BOTTOM_Y_RATIO, w: d.w, h: d.h * (1 - DATA_BOTTOM_Y_RATIO) };
}

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

/* Threshold hitam-putih otomatis (metode Otsu): menghitung ambang batas yang
   memisahkan piksel gelap (teks) dari terang (latar) berdasarkan histogram
   gambar itu sendiri, lalu memaksa tiap piksel jadi hitam/putih murni. Ini
   menghilangkan pola gelombang pengaman cetak di background KTP yang bisa
   mengecoh OCR, dan membuat tepi huruf jauh lebih tajam. */
function binarizeCanvas(ctx, canvas) {
  const w = canvas.width, h = canvas.height;
  if (w < 1 || h < 1) return;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const v = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    gray[p] = v;
    hist[v]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, varMax = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) { varMax = varBetween; threshold = t; }
  }
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const v = gray[p] > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
}

function cropRegionCanvas(videoEl, rectPx, scale) {
  scale = scale || 3;
  const canvas = document.createElement('canvas');
  canvas.width = rectPx.w * scale;
  canvas.height = rectPx.h * scale;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.3) brightness(1.08)';
  ctx.drawImage(videoEl, rectPx.x, rectPx.y, rectPx.w, rectPx.h, 0, 0, canvas.width, canvas.height);
  binarizeCanvas(ctx, canvas);
  return canvas;
}

// Mode OCR Tesseract, disesuaikan per jenis kotak supaya lebih cepat & akurat
// daripada mode otomatis (yang harus menebak tata letak tiap kali):
//  - 'digits'   NIK: satu baris, HANYA karakter angka diperbolehkan.
//  - 'nameline' Nama: satu baris, kamus Bahasa Indonesia dimatikan (supaya
//                nama orang yang bukan kata baku tidak "dikoreksi paksa"
//                oleh Tesseract jadi kata lain yang mirip).
//  - 'block'    Alamat & kotak data bawah: satu blok kolom teks pendek.
let lastOcrMode = null;
async function setOcrMode(worker, mode) {
  if (lastOcrMode === mode) return;
  if (mode === 'digits') {
    await worker.setParameters({
      tessedit_pageseg_mode: '7',
      tessedit_char_whitelist: '0123456789',
    });
  } else if (mode === 'nameline') {
    await worker.setParameters({
      tessedit_pageseg_mode: '7',
      tessedit_char_whitelist: '',
      load_system_dawg: '0',
      load_freq_dawg: '0',
    });
  } else {
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: '',
      load_system_dawg: '1',
      load_freq_dawg: '1',
    });
  }
  lastOcrMode = mode;
}

async function ocrRegion(worker, videoEl, guideRect, field, mode) {
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const rectPx = fieldRectPx(guideRect, field, vw, vh);
  const canvas = cropRegionCanvas(videoEl, rectPx);
  if (mode) await setOcrMode(worker, mode);
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
const RTRW_RE = /(\d{1,3})\s*\/\s*(\d{1,3})/;
// Baris yang isinya cuma deretan angka sepanjang RT/RW (kadang garis miringnya
// gagal terbaca jadi "047012" tanpa "/") -- dipakai untuk MEMBUANG baris RT/RW
// yang nyasar ke crop Alamat, bukan untuk mengekstrak RT/RW yang sebenarnya.
const RTRW_LOOSE_RE = /^\d{2,3}\D{0,2}\d{2,3}$/;
const WARGA_RE = /^WN[AI]$/i;

function toValueLines(text) {
  return text
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[:.\-\s]+/, '') // buang tanda baca nyasar di awal baris
        .replace(/^[A-Za-z]{1,4}\s*:\s*/, '') // buang sisa ekor label + ":" yang ikut ter-crop (mis. "AN: KAWIN" -> "KAWIN")
        .trim()
    )
    .filter((l) => l.length > 0);
}

/* Cari baris Alamat dari hasil crop kotak Alamat (yang sudah terpisah &
   berjarak aman dari baris Jenis Kelamin/Gol.Darah -- jadi tidak perlu lagi
   mendeteksi baris itu sebagai batas). Alamat bisa 1-2 baris; gabungkan
   semua baris KECUALI yang ternyata deretan angka RT/RW yang nyasar ikut
   ter-crop di ujung bawah. */
function extractAlamat(lines) {
  const clean = lines.filter((l) => !RTRW_LOOSE_RE.test(l.replace(/\s/g, '')));
  return clean.slice(0, 2).join(' ').trim();
}

/* Klasifikasikan kotak RT/RW s.d. Pekerjaan, memakai Agama & RT/RW sebagai
   "jangkar" lalu menurunkan field lain dari posisi relatif terhadap jangkar
   itu -- bukan dari nomor baris mutlak, sehingga tahan kalau ada baris yang
   gagal terbaca. */
function classifyBottomLines(lines) {
  const agamaIdx = lines.findIndex((l) => AGAMA_RE.test(l));
  const searchEndForRtRw = agamaIdx !== -1 ? agamaIdx : lines.length;

  let rtrwIdx = -1;
  for (let i = 0; i < searchEndForRtRw; i++) {
    if (RTRW_RE.test(lines[i]) || RTRW_LOOSE_RE.test(lines[i].replace(/\s/g, ''))) { rtrwIdx = i; break; }
  }

  let rt = '', rw = '';
  if (rtrwIdx !== -1) {
    const raw = lines[rtrwIdx].replace(/\s/g, '');
    const m = raw.match(/(\d{1,3})\D{0,2}(\d{1,3})/);
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
  const status_kawin = statusIdx !== -1 ? (lines[statusIdx].match(STATUS_RE) || [''])[0] : '';

  let pekerjaan = '';
  if (statusIdx !== -1 && lines[statusIdx + 1] && !WARGA_RE.test(lines[statusIdx + 1])) {
    pekerjaan = lines[statusIdx + 1];
  }

  return {
    rt, rw,
    kelurahan: kelurahan.toUpperCase(),
    kecamatan: kecamatan.toUpperCase(),
    agama: agama.toUpperCase(),
    status_kawin: status_kawin.toUpperCase(),
    pekerjaan: pekerjaan.toUpperCase(),
  };
}

/* Fase 1 (cepat): hanya crop & baca kotak NIK, dengan mode "satu baris,
   khusus angka" -- lebih cepat & akurat daripada mode otomatis. Dipakai
   berulang-ulang saat peserta masih memposisikan KTP. */
async function scanNikOnly(worker, videoEl, guideRect) {
  const text = await ocrRegion(worker, videoEl, guideRect, FIELD_BOXES.nik, 'digits');
  return extractNik(text);
}

/* Fase 2: setelah NIK terkunci (stabil), baca 3 kotak: Nama saja, Alamat
   saja, lalu RT/RW s.d. Pekerjaan -- masing-masing dengan mode OCR yang
   paling sesuai isinya. */
async function scanOtherFields(worker, videoEl, guideRect) {
  const namaText = await ocrRegion(worker, videoEl, guideRect, getNamaBox(), 'nameline');
  const alamatText = await ocrRegion(worker, videoEl, guideRect, getAlamatBox(), 'block');
  const bottomText = await ocrRegion(worker, videoEl, guideRect, getDataBottomBox(), 'block');

  const namaLines = toValueLines(namaText);
  const alamatLines = toValueLines(alamatText);
  const bottom = classifyBottomLines(toValueLines(bottomText));

  return {
    nama: (namaLines[0] || '').toUpperCase(),
    alamat: extractAlamat(alamatLines).toUpperCase(),
    ...bottom,
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
