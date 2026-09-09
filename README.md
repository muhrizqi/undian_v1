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

1. Kamera memotret KTP.
2. Teks pada foto dibaca otomatis (OCR) langsung di browser (tidak dikirim ke server luar).
3. Hasil bacaan (NIK, Nama, Alamat) ditampilkan di form yang **bisa diedit** — penting, karena OCR dari foto kamera tidak selalu 100% akurat, apalagi jika KTP buram/silau.
4. Setelah dikonfirmasi dan disimpan:
   - Jika NIK **belum pernah terdaftar** → data disimpan, diberi nomor undian baru (urut 1, 2, 3, ...).
   - Jika NIK **sudah terdaftar** → tidak dibuat data baru, langsung ditampilkan nomor undian yang sudah ada (mencegah satu orang dapat nomor dobel).
5. Nomor undian ditampilkan besar di layar sebagai konfirmasi data tersimpan.

## 4. Saat pengundian

Panitia membuka `/draw.html` di laptop yang disambungkan ke proyektor/layar besar. Setelah kertas gulungan diambil dan nomor undian dibacakan, panitia mengetik nomor tersebut → nama & alamat peserta pemenang langsung tampil besar di layar untuk konfirmasi ke seluruh peserta.

## 5. Data & backup

- Semua data tersimpan di file `data.db` di folder proyek (database SQLite).
- **Backup**: sesekali copy file `data.db` (dan folder `data.db-wal`, `data.db-shm` jika ada) ke tempat lain / flashdisk, terutama sebelum sesi pengundian.
- Unduh rekap CSV kapan saja lewat tombol "Unduh CSV" di halaman `/admin.html`.

## 6. Kapasitas

Dirancang untuk ±1.500 peserta dan puluhan petugas memindai bersamaan. Database SQLite dengan mode WAL yang dipakai cukup untuk beban ini di satu laptop server. Jika nanti dipakai untuk acara jauh lebih besar (puluhan ribu peserta / server terpisah dari beberapa lokasi), sebaiknya migrasi ke PostgreSQL — beri tahu saya jika perlu bantuan.

## 7. Keamanan

- Halaman data peserta (`/admin.html`) dan layar pengundian (`/draw.html`) dilindungi PIN sederhana (`ADMIN_PIN`). Bagikan PIN ini hanya ke panitia inti.
- Halaman scan (`/scan.html`, `/self-scan.html`) sengaja dibuat terbuka (tanpa PIN) agar mudah diakses banyak petugas & peserta sekaligus — karena hanya berjalan di WiFi lokal panitia, risikonya rendah. Jika perlu lebih ketat, bisa ditambah PIN juga.
