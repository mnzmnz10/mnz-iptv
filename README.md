# IPTV Xstream

Xtream Codes IPTV player for PC. Electron UI + embedded **mpv** engine.
Canlı TV (EPG), Filmler (VOD), Diziler (sezon/bölüm).

## Nasıl çalışır
- Ağ istekleri (Xtream `player_api.php`) Electron **main process**'te → CORS yok.
- Video: **mpv.exe** frameless bir alt pencereye `--wid` ile gömülür, named-pipe JSON IPC ile kontrol edilir (oynat/duraklat/sar/ses).
- `.ts` canlı stream ve tüm codec'ler mpv sayesinde sorunsuz.

## Kurulum

1. Bağımlılıklar:
   ```bash
   npm install
   ```
2. **mpv** gerekli. İki yol:
   - PATH'e ekli mpv (winget: `winget install mpv` ya da https://mpv.io/installation/), **veya**
   - `mpv.exe` dosyasını proje içindeki `bin/` klasörüne koy.
3. Çalıştır:
   ```bash
   npm start
   ```

## Paketleme (.exe)
```bash
npm run dist
```
`bin/mpv.exe` varsa kurulum paketine gömülür (extraResources).

## Giriş
Sunucu (`http://host:port`), kullanıcı adı, şifre. "Beni hatırla" bilgileri yerelde saklar.

## Otomatik güncelleme (GitHub Releases)
Uygulama, kurulu (.exe) sürümde her açılışta GitHub'daki son sürümü kontrol eder;
yeni sürüm varsa indirir ve "şimdi kur / sonra" diye sorar. (Geliştirme modunda çalışmaz.)

Kurulum (bir kez):
1. GitHub'da `mnz-iptv` adında bir repo aç (public en kolayı).
2. `package.json` içindeki `"owner": "GITHUB_KULLANICI_ADIN"` yerine gerçek GitHub kullanıcı adını yaz.
3. GitHub'da `repo` yetkili bir Personal Access Token oluştur.

Yeni sürüm yayınlama:
1. `package.json` içindeki `version`'ı artır (örn. `1.0.0` → `1.0.1`).
2. Token'ı ortam değişkenine ver ve yayınla:
   ```bash
   set GH_TOKEN=github_token_buraya
   npm run release
   ```
   Bu, `.exe` + `latest.yml` dosyalarını GitHub Releases'e yükler.
3. Kullanıcılardaki uygulama bir sonraki açılışta otomatik günceller.

## Yasal not
Sadece erişim hakkına sahip olduğun içerik/hesap için kullan.
