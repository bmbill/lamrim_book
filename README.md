# 廣論與南山律 PDF 閱讀（PWA）

以 [PDF.js](https://mozilla.github.io/pdf.js/) 在瀏覽器內閱讀 PDF，支援單頁／雙頁、左右隱形翻頁區、滑動手勢與鍵盤左右鍵，並依各書規則在「正文頁」與「PDF 頁」之間換算。

## 首頁操作

- **顯示**：標題列右側圖示可切換 **條列**（兩個可展開區塊，預設收合）或 **圖片**（橫幅並排；點圖後進入該類的原文／手抄或開示，可「返回選書」）。選擇會記在瀏覽器 `localStorage`。
- **菩提道次第廣論**：**原文**、**手抄**（南普陀 LR01–LR20）。
- **南山律在家備覽略編**：**原文**、**開示**（1991 十冊；正文頁可留空從頭開啟）。

橫幅圖檔置於 `public/banners/lamrim.png`、`public/banners/nanshan-lay.png`。

## 準備 PDF 檔

請將下列檔案放入 **`public/pdfs/`**（與程式一併部署；檔名需與下列完全一致）：

| 類型 | 檔名 |
|------|------|
| 菩提道次第廣論 | `菩提道次第廣論.pdf` |
| 南普陀手抄 第 1–20 冊 | `南普陀版手抄LR01-2016.pdf` … `南普陀版手抄LR20-2016.pdf` |
| 南山律在家備覽略編 | `南山律在家備覽略編.pdf` |
| 南山 1991 開示 第 1–10 冊 | `Nanshan_Vinaya1991-book01-01A-08B.pdf` … `Nanshan_Vinaya1991-book10-73A-80B.pdf` |

若 PDF 目前在本專案上層目錄，可在專案根目錄執行（PowerShell）：

```powershell
Copy-Item -Path *.pdf -Destination public\pdfs\ -Force
```

## 頁碼對照（程式內已寫死，與需求一致）

- **菩提道次第廣論**：PDF 第 23 頁 = 正文第 1 頁；前置內容請用「PDF 頁」跳轉。
- **南普陀手抄（每冊）**：PDF 第 9 頁 = 該冊正文第 1 頁。
- **南山律在家備覽略編**：PDF 第 17 頁 = 正文第 1 頁；前置請用「PDF 頁」。
- **Nanshan_Vinaya1991 各冊**：PDF 第 6 頁起為正文；**每個 PDF 頁對應兩個正文頁**（如書本對開）。

## 閱讀器縮放

工具列 **縮放** 為 **拉桿**，可在 **100%–300%** 之間連續調整（在「適合視窗」的基礎上再放大）。放大後可於畫面區域 **左右／上下捲動** 瀏覽。

## 本機開發

```bash
npm install
npm run dev
```

## 建置

```bash
npm run build
```

產出於 `dist/`。若網站網址含子路徑（例如 GitHub Project Pages 的 `https://帳號.github.io/倉庫名/`），建置時請設定 **`VITE_BASE`**：

```bash
# Windows PowerShell
$env:VITE_BASE="/你的倉庫名稱/"; npm run build
```

## GitHub Pages（Actions）

1. 將本資料夾作為（或推入）GitHub 倉庫根目錄。
2. 倉庫 **Settings → Pages**：**Build and deployment** 來源選 **GitHub Actions**。
3. 推送至 `main` 或 `master` 分支後，會執行 [`.github/workflows/pages.yml`](.github/workflows/pages.yml)。  
   工作流程會以 `VITE_BASE: /倉庫名稱/` 建置，與 `https://<user>.github.io/<repo>/` 對齊。

若你的程式放在單一倉庫的**子資料夾**，需自行修改該 workflow 的 `working-directory` 與 `VITE_BASE`。

## PWA 圖示

預設使用 `src-assets/app-icon-source.png`（菩提道次第廣論書影）經 **中央裁正方形** 後產生 `public/icons/icon-192.png`、`icon-512.png`。更換圖示時覆寫來源檔後執行：

```bash
npm run icons
```

## PWA

建置後以 **HTTPS** 開啟網站，瀏覽器可將網站「加入主畫面」。Service Worker 會快取靜態資源與曾開啟過的 PDF（利於離線重讀）。

## 授權

專案程式碼由你自行決定授權；PDF 內容之版權仍屬原出版或編印單位。
