/* Modul bersama: kamera + OCR KTP + parsing.
   Dipakai oleh scan.html (petugas) dan self-scan.html (peserta mandiri).
   OCR memakai Tesseract.js (dimuat via CDN) yang berjalan di browser
   (HP/laptop), jadi tidak butuh server OCR terpisah.
*/

let currentStream = null;

async function startCamera(videoEl, facingMode = 'environment') {
  stopCamera();
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    videoEl.srcObject = currentStream;
    await videoEl.play();
    return true;
  } catch (err) {
    console.error('Gagal akses kamera:', err);
    throw err;
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
}

function capturePhoto(videoEl, canvasEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  canvasEl.width = w;
  canvasEl.height = h;
  const ctx = canvasEl.getContext('2d');
  ctx.drawImage(videoEl, 0, 0, w, h);
  return canvasEl.toDataURL('image/jpeg', 0.92);
}

/* Jalankan OCR pada gambar (dataURL) dan panggil onProgress(persen, tahap) */
async function runOCR(dataURL, onProgress) {
  const { data } = await Tesseract.recognize(dataURL, 'ind+eng', {
    logger: (m) => {
      if (onProgress) onProgress(m);
    },
  });
  return data.text || '';
}

/* Heuristik parsing teks hasil OCR KTP Indonesia menjadi NIK, Nama, Alamat.
   OCR dari kamera HP tidak pernah 100% akurat -- karena itu hasil ini
   HARUS ditampilkan di form yang bisa diedit sebelum disimpan. */
function parseKTP(rawText) {
  const text = rawText.replace(/\r/g, '');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // --- NIK: cari 16 digit berurutan di seluruh teks ---
  let nik = '';
  const nikMatch = text.match(/\b\d{15,17}\b/);
  if (nikMatch) {
    // Ambil 16 digit pertama jika lebih/kurang sedikit karena salah baca OCR
    nik = nikMatch[0].replace(/\D/g, '').slice(0, 16);
  } else {
    // fallback: cari baris berlabel NIK lalu ambil digitnya
    const nikLine = lines.find((l) => /nik/i.test(l));
    if (nikLine) nik = nikLine.replace(/\D/g, '').slice(0, 16);
  }

  // --- Nama ---
  let nama = '';
  const namaIdx = lines.findIndex((l) => /^nama\b/i.test(l) || /^nama[:\s]/i.test(l));
  if (namaIdx !== -1) {
    nama = lines[namaIdx].replace(/^nama\s*[:\-]?\s*/i, '').trim();
    if (!nama && lines[namaIdx + 1]) nama = lines[namaIdx + 1].trim();
  }

  // --- Alamat: gabungkan baris "Alamat" + 1-3 baris setelahnya
  //     yang sering berisi RT/RW, Kel/Desa, Kecamatan ---
  let alamatParts = [];
  const alamatIdx = lines.findIndex((l) => /^alamat\b/i.test(l));
  if (alamatIdx !== -1) {
    let first = lines[alamatIdx].replace(/^alamat\s*[:\-]?\s*/i, '').trim();
    if (first) alamatParts.push(first);
    for (let i = alamatIdx + 1; i < Math.min(alamatIdx + 5, lines.length); i++) {
      const l = lines[i];
      if (/^(agama|status perkawinan|pekerjaan|kewarganegaraan|berlaku hingga|jenis kelamin|gol\.? darah)/i.test(l)) {
        break;
      }
      alamatParts.push(l.replace(/^(rt\/rw|kel\/desa|kelurahan\/desa|kecamatan)\s*[:\-]?\s*/i, '$& '));
    }
  }
  const alamat = alamatParts.join(', ').replace(/\s{2,}/g, ' ').trim();

  return {
    nik: nik || '',
    nama: (nama || '').toUpperCase(),
    alamat: (alamat || '').toUpperCase(),
  };
}
