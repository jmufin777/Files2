# 💰 Náklady na vlastním serveru

## 🎯 **TL;DR: $0-15/měsíc (téměř zdarma!)**

---

## 📊 **Detailní rozpis nákladů**

### **Pokud máte vlastní server (self-hosted):**

```
Hardware (už máte):              $0
Elektřina:                       $5-10/měsíc
PostgreSQL (local):              $0 (Docker)
Next.js app (local):             $0 (npm run)
Samba share (local):             $0 (už máte)
────────────────────────────────────────
Google Gemini API:               $0 (FREE tier!)
Google Embeddings:               $0 (FREE tier!)
────────────────────────────────────────
CELKEM:                          $5-15/měsíc ✅
```

---

## 🆓 **Co je ZDARMA na vlastním serveru:**

### **1. Databáze (PostgreSQL)**
```bash
# Docker Compose (už máte v projektu)
docker-compose up -d

# Běží lokálně, žádné cloud náklady!
Cena: $0
Storage: Unlimited (jen váš disk)
```

### **2. Next.js aplikace**
```bash
npm run dev   # Development
npm run build && npm start  # Production

# Běží na vašem serveru
Cena: $0
RAM: ~500 MB
CPU: Minimální
```

### **3. Samba share**
```bash
# Připojeno k vašemu síťovému disku
mount -t cifs //192.168.1.100/documents /mnt/samba

# Data jsou na vašem NAS/serveru
Cena: $0
Bandwidth: Local network (rychlé!)
```

### **4. Storage**
```
Original data (300 GB):          Na Samba → $0
PostgreSQL vectors (1.5 GB):     Lokální disk → $0
Cache (optional, 5 GB):          Lokální disk → $0
Logs (1 GB):                     Lokální disk → $0
────────────────────────────────────────
CELKEM storage:                  ~310 GB → $0
```

---

## 💸 **Co NENÍ zdarma (Google API):**

### **Google Gemini API** (chat/generování odpovědí)

#### **FREE Tier:**
```
Limit:          15 requests/minute
                1,500 requests/day
                1 million tokens/month

Cena:           $0 ✅

Pro 300 GB dat:
- Typický uživatel: 50-200 dotazů/den → ZDARMA
- Power user: 500 dotazů/den → ZDARMA (v limitu)
```

#### **Paid Tier** (pokud překročíte free tier):
```
Model:          gemini-2.5-flash
Input:          $0.075 per 1M tokens
Output:         $0.30 per 1M tokens

Průměr. query:
- Input:  2000 tokens (context) = $0.00015
- Output: 500 tokens (odpověď) = $0.00015
────────────────────────────────────────
Per query:      ~$0.0003 (0.03 centu)

1000 queries:   $0.30
10,000 queries: $3
100,000 queries: $30/měsíc
```

**Reálné číslo:**
- Pokud jste v FREE tier: **$0**
- Pokud 1000 queries/měsíc: **$0.30**
- Pokud 5000 queries/měsíc: **$1.50**

---

### **Google Embeddings API** (indexování)

#### **FREE Tier:**
```
Limit:          1,500 requests/day
                ~45,000 requests/month
                
Cena:           $0 ✅

Pro 300 GB dat:
- 300K chunks → potřeba 300K embeddingů
- First indexing: 300K requests (nad limit!)
- Incremental: 100-1000 requests/den → ZDARMA
```

#### **Paid Tier** (pro initial indexing 300K chunks):
```
Model:          embedding-001
Cena:           $0.00001 per 1K tokens (~750 chars)

300K chunks × 1000 chars = 300M chars = 400M tokens
400,000 × $0.00001 = $4 (jednoráz)

Pak incremental (nové soubory):
100 chunks/den × $0.00001 = $0.001/den = $0.03/měsíc
```

**Reálné číslo:**
- Initial indexing 300 GB: **$4 (jednoráz)**
- Incremental updates: **$0-0.50/měsíc**

---

## 💡 **Optimalizace pro $0 náklady:**

### **1. Zůstat ve FREE tieru** ⭐
```bash
# Limity:
Google Gemini:     1,500 req/day = 50 req/hour
Google Embeddings: 1,500 req/day

# Strategie:
- Indexovat po nocích (batch 1500 chunks/den)
- 300K chunks ÷ 1500 = 200 dní (6 měsíců)
- Nebo indexovat jen důležité složky

# Výsledek: $0 ✅
```

