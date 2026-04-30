import { useState, useEffect, useRef, useCallback } from "react";
import { db, auth, googleProvider } from "./firebase";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where
} from "firebase/firestore";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { BrowserMultiFormatReader, NotFoundException } from "@zxing/browser";

// ─── API: Open Library ───
async function lookupOpenLibrary(isbn) {
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const d = await r.json();
    const b = d[`ISBN:${isbn}`];
    if (!b) return null;
    return {
      title: b.title || "", author: b.authors?.map(a => a.name).join(", ") || "",
      cover: b.cover?.medium || b.cover?.small || null, year: b.publish_date || "",
      subjects: b.subjects?.map(s => s.name) || [], publisher: b.publishers?.map(p => p.name).join(", ") || "",
      source: "OpenLibrary",
    };
  } catch { return null; }
}

// ─── API: Google Books ───
async function lookupGoogleBooks(isbn) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const d = await r.json();
    if (!d.items?.length) return null;
    const v = d.items[0].volumeInfo;
    return {
      title: v.title || "", author: (v.authors || []).join(", "),
      cover: v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || null,
      year: v.publishedDate || "", subjects: v.categories || [],
      publisher: v.publisher || "", source: "GoogleBooks",
    };
  } catch { return null; }
}

async function lookupISBN(isbn) {
  let data = await lookupOpenLibrary(isbn);
  if (!data) data = await lookupGoogleBooks(isbn);
  return data;
}

// ─── API: BoardGameGeek ───
async function searchBGG(queryStr) {
  try {
    const r = await fetch(`https://boardgamegeek.com/xmlapi2/search?query=${encodeURIComponent(queryStr)}&type=boardgame`);
    const txt = await r.text(); const p = new DOMParser(); const xml = p.parseFromString(txt, "text/xml");
    const items = xml.querySelectorAll("item"); if (!items.length) return null;
    const id = items[0].getAttribute("id");
    const dr = await fetch(`https://boardgamegeek.com/xmlapi2/thing?id=${id}&stats=1`);
    const dt = await dr.text(); const dx = p.parseFromString(dt, "text/xml"); const it = dx.querySelector("item");
    if (!it) return null;
    return {
      title: it.querySelector("name[type='primary']")?.getAttribute("value") || queryStr,
      year: it.querySelector("yearpublished")?.getAttribute("value") || "",
      minPlayers: it.querySelector("minplayers")?.getAttribute("value") || "",
      maxPlayers: it.querySelector("maxplayers")?.getAttribute("value") || "",
      playingTime: it.querySelector("playingtime")?.getAttribute("value") || "",
      image: it.querySelector("image")?.textContent || null,
      categories: [...it.querySelectorAll('link[type="boardgamecategory"]')].map(l => l.getAttribute("value")),
      designer: [...it.querySelectorAll('link[type="boardgamedesigner"]')].map(l => l.getAttribute("value")).join(", "),
      rating: it.querySelector("statistics ratings average")?.getAttribute("value") || "",
    };
  } catch { return null; }
}

// ─── Classification ───
function isISBN(code) { return code && (code.startsWith("978") || code.startsWith("979")) && code.length === 13; }
const COMIC_KW = ["comic", "comics", "manga", "graphic novel", "fumett", "bande dessinée", "marvel", "dc comics", "bonelli", "panini comics", "star comics", "j-pop", "planet manga", "dynit"];
const RPG_KW = ["role-playing", "roleplaying", "rpg", "gioco di ruolo", "gdr", "dungeons", "d&d", "pathfinder"];

function detectType(subjects = [], title = "", publisher = "") {
  const all = [...subjects, title, publisher].join(" ").toLowerCase();
  if (COMIC_KW.some(k => all.includes(k))) return "fumetto";
  return "libro";
}

function detectGenre(subjects = [], categories = [], type = "libro") {
  const all = [...subjects, ...categories].map(s => s.toLowerCase());
  if (all.some(s => RPG_KW.some(k => s.includes(k)))) return "GdR";
  if (type === "fumetto") {
    if (all.some(s => s.includes("manga"))) return "Manga";
    if (all.some(s => s.includes("superhero") || s.includes("supereroi"))) return "Supereroi";
    if (all.some(s => s.includes("horror"))) return "Horror";
    return "Fumetto";
  }
  if (all.some(s => s.includes("fantasy"))) return "Fantasy";
  if (all.some(s => s.includes("sci-fi") || s.includes("science fiction"))) return "Sci-Fi";
  if (all.some(s => s.includes("horror"))) return "Horror";
  if (all.some(s => s.includes("fiction") || s.includes("romanzo"))) return "Narrativa";
  if (all.some(s => s.includes("strategy"))) return "Strategia";
  if (all.some(s => s.includes("party"))) return "Party Game";
  return "Altro";
}

