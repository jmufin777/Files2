# 🖥️ Samba + 300 GB Setup - Pokyn

## ✅ Ano, je to schůdné!

Ale potřebujete tyto optimalizace pro 300 GB textu s Word/Excel soubory.

---

## 📋 **Schůdnost faktory**

### 1. **Počet souborů**
```
300 GB Excel/Word
Průměr. soubor: 1-5 MB (office files)
→ Cca 60,000 - 300,000 souborů
→ Zvládnete ✅ (měl byste)
```

### 2. **Samba Performance**
```
Samba throughput: 50-150 MB/s (lokální síť)
300 GB data:
  - Při 50 MB/s = 1.6 hodin (initial scan)
  - Při 150 MB/s = 30 minut (good network)

Incremental (jen nové soubory): Rychlejší! ✅
```

### 3. **Indexování čas**
```
300 GB → 300K chunks (1000 char chunks)
Per chunk (embedding): ~200ms
Parallelní (batch 10): ~20ms
─────────────────────────
Celkem: 6,000 minut / 10 = 600 minut = 10 hodin

S caching: 5 hodin ✅
```

### 4. **Storage na disku**
```
PostgreSQL vectorstore (300K chunks):
  - Vectors: 300K × 768 dims × 4 bytes = 900 MB
  - Metadata: +200 MB
  - Index: +200 MB
─────────────────────────
CELKEM: ~1.5 GB 

Zvládnete ✅ (i s 500GB diskem)
```

---

## 🔧 **Setup instruktáž**

### **Krok 1: Připojit Samba na Linux/macOS**

#### **macOS (Finder)**
```bash
# Přidat síťové umístění
# Finder → Go → Connect to Server
# smb://username@192.168.1.100/documents

# Nebo z CLI:
mkdir -p ~/mnt/documents
mount_smbfs //username:password@192.168.1.100/documents ~/mnt/documents
```

#### **Linux (Ubuntu)**
```bash
sudo apt-get install cifs-utils

# Vytvořit mount point
mkdir -p /mnt/samba

# Připojit
sudo mount -t cifs //192.168.1.100/documents /mnt/samba \
  -o username=user,password=pass,uid=1000,gid=1000

# Permanentně (v /etc/fstab)
//192.168.1.100/documents /mnt/samba cifs credentials=/home/user/.smbcredentials,uid=1000,gid=1000 0 0
```

### **Krok 2: Testovat připojení**
```bash
# Ověřit
ls -la /mnt/samba
du -sh /mnt/samba  # Zobrazit velikost

# Měřit speed
time cp /mnt/samba/test.xlsx /tmp/test.xlsx
```

### **Krok 3: API endpoint pro Sambu**

Nový endpoint `/api/samba` (nyní dostupný!) skenuje Samba sdílení:

```typescript
// POST /api/samba
{
  "sambaPath": "/mnt/samba",
  "recursive": true,
  "maxFiles": 1000  // Limit pro první sken
}
```

**Response:**
```json
{
  "success": true,
  "files": [
    {
      "path": "/mnt/samba/docs/report.xlsx",
      "name": "docs/report.xlsx",
      "size": 2048576,
      "type": "file",
      "modified": "2024-01-15T10:30:00Z"
    }
  ],
  "stats": {
    "totalFiles": 45123,
    "totalSize": 321474836480,
    "totalSizeGB": "299.24"
  }
}
```

### **Krok 4: Extrahovat text z Office**

Nový endpoint `/api/extract` parsuje Word/Excel:

```typescript
// POST /api/extract
{
  "filePath": "/mnt/samba/docs/report.xlsx",
  "fileName": "report.xlsx"
}
```

**Podporované typy:**
- `docx`, `doc` - Word
- `xlsx`, `xls` - Excel
- `pdf` - PDF
- `txt`, `md`, `csv` - Text

---

## 🚀 **Optimalizační strategie pro 300 GB**

### **1. Batch Processing (DŮLEŽITÉ!)**

Neindexujte všechno najednou. Rozdělte na batche:

```bash
# Batch 1: 10 GB
# Batch 2: 10 GB
# ...
# Batch 30: 10 GB

# Nebo:
# Batch per folder
# Batch per department
```

**Příklad workflow:**
```
Pondělí:     Indexuj "Finance" (20 GB)
Úterý:       Indexuj "HR" (15 GB)
Středa:      Indexuj "Operations" (25 GB)
... a tak dál
```

### **2. Caching (Performance)**

Přidej Redis cache pro extractované texty:

```bash
npm install redis
```

```typescript
// Cache extracted text pro 1 hodinu
const cacheKey = `extracted:${filePath}:${stat.mtime}`;
const cached = await redis.get(cacheKey);
if (cached) return JSON.parse(cached);

// Extrahuj a cachuj
const text = await extractText(filePath);
await redis.setex(cacheKey, 3600, JSON.stringify(text));
```

### **3. Incremental Sync (KLÍČOVÉ)**

Monitorujte Sambu na změny:

```bash
npm install chokidar  # File watcher
```