### **2. Použít menší chunks** ⭐
```typescript
// Místo:
chunkSize: 1000
→ 300K chunks

// Použít:
chunkSize: 1500
→ 200K chunks (o 33% méně!)

// Úspora embeddings API callů: 33%
```

### **3. Smart indexing** ⭐
```bash
# Neindexovat vše najednou!
# Indexovat jen relevantní složky:

Priority 1: /Finance/2024      (5 GB)   → 1 den
Priority 2: /HR/Active          (3 GB)   → 1 den
Priority 3: /Operations/Current (10 GB)  → 3 dny
...

# Celkem: Indexovat 50-100 GB místo 300 GB
# Úspora: 66% embeddings → stále $0 (FREE tier)
```

### **4. Cache embeddings** ⭐
```bash
# Cachovat již vytvořené embeddings
# Při re-indexování: skip už indexed chunks

# Úspora: 90% re-indexing API callů
```

---

## ⚡ **Elektřina - Hardware náklady:**

### **Typical server (24/7):**
```
Next.js (Node):     ~10W (když běží)
PostgreSQL:         ~5W (idle), ~15W (indexing)
Samba mount:        ~1W (network overhead)
────────────────────────────────────────
CELKEM:             ~20-30W průměr

Elektřina v ČR:     ~6 Kč/kWh
────────────────────────────────────────
20W × 24h × 30 dní = 14.4 kWh = ~86 Kč = $4/měsíc
30W (peak)         = 21.6 kWh = ~130 Kč = $6/měsíc
```

**Pokud vypínáte server v noci:**
```
12h/den active:     7-10 kWh = ~60 Kč = $2.50/měsíc
```

---

## 📊 **Srovnání: Cloud vs. Self-hosted**

| Položka | Cloud (managed) | Self-hosted (váš server) |
|---------|----------------|--------------------------|
| **PostgreSQL** | $20-30/měsíc | $0 |
| **Hosting (Next.js)** | $0 (Vercel free) | $0 (lokální) |
| **Gemini API** | $0-15 | $0-15 |
| **Embeddings API** | $0-50 | $0-50 |
| **Storage (300 GB)** | $0 (Vercel) + $30 DB | $0 (local disk) |
| **Bandwidth** | Unlimited (Vercel) | $0 (local LAN) |
| **Elektřina** | Zahrnutá | $4-6/měsíc |
| **─────────────** | **─────────────** | **─────────────** |
| **CELKEM** | **$50-125/měsíc** | **$4-21/měsíc** 🎉 |

---

## 🎯 **Realistické scénáře:**

### **Scénář 1: Malý tým (5-10 lidí)**
```
Queries:            100-300/den
Gemini API:         FREE tier → $0
New documents:      10-50/den
Embeddings:         FREE tier → $0
Elektřina:          $4/měsíc
────────────────────────────────────
CELKEM:             $4/měsíc ✅
```

### **Scénář 2: Střední tým (20-50 lidí)**
```
Queries:            500-1000/den
Gemini API:         FREE tier (limit!) → $0-3/měsíc
New documents:      50-200/den
Embeddings:         Částečně nad limitem → $1-2/měsíc
Elektřina:          $6/měsíc
────────────────────────────────────
CELKEM:             $7-11/měsíc ✅
```

### **Scénář 3: Velký tým (100+ lidí)**
```
Queries:            3000-5000/den
Gemini API:         Nad limitem → $10-30/měsíc
New documents:      500+/den
Embeddings:         Nad limitem → $5-10/měsíc
Elektřina:          $6/měsíc
────────────────────────────────────
CELKEM:             $21-46/měsíc
```

---

## 🚀 **Jak minimalizovat náklady:**

### **Tip 1: Batch processing v noci**
```bash
# Spustit indexing job každou noc v 2:00
crontab -e
0 2 * * * /home/user/nai/scripts/index-new-files.sh

# Využít FREE tier limity (1500 req/day)
# Úspora: 100% (stay v FREE tier)
```

### **Tip 2: Smart caching**
```typescript
// Cachovat Gemini responses na 1 hodinu
const cacheKey = `gemini:${queryHash}`;
const cached = await cache.get(cacheKey);
if (cached) return cached;

// Snížení API callů: 30-50%
```

### **Tip 3: Lokální LLM (fallback)**
```bash
# Pro méně kritické queries použít lokální Llama
npm install @llama-node/llama-cpp

# Lokální LLM: $0 API costs
# Trade-off: Nižší kvalita, ale FREE
```

