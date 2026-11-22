# Tebak Gambar

Game tebak gambar berbasis web — dibangun dengan **Vite + Vanilla JS**, di-deploy ke **Cloudflare Pages**.

---

## Struktur Folder

```
tebak-gambar/
├── index.html          # Entry HTML
├── src/
│   ├── main.js         # Entry point JavaScript
│   └── style.css       # Stylesheet utama
├── public/
│   └── favicon.svg
└── package.json
```

---

## Development Lokal

```bash
npm install
npm run dev        # dev server: http://localhost:5173
npm run build      # output ke folder dist/
npm run preview    # preview build lokal
```

---

## Deploy ke Cloudflare Pages

### Cara 1 — Connect Git Repo (Direkomendasikan)

1. Push repo ini ke GitHub / GitLab.
2. Buka [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**.
3. Pilih repo `tebak-gambar`.
4. Isi pengaturan build:

   | Setting | Value |
   |---|---|
   | **Framework preset** | Vite |
   | **Build command** | `npm run build` |
   | **Build output directory** | `dist` |
   | **Root directory** | *(kosong / root repo)* |

5. Klik **Save and Deploy**. Cloudflare akan otomatis rebuild setiap push ke branch utama.

### Cara 2 — Deploy Manual via CLI (Wrangler)

```bash
# Install Wrangler (sekali saja)
npm install -g wrangler

# Login ke Cloudflare
wrangler login

# Build dulu
npm run build

# Deploy folder dist ke Pages
wrangler pages deploy dist --project-name tebak-gambar
```

> [!NOTE]
> Pastikan sudah membuat project Pages di dashboard Cloudflare terlebih dahulu sebelum deploy via Wrangler, atau gunakan flag `--project-name` yang belum pernah dipakai agar Wrangler membuatkannya secara otomatis.

---

## Fase Pengembangan

- [x] **Fase 1a** — Setup project + pipeline deploy
- [ ] Fase 1b — Struktur UI dasar
- [ ] Fase 1c — Logika game
