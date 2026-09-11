# Aplikasi Undian Umroh — Jalan Sehat Masjid Jogokariyan

Aplikasi web (bukan aplikasi HP terpisah) untuk:
- **`/scan.html`** — petugas memindai KTP peserta (kamera HP Android/iPhone atau laptop), cek duplikat, simpan, tampilkan nomor undian.
- **`/self-scan.html`** — peserta memindai KTP sendiri lewat kamera laptop yang disediakan panitia.
- **`/admin.html`** — tabel peserta (No. Undian, Nama, Alamat) + pencarian. Dilindungi PIN.
- **`/draw.html`** — layar besar untuk sesi pengundian manual: ketik nomor dari gulungan kertas, tampil nama besar. Dilindungi PIN.

Karena berbasis web, **tidak perlu instal aplikasi apa pun** di HP petugas atau laptop peserta — cukup buka alamat web-nya di browser (Chrome/Safari).

---

## 0. Deploy ke server masjid via Coolify (disarankan)

Karena Coolify berjalan di server dengan domain asli, Coolify (lewat Traefik) akan **otomatis mengurus HTTPS/Let's Encrypt** — jadi masalah "kamera butuh HTTPS" di README bagian 1 di bawah **sudah otomatis terselesaikan**, tidak perlu bikin sertifikat sendiri.

**Langkah-langkah:**

1. **Push project ini ke GitHub** (dari komputer Anda, di folder hasil ekstrak zip ini):
   ```bash
   git init
   git add .
   git commit -m "Aplikasi undian umroh Jogokariyan"
   git branch -M main
   git remote add origin https://github.com/muhrizqi/undian_v1.git
   git push -u origin main
   ```

2. **Di Coolify**, buat resource baru:
   - Pilih **Application** → **Public Repository** (atau lewat GitHub App jika repo private), masukkan `https://github.com/muhrizqi/undian_v1.git`, branch `main`.
   - Build Pack: pilih **Dockerfile** (sudah disediakan di project ini, jadi Coolify tinggal build otomatis — tidak perlu Nixpacks).
   - Port aplikasi (Ports Exposes): `3000`.

3. **Tambahkan Environment Variable** di tab Environment Variables:
   - `ADMIN_PIN` = PIN rahasia panitia (untuk buka `/admin.html` dan `/draw.html`), contoh `778899`.
   - (Opsional) `DATA_DIR` sudah default `/app/data` dari Dockerfile, tidak perlu diubah kecuali mau ganti lokasi.

4. **Tambahkan Persistent Storage** (PENTING, supaya data peserta tidak hilang saat redeploy):
   - Tab **Storages** → Add → *Destination Path* isi `/app/data`.
   - Tanpa langkah ini, `data.db` akan ikut terhapus setiap kali Anda redeploy/update aplikasi.

5. **Set domain** di tab Domains, misal `undian.masjidjogokariyan.or.id` — Coolify akan otomatis terbitkan sertifikat HTTPS untuk domain tersebut.

6. **Deploy.** Setelah selesai, alamat yang dibagikan ke petugas/peserta/panitia cukup pakai domain tersebut, contoh:

   | Untuk | Alamat |
   |---|---|
   | Petugas | `https://undian.masjidjogokariyan.or.id/scan.html` |
   | Peserta (kiosk laptop) | `https://undian.masjidjogokariyan.or.id/self-scan.html` |
   | Panitia (data) | `https://undian.masjidjogokariyan.or.id/admin.html` |
   | Layar pengundian | `https://undian.masjidjogokariyan.or.id/draw.html` |

   Karena sudah HTTPS asli, tidak akan ada peringatan "Not secure" di HP/laptop peserta manapun.

7. **Backup rutin**: sebelum sesi pengundian, ambil backup database lewat Coolify (masuk ke container/terminal aplikasi di Coolify, copy file di `/app/data/data.db`), atau paling gampang unduh CSV rekap lewat tombol di `/admin.html`.

> Catatan: bagian 1–2 di bawah ini (HTTPS manual, `USE_HTTPS=1`, dsb) hanya relevan **jika Anda menjalankan di laptop lokal tanpa Coolify/domain** (misalnya sebagai cadangan kalau internet di lokasi acara bermasalah). Kalau sudah pakai Coolify dengan domain, langsung lompat ke bagian 3 (Cara kerja pendaftaran).

---

## 1. Persiapan (sekali saja, sebelum hari-H) — mode lokal tanpa Coolify

Butuh satu **laptop/komputer sebagai server** (dipakai hanya untuk menjalankan aplikasi, terhubung ke WiFi/hotspot yang sama dengan HP petugas & laptop-laptop peserta).