```typescript
// Sledovat Sambu na nové/upravené soubory
const watcher = chokidar.watch("/mnt/samba", {
  persistent: true,
  ignored: ["node_modules", ".git"],
  awaitWriteFinish: {
    stabilityThreshold: 2000,
    pollInterval: 100,
  },
});

watcher.on("change", async (path) => {
  console.log(`File changed: ${path}`);
  // Re-index jen tenhle soubor
  await indexSingleFile(path);
});
```

### **4. Parallel Extraction (Rychlost)**

```typescript
// Místo sekvenčně, zpracuj parallelně
const { pLimit } = await import("p-limit");
const limit = pLimit(5); // 5 parallelních

const extractPromises = files.map((file) =>
  limit(() => extractText(file.path))
);

const texts = await Promise.all(extractPromises);
```

### **5. Memory-efficient Chunking**

```typescript
// Nesplituj vše najednou - streamuj
const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 800,      // Menší chunks = lepší relevance
  chunkOverlap: 150,
});

// Zpracuj po 100 souborech najednou
for (let i = 0; i < files.length; i += 100) {
  const batch = files.slice(i, i + 100);
  await indexBatch(batch);
  console.log(`Indexed ${i + 100}/${files.length}`);
}
```

---

## 📊 **Očekávaný Timeline**

### **Skenování Samby (300 GB)**
```
30,000 souborů × 10ms = 5 minut
Inicializace DB:        5 minut
─────────────────────────────────
CELKEM SKEN:            10 minut
```

### **Extrakce textu**
```
30,000 souborů × 50ms (extraction) = 25 minut
─────────────────────────
Paralelně (5x):         5 minut
```

### **Indexování (embeddings)**
```
300K chunks × 200ms (sequential) = 60,000 s = 16.6 hodin
Paralelně (10x batch):  ~1.6 hodin
S caching:              ~4 hodin (first run)
─────────────────────────
CELKEM (first):         5 hodin
Incremental:            10-30 minut
```

### **Celkově (first time)**
```
Sken:       10 minut
Extrakce:   5 minut (paralelně)
Indexing:   4 hodin (s optimalizací)
─────────────────────
TOTAL:      4.25 hodin (přes noc je ideální!)
```

---

## 💾 **Storage Requirements**

```
Original data:           300 GB
PostgreSQL vectorstore:  ~1.5 GB (vektory)
Cache (Redis):           ~5 GB (full extract)
─────────────────────
CELKEM:                  ~310 GB
```

**Disk na serveru:**
- Minimální: 500 GB (těsně)
- Doporučeno: **1 TB** (prostor pro logs, temp files)

---

## 🔐 **Bezpečnost Samby**

### Kredenciály
```bash
# Negeneruj v kódu! Použij env vars:
SAMBA_PATH=/mnt/samba
SAMBA_USER=documents_user
SAMBA_PASS=secure_password_here

# Nebo authentication file (Linux):
cat ~/.smbcredentials
username=user
password=pass

chmod 600 ~/.smbcredentials
```

### Firewall
```bash
# Jen lokální sítě na Sambu
sudo ufw allow from 192.168.1.0/24 to any port 445
sudo ufw allow from 192.168.1.0/24 to any port 139
```

---

## 🛠️ **Deployment Checklist**

- [ ] Samba připojeno a testováno (`mount | grep samba`)
- [ ] Ověřit read permissions na všech složkách
- [ ] PostgreSQL běží s dost disk space
- [ ] `SAMBA_PATH` v `.env.local`
- [ ] Testovat `/api/samba` endpoint
- [ ] Testovat `/api/extract` s jedním souborem
- [ ] Spustit indexování v noci (batch režim)
- [ ] Monitorovat disk space během indexování
- [ ] Nastavit watcher pro nové soubory

---

## 📈 **Performance Monitoring**

Přidej metriky:

```typescript
console.time("samba-scan");
const files = await scanSamba();
console.timeEnd("samba-scan");

console.time("extract-batch");
const texts = await extractBatch(files);
console.timeEnd("extract-batch");

console.time("index-batch");
await indexBatch(texts);
console.timeEnd("index-batch");
```

---

## ⚠️ **Problémy & Řešení**

| Problém | Řešení |
|---------|---------|
| "Permission denied" na Sambu | Ověřit permissi: `chmod 755` / `ls -la` |
| Samba disconnects | Nastavit keep-alive v mount options |
| Pomala extrakce Word | Rozdělit na batche, zvýšit parallelizaci |
| Out of memory | Snížit `maxFiles` nebo `chunkSize` |
| PostgreSQL disk plný | Smazat staré chunks před re-indexem |

---

## 🚀 **Příští kroky**

1. ✅ Setup Samby na vašem serveru
2. ✅ Testovat `/api/samba` endpoint
3. ✅ Extrahovat jeden soubor s `/api/extract`
4. ✅ Spustit batch indexování
5. ✅ Nastavit incremental watcher
6. ✅ Optimalizovat chunk size podle relevance

---

## 📞 **Reference**

- Samba troubleshooting: https://ubuntu.com/server/docs/samba
- Office parsing: https://github.com/mozilla/pdf.js (PDF)
- Performance tuning: https://wiki.samba.org/index.php/Performance_Tuning