function extractVolume(title) {
  const patterns = [/vol\.?\s*(\d+)/i, /volume\s*(\d+)/i, /#\s*(\d+)/, /,\s*(\d+)$/, /n\.?\s*(\d+)/i, /\((\d+)\)/, /\[(\d+)\]/];
  for (const p of patterns) { const m = title.match(p); if (m) return parseInt(m[1], 10); }
  return null;
}

function extractSeries(title) {
  let s = title;
  s = s.replace(/[,:]?\s*(vol\.?|volume|n\.?|#)\s*\d+.*/i, "").trim();
  s = s.replace(/\s*[\(\[]\d+[\)\]]\s*$/, "").trim();
  return s || title;
}

// ─── Theme ───
const C = {
  bg: "#0c0e14", surface: "#151822", surfaceAlt: "#1b1f2d", card: "#181c28",
  accent: "#d4a24e", libro: "#6b9bef", gioco: "#ef7b6b", fumetto: "#c07bef",
  text: "#e8e6e1", textDim: "#7d7c79", border: "#252938", green: "#5bdf8b", red: "#ef5b5b",
};
const FD = `'Playfair Display', Georgia, serif`;
const FB = `'DM Sans', 'Segoe UI', sans-serif`;
const typeColor = t => t === "libro" ? C.libro : t === "gioco" ? C.gioco : C.fumetto;
const typeIcon = t => t === "libro" ? "📚" : t === "gioco" ? "🎲" : "📖";
const typeLabel = t => t === "libro" ? "LIBRO" : t === "gioco" ? "GIOCO" : "FUMETTO";
const inputBase = {
  width: "100%", padding: "9px 12px", borderRadius: 6, border: `1px solid ${C.border}`,
  background: C.bg, color: C.text, fontSize: 14, fontFamily: FB, outline: "none", boxSizing: "border-box"
};

// ═══════════════════ MAIN APP ═══════════════════
export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [tab, setTab] = useState("scan");
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [manualEntry, setManualEntry] = useState(null);
  const [bggQuery, setBggQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [detailItem, setDetailItem] = useState(null);
  const [seriesView, setSeriesView] = useState(false);
  const videoRef = useRef(null);
  const readerRef = useRef(null);
  const scanningRef = useRef(false);

  // ─── Auth ───
  useEffect(() => {
    return onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
  }, []);

  const login = () => signInWithPopup(auth, googleProvider);
  const logout = () => signOut(auth);

  // ─── Firestore sync ───
  useEffect(() => {
    if (!user) { setItems([]); return; }
    const q = query(collection(db, "items"), where("uid", "==", user.uid));
    const unsub = onSnapshot(q, snap => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      data.sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
      setItems(data);
    });
    return unsub;
  }, [user]);

  // ─── CRUD ───
  const addItem = async (item) => {
    const { id, ...data } = item;
    await addDoc(collection(db, "items"), { ...data, uid: user.uid });
    setEditItem(null); setManualEntry(null); setScanStatus("✓ Aggiunto!");
  };
  const updateItem = async (item) => {
    const { id, ...data } = item;
    await updateDoc(doc(db, "items", id), data);
    setDetailItem(item);
  };
  const deleteItem = async (id) => {
    await deleteDoc(doc(db, "items", id));
    setDetailItem(null);
  };

  // ─── ZXing Scanner ───
  const stopScan = useCallback(() => {
    scanningRef.current = false;
    if (readerRef.current) {
      try { readerRef.current.reset(); } catch {}
      readerRef.current = null;
    }
    // Stop camera stream
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  const startScan = useCallback(async () => {
    try {
      setScanStatus("Avvio fotocamera...");
      setScanning(true);
      scanningRef.current = true;

      const reader = new BrowserMultiFormatReader();
      readerRef.current = reader;

      // Get rear camera
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      const rearCamera = devices.find(d =>
        d.label.toLowerCase().includes("back") ||
        d.label.toLowerCase().includes("rear") ||
        d.label.toLowerCase().includes("posteriore") ||
        d.label.toLowerCase().includes("environment")
      ) || devices[devices.length - 1] || devices[0];

      if (!rearCamera) {
        setScanStatus("Nessuna fotocamera trovata.");
        setScanning(false);
        return;
      }

      setScanStatus("Inquadra il barcode...");

      await reader.decodeFromVideoDevice(
        rearCamera.deviceId,
        videoRef.current,
        (result, error) => {
          if (!scanningRef.current) return;
          if (result) {
            const code = result.getText();
            stopScan();
            handleBarcode(code);
          }
          // NotFoundException is normal (no barcode in frame yet), ignore it
        }
      );
    } catch (err) {
      setScanStatus("Errore fotocamera: " + err.message);
      setScanning(false);
    }
  }, [stopScan]);

  useEffect(() => () => stopScan(), [stopScan]);

  // ─── Barcode handler ───
  const handleBarcode = async (code) => {
    if (items.some(i => i.barcode === code)) { setScanStatus(`⚠️ Codice ${code} già presente!`); return; }
    setLookupLoading(true);
    const isbn = isISBN(code);
    setScanStatus(isbn ? `ISBN: ${code} — Ricerca...` : `EAN: ${code} — Ricerca...`);

    const buildItem = (data, code) => {
      const tp = detectType(data.subjects || [], data.title, data.publisher || "");
      const genre = detectGenre(data.subjects || [], [], tp);
      const vn = extractVolume(data.title);
      return {
        id: "_new", type: tp, barcode: code,
        title: data.title, author: data.author || "", cover: data.cover || "",
        year: data.year || "", genre, publisher: data.publisher || "",
        series: vn ? extractSeries(data.title) : "", volumeNumber: vn || "",
        totalVolumes: "", notes: "", addedAt: new Date().toISOString()
      };
    };

    const data = await lookupISBN(code);
    if (data) {
      setEditItem(buildItem(data, code));
      setScanStatus(`✓ ${data.source}: ${data.title}`);
    } else if (isbn) {
      setManualEntry({ type: "libro", barcode: code });
      setScanStatus("Non trovato. Inserisci manualmente.");
    } else {
      setManualEntry({ type: "gioco", barcode: code });
      setScanStatus("EAN non ISBN — probabilmente un gioco. Cerca su BGG.");
    }
    setLookupLoading(false);
  };

  const handleBGGSearch = async () => {
    if (!bggQuery.trim()) return;
    setLookupLoading(true); setScanStatus("Cerco su BoardGameGeek...");
    const data = await searchBGG(bggQuery);
    if (data) {
      const genre = detectGenre([], data.categories, "gioco");
      setEditItem({ id: "_new", type: "gioco", barcode: manualEntry?.barcode || "", title: data.title, designer: data.designer || "", cover: data.image || "", year: data.year || "", genre, minPlayers: data.minPlayers || "", maxPlayers: data.maxPlayers || "", playingTime: data.playingTime || "", rating: data.rating || "", notes: "", addedAt: new Date().toISOString() });
      setManualEntry(null); setScanStatus(`✓ BGG: ${data.title}`);
    } else { setScanStatus("Non trovato su BGG."); }
    setLookupLoading(false);
  };

  const createBlank = (type) => ({ id: "_new", type, barcode: manualEntry?.barcode || "", title: "", author: "", designer: "", cover: "", year: "", genre: "Altro", publisher: "", series: "", volumeNumber: "", totalVolumes: "", minPlayers: "", maxPlayers: "", playingTime: "", rating: "", notes: "", addedAt: new Date().toISOString() });

  // ─── Derived ───
  const counts = { libro: items.filter(i => i.type === "libro").length, gioco: items.filter(i => i.type === "gioco").length, fumetto: items.filter(i => i.type === "fumetto").length };
  const searchResults = searchQuery.trim() ? items.filter(i => { const q = searchQuery.toLowerCase(); return i.title?.toLowerCase().includes(q) || (i.author || i.designer || "").toLowerCase().includes(q) || (i.genre || "").toLowerCase().includes(q) || (i.series || "").toLowerCase().includes(q); }) : [];

  const comicSeries = (() => {
    const cs = items.filter(i => i.type === "fumetto" && i.series);
    const m = {};
    cs.forEach(c => { const k = c.series.toLowerCase().trim(); if (!m[k]) m[k] = { name: c.series, items: [], totalVolumes: 0, cover: null }; m[k].items.push(c); if (c.cover && !m[k].cover) m[k].cover = c.cover; const tv = parseInt(c.totalVolumes); if (tv > m[k].totalVolumes) m[k].totalVolumes = tv; });
    Object.values(m).forEach(s => s.items.sort((a, b) => (parseInt(a.volumeNumber) || 0) - (parseInt(b.volumeNumber) || 0)));
    return m;
  })();

  const getMissing = (s) => { if (!s.totalVolumes) return []; const owned = new Set(s.items.map(i => parseInt(i.volumeNumber)).filter(Boolean)); const m = []; for (let i = 1; i <= s.totalVolumes; i++) if (!owned.has(i)) m.push(i); return m; };

  // ─── Login screen ───
  if (authLoading) return <div style={{ background: C.bg, height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: C.text, fontFamily: FB }}>Caricamento...</div>;

  if (!user) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: FB, padding: 24 }}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ textAlign: "center", maxWidth: 340 }}>
        <div style={{ fontSize: 64, marginBottom: 16 }}>📚</div>
        <h1 style={{ fontFamily: FD, fontSize: 30, fontWeight: 800, color: C.accent, margin: "0 0 8px" }}>La Mia Collezione</h1>
        <p style={{ color: C.textDim, fontSize: 15, margin: "0 0 32px", lineHeight: 1.5 }}>Cataloga libri, fumetti e giochi da tavolo scansionando il barcode.</p>
        <button onClick={login} style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 auto", padding: "14px 28px", borderRadius: 10, border: "none", background: "#fff", color: "#333", fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: FB, boxShadow: "0 2px 12px rgba(0,0,0,0.3)" }}>
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" width={20} />
          Accedi con Google
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: FB, maxWidth: 520, margin: "0 auto" }}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ padding: "16px 16px 10px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 style={{ fontFamily: FD, fontSize: 22, fontWeight: 800, margin: 0, color: C.accent, letterSpacing: -0.5 }}>La Mia Collezione</h1>
          <div style={{ display: "flex", gap: 12, marginTop: 5, fontSize: 11, color: C.textDim }}>
            {[["libro", C.libro, "libri"], ["fumetto", C.fumetto, "fumetti"], ["gioco", C.gioco, "giochi"]].map(([t, c, l]) => (
              <span key={t} style={{ display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: c, display: "inline-block" }} />{counts[t]} {l}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {user.photoURL && <img src={user.photoURL} alt="" style={{ width: 28, height: 28, borderRadius: "50%" }} />}
          <button onClick={logout} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "5px 10px", color: C.textDim, cursor: "pointer", fontSize: 11, fontFamily: FB }}>Esci</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, background: C.surface, overflowX: "auto" }}>
        {[{ id: "scan", l: "📷 Scan" }, { id: "search", l: "🔍 Cerca" }, { id: "libri", l: "📚 Libri" }, { id: "fumetti", l: "📖 Fumetti" }, { id: "giochi", l: "🎲 Giochi" }].map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); if (t.id !== "scan") stopScan(); }}
            style={{ flex: "0 0 auto", padding: "10px 12px", border: "none", cursor: "pointer", whiteSpace: "nowrap", background: tab === t.id ? C.bg : "transparent", color: tab === t.id ? C.accent : C.textDim, fontFamily: FB, fontSize: 12.5, fontWeight: tab === t.id ? 700 : 500, borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent" }}>
            {t.l}
          </button>
        ))}
      </div>

      <div style={{ padding: 16 }}>

        {/* ═══ SCAN ═══ */}
        {tab === "scan" && (<div>
          <div style={{ position: "relative", borderRadius: 12, overflow: "hidden", background: "#000", marginBottom: 12, aspectRatio: "4/3", border: `1px solid ${C.border}` }}>
            <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover", display: scanning ? "block" : "none" }} playsInline muted />
            {!scanning && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <div style={{ fontSize: 48, opacity: 0.25 }}>📷</div>
                <button onClick={startScan} style={{ background: C.accent, color: C.bg, border: "none", borderRadius: 8, padding: "12px 28px", fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: FB }}>
                  Avvia Scanner
                </button>
              </div>
            )}
            {scanning && (
              <>
                {/* Scan overlay frame */}
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                  <div style={{ width: "72%", height: "30%", border: `2px solid ${C.accent}`, borderRadius: 8, boxShadow: `0 0 0 2000px rgba(0,0,0,0.45)` }} />
                </div>
                {/* Scan line */}
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", overflow: "hidden" }}>
                  <div style={{ width: "72%", height: 2, background: C.accent, opacity: 0.9, boxShadow: `0 0 12px ${C.accent}`, animation: "sl 2s ease-in-out infinite" }} />
                </div>
              </>
            )}
          </div>
          <style>{`@keyframes sl{0%,100%{transform:translateY(-50px)}50%{transform:translateY(50px)}}`}</style>

          {scanning && (
            <button onClick={stopScan} style={{ width: "100%", padding: 10, borderRadius: 8, border: `1px solid ${C.border}`, background: C.surface, color: C.text, cursor: "pointer", marginBottom: 12, fontFamily: FB, fontSize: 13 }}>
              ⏹ Ferma scanner
            </button>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <input value={manualCode} onChange={e => setManualCode(e.target.value)} placeholder="Codice a barre manuale..."
              style={{ ...inputBase, flex: 1 }}
              onKeyDown={e => { if (e.key === "Enter" && manualCode.trim()) { handleBarcode(manualCode.trim()); setManualCode(""); } }} />
            <button onClick={() => { if (manualCode.trim()) { handleBarcode(manualCode.trim()); setManualCode(""); } }}
              style={{ padding: "10px 16px", borderRadius: 8, border: "none", background: C.accent, color: C.bg, fontWeight: 700, cursor: "pointer", fontFamily: FB, fontSize: 14 }}>Cerca</button>
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {[["libro", C.libro, "📚 Libro"], ["fumetto", C.fumetto, "📖 Fumetto"], ["gioco", C.gioco, "🎲 Gioco"]].map(([t, c, l]) => (
              <button key={t} onClick={() => { if (t === "gioco") setManualEntry({ type: "gioco", barcode: "" }); else setEditItem(createBlank(t)); }}
                style={{ flex: 1, padding: 9, borderRadius: 8, border: `1px solid ${c}30`, background: `${c}12`, color: c, cursor: "pointer", fontFamily: FB, fontSize: 12, fontWeight: 600 }}>+ {l}</button>
            ))}
          </div>

          {scanStatus && (
            <div style={{ padding: 12, borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`, fontSize: 13, color: C.textDim, marginBottom: 12 }}>
              {lookupLoading && "⏳ "}{scanStatus}
            </div>
          )}

          {manualEntry?.type === "gioco" && !editItem && (
            <div style={{ padding: 14, borderRadius: 10, background: C.surface, border: `1px solid ${C.border}`, marginBottom: 12 }}>
              <p style={{ margin: "0 0 10px", fontWeight: 600, color: C.gioco, fontSize: 13 }}>🎲 Cerca su BoardGameGeek</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={bggQuery} onChange={e => setBggQuery(e.target.value)} placeholder="Nome del gioco..."
                  style={{ ...inputBase, background: C.bg }}
                  onKeyDown={e => { if (e.key === "Enter") handleBGGSearch(); }} />
                <button onClick={handleBGGSearch} disabled={lookupLoading}
                  style={{ padding: "10px 16px", borderRadius: 8, border: "none", background: C.gioco, color: "#fff", fontWeight: 700, cursor: "pointer", fontFamily: FB }}>Cerca</button>
              </div>
              <button onClick={() => { setEditItem(createBlank("gioco")); setManualEntry(null); }}
                style={{ marginTop: 10, width: "100%", padding: 8, borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.textDim, cursor: "pointer", fontSize: 12, fontFamily: FB }}>
                Inserisci manualmente
              </button>
            </div>
          )}

          {editItem && <EditForm item={editItem} onSave={addItem} onCancel={() => { setEditItem(null); setManualEntry(null); }} />}
        </div>)}

        {/* ═══ SEARCH ═══ */}
        {tab === "search" && (<div>
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Cerca per titolo, autore, serie, genere..." autoFocus
            style={{ ...inputBase, padding: "12px 14px", fontSize: 15, marginBottom: 4 }} />
          {searchQuery.trim() && searchResults.length > 0 && (
            <div style={{ background: C.surface, borderRadius: 10, border: `1px solid ${C.border}`, maxHeight: 500, overflowY: "auto", marginTop: 4 }}>
              {searchResults.map(it => (
                <div key={it.id} onClick={() => setDetailItem(it)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", cursor: "pointer", borderBottom: `1px solid ${C.border}` }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceAlt}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: `${typeColor(it.type)}25`, color: typeColor(it.type), whiteSpace: "nowrap" }}>{typeLabel(it.type)}</span>
                  {it.cover && <img src={it.cover} alt="" style={{ width: 30, height: 40, objectFit: "cover", borderRadius: 4 }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</div>
                    <div style={{ fontSize: 11, color: C.textDim }}>{it.author || it.designer || ""}{it.series ? ` · ${it.series}` : ""}{it.year ? ` (${it.year})` : ""}</div>
                  </div>
                  <span style={{ fontSize: 10, color: C.accent, background: `${C.accent}15`, padding: "2px 6px", borderRadius: 4 }}>{it.genre}</span>
                </div>
              ))}
            </div>
          )}
          {searchQuery.trim() && !searchResults.length && <p style={{ textAlign: "center", color: C.textDim, marginTop: 40 }}>Nessun risultato per "{searchQuery}"</p>}
          {!searchQuery.trim() && <p style={{ textAlign: "center", color: C.textDim, marginTop: 40 }}>Inizia a digitare per cercare</p>}
        </div>)}

        {tab === "libri" && <ItemGrid items={items.filter(i => i.type === "libro")} type="libro" onSelect={setDetailItem} />}

        {tab === "fumetti" && (<div>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <button onClick={() => setSeriesView(false)} style={{ padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer", background: !seriesView ? C.fumetto : C.surface, color: !seriesView ? "#fff" : C.textDim, fontSize: 12, fontWeight: 600, fontFamily: FB }}>Tutti</button>
            <button onClick={() => setSeriesView(true)} style={{ padding: "6px 14px", borderRadius: 20, border: "none", cursor: "pointer", background: seriesView ? C.fumetto : C.surface, color: seriesView ? "#fff" : C.textDim, fontSize: 12, fontWeight: 600, fontFamily: FB }}>Per serie</button>
          </div>
          {!seriesView ? <ItemGrid items={items.filter(i => i.type === "fumetto")} type="fumetto" onSelect={setDetailItem} /> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Object.keys(comicSeries).length === 0 && <p style={{ textAlign: "center", color: C.textDim, marginTop: 30 }}>Nessuna serie. Aggiungi fumetti con il campo "Serie".</p>}
              {Object.values(comicSeries).map(s => {
                const miss = getMissing(s);
                return (
                  <div key={s.name} style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", gap: 12, padding: 12 }}>
                      {s.cover && <img src={s.cover} alt="" style={{ width: 50, height: 68, objectFit: "cover", borderRadius: 6 }} />}
                      <div style={{ flex: 1 }}>
                        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, fontFamily: FD, color: C.fumetto }}>{s.name}</h3>
                        <p style={{ margin: "4px 0 0", fontSize: 12, color: C.textDim }}>{s.items.length} vol.{s.totalVolumes ? ` su ${s.totalVolumes}` : ""}</p>
                        {s.totalVolumes > 0 && <div style={{ marginTop: 6, height: 4, borderRadius: 2, background: C.border, overflow: "hidden" }}>
                          <div style={{ height: "100%", borderRadius: 2, background: C.fumetto, width: `${Math.min(100, (s.items.length / s.totalVolumes) * 100)}%` }} />
                        </div>}
                        {miss.length > 0 && miss.length <= 20 && <p style={{ margin: "6px 0 0", fontSize: 11, color: C.red }}>Mancanti: {miss.join(", ")}</p>}
                        {miss.length > 20 && <p style={{ margin: "6px 0 0", fontSize: 11, color: C.red }}>{miss.length} volumi mancanti</p>}
                      </div>
                    </div>
                    <div style={{ padding: "0 12px 12px", display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {s.items.map(v => <span key={v.id} onClick={() => setDetailItem(v)} style={{ padding: "3px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: `${C.fumetto}25`, color: C.fumetto, cursor: "pointer" }}>#{v.volumeNumber || "?"}</span>)}
                    </div>
                  </div>
                );
              })}
              {(() => { const st = items.filter(i => i.type === "fumetto" && !i.series); if (!st.length) return null; return <div style={{ marginTop: 8 }}><h4 style={{ fontSize: 13, color: C.textDim, margin: "0 0 8px" }}>Senza serie</h4><ItemGrid items={st} type="fumetto" onSelect={setDetailItem} /></div>; })()}
            </div>
          )}
        </div>)}

        {tab === "giochi" && <ItemGrid items={items.filter(i => i.type === "gioco")} type="gioco" onSelect={setDetailItem} />}
      </div>

      {detailItem && <DetailModal item={detailItem} onClose={() => setDetailItem(null)} onDelete={deleteItem} onUpdate={updateItem} />}
    </div>
  );
}

// ─── ItemGrid ───
function ItemGrid({ items, type, onSelect }) {
  const [filter, setFilter] = useState("Tutti");
  const genres = ["Tutti", ...new Set(items.map(i => i.genre).filter(Boolean))];
  const filtered = filter === "Tutti" ? items : items.filter(i => i.genre === filter);
  const tc = typeColor(type);
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 }}>
        {genres.map(g => <button key={g} onClick={() => setFilter(g)} style={{ padding: "4px 11px", borderRadius: 16, border: "none", cursor: "pointer", background: filter === g ? tc : C.surface, color: filter === g ? "#fff" : C.textDim, fontSize: 11, fontWeight: 600, fontFamily: FB }}>{g}</button>)}
      </div>
      {!filtered.length ? <p style={{ textAlign: "center", color: C.textDim, marginTop: 30 }}>{!items.length ? "Nessun elemento. Scansiona!" : "Nessun risultato."}</p> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", gap: 10 }}>
          {filtered.map(it => (
            <div key={it.id} onClick={() => onSelect(it)} style={{ background: C.card, borderRadius: 10, overflow: "hidden", cursor: "pointer", border: `1px solid ${C.border}`, transition: "transform 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"} onMouseLeave={e => e.currentTarget.style.transform = ""}>
              <div style={{ aspectRatio: "3/4", background: C.surface, display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
                {it.cover ? <img src={it.cover} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: 32, opacity: 0.2 }}>{typeIcon(type)}</span>}
                {it.volumeNumber && <span style={{ position: "absolute", top: 4, right: 4, background: C.fumetto, color: "#fff", fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}>#{it.volumeNumber}</span>}
              </div>
              <div style={{ padding: "7px 9px" }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.3, marginBottom: 2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{it.title || "Senza titolo"}</div>
                <div style={{ fontSize: 10, color: C.textDim, marginBottom: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.author || it.designer || it.series || ""}</div>
                <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: `${C.accent}18`, color: C.accent }}>{it.genre}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── EditForm ───
function EditForm({ item, onSave, onCancel }) {
  const [d, setD] = useState({ ...item });
  const s = (k, v) => setD(p => ({ ...p, [k]: v }));
  const tc = typeColor(d.type);
  const go = d.type === "libro" ? ["GdR", "Fantasy", "Sci-Fi", "Horror", "Narrativa", "Saggistica", "Manuale", "Altro"] : d.type === "fumetto" ? ["Manga", "Supereroi", "GdR", "Fantasy", "Sci-Fi", "Horror", "Fumetto", "Graphic Novel", "Altro"] : ["GdR", "Strategia", "Fantasy", "Sci-Fi", "Horror", "Party Game", "Cooperativo", "Bambini", "Altro"];
  return (
    <div style={{ padding: 14, borderRadius: 10, background: C.surface, border: `1px solid ${tc}35`, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {d.cover && <img src={d.cover} alt="" style={{ width: 46, height: 62, objectFit: "cover", borderRadius: 6 }} />}
        <div>
          <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
            {["libro", "fumetto", "gioco"].map(t => (
              <button key={t} onClick={() => s("type", t)} style={{ padding: "2px 8px", borderRadius: 4, border: "none", cursor: "pointer", fontSize: 10, fontWeight: 700, background: d.type === t ? `${typeColor(t)}30` : "transparent", color: d.type === t ? typeColor(t) : C.textDim, fontFamily: FB }}>{typeLabel(t)}</button>
            ))}
          </div>
          {d.barcode && <div style={{ fontSize: 10, color: C.textDim }}>Codice: {d.barcode}</div>}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <input value={d.title} onChange={e => s("title", e.target.value)} placeholder="Titolo *" style={inputBase} />
        {(d.type === "libro" || d.type === "fumetto") && <input value={d.author || ""} onChange={e => s("author", e.target.value)} placeholder="Autore" style={inputBase} />}
        {d.type === "gioco" && <input value={d.designer || ""} onChange={e => s("designer", e.target.value)} placeholder="Designer" style={inputBase} />}
        {(d.type === "libro" || d.type === "fumetto") && <input value={d.publisher || ""} onChange={e => s("publisher", e.target.value)} placeholder="Editore" style={inputBase} />}
        {d.type === "fumetto" && <div style={{ display: "flex", gap: 6 }}>
          <input value={d.series || ""} onChange={e => s("series", e.target.value)} placeholder="Serie (es. One Piece)" style={{ ...inputBase, flex: 2 }} />
          <input value={d.volumeNumber || ""} onChange={e => s("volumeNumber", e.target.value)} placeholder="N°" style={{ ...inputBase, flex: 1 }} type="number" />
          <input value={d.totalVolumes || ""} onChange={e => s("totalVolumes", e.target.value)} placeholder="Tot." style={{ ...inputBase, flex: 1 }} type="number" />
        </div>}
        {d.type === "gioco" && <div style={{ display: "flex", gap: 6 }}>
          <input value={d.minPlayers || ""} onChange={e => s("minPlayers", e.target.value)} placeholder="Min" style={{ ...inputBase, flex: 1 }} />
          <input value={d.maxPlayers || ""} onChange={e => s("maxPlayers", e.target.value)} placeholder="Max" style={{ ...inputBase, flex: 1 }} />
          <input value={d.playingTime || ""} onChange={e => s("playingTime", e.target.value)} placeholder="Min." style={{ ...inputBase, flex: 1 }} />
        </div>}
        <div style={{ display: "flex", gap: 6 }}>
          <input value={d.year || ""} onChange={e => s("year", e.target.value)} placeholder="Anno" style={{ ...inputBase, flex: 1 }} />
          <select value={d.genre} onChange={e => s("genre", e.target.value)} style={{ ...inputBase, flex: 1, cursor: "pointer" }}>{go.map(g => <option key={g} value={g}>{g}</option>)}</select>
        </div>
        <textarea value={d.notes || ""} onChange={e => s("notes", e.target.value)} placeholder="Note..." rows={2} style={{ ...inputBase, resize: "vertical" }} />
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={() => onSave(d)} disabled={!d.title.trim()} style={{ flex: 1, padding: 10, borderRadius: 8, border: "none", background: d.title.trim() ? C.green : C.border, color: d.title.trim() ? C.bg : C.textDim, fontWeight: 700, cursor: d.title.trim() ? "pointer" : "not-allowed", fontFamily: FB, fontSize: 14 }}>✓ Salva</button>
        <button onClick={onCancel} style={{ padding: "10px 16px", borderRadius: 8, border: `1px solid ${C.border}`, background: "transparent", color: C.textDim, cursor: "pointer", fontFamily: FB, fontSize: 14 }}>Annulla</button>
      </div>
    </div>
  );
}

// ─── DetailModal ───
function DetailModal({ item, onClose, onDelete, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({ ...item });
  const s = (k, v) => setD(p => ({ ...p, [k]: v }));
  const tc = typeColor(item.type);
  const go = item.type === "libro" ? ["GdR", "Fantasy", "Sci-Fi", "Horror", "Narrativa", "Saggistica", "Manuale", "Altro"] : item.type === "fumetto" ? ["Manga", "Supereroi", "GdR", "Fantasy", "Sci-Fi", "Horror", "Fumetto", "Graphic Novel", "Altro"] : ["GdR", "Strategia", "Fantasy", "Sci-Fi", "Horror", "Party Game", "Cooperativo", "Bambini", "Altro"];
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div style={{ width: "100%", maxWidth: 520, maxHeight: "88vh", overflowY: "auto", background: C.bg, borderRadius: "20px 20px 0 0", padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 4, background: `${tc}25`, color: tc }}>{typeIcon(item.type)} {typeLabel(item.type)}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.textDim, cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        {item.cover && <div style={{ textAlign: "center", marginBottom: 14 }}><img src={item.cover} alt="" style={{ maxHeight: 180, borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,0.4)" }} /></div>}
        {!editing ? (<>
          <h2 style={{ fontFamily: FD, fontSize: 20, fontWeight: 700, margin: "0 0 4px", color: C.text }}>{item.title}</h2>
          <p style={{ margin: "0 0 10px", color: C.textDim, fontSize: 13 }}>{item.author || item.designer || ""}{item.year ? ` · ${item.year}` : ""}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
            <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, fontWeight: 600, background: `${C.accent}20`, color: C.accent }}>{item.genre}</span>
            {item.series && <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, background: `${C.fumetto}15`, color: C.fumetto }}>📖 {item.series}{item.volumeNumber ? ` #${item.volumeNumber}` : ""}</span>}
            {item.totalVolumes && <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, background: `${C.textDim}15`, color: C.textDim }}>Tot. {item.totalVolumes} vol.</span>}
            {item.minPlayers && <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, background: `${C.libro}15`, color: C.libro }}>👥 {item.minPlayers}{item.maxPlayers ? `–${item.maxPlayers}` : ""}</span>}
            {item.playingTime && <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, background: `${C.green}15`, color: C.green }}>⏱ {item.playingTime} min</span>}
            {item.rating && parseFloat(item.rating) > 0 && <span style={{ padding: "3px 10px", borderRadius: 12, fontSize: 11, background: `${C.accent}15`, color: C.accent }}>⭐ {parseFloat(item.rating).toFixed(1)}</span>}
          </div>
          {item.publisher && <p style={{ fontSize: 12, color: C.textDim, margin: "0 0 3px" }}>Editore: {item.publisher}</p>}
          {item.barcode && <p style={{ fontSize: 11, color: C.textDim, margin: "0 0 3px" }}>Codice: {item.barcode}</p>}
          {item.notes && <p style={{ fontSize: 13, color: C.text, margin: "10px 0 0", padding: 10, background: C.surface, borderRadius: 6 }}>{item.notes}</p>}
          <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
            <button onClick={() => { setD({ ...item }); setEditing(true); }} style={{ flex: 1, padding: 10, borderRadius: 8, border: `1px solid ${tc}`, background: "transparent", color: tc, fontWeight: 600, cursor: "pointer", fontFamily: FB, fontSize: 13 }}>✏️ Modifica</button>
            <button onClick={() => { if (window.confirm("Eliminare?")) onDelete(item.id); }} style={{ padding: "10px 16px", borderRadius: 8, border: `1px solid ${C.red}40`, background: "transparent", color: C.red, fontWeight: 600, cursor: "pointer", fontFamily: FB, fontSize: 13 }}>🗑</button>
          </div>
        </>) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <input value={d.title} onChange={e => s("title", e.target.value)} placeholder="Titolo" style={inputBase} />
            {(d.type === "libro" || d.type === "fumetto") && <input value={d.author || ""} onChange={e => s("author", e.target.value)} placeholder="Autore" style={inputBase} />}
            {d.type === "gioco" && <input value={d.designer || ""} onChange={e => s("designer", e.target.value)} placeholder="Designer" style={inputBase} />}
            {(d.type === "libro" || d.type === "fumetto") && <input value={d.publisher || ""} onChange={e => s("publisher", e.target.value)} placeholder="Editore" style={inputBase} />}
            {d.type === "fumetto" && <div style={{ display: "flex", gap: 6 }}>
              <input value={d.series || ""} onChange={e => s("series", e.target.value)} placeholder="Serie" style={{ ...inputBase, flex: 2 }} />
              <input value={d.volumeNumber || ""} onChange={e => s("volumeNumber", e.target.value)} placeholder="N°" style={{ ...inputBase, flex: 1 }} type="number" />
              <input value={d.totalVolumes || ""} onChange={e => s("totalVolumes", e.target.value)} placeholder="Tot." style={{ ...inputBase, flex: 1 }} type="number" />
            </div>}
            {d.type === "gioco" && <div style={{ display: "flex", gap: 6 }}>
              <input value={d.minPlayers || ""} onChange={e => s("minPlayers", e.target.value)} placeholder="Min" style={{ ...inputBase, flex: 1 }} />
              <input value={d.maxPlayers || ""} onChange={e => s("maxPlayers", e.target.value)} placeholder="Max" style={{ ...inputBase, flex: 1 }} />
              <input value={d.playingTime || ""} onChange={e => s("playingTime", e.target.value)} placeholder="Min." style={{ ...inputBase, flex: 1 }} />
            </div>}
            <div style={{ display: "flex", gap: 6 }}>
              <input value={d.year || ""} onChange={e => s("year", e.target.value)} placeholder="Anno" style={{ ...inputBase, flex: 1 }} />
              <select value={d.genre} onChange={e => s("genre", e.target.value)} style={{ ...inputBase, flex: 1, cursor: "pointer" }}>{go.map(g => <option key={g} value={g}>{g}</option>)}</select>
            </div>
            <textarea value={d.notes || ""} onChange={e => s("notes", e.target.value)} placeholder="Note..." rows={2} style={{ ...inputBase, resize: "vertical" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button onClick={() => { onUpdate(d); setEditing(false); }} style={{ flex: 1, padding: 10, borderRadius: 8, border: "none", background: C.green, color: C.bg, fontWeight: 700, cursor: "pointer", fontFamily: FB, fontSize: 13 }}>✓ Salva</button>
              <button onClick={() => setEditing(false)} style={{ padding: "10px 16px", borderRadius: 8, border: `1px solid ${C.border}`, background: "transparent", color: C.textDim, cursor: "pointer", fontFamily: FB, fontSize: 13 }}>Annulla</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