1. Install **Node.js** (versi 18+) di laptop server itu: https://nodejs.org
2. Salin folder proyek ini ke laptop tersebut.
3. Buka terminal di folder proyek, jalankan:
   ```bash
   npm install
   ```

### PENTING — Kamera hanya jalan di HTTPS
Browser (Chrome/Safari) **melarang akses kamera** di halaman `http://` biasa, kecuali di `localhost`. Karena aplikasi ini diakses dari banyak HP/laptop lewat WiFi lokal (bukan localhost), **wajib pakai HTTPS**. Dua pilihan termudah:

**Opsi A — Sertifikat sendiri (tanpa internet, cocok untuk WiFi lokal panitia)**
```bash
mkdir cert
openssl req -x509 -newkey rsa:2048 -nodes -keyout cert/key.pem -out cert/cert.pem -days 3 -subj "/CN=undian-jogokariyan"
```
Lalu jalankan server dengan:
```bash
USE_HTTPS=1 ADMIN_PIN=778899 npm start
```
Di HP/laptop peserta & petugas, saat pertama kali buka alamatnya akan muncul peringatan "Not Secure / Sertifikat tidak dipercaya" — pilih **Lanjutkan/Advanced → Proceed**. Ini aman karena hanya dipakai di jaringan WiFi panitia sendiri.

**Opsi B — Domain + HTTPS asli (kalau server ditaruh di internet/VPS)**
Gunakan reverse proxy (nginx) + Let's Encrypt seperti biasa, lalu jalankan `npm start` di belakangnya (tanpa `USE_HTTPS`, karena HTTPS sudah ditangani nginx).

---

## 2. Menjalankan saat hari-H

```bash
USE_HTTPS=1 ADMIN_PIN=778899 npm start
```
- Ganti `778899` dengan PIN rahasia panitia (untuk buka `/admin.html` dan `/draw.html`).
- Server akan berjalan di `https://<IP-laptop-server>:3000`. Cari IP laptop dengan `ipconfig` (Windows) atau `ifconfig`/`ip a` (Mac/Linux) di jaringan WiFi yang sama.

Bagikan alamat berikut ke masing-masing pihak (ganti `192.168.x.x` dengan IP laptop server):

| Untuk | Alamat |
|---|---|
| Petugas (HP, scan KTP peserta) | `https://192.168.x.x:3000/scan.html` |
| Peserta (laptop kiosk, scan mandiri) | `https://192.168.x.x:3000/self-scan.html` |
| Panitia (lihat tabel data) | `https://192.168.x.x:3000/admin.html` |
| Layar pengundian | `https://192.168.x.x:3000/draw.html` |

Tip: buat kode QR dari masing-masing alamat supaya petugas & peserta tinggal scan QR untuk membuka halamannya di HP.

---

## 3. Cara kerja pendaftaran

1. Petugas/peserta tekan **"Mulai Scan"** sekali di awal — kamera & mesin baca teks disiapkan (±3-5 detik).
2. Di layar muncul **kotak putih berbentuk KTP** dengan kotak-kotak kuning putus-putus menandai posisi NIK, Nama, Alamat, dst. — posisikan kartu fisik supaya pas mengisi kotak putih tersebut (mendatar/landscape).
3. Sistem membaca dalam **2 kotak** — kotak **NIK**, dan satu kotak besar berisi **kolom nilai saja** (tanpa kolom label) dari "Nama" sampai "Berlaku Hingga". Di dalam kotak besar ini, tiap baris dikenali dari **pola isinya**, bukan urutan baris: baris RT/RW dikenali dari pola "angka/angka", Agama dari daftar kata baku (Islam/Kristen/dst), Status Perkawinan dari kata "Kawin" — lalu Nama dan Alamat diturunkan dari posisi relatif terhadap pola-pola itu. Ini membuat pembacaan tetap akurat walau satu baris (misal Tempat/Tgl Lahir) gagal terbaca sama sekali, karena field lain tidak ikut bergeser posisinya.
4. Setelah data cukup lengkap (atau maksimal ~5 detik mencoba melengkapi), **proses berhenti otomatis** dan muncul **kartu konfirmasi** berisi semua data, masih bisa diedit.
5. Tekan **"✓ Konfirmasi & Simpan"**:
   - Jika NIK **belum pernah terdaftar** → data baru disimpan, diberi nomor undian urut berikutnya.
   - Jika NIK **sudah terdaftar** → tidak dibuat data baru, langsung tampil nomor undian yang sudah ada.
