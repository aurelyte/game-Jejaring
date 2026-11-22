# Fase 4a — Spesifikasi Power-up

## 1. Konteks & Evaluasi Kritis Draf Awal

Sistem permainan saat ini menggunakan arsitektur **Host-Authoritative**:
- Host memegang kata rahasia, mengatur giliran round-robin, memvalidasi tebakan (`guess-attempt` -> `guess-result`), dan mengontrol countdown timer 60s per ronde.
- Klien menerima dan merender perubahan state dari event broadcast Supabase Realtime.

### Review Ide Power-up Draf Awal:
1. **Intip Huruf (Reveal Letter):** ✅ Sangat bagus dan langsung diimplementasikan di Fase 4b. Efek instan (non-timing), membantu penebak saat menemui kata sulit, zero risk desync.
2. **Bersihkan Kanvas:** ❌ *Dihapus / Redundant.* Drawer sudah memiliki tombol `Clear` di toolbar yang bebas digunakan kapan saja. Menjadikannya power-up terbatas justru mempersempit fungsi dasar menggambar dan kurang memberikan sensasi power-up.
3. **Bekukan Kuas (Jeda Gambar Drawer):** ❌ *Problematik untuk gameplay.* Jika penggambar di-freeze 5 detik, game mendadak macet total: penebak bengong tanpa visual baru, dan drawer merasa frustrasi. Tempo game terganggu.
4. **Bekukan Lawan (Freeze Rivals / Freeze Guess):** ✅ *Pengganti Jeda Gambar yang Jauh Lebih Asik (Fase 4c).*
   Tebak Gambar pada dasarnya adalah **balapan menebak duluan**. Penebak dapat membekukan input tebakan para rival selama 5 detik, memberi pemicu kesempatan emas untuk menebak lebih dulu tanpa disalip! Timing dikontrol 100% oleh Host.

---

## 2. Spesifikasi Power-up Terpilih (Urutan: Simpel ke Timing)

### 1. Intip Huruf — **Reveal Hint** (Fase 4b: Simpel & Non-Timing)
- **Nama:** Intip Huruf (Reveal Letter 💡)
- **Efek:** Membuka 1 huruf acak yang masih tersamarkan (`_`) pada slot tebakan kata. Huruf yang terbuka disinkronkan ke seluruh penebak di room.
- **Trigger:** Penebak aktif (bukan drawer).
- **Target:** Seluruh penebak di room (slot kata terupdate bersama). Drawer tidak terpengaruh karena sudah tahu kata rahasia.
- **Timing Presisi:** **Tidak.** Efek langsung (instant) dan menetap hingga ronde selesai.
- **Limit/Cooldown:** 1x penggunaan per penebak per ronde. Tombol otomatis disabled setelah digunakan dan di-reset saat ronde baru dimulai (`turn-change`).
- **Alur Otoritas Host:**
  1. Client mengirim broadcast `powerup-request` `{ powerup: 'reveal-letter' }`.
  2. Host memvalidasi: ronde aktif, pengirim bukan drawer, belum mencapai batas ronde, dan masih ada huruf tersisa yang bernilai `_`.
  3. Host memilih 1 indeks `_` acak, menggantinya dengan huruf asli dari `hostState.secretWord`.
  4. Host menyiarkan `powerup-applied` `{ powerup: 'reveal-letter', hint: updatedHint, from: playerId }`.
  5. Seluruh client memperbarui tampilan slot huruf dengan visual animasi highlight.

---

### 2. Bekukan Lawan — **Freeze Rivals** (Fase 4c: Timing & Host Synchronized)
- **Nama:** Bekukan Lawan (Freeze Rivals 🧊)
- **Efek:** Mengunci input tebakan pemain lain (rival) selama 5 detik, memberi keuntungan eksklusif bagi pemakai untuk menebak kata tanpa terburu-buru disalip.
- **Trigger:** Penebak aktif (bukan drawer).
- **Target:** Seluruh penebak lain di room (rival). Pemicu power-up dan drawer tetap bebas beraksi.
- **Timing Presisi:** **Ya.** Sinkronisasi durasi 5 detik dikelola penuh oleh Host untuk mencegah desync.
- **Limit/Cooldown:** 1x penggunaan per penebak per sesi/ronde.
- **Alur Otoritas Host:**
  1. Client mengirim broadcast `powerup-request` `{ powerup: 'freeze-rivals' }`.
  2. Host memvalidasi: ronde aktif, pengirim bukan drawer, belum pernah dipakai di ronde ini, dan tidak ada efek freeze yang sedang berlangsung.
  3. Host mencatat `freezeUntil = Date.now() + 5000` dan `freezeInitiator = playerId`.
  4. Host menyiarkan event mulai: `powerup-applied` `{ powerup: 'freeze-rivals', initiatorId: playerId, duration: 5 }`.
  5. **Validasi Server-Side Host:** Selama jendela 5 detik tersebut, jika Host menerima `guess-attempt` dari pemain selain `initiatorId`, Host menolaknya.
  6. **UI Client:** Penebak rival mendapati form tebakannya di-disable dengan tema es 🧊 (placeholder: "🧊 Dibekukan oleh Peer XXXX (5s)..."), sedangkan pemicu menerima notifikasi kesempatan menebak.
  7. **Event Selesai dari Host:** Setelah 5 detik berlalu di interval Host, Host menyiarkan `powerup-end` `{ powerup: 'freeze-rivals' }`. Client mereset tampilan form kembali normal.
  8. Jika ronde berakhir lebih cepat (tebakan benar atau timeout), efek freeze otomatis dibatalkan di Host dan Client.

---

### 3. (Pelengkap Drawer) Waktu Ekstra — **Extra Time** (Opsional Drawer ⏰)
- **Nama:** Waktu Ekstra (+15s ⏰)
- **Efek:** Menambah 15 detik ke countdown timer ronde (maksimum 60 detik) jika waktu menggambar hampir habis.
- **Trigger:** Drawer aktif (bila sisa waktu <= 30s).
- **Target:** Seluruh pemain di room (timer bertambah serentak).
- **Timing Presisi:** Dikelola oleh timer authoritative Host.
- **Limit:** 1x per giliran menggambar.

---

## 3. Matriks Perbandingan & Protokol Event

| Event Name | Direction | Payload Ringkas | Deskripsi |
| :--- | :--- | :--- | :--- |
| `powerup-request` | Client -> Host | `{ powerup: string, from: string, ts: number }` | Permintaan penggunaan power-up |
| `powerup-applied` | Host -> All | `{ powerup: string, from: string, hint?: object, initiatorId?: string, duration?: number }` | Host mengonfirmasi & menerapkan efek |
| `powerup-end` | Host -> All | `{ powerup: string, from: string }` | Host mengumumkan durasi efek telah selesai |

Dengan arsitektur ini, tidak ada celah bagi client untuk memanipulasi waktu atau mengabaikan status beku secara lokal, karena Host menolak tebakan yang dikirim saat status beku aktif.
