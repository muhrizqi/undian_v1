/* Modul bersama: kamera + OCR KTP real-time + parsing lengkap.
   Dipakai oleh scan.html (petugas) dan self-scan.html (peserta mandiri).
   OCR memakai Tesseract.js (CDN) yang berjalan di browser -- tidak ada
   foto/gambar KTP yang dikirim ke server manapun, hanya teks hasil baca.
*/

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

/* Buat SATU worker Tesseract yang dipakai berulang-ulang selama sesi scan
   (bukan dibuat ulang tiap frame) -- jauh lebih cepat, mendekati "real-time". */
async function createOcrWorker() {
  const worker = await Tesseract.createWorker('ind+eng');
  return worker;
}

/* Ambil frame dari video, konversi ke hitam-putih & naikkan kontras
   supaya teks KTP lebih gampang terbaca OCR dibanding foto warna biasa. */
function captureFrame(videoEl, canvasEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  canvasEl.width = w;
  canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.35) brightness(1.08)';
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvasEl;
}

async function recognizeFrame(worker, canvasEl) {
  const { data } = await worker.recognize(canvasEl);
  return data.text || '';
}

/* ---------- PARSING (berbasis POSISI, sesuai struktur baku KTP Indonesia) ----------
   Urutan baku pada KTP: NIK, Nama, Tempat/Tgl Lahir, Jenis Kelamin, Alamat,
   RT/RW, Kel/Desa, Kecamatan, Agama, Status Perkawinan, Pekerjaan,
   Kewarganegaraan, Berlaku Hingga.

   Baris NIK dijadikan JANGKAR (dicari lewat pola 16 digit -- paling stabil
   dibanding mencari label teks "NIK" yang kadang salah OCR), lalu field-field
   lain diambil berdasarkan posisi relatif terhadap baris NIK. Ini lebih cepat
   daripada mencari label satu per satu di seluruh teks. */

function lineValue(line) {
  if (!line) return '';
  const idx = line.indexOf(':');
  return (idx !== -1 ? line.slice(idx + 1) : line).trim();
}

function looksLikeRtRw(line) {
  return /\d{1,3}\s*\/\s*\d{1,3}/.test(line || '');
}

const EMPTY_PARSED = {
  nik: '', nama: '', alamat: '', rt: '', rw: '',
  kelurahan: '', kecamatan: '', agama: '', status_kawin: '', pekerjaan: '',
};

function parseKTP(rawText) {
  const text = rawText.replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // 1) NIK = jangkar. Cari baris berisi 16 digit berurutan.
  const nikIdx = lines.findIndex((l) => /\d{15,17}/.test(l));
  if (nikIdx === -1) return { ...EMPTY_PARSED };
  const nik = lines[nikIdx].match(/\d{15,17}/)[0].replace(/\D/g, '').slice(0, 16);

  // 2) Nama = tepat 1 baris setelah NIK (struktur baku).
  const nama = lineValue(lines[nikIdx + 1]);

  // 3) Alamat: cari label "Alamat" di jendela 2-6 baris setelah NIK
  //    (mengantisipasi Tempat/Tgl Lahir & Jenis Kelamin kadang menyatu/terpisah).
  let alamatIdx = -1;
  for (let i = nikIdx + 2; i <= Math.min(nikIdx + 6, lines.length - 1); i++) {
    if (/^alamat\b/i.test(lines[i])) { alamatIdx = i; break; }
  }
  if (alamatIdx === -1) alamatIdx = nikIdx + 4; // fallback posisi baku

  // 4) Alamat bisa 1-2 baris -- kumpulkan sampai ketemu pola RT/RW.
  const alamatParts = [lineValue(lines[alamatIdx])];
  let rtrwIdx = -1;
  for (let i = alamatIdx + 1; i <= Math.min(alamatIdx + 3, lines.length - 1); i++) {
    if (looksLikeRtRw(lines[i])) { rtrwIdx = i; break; }
    alamatParts.push(lines[i]);
  }
  const alamat = alamatParts.join(', ').replace(/\s{2,}/g, ' ').trim();

  let rt = '', rw = '';
  if (rtrwIdx !== -1) {
    const m = lines[rtrwIdx].match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    if (m) { rt = m[1]; rw = m[2]; }
  } else {
    rtrwIdx = alamatIdx + 1; // fallback posisi
  }

  // 5) Field berikutnya langsung ikut posisi baku setelah RT/RW (tanpa cari label lagi -> cepat).
  const kelurahan = lineValue(lines[rtrwIdx + 1]);
  const kecamatan = lineValue(lines[rtrwIdx + 2]);
  const agama = lineValue(lines[rtrwIdx + 3]);
  const status_kawin = lineValue(lines[rtrwIdx + 4]);
  const pekerjaan = lineValue(lines[rtrwIdx + 5]);

  return {
    nik,
    nama: (nama || '').toUpperCase(),
    alamat: (alamat || '').toUpperCase(),
    rt: (rt || '').toUpperCase(),
    rw: (rw || '').toUpperCase(),
    kelurahan: (kelurahan || '').toUpperCase(),
    kecamatan: (kecamatan || '').toUpperCase(),
    agama: (agama || '').toUpperCase(),
    status_kawin: (status_kawin || '').toUpperCase(),
    pekerjaan: (pekerjaan || '').toUpperCase(),
  };
}

/* Data dianggap "layak" kalau minimal NIK 16 digit valid, nama
   dan alamat cukup panjang untuk masuk akal (bukan sekadar noise OCR). */
function isPlausible(parsed) {
  return (
    parsed.nik.length === 16 &&
    parsed.nama.replace(/[^A-Z]/g, '').length >= 3 &&
    parsed.alamat.length >= 4
  );
}

/* Dianggap "lengkap" kalau data wajib valid DAN sebagian besar field
   tambahan juga sudah tertangkap -- ini yang menentukan kapan proses
   scan berhenti dan kartu konfirmasi muncul. */
function isComplete(parsed) {
  if (!isPlausible(parsed)) return false;
  const extra = [parsed.kelurahan, parsed.kecamatan, parsed.agama, parsed.status_kawin, parsed.pekerjaan];
  const filled = extra.filter((v) => v && v.length >= 2).length;
  return filled >= 3;
}

/* Gabungkan hasil beberapa frame berturut-turut (selama KTP yang sama masih
   di depan kamera): kalau satu field masih kosong di "best" tapi frame baru
   berhasil membacanya, isi. Ini menaikkan peluang mendapat data lengkap
   walau satu frame tunggal tidak selalu menangkap semua field sekaligus. */
function mergeParsed(best, incoming) {
  const merged = { ...best };
  for (const key of Object.keys(EMPTY_PARSED)) {
    if ((!merged[key] || merged[key].length < 2) && incoming[key] && incoming[key].length >= 2) {
      merged[key] = incoming[key];
    }
  }
  return merged;
}
