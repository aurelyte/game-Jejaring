# Tebak Gambar

Tebak Gambar adalah aplikasi permainan tebak gambar multipemain (multiplayer) berbasis web yang berjalan secara real-time. Pemain bergantian menggambar kata rahasia di kanvas digital, sementara pemain lain berlomba menebak kata tersebut secepat mungkin untuk mengumpulkan poin tertinggi.

Aplikasi ini dibangun menggunakan arsitektur client-side murni dengan Vanilla JavaScript dan Vite, memanfaatkan Supabase Realtime serta PostgreSQL RPC untuk sinkronisasi state dan data room berkecepatan tinggi tanpa memerlukan server terpisah.

---

## Fitur Utama

### 1. Ruang Tunggu dan Manajemen Room
- **Pembuatan dan Masuk Room**: Pemain dapat membuat room baru dengan kode acak unik (6 karakter) atau bergabung ke room yang telah ada menggunakan kode tersebut.
- **Kapasitas Pemain**: Mendukung hingga maksimal 8 pemain per room.
- **Konfigurasi Ronde**: Host dapat menentukan jumlah ronde permainan (1 hingga 5 ronde) sebelum memulai permainan.
- **Moderasi Host (Kick Pemain)**: Host memiliki hak untuk mengeluarkan pemain yang tidak diinginkan langsung dari daftar tunggu. Pemain yang dikeluarkan akan dialihkan kembali ke lobi dengan notifikasi dan diblokir dari upaya masuk kembali ke room tersebut.
- **Pelacakan Kehadiran (Presence)**: Daftar anggota room dan status online diperbarui secara otomatis menggunakan Supabase Realtime Presence.

### 2. Studio Kanvas dan Menggambar Real-time
- **Kanvas Responsif Terisolasi**: Kanvas mempertahankan rasio aspek 16:9 yang pas dengan ruang tampilan dan terikat di dalam wadah pembatas, mencegah elemen kanvas meluap atau menimpa bilah kata tebakan.
- **Alat Gambar Lengkap**: Dilengkapi dengan palet pilihan warna tinta, pengaturan ukuran kuas (Small, Medium, Large), serta tombol pembersih kanvas instan.
- **Kursor Khusus (Brush Cursor)**: Indikator kursor lingkaran yang mengikuti posisi pointer dan menyesuaikan diameternya secara presisi sesuai ukuran kuas yang aktif.
- **Streaming Stroke Berkecepatan Tinggi**: Data guratan kuas dikelompokkan dalam batch interval ~60ms dengan normalisasi koordinat untuk memastikan sinkronisasi halus dan efisien di layar lawan main.
- **Mode Read-Only Penebak**: Saat giliran pemain lain menggambar, kanvas penebak terkunci secara otomatis dan bilah peralatan menggambar dinonaktifkan.

### 3. Logika Permainan dan Validasi Terpusat (Host-Authoritative)
- **Penggambar Pertama Acak (Fair Random Selection)**: Sistem memilih penggambar pertama secara acak dari semua anggota yang aktif, termasuk Host.
- **Sistem Giliran Round-Robin**: Giliran menggambar berpindah secara tertib ke setiap pemain. Satu ronde terhitung selesai setelah seluruh pemain di dalam room telah mendapat giliran menjadi penggambar tepat satu kali.
- **Bank Kata Luas dan Acak Sempurna**: Menyediakan lebih dari 300 kata benda bahasa Indonesia dari berbagai kategori (hewan, tumbuhan, makanan, perkakas, transportasi, profesi, dan alam). Pemilihan kata diatur menggunakan algoritma pengacakan Fisher-Yates shuffle untuk mencegah pengulangan pola kata yang sama.
- **Validasi Tebakan Otomatis**: Host memvalidasi setiap masukan tebakan secara otoritatif, menyamakan huruf tanpa membedakan huruf besar/kecil, serta mengabaikan spasi berlebih.
- **Sensor Kata Rahasia**: Penebak hanya dapat melihat petunjuk berupa jumlah karakter dan slot garis bawah yang merepresentasikan panjang kata.
- **Penghitung Waktu Mundur (Countdown Timer)**: Setiap giliran dibatasi waktu 60 detik. Jika waktu habis sebelum ada yang menebak dengan benar, kata asli diungkapkan dan giliran dialihkan.

### 4. Sistem Skor dan Papan Peringkat (Leaderboard)
- **Bonus Kecepatan (Speed Scaling)**: Skor tebakan dihitung berdasarkan sisa waktu saat tebakan berhasil dikirim (rentang 100 hingga 500 poin). Semakin cepat pemain menebak, semakin besar poin yang diperoleh.
- **Poin Apresiasi Penggambar**: Penggambar mendapatkan poin sebesar 50% dari poin yang diperoleh penebak sebagai imbalan atas kualitas gambar yang mudah ditebak.
- **Papan Peringkat Real-time**: Daftar skor seluruh pemain diperbarui dan diurutkan secara langsung di sisi layar permainan.
- **Hasil Akhir Permainan**: Menampilkan dialog peringkat lengkap saat seluruh ronde yang ditentukan telah selesai atau jika Host meninggalkan permainan.

### 5. Komunikasi Obrolan dan Notifikasi
- Obrolan teks terintegrasi untuk komunikasi antar pemain di dalam room.
- Pesan sistem otomatis untuk mencatat peristiwa penting, seperti pemain bergabung, pemain keluar, pengumuman giliran baru, dan tebakan yang tepat.

