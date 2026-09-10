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

/* ---------- PARSING ---------- */

function findLabelValue(lines, labelPattern, stopPattern) {
  const idx = lines.findIndex((l) => labelPattern.test(l));
  if (idx === -1) return '';
  let val = lines[idx].replace(labelPattern, '').replace(/^[:\-\s]+/, '').trim();
  if (!val && lines[idx + 1] && !(stopPattern && stopPattern.test(lines[idx + 1]))) {
    val = lines[idx + 1].trim();
  }
  return val;
}

/* Heuristik parsing teks hasil OCR KTP Indonesia. OCR dari kamera tidak
   pernah 100% akurat -- karena itu proses simpan-otomatis di scan.html/
   self-scan.html mensyaratkan hasil baca stabil (sama persis) 2x berturut-turut
   sebelum benar-benar disimpan, dan data tetap bisa dikoreksi lewat halaman admin. */
function parseKTP(rawText) {
  const text = rawText.replace(/\r/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const nextLabel = /^(nama|tempat|jenis kelamin|alamat|rt\s*\/?\s*rw|kel|kecamatan|agama|status|pekerjaan|kewarganegaraan|berlaku)/i;

  // NIK: 16 digit berurutan di seluruh teks
  let nik = '';
  const nikMatch = text.match(/\b\d{15,17}\b/);
  if (nikMatch) {
    nik = nikMatch[0].replace(/\D/g, '').slice(0, 16);
  } else {
    const nikLine = lines.find((l) => /nik/i.test(l));
    if (nikLine) nik = nikLine.replace(/\D/g, '').slice(0, 16);
  }

  const nama = findLabelValue(lines, /^nama\b/i, nextLabel);

  // Alamat: gabungkan baris "Alamat" + baris setelahnya sampai ketemu label lain
  let alamat = '';
  const alamatIdx = lines.findIndex((l) => /^alamat\b/i.test(l));
  if (alamatIdx !== -1) {
    const parts = [];
    const first = lines[alamatIdx].replace(/^alamat\s*[:\-]?\s*/i, '').trim();
    if (first) parts.push(first);
    for (let i = alamatIdx + 1; i < Math.min(alamatIdx + 4, lines.length); i++) {
      if (/^(rt\s*\/?\s*rw|kel|kecamatan|agama|status|pekerjaan|kewarganegaraan|berlaku)/i.test(lines[i])) break;
      parts.push(lines[i]);
    }
    alamat = parts.join(', ').replace(/\s{2,}/g, ' ').trim();
  }

  // RT/RW
  let rt = '', rw = '';
  const rtrwLine = lines.find((l) => /rt\s*\/?\s*rw/i.test(l));
  if (rtrwLine) {
    const m = rtrwLine.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    if (m) { rt = m[1]; rw = m[2]; }
  }

  const kelurahan = findLabelValue(lines, /^kel\s*\/?\s*desa\b/i, nextLabel);
  const kecamatan = findLabelValue(lines, /^kecamatan\b/i, nextLabel);
  const agama = findLabelValue(lines, /^agama\b/i, nextLabel);
  const status_kawin = findLabelValue(lines, /^status\s*perkawinan\b/i, nextLabel);
  const pekerjaan = findLabelValue(lines, /^pekerjaan\b/i, nextLabel);

  return {
    nik: nik || '',
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

/* Data dianggap "layak simpan" kalau minimal NIK 16 digit valid, nama
   dan alamat cukup panjang untuk masuk akal (bukan sekadar 1-2 huruf noise OCR). */
function isPlausible(parsed) {
  return (
    parsed.nik.length === 16 &&
    parsed.nama.replace(/[^A-Z]/g, '').length >= 3 &&
    parsed.alamat.length >= 4
  );
}