### **Tip 4: Incremental only**
```bash
# Indexovat jen nové/upravené soubory
# Místo full re-index každý týden

# Úspora embeddings API: 90%
```

---

## 💾 **Hardware requirements (váš server):**

### **Minimum:**
```
CPU:    2 cores (nebo 4 vCPU)
RAM:    4 GB
Disk:   500 GB SSD (pro 300 GB dat + vectors)
Network: 100 Mbps LAN (pro Samba)
```

### **Doporučeno:**
```
CPU:    4 cores (8 vCPU)
RAM:    8 GB (pro paralelní indexing)
Disk:   1 TB SSD
Network: 1 Gbps LAN
```

### **Cena hardware (pokud kupujete nový):**
```
Mini PC (Intel NUC):        $300-500 (jednoráz)
RAM upgrade:                $50
SSD 1TB:                    $80
────────────────────────────────────
CELKEM:                     $430-630 (jednoráz)

ROI vs. cloud ($50/měsíc):  9-13 měsíců
```

---

## 📈 **ROI kalkulačka:**

### **Cloud (managed):**
```
Měsíc 1:   $50
Měsíc 12:  $600
Rok 2:     $1,200
Rok 3:     $1,800
────────────────────────────────
3 roky:    $1,800
```

### **Self-hosted:**
```
Hardware:  $500 (jednoráz)
Měsíc 1:   $4
Měsíc 12:  $48
Rok 2:     $48
Rok 3:     $48
────────────────────────────────
3 roky:    $500 + $144 = $644

ÚSPORA:    $1,156 (64%) 🎉
```

---

## ⚠️ **Hidden costs (pozor!):**

### **Co NENÍ započítáno:**
```
1. Čas na setup:        2-4 hodiny (jednoráz)
2. Čas na údržbu:       1-2 hodiny/měsíc
3. Backups:             Potřeba vlastní řešení
4. Monitoring:          Potřeba nastavit
5. Security updates:    Potřeba sledovat
6. Downtime risk:       Pokud spadne server
```

### **Pro cloud managed řešení:**
```
1. Setup:       10 minut (Vercel deploy)
2. Údržba:      0 hodin (auto-updates)
3. Backups:     Automatické
4. Monitoring:  Included
5. Security:    Managed
6. Uptime:      99.9% SLA
```

---

## 🎯 **Doporučení podle use-case:**

### **Pokud:**
- ✅ Máte vlastní server/NAS
- ✅ Technicky zdatní (Linux, Docker)
- ✅ <100 queries/den
- ✅ Data jsou citlivá (privacy)
- ✅ Chcete kontrolu

→ **Self-hosted = ideální!** ($4-15/měsíc)

### **Pokud:**
- ❌ Nemáte server
- ❌ Nechcete se starat o DevOps
- ❌ >1000 queries/den
- ❌ Potřeba 99.9% uptime
- ❌ Remote team

→ **Cloud managed = lepší** ($50-125/měsíc)

---

## 💰 **Finální čísla pro váš případ:**

### **Self-hosted (vlastní server + Samba 300 GB):**

```
════════════════════════════════════════════
MĚSÍČNÍ NÁKLADY:
════════════════════════════════════════════

Hardware:                $0 (už máte)
Elektřina:               $4-6
PostgreSQL:              $0 (Docker)
Next.js:                 $0 (local)
Samba:                   $0 (local)
────────────────────────────────────────────
Google Gemini API:       $0-3 (FREE tier!)
Google Embeddings:       $0-2 (FREE tier!)
────────────────────────────────────────────
CELKEM:                  $4-11/měsíc ✅
════════════════════════════════════════════

JEDNORÁZ (initial indexing 300 GB):
Google Embeddings:       $0-4 (pokud najednou)
                    nebo $0 (postupně přes FREE tier)
════════════════════════════════════════════
```

---

## 🎉 **TL;DR:**

| Konfigurace | Měsíční náklady |
|-------------|----------------|
| **Self-hosted + FREE tier APIs** | **$4-6** 🏆 |
| Self-hosted + paid APIs (low) | $7-11 |
| Self-hosted + paid APIs (medium) | $15-25 |
| Cloud managed | $50-125 |
| Google Vertex AI | $2,500+ |

---

**S vlastním serverem: téměř zadarmo! 🎉**

Hlavní náklady = jen elektřina ($4-6) + občas API calls ($0-5)