6. Nomor undian tampil besar ± 3-4 detik, lalu **otomatis kembali ke mode scan** untuk peserta berikutnya.

Semua proses pemindaian & pembacaan teks berjalan **sepenuhnya di perangkat (browser)** — tidak ada foto/gambar KTP yang dikirim atau disimpan di server, hanya hasil teks akhir (NIK, nama, dst.) yang dikirim saat menekan "Konfirmasi & Simpan".

### Kalau OCR tetap salah baca
- Sebelum menekan "Konfirmasi & Simpan", semua field di kartu konfirmasi **bisa langsung diedit**.
- Kalau baru ketahuan salah setelah tersimpan: tombol **"Batalkan"** di layar hasil (60 detik, tanpa PIN), atau edit lewat `/admin.html` (perlu PIN) kapan saja setelahnya.
- Kalau KTP sulit terbaca berkali-kali (rusak/pudar/pantulan cahaya), ada tombol **"Isi manual"**.
- Posisi kotak sudah dikalibrasi presisi dari 2 contoh KTP asli (Kediri &amp; Yogyakarta) dengan tata letak gelar/alamat yang berbeda, dan diuji tahan terhadap kasus 1-2 baris yang gagal terbaca sama sekali. Kalau di lapangan ternyata masih sering meleset untuk model KTP tertentu, kirim contoh fotonya dan akan dikalibrasi ulang.
- Field **Nama** khususnya bergantung pada baris pertama di dalam kotak besar terbaca dengan benar (karena tidak ada pola khas untuk mengenali "ini baris Nama" selain posisinya paling atas) — jadi pastikan bagian atas KTP (baris Nama) tidak terpotong di luar kotak panduan saat memposisikan kartu.
- Untuk akurasi & kecepatan, sistem memberi tahu Tesseract secara eksplisit bentuk tiap kotak (1 baris untuk NIK, 1 blok kolom teks untuk kotak data) alih-alih menebak tata letak sendiri, dan tiap crop di-threshold hitam-putih otomatis (metode Otsu) untuk menghilangkan pola gelombang pengaman cetak di background KTP yang bisa mengecoh OCR. Kotak data besar juga dibaca sebagai 2 potongan internal (Nama/Alamat, lalu RT-RW s.d. Pekerjaan) — walau tampil sebagai satu kotak saja di layar — supaya lebih sedikit baris per pembacaan.
- Golongan Darah yang ikut terbaca di baris Jenis Kelamin (karena satu baris dengan LAKI-LAKI/PEREMPUAN) otomatis diabaikan — tidak memengaruhi field lain.
- Disarankan **uji coba dulu dengan beberapa KTP asli** sebelum hari-H, terutama posisi mendatar (landscape) & pencahayaan yang cukup.

## 4. Saat pengundian

Panitia membuka `/draw.html` di laptop yang disambungkan ke proyektor/layar besar. Setelah kertas gulungan diambil dan nomor undian dibacakan, panitia mengetik nomor tersebut → nama & alamat peserta pemenang langsung tampil besar di layar untuk konfirmasi ke seluruh peserta.

## 5. Data & backup

- Semua data tersimpan di file `data.db` (SQLite) — di Coolify berada di volume `/app/data` yang Anda mount di langkah 4 pada bagian Coolify di atas.
- **Backup**: sesekali unduh rekap CSV lewat tombol "Unduh CSV" di halaman `/admin.html`, terutama sebelum sesi pengundian.
- Riwayat perubahan data (edit oleh admin) tercatat di kolom `updated_at`, meski tidak ditampilkan di tabel — bisa dicek langsung di `data.db` kalau diperlukan.

## 6. Kapasitas

Dirancang untuk ±1.500 peserta dan puluhan petugas memindai bersamaan. Database SQLite dengan mode WAL yang dipakai cukup untuk beban ini di satu laptop server / satu container Coolify. Jika nanti dipakai untuk acara jauh lebih besar (puluhan ribu peserta / server terpisah dari beberapa lokasi), sebaiknya migrasi ke PostgreSQL — beri tahu saya jika perlu bantuan.

## 7. Keamanan

- Halaman data peserta (`/admin.html`) dan layar pengundian (`/draw.html`) dilindungi PIN sederhana (`ADMIN_PIN`). Bagikan PIN ini hanya ke panitia inti.
- Halaman scan (`/scan.html`, `/self-scan.html`) sengaja dibuat terbuka (tanpa PIN) agar mudah diakses banyak petugas & peserta sekaligus — karena hanya berjalan di WiFi lokal panitia, risikonya rendah. Jika perlu lebih ketat, bisa ditambah PIN juga.