### 6. Sistem Power-up
- **Intip Huruf**: Membuka satu huruf acak pada slot kata rahasia (dapat digunakan 1 kali per ronde).
- **Bekukan Lawan**: Mengunci kolom masukan tebakan lawan main selama 5 detik (dapat digunakan 1 kali per ronde).
- **Tambah Waktu**: Menambah waktu menggambar sebesar 15 detik khusus untuk penggambar (dapat digunakan 1 kali per giliran).

### 7. Keandalan Jaringan dan Fail-Safe
- **Penanganan Beban Concurrency**: Dilengkapi mekanisme timeout race pada panggilan RPC database untuk mencegah antrean transaksi menggantung tombol mulai saat banyak pemain masuk bersamaan.
- **Pemeriksaan Keaktifan Drawer**: Memverifikasi penggambar terpilih masih aktif di room; apabila offline, sistem segera memilih cadangan dari pemain yang online.
- **Masa Tenggang Koneksi (Grace Period)**: Penerapan penundaan 5 detik pada verifikasi kehadiran Host untuk mengantisipasi penurunan paket sesaat (transient presence drop) agar permainan tidak terputus tiba-tiba.

---

## Struktur Direktori

```
tebak-gambar/
├── index.html                           # Struktur markup antarmuka pengguna
├── package.json                         # Konfigurasi dependensi dan skrip proyek
├── vite.config.js                       # Konfigurasi build tool Vite
├── src/
│   ├── main.js                          # Pengendali UI, loop permainan, dan logika Host
│   ├── room.js                          # Abstraksi koneksi Supabase Realtime, Presence, dan RPC
│   └── style.css                        # Desain tampilan antarmuka, tata letak grid, dan kanvas
├── tests/
│   ├── multiplayer-flow.test.js         # Uji alur koneksi multipemain dan undian penggambar
│   ├── scoring-leaderboard.test.js      # Uji rumus perhitungan poin dan peringkat
│   └── overload-kick-layout.test.js     # Uji pembatasan ukuran kanvas, siaran kick, dan ketahanan room
└── public/
    └── favicon.svg                      # Ikon aplikasi
```

---

## Kebutuhan Sistem

- **Node.js**: Versi 18.0.0 atau yang lebih baru.
- **NPM**: Versi 9.0.0 atau yang lebih baru.
- **Proyek Supabase**: Memerlukan URL proyek dan Kunci Anonim Supabase yang aktif.

---

## Konfigurasi Lingkungan

Buat file bernama `.env` di dalam direktori `tebak-gambar/` dengan format berikut:

```env
VITE_SUPABASE_URL=https://proyek-anda.supabase.co
VITE_SUPABASE_ANON_KEY=kunci-anon-supabase-anda
```

---

## Panduan Instalasi dan Menjalankan Proyek

### 1. Memasang Dependensi
Jalankan perintah berikut di terminal:

```bash
npm install
```

### 2. Menjalankan Server Pengembangan Lokal
Mulai server pengembangan Vite:

```bash
npm run dev
```

Aplikasi dapat diakses melalui peramban pada alamat `http://localhost:5173`.

### 3. Membangun Berkas Produksi
Untuk mengompilasi seluruh modul ke dalam direktori `dist/`:

```bash
npm run build
```

### 4. Pratinjau Hasil Kompilasi
Untuk menguji hasil kompilasi lokal sebelum disebarkan ke server produksi:

```bash
npm run preview
```

---

## Pengujian Otomatis

Aplikasi dilengkapi dengan rangkaian pengujian unit dan integrasi berbasis Node.js untuk memastikan kestabilan fitur:

```bash
# Uji sinkronisasi ruangan, kehadiran pemain, dan undian giliran
node tests/multiplayer-flow.test.js

# Uji kalkulasi skor berbasis waktu dan pembaruan papan peringkat
node tests/scoring-leaderboard.test.js

# Uji penahanan aspek rasio kanvas, pengacakan kata, dan siaran pengeluaran pemain
node tests/overload-kick-layout.test.js
```

---

## Panduan Penyebaran (Deployment) ke Cloudflare Pages

### Metode 1: Integrasi Git (Direkomendasikan)
1. Unggah kode ke repositori Git (GitHub atau GitLab).
2. Masuk ke Cloudflare Dashboard, pilih menu **Workers & Pages**, lalu klik **Create application** > **Pages** > **Connect to Git**.
3. Pilih repositori proyek ini.
4. Masukkan konfigurasi build berikut:
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - **Root directory**: `tebak-gambar` (atau kosongkan jika repositori berada di root)
5. Masukkan variabel lingkungan pada bagian **Environment variables**:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Klik **Save and Deploy**. Pembaruan berikutnya akan dibangun secara otomatis setiap kali ada commit baru ke branch utama.

### Metode 2: Penyebaran Manual Melalui Wrangler CLI
1. Pasang Wrangler secara global jika belum terpasang:
   ```bash
   npm install -g wrangler
   ```
2. Masuk ke akun Cloudflare:
   ```bash
   wrangler login
   ```
3. Lakukan kompilasi proyek:
   ```bash
   npm run build
   ```
4. Unggah direktori kompilasi ke Cloudflare Pages:
   ```bash
   wrangler pages deploy dist --project-name tebak-gambar
   ```
