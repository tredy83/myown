import { useState, useEffect, useRef, useCallback } from "react";
import { db, auth, googleProvider } from "./firebase";
import { collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where } from "firebase/firestore";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { BrowserMultiFormatReader } from "@zxing/browser";

const GLOBAL_CSS = `
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; overscroll-behavior: none; background: #0a0b0f; }
  :root {
    --bg: #0a0b0f; --surface: #13151e; --surface2: #1a1d2a; --card: #161923;
    --border: #232637; --accent: #e8b84b; --libro: #5b8ff5; --fumetto: #b96ef5;
    --gioco: #f5705b; --text: #ece9e2; --textdim: #6b6a67; --green: #4dd98a; --red: #f55b5b;
    --safe-bottom: env(safe-area-inset-bottom, 0px); --safe-top: env(safe-area-inset-top, 0px);
  }
  input, select, textarea, button { font-family: inherit; }
  input::placeholder, textarea::placeholder { color: var(--textdim); }
  select option { background: var(--surface); color: var(--text); }
  ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  @media (orientation: landscape) and (max-height: 500px) {
    .scan-wrap { aspect-ratio: 16/6 !important; }
    .nav-label { display: none !important; }
    .nav-btn { padding: 4px !important; }
    .grid-auto { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)) !important; }
  }
  @keyframes fadeUp { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
  @keyframes slideUp { from { transform:translateY(100%); } to { transform:translateY(0); } }
  @keyframes scanLine { 0%,100% { transform:translateY(-44px); } 50% { transform:translateY(44px); } }
  @keyframes spin { to { transform:rotate(360deg); } }
  .fade-up { animation: fadeUp 0.25s ease forwards; }
  .slide-up { animation: slideUp 0.3s cubic-bezier(0.32,1,0.5,1) forwards; }
  .tap:active { opacity:0.65; transform:scale(0.96); transition:all 0.1s; }
`;

async function lookupOpenLibrary(isbn) {
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
    const d = await r.json(); const b = d[`ISBN:${isbn}`]; if (!b) return null;
    return { title: b.title||"", author: b.authors?.map(a=>a.name).join(", ")||"", cover: b.cover?.medium||b.cover?.small||null, year: b.publish_date||"", subjects: b.subjects?.map(s=>s.name)||[], publisher: b.publishers?.map(p=>p.name).join(", ")||"", source:"OpenLibrary" };
  } catch { return null; }
}
async function lookupGoogleBooks(isbn) {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`);
    const d = await r.json(); if (!d.items?.length) return null; const v = d.items[0].volumeInfo;
    return { title: v.title||"", author:(v.authors||[]).join(", "), cover: v.imageLinks?.thumbnail||v.imageLinks?.smallThumbnail||null, year: v.publishedDate||"", subjects: v.categories||[], publisher: v.publisher||"", source:"GoogleBooks" };
  } catch { return null; }
}
async function lookupISBN(isbn) { return (await lookupOpenLibrary(isbn)) || (await lookupGoogleBooks(isbn)); }
async function searchBGG(q) {
  // Try Google Books first - works without CORS issues
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q+' board game')}&maxResults=5`);
    const d = await r.json();
    if (d.items?.length) {
      // Find best match - prefer results with board game keywords
      const item = d.items.find(i => {
        const cats = (i.volumeInfo.categories||[]).join(' ').toLowerCase();
        const title = (i.volumeInfo.title||'').toLowerCase();
        return cats.includes('game') || cats.includes('gioc') || title.includes('game');
      }) || d.items[0];
      const v = item.volumeInfo;
      return {
        title: v.title||q,
        designer: (v.authors||[]).join(', '),
        cover: v.imageLinks?.thumbnail||v.imageLinks?.smallThumbnail||null,
        year: v.publishedDate||'',
        categories: v.categories||[],
        minPlayers: '', maxPlayers: '', playingTime: '', rating: '',
        source: 'GoogleBooks'
      };
    }
  } catch {}

  // Fallback: Open Library search
  try {
    const r = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&subject=board+games&limit=1`);
    const d = await r.json();
    if (d.docs?.length) {
      const doc = d.docs[0];
      const coverId = doc.cover_i;
      return {
        title: doc.title||q,
        designer: (doc.author_name||[]).join(', '),
        cover: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
        year: doc.first_publish_year?.toString()||'',
        categories: doc.subject?.slice(0,3)||[],
        minPlayers: '', maxPlayers: '', playingTime: '', rating: '',
        source: 'OpenLibrary'
      };
    }
  } catch {}

  return null;
}

function isISBN(c) { return c&&(c.startsWith("978")||c.startsWith("979"))&&c.length===13; }
const CKWS = ["comic","comics","manga","graphic novel","fumett","marvel","dc comics","bonelli","panini comics","star comics","j-pop","planet manga","dynit"];
const RKWS = ["role-playing","roleplaying","rpg","gioco di ruolo","gdr","dungeons","d&d","pathfinder"];
function detectType(s=[],t="",pub="") { return CKWS.some(k=>[...s,t,pub].join(" ").toLowerCase().includes(k))?"fumetto":"libro"; }
function detectGenre(s=[],cats=[],type="libro") {
  const a=[...s,...cats].map(x=>x.toLowerCase());
  if (a.some(x=>RKWS.some(k=>x.includes(k)))) return "GdR";
  if (type==="fumetto") { if(a.some(x=>x.includes("manga"))) return "Manga"; if(a.some(x=>x.includes("superhero"))) return "Supereroi"; return "Fumetto"; }
  if (a.some(x=>x.includes("fantasy"))) return "Fantasy";
  if (a.some(x=>x.includes("sci-fi")||x.includes("science fiction"))) return "Sci-Fi";
  if (a.some(x=>x.includes("horror"))) return "Horror";
  if (a.some(x=>x.includes("fiction"))) return "Narrativa";
  if (a.some(x=>x.includes("strategy"))) return "Strategia";
  if (a.some(x=>x.includes("party"))) return "Party Game";
  return "Altro";
}
function extractVol(t) { for (const p of [/vol\.?\s*(\d+)/i,/volume\s*(\d+)/i,/#\s*(\d+)/,/,\s*(\d+)$/,/n\.?\s*(\d+)/i,/\((\d+)\)/,/\[(\d+)\]/]) { const m=t.match(p); if(m) return parseInt(m[1],10); } return null; }
function extractSeries(t) { return t.replace(/[,:]?\s*(vol\.?|volume|n\.?|#)\s*\d+.*/i,"").replace(/\s*[\(\[]\d+[\)\]]\s*$/,"").trim()||t; }

const TC = {libro:"var(--libro)",fumetto:"var(--fumetto)",gioco:"var(--gioco)"};
const TI = {libro:"📚",fumetto:"📖",gioco:"🎲"};
const TL = {libro:"LIBRO",fumetto:"FUMETTO",gioco:"GIOCO"};
const GEN = {libro:["GdR","Fantasy","Sci-Fi","Horror","Narrativa","Saggistica","Manuale","Altro"],fumetto:["Manga","Supereroi","GdR","Fantasy","Sci-Fi","Horror","Fumetto","Graphic Novel","Altro"],gioco:["GdR","Strategia","Fantasy","Sci-Fi","Horror","Party Game","Cooperativo","Bambini","Altro"]};
const INP = {width:"100%",padding:"12px 14px",borderRadius:12,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:15,outline:"none",boxSizing:"border-box"};

export default function App() {
  const [user,setUser]=useState(null);
  const [authLoading,setAuthLoading]=useState(true);
  const [items,setItems]=useState([]);
  const [tab,setTab]=useState("scan");
  const [scanning,setScanning]=useState(false);
  const [status,setStatus]=useState({msg:"",type:"idle"});
  const [manualCode,setManualCode]=useState("");
  const [busy,setBusy]=useState(false);
  const [editItem,setEditItem]=useState(null);
  const [manualEntry,setManualEntry]=useState(null);
  const [bggQ,setBggQ]=useState("");
  const [searchQ,setSearchQ]=useState("");
  const [detail,setDetail]=useState(null);
  const [seriesView,setSeriesView]=useState(false);
  const videoRef=useRef(null);
  const readerRef=useRef(null);
  const scanRef=useRef(false);

  useEffect(()=>{ const s=document.createElement("style"); s.textContent=GLOBAL_CSS; document.head.appendChild(s); return()=>s.remove(); },[]);
  useEffect(()=>onAuthStateChanged(auth,u=>{ setUser(u); setAuthLoading(false); }),[]);
  useEffect(()=>{
    if(!user){setItems([]);return;}
    const q=query(collection(db,"items"),where("uid","==",user.uid));
    const u=onSnapshot(q,snap=>{ const d=snap.docs.map(x=>({id:x.id,...x.data()})); d.sort((a,b)=>(b.addedAt||"").localeCompare(a.addedAt||"")); setItems(d); });
    return u;
  },[user]);

  const addItem=async(item)=>{ const{id,...d}=item; await addDoc(collection(db,"items"),{...d,uid:user.uid}); setEditItem(null);setManualEntry(null);setStatus({msg:"✓ Aggiunto!",type:"ok"}); };
  const updateItem=async(item)=>{ const{id,...d}=item; await updateDoc(doc(db,"items",id),d); setDetail(item); };
  const deleteItem=async(id)=>{ await deleteDoc(doc(db,"items",id)); setDetail(null); };

  const stopScan=useCallback(()=>{
    scanRef.current=false;
    if(readerRef.current){try{readerRef.current.reset();}catch{}readerRef.current=null;}
    if(videoRef.current?.srcObject){videoRef.current.srcObject.getTracks().forEach(t=>t.stop());videoRef.current.srcObject=null;}
    setScanning(false);
  },[]);

  const startScan=useCallback(async()=>{
    try{
      setStatus({msg:"Avvio fotocamera…",type:"loading"}); setScanning(true); scanRef.current=true;
      const reader=new BrowserMultiFormatReader(); readerRef.current=reader;
      const devs=await BrowserMultiFormatReader.listVideoInputDevices();
      const rear=devs.find(d=>/back|rear|post|env/i.test(d.label))||devs[devs.length-1]||devs[0];
      if(!rear){setStatus({msg:"Nessuna fotocamera",type:"error"});setScanning(false);return;}
      setStatus({msg:"Inquadra il barcode nel riquadro",type:"loading"});
      await reader.decodeFromVideoDevice(rear.deviceId,videoRef.current,(res)=>{ if(!scanRef.current||!res)return; stopScan(); handleBarcode(res.getText()); });
    } catch(e){setStatus({msg:"Errore: "+e.message,type:"error"});setScanning(false);}
  },[stopScan]);

  useEffect(()=>()=>stopScan(),[stopScan]);

  const handleBarcode=async(code)=>{
    if(items.some(i=>i.barcode===code)){setStatus({msg:"⚠️ Già presente!",type:"error"});return;}
    setBusy(true); setStatus({msg:isISBN(code)?`ISBN: ${code} — Ricerca…`:`EAN: ${code} — Ricerca…`,type:"loading"});
    const data=await lookupISBN(code);
    if(data){
      const tp=detectType(data.subjects,data.title,data.publisher); const vn=extractVol(data.title);
      setEditItem({id:"_new",type:tp,barcode:code,title:data.title,author:data.author||"",cover:data.cover||"",year:data.year||"",genre:detectGenre(data.subjects,[],tp),publisher:data.publisher||"",series:vn?extractSeries(data.title):"",volumeNumber:vn||"",totalVolumes:"",notes:"",addedAt:new Date().toISOString()});
      setStatus({msg:`✓ ${data.title}`,type:"ok"});
    } else if(isISBN(code)){
      setManualEntry({type:"libro",barcode:code}); setStatus({msg:"Non trovato. Inserisci manualmente.",type:"error"});
    } else {
      setManualEntry({type:"gioco",barcode:code}); setStatus({msg:"EAN non-ISBN — cerca su BGG",type:"idle"});
    }
    setBusy(false);
  };

  const handleBGG=async()=>{
    if(!bggQ.trim())return; setBusy(true); setStatus({msg:"Cerco su BoardGameGeek…",type:"loading"});
    const data=await searchBGG(bggQ);
    if(data){
      setEditItem({id:"_new",type:"gioco",barcode:manualEntry?.barcode||"",title:data.title,designer:data.designer||"",cover:data.image||"",year:data.year||"",genre:detectGenre([],data.categories,"gioco"),minPlayers:data.minPlayers||"",maxPlayers:data.maxPlayers||"",playingTime:data.playingTime||"",rating:data.rating||"",notes:"",addedAt:new Date().toISOString()});
      setManualEntry(null); setStatus({msg:`✓ ${data.title}`,type:"ok"});
    } else { setStatus({msg:"Non trovato su BGG.",type:"error"}); }
    setBusy(false);
  };

  const blank=(type)=>({id:"_new",type,barcode:"",title:"",author:"",designer:"",cover:"",year:"",genre:"Altro",publisher:"",series:"",volumeNumber:"",totalVolumes:"",minPlayers:"",maxPlayers:"",playingTime:"",rating:"",notes:"",addedAt:new Date().toISOString()});

  const counts={libro:items.filter(i=>i.type==="libro").length,gioco:items.filter(i=>i.type==="gioco").length,fumetto:items.filter(i=>i.type==="fumetto").length};
  const searchRes=searchQ.trim()?items.filter(i=>{const q=searchQ.toLowerCase();return i.title?.toLowerCase().includes(q)||(i.author||i.designer||"").toLowerCase().includes(q)||(i.genre||"").toLowerCase().includes(q)||(i.series||"").toLowerCase().includes(q);}):[];

  const series=(() => {
    const m={};
    items.filter(i=>i.type==="fumetto"&&i.series).forEach(c=>{
      const k=c.series.toLowerCase().trim();
      if(!m[k])m[k]={name:c.series,items:[],totalVolumes:0,cover:null};
      m[k].items.push(c); if(c.cover&&!m[k].cover)m[k].cover=c.cover;
      const tv=parseInt(c.totalVolumes); if(tv>m[k].totalVolumes)m[k].totalVolumes=tv;
    });
    Object.values(m).forEach(s=>s.items.sort((a,b)=>(parseInt(a.volumeNumber)||0)-(parseInt(b.volumeNumber)||0)));
    return m;
  })();
  const missing=(s)=>{ if(!s.totalVolumes)return[]; const o=new Set(s.items.map(i=>parseInt(i.volumeNumber)).filter(Boolean)); return Array.from({length:s.totalVolumes},(_,i)=>i+1).filter(i=>!o.has(i)); };

  if(authLoading) return <div style={{background:"var(--bg)",height:"100vh",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{width:36,height:36,border:"3px solid var(--border)",borderTopColor:"var(--accent)",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/></div>;

  if(!user) return (
    <div style={{background:"var(--bg)",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"'DM Sans',sans-serif"}}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <div className="fade-up" style={{display:"flex",flexDirection:"column",alignItems:"center",gap:20,maxWidth:340,width:"100%",textAlign:"center"}}>
        <div style={{width:88,height:88,borderRadius:24,background:"linear-gradient(135deg,var(--accent),var(--fumetto))",display:"flex",alignItems:"center",justifyContent:"center",fontSize:40,boxShadow:"0 16px 48px rgba(232,184,75,0.35)"}}>📚</div>
        <div>
          <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:30,fontWeight:800,color:"var(--accent)",margin:"0 0 8px"}}>La Mia Collezione</h1>
          <p style={{color:"var(--textdim)",fontSize:15,margin:0,lineHeight:1.6}}>Libri, fumetti e giochi in un unico posto</p>
        </div>
        <button onClick={()=>signInWithPopup(auth,googleProvider)} className="tap"
          style={{display:"flex",alignItems:"center",gap:12,padding:"15px 28px",borderRadius:16,border:"none",background:"#fff",color:"#1a1a1a",fontSize:16,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 24px rgba(0,0,0,0.4)",width:"100%",justifyContent:"center"}}>
          <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" width={22} alt=""/>
          Accedi con Google
        </button>
      </div>
    </div>
  );

  const TABS=[{id:"scan",icon:"📷",label:"Scan"},{id:"search",icon:"🔍",label:"Cerca"},{id:"libri",icon:"📚",label:"Libri"},{id:"fumetti",icon:"📖",label:"Fumetti"},{id:"giochi",icon:"🎲",label:"Giochi"}];

  return (
    <div style={{background:"var(--bg)",minHeight:"100vh",color:"var(--text)",fontFamily:"'DM Sans',sans-serif",display:"flex",flexDirection:"column",maxWidth:600,margin:"0 auto",position:"relative"}}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>

      {/* Header */}
      <div style={{padding:"calc(10px + var(--safe-top)) 16px 10px",background:"rgba(19,21,30,0.92)",backdropFilter:"blur(20px)",borderBottom:"1px solid var(--border)",position:"sticky",top:0,zIndex:50,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div>
          <h1 style={{fontFamily:"'Playfair Display',serif",fontSize:19,fontWeight:800,margin:0,color:"var(--accent)",letterSpacing:-0.3}}>La Mia Collezione</h1>
          <div style={{display:"flex",gap:10,marginTop:3}}>
            {[["libro","var(--libro)",counts.libro,"libri"],["fumetto","var(--fumetto)",counts.fumetto,"fumetti"],["gioco","var(--gioco)",counts.gioco,"giochi"]].map(([t,c,n,l])=>(
              <span key={t} style={{fontSize:10,color:"var(--textdim)",display:"flex",alignItems:"center",gap:3}}>
                <span style={{width:5,height:5,borderRadius:"50%",background:c,display:"inline-block"}}/>
                {n} {l}
              </span>
            ))}
          </div>
        </div>
        <button onClick={()=>signOut(auth)} className="tap"
          style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:10,border:"1px solid var(--border)",background:"transparent",color:"var(--textdim)",cursor:"pointer",fontSize:12}}>
          {user.photoURL&&<img src={user.photoURL} alt="" style={{width:20,height:20,borderRadius:"50%"}}/>}
          Esci
        </button>
      </div>

      {/* Content */}
      <div style={{flex:1,overflowY:"auto",padding:"16px",paddingBottom:"calc(76px + var(--safe-bottom))"}}>

        {/* SCAN */}
        {tab==="scan"&&(<div className="fade-up">
          <div className="scan-wrap" style={{position:"relative",borderRadius:18,overflow:"hidden",background:"#000",marginBottom:14,aspectRatio:"4/3",border:`1.5px solid ${scanning?"var(--accent)":"var(--border)"}`,transition:"border-color 0.3s",boxShadow:scanning?"0 0 0 1px var(--accent), 0 8px 32px rgba(232,184,75,0.15)":"none"}}>
            <video ref={videoRef} style={{width:"100%",height:"100%",objectFit:"cover",display:scanning?"block":"none"}} playsInline muted/>
            {!scanning&&<div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:20}}>
              <div style={{width:70,height:70,borderRadius:20,background:"rgba(232,184,75,0.1)",border:"1px solid rgba(232,184,75,0.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30}}>📷</div>
              <button onClick={startScan} className="tap" style={{background:"var(--accent)",color:"#0a0b0f",border:"none",borderRadius:16,padding:"14px 36px",fontSize:16,fontWeight:800,cursor:"pointer",boxShadow:"0 6px 24px rgba(232,184,75,0.4)",letterSpacing:0.3}}>Avvia Scanner</button>
            </div>}
            {scanning&&<>
              <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.5)"}}/>
              <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                <div style={{position:"relative",width:"68%",height:"36%"}}>
                  <div style={{position:"absolute",inset:0,borderRadius:12,boxShadow:"0 0 0 9999px rgba(0,0,0,0.5)"}}/>
                  {[
                    {top:0,left:0,borderTop:"3px solid var(--accent)",borderLeft:"3px solid var(--accent)",borderRadius:"8px 0 0 0"},
                    {top:0,right:0,borderTop:"3px solid var(--accent)",borderRight:"3px solid var(--accent)",borderRadius:"0 8px 0 0"},
                    {bottom:0,left:0,borderBottom:"3px solid var(--accent)",borderLeft:"3px solid var(--accent)",borderRadius:"0 0 0 8px"},
                    {bottom:0,right:0,borderBottom:"3px solid var(--accent)",borderRight:"3px solid var(--accent)",borderRadius:"0 0 8px 0"},
                  ].map((corner,i)=>(
                    <div key={i} style={{position:"absolute",width:22,height:22,...corner}}/>
                  ))}
                  <div style={{position:"absolute",left:4,right:4,top:"50%",height:2,background:"linear-gradient(90deg,transparent,var(--accent),transparent)",animation:"scanLine 2s ease-in-out infinite"}}/>
                </div>
              </div>
            </>}
          </div>

          {scanning&&<button onClick={stopScan} className="tap" style={{width:"100%",padding:13,borderRadius:14,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--text)",cursor:"pointer",fontSize:14,marginBottom:12,fontWeight:600}}>⏹ Ferma scanner</button>}

          {status.msg&&<div style={{padding:"11px 14px",borderRadius:12,marginBottom:12,fontSize:13,fontWeight:600,background:status.type==="ok"?"rgba(77,217,138,0.1)":status.type==="error"?"rgba(245,91,91,0.1)":status.type==="loading"?"rgba(232,184,75,0.08)":"var(--surface)",border:`1px solid ${status.type==="ok"?"rgba(77,217,138,0.25)":status.type==="error"?"rgba(245,91,91,0.25)":status.type==="loading"?"rgba(232,184,75,0.15)":"var(--border)"}`,color:status.type==="ok"?"var(--green)":status.type==="error"?"var(--red)":status.type==="loading"?"var(--accent)":"var(--textdim)",display:"flex",alignItems:"center",gap:8}}>
            {status.type==="loading"&&<span style={{width:12,height:12,border:"2px solid currentColor",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.6s linear infinite",flexShrink:0,display:"inline-block"}}/>}
            {status.msg}
          </div>}

          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <input value={manualCode} onChange={e=>setManualCode(e.target.value)} placeholder="Codice manuale…"
              style={{...INP,flex:1,fontSize:14}} onKeyDown={e=>{if(e.key==="Enter"&&manualCode.trim()){handleBarcode(manualCode.trim());setManualCode("");}}}/>
            <button onClick={()=>{if(manualCode.trim()){handleBarcode(manualCode.trim());setManualCode("");}}} className="tap"
              style={{padding:"12px 16px",borderRadius:12,border:"none",background:"var(--accent)",color:"#0a0b0f",fontWeight:800,cursor:"pointer",fontSize:14,whiteSpace:"nowrap"}}>Cerca</button>
          </div>

          <div style={{display:"flex",gap:8,marginBottom:14}}>
            {[["libro","var(--libro)","📚","Libro"],["fumetto","var(--fumetto)","📖","Fumetto"],["gioco","var(--gioco)","🎲","Gioco"]].map(([t,c,icon,l])=>(
              <button key={t} className="tap" onClick={()=>{if(t==="gioco")setManualEntry({type:"gioco",barcode:""});else setEditItem(blank(t));}}
                style={{flex:1,padding:"10px 4px",borderRadius:14,border:`1.5px solid ${c}35`,background:`${c}0d`,color:c,cursor:"pointer",fontSize:12,fontWeight:700,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <span style={{fontSize:20}}>{icon}</span>+ {l}
              </button>
            ))}
          </div>

          {manualEntry?.type==="gioco"&&!editItem&&<div className="fade-up" style={{padding:14,borderRadius:16,background:"var(--surface)",border:"1px solid var(--border)",marginBottom:14}}>
            <p style={{margin:"0 0 10px",fontWeight:700,color:"var(--gioco)",fontSize:14}}>🎲 Cerca su BoardGameGeek</p>
            <div style={{display:"flex",gap:8}}>
              <input value={bggQ} onChange={e=>setBggQ(e.target.value)} placeholder="Nome del gioco…" style={{...INP,flex:1,fontSize:14}} onKeyDown={e=>{if(e.key==="Enter")handleBGG();}}/>
              <button onClick={handleBGG} disabled={busy} className="tap" style={{padding:"12px 16px",borderRadius:12,border:"none",background:"var(--gioco)",color:"#fff",fontWeight:700,cursor:"pointer",fontSize:14}}>Cerca</button>
            </div>
            <button onClick={()=>{setEditItem(blank("gioco"));setManualEntry(null);}} className="tap" style={{marginTop:10,width:"100%",padding:10,borderRadius:10,border:"1px solid var(--border)",background:"transparent",color:"var(--textdim)",cursor:"pointer",fontSize:13}}>Inserisci manualmente</button>
          </div>}

          {editItem&&<EForm item={editItem} onSave={addItem} onCancel={()=>{setEditItem(null);setManualEntry(null);}}/>}
        </div>)}

        {/* SEARCH */}
        {tab==="search"&&(<div className="fade-up">
          <div style={{position:"relative",marginBottom:10}}>
            <span style={{position:"absolute",left:14,top:"50%",transform:"translateY(-50%)",fontSize:16,pointerEvents:"none"}}>🔍</span>
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} placeholder="Titolo, autore, serie, genere…" autoFocus style={{...INP,paddingLeft:44}}/>
          </div>
          {searchQ.trim()&&searchRes.length>0&&<div style={{borderRadius:14,border:"1px solid var(--border)",overflow:"hidden",background:"var(--surface)"}}>
            {searchRes.map((it,i)=>(
              <div key={it.id} onClick={()=>setDetail(it)} className="tap"
                style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px",cursor:"pointer",borderBottom:i<searchRes.length-1?"1px solid var(--border)":"none"}}>
                <span style={{fontSize:9,fontWeight:800,padding:"3px 8px",borderRadius:6,background:`${TC[it.type]}20`,color:TC[it.type],whiteSpace:"nowrap",letterSpacing:0.4}}>{TL[it.type]}</span>
                {it.cover&&<img src={it.cover} alt="" style={{width:34,height:46,objectFit:"cover",borderRadius:8}}/>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:14,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.title}</div>
                  <div style={{fontSize:11,color:"var(--textdim)",marginTop:2}}>{it.author||it.designer||""}{it.series?` · ${it.series}`:""}{it.year?` (${it.year})`:""}</div>
                </div>
                <span style={{fontSize:10,color:"var(--accent)",background:"rgba(232,184,75,0.1)",padding:"3px 8px",borderRadius:8,whiteSpace:"nowrap"}}>{it.genre}</span>
              </div>
            ))}
          </div>}
          {searchQ.trim()&&!searchRes.length&&<Empty icon="🔍" text={`Nessun risultato per "${searchQ}"`}/>}
          {!searchQ.trim()&&<Empty icon="✨" text="Inizia a digitare per cercare"/>}
        </div>)}

        {tab==="libri"&&<Grid items={items.filter(i=>i.type==="libro")} type="libro" onSelect={setDetail}/>}

        {tab==="fumetti"&&(<div className="fade-up">
          <div style={{display:"flex",gap:8,marginBottom:14}}>
            {[["Tutti",false],["Per serie",true]].map(([l,v])=>(
              <button key={l} onClick={()=>setSeriesView(v)} className="tap"
                style={{padding:"8px 18px",borderRadius:20,border:"none",cursor:"pointer",background:seriesView===v?"var(--fumetto)":"var(--surface)",color:seriesView===v?"#fff":"var(--textdim)",fontSize:13,fontWeight:700,transition:"all 0.2s"}}>{l}</button>
            ))}
          </div>
          {!seriesView?<Grid items={items.filter(i=>i.type==="fumetto")} type="fumetto" onSelect={setDetail}/>:(
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {!Object.keys(series).length&&<Empty icon="📖" text="Nessuna serie. Aggiungi fumetti con il campo Serie."/>}
              {Object.values(series).map(s=>{
                const miss=missing(s); const pct=s.totalVolumes>0?Math.min(100,(s.items.length/s.totalVolumes)*100):0;
                return <div key={s.name} style={{background:"var(--card)",borderRadius:16,border:"1px solid var(--border)",overflow:"hidden"}}>
                  <div style={{display:"flex",gap:14,padding:14}}>
                    {s.cover?<img src={s.cover} alt="" style={{width:54,height:72,objectFit:"cover",borderRadius:10}}/>:<div style={{width:54,height:72,borderRadius:10,background:"var(--surface)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>📖</div>}
                    <div style={{flex:1,minWidth:0}}>
                      <h3 style={{margin:"0 0 4px",fontSize:15,fontWeight:800,fontFamily:"'Playfair Display',serif",color:"var(--fumetto)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</h3>
                      <p style={{margin:"0 0 8px",fontSize:12,color:"var(--textdim)"}}>{s.items.length} vol.{s.totalVolumes?` su ${s.totalVolumes}`:""}</p>
                      {s.totalVolumes>0&&<div style={{height:5,borderRadius:3,background:"var(--border)",overflow:"hidden"}}><div style={{height:"100%",borderRadius:3,background:"var(--fumetto)",width:`${pct}%`,transition:"width 0.5s"}}/></div>}
                      {miss.length>0&&<p style={{margin:"6px 0 0",fontSize:11,color:"var(--red)",fontWeight:600}}>Mancanti: {miss.length<=12?miss.join(", "):`${miss.slice(0,12).join(", ")}… (${miss.length})`}</p>}
                    </div>
                  </div>
                  <div style={{padding:"0 14px 12px",display:"flex",flexWrap:"wrap",gap:6}}>
                    {s.items.map(v=><span key={v.id} onClick={()=>setDetail(v)} className="tap" style={{padding:"4px 10px",borderRadius:8,fontSize:12,fontWeight:700,background:"rgba(185,110,245,0.15)",color:"var(--fumetto)",cursor:"pointer"}}>#{v.volumeNumber||"?"}</span>)}
                  </div>
                </div>;
              })}
              {(()=>{ const st=items.filter(i=>i.type==="fumetto"&&!i.series); if(!st.length)return null; return <div><p style={{fontSize:12,color:"var(--textdim)",margin:"8px 0"}}>Senza serie</p><Grid items={st} type="fumetto" onSelect={setDetail}/></div>; })()}
            </div>
          )}
        </div>)}

        {tab==="giochi"&&<Grid items={items.filter(i=>i.type==="gioco")} type="gioco" onSelect={setDetail}/>}
      </div>

      {/* Bottom Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:600,background:"rgba(13,15,20,0.96)",backdropFilter:"blur(24px)",borderTop:"1px solid var(--border)",zIndex:100,paddingBottom:"var(--safe-bottom)"}}>
        <div style={{display:"flex",padding:"6px 0 8px"}}>
          {TABS.map(t=>(
            <button key={t.id} className="nav-btn tap" onClick={()=>{setTab(t.id);if(t.id!=="scan")stopScan();}}
              style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"6px 2px",border:"none",background:"transparent",cursor:"pointer",color:tab===t.id?"var(--accent)":"var(--textdim)",transition:"color 0.2s"}}>
              <span style={{fontSize:22,lineHeight:1,filter:tab===t.id?"drop-shadow(0 0 8px rgba(232,184,75,0.6))":"none",transition:"filter 0.2s"}}>{t.icon}</span>
              <span className="nav-label" style={{fontSize:10,fontWeight:tab===t.id?700:500}}>{t.label}</span>
              {tab===t.id&&<div style={{width:3,height:3,borderRadius:"50%",background:"var(--accent)"}}/>}
            </button>
          ))}
        </div>
      </div>

      {detail&&<Modal item={detail} onClose={()=>setDetail(null)} onDelete={deleteItem} onUpdate={updateItem}/>}
    </div>
  );
}

function Empty({icon,text}) {
  return <div style={{textAlign:"center",padding:"48px 24px",color:"var(--textdim)"}}><div style={{fontSize:40,marginBottom:12,opacity:0.4}}>{icon}</div><p style={{fontSize:14,margin:0,lineHeight:1.6}}>{text}</p></div>;
}

function Grid({items,type,onSelect}) {
  const [f,setF]=useState("Tutti");
  const genres=["Tutti",...new Set(items.map(i=>i.genre).filter(Boolean))];
  const filtered=f==="Tutti"?items:items.filter(i=>i.genre===f);
  return <div className="fade-up">
    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:14}}>
      {genres.map(g=><button key={g} onClick={()=>setF(g)} className="tap" style={{padding:"6px 14px",borderRadius:20,border:"none",cursor:"pointer",background:f===g?TC[type]:"var(--surface)",color:f===g?"#fff":"var(--textdim)",fontSize:12,fontWeight:700,transition:"all 0.2s"}}>{g}</button>)}
    </div>
    {!filtered.length?<Empty icon={TI[type]} text={!items.length?"Nessun elemento. Scansiona!":"Nessun risultato."}/>:(
      <div className="grid-auto" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:12}}>
        {filtered.map(it=>(
          <div key={it.id} onClick={()=>onSelect(it)} className="tap" style={{background:"var(--card)",borderRadius:14,overflow:"hidden",cursor:"pointer",border:"1px solid var(--border)"}}>
            <div style={{aspectRatio:"2/3",background:"var(--surface)",display:"flex",alignItems:"center",justifyContent:"center",position:"relative",overflow:"hidden"}}>
              {it.cover?<img src={it.cover} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<span style={{fontSize:34,opacity:0.15}}>{TI[type]}</span>}
              {it.volumeNumber&&<span style={{position:"absolute",top:6,right:6,background:"var(--fumetto)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 7px",borderRadius:6,boxShadow:"0 2px 8px rgba(0,0,0,0.4)"}}>#{it.volumeNumber}</span>}
              <div style={{position:"absolute",bottom:0,left:0,right:0,height:"50%",background:"linear-gradient(to top,rgba(0,0,0,0.75),transparent)"}}/>
            </div>
            <div style={{padding:"9px 10px 10px"}}>
              <div style={{fontSize:12,fontWeight:700,lineHeight:1.3,marginBottom:4,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{it.title||"Senza titolo"}</div>
              <div style={{fontSize:10,color:"var(--textdim)",marginBottom:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{it.author||it.designer||it.series||""}</div>
              <span style={{fontSize:9,fontWeight:800,padding:"2px 7px",borderRadius:6,background:`${TC[type]}18`,color:TC[type],letterSpacing:0.3}}>{it.genre}</span>
            </div>
          </div>
        ))}
      </div>
    )}
  </div>;
}

function EForm({item,onSave,onCancel}) {
  const [d,setD]=useState({...item});
  const s=(k,v)=>setD(p=>({...p,[k]:v}));
  return <div className="fade-up" style={{padding:16,borderRadius:18,background:"var(--surface)",border:`1.5px solid ${TC[d.type]}35`,marginBottom:14}}>
    <div style={{display:"flex",gap:5,marginBottom:14,background:"var(--surface2)",borderRadius:12,padding:4}}>
      {["libro","fumetto","gioco"].map(t=><button key={t} onClick={()=>s("type",t)} className="tap" style={{flex:1,padding:"8px 4px",borderRadius:9,border:"none",cursor:"pointer",background:d.type===t?TC[t]:"transparent",color:d.type===t?"#fff":"var(--textdim)",fontSize:11,fontWeight:700,transition:"all 0.2s"}}>{TI[t]} {TL[t]}</button>)}
    </div>
    {d.cover&&<div style={{display:"flex",gap:12,marginBottom:14,alignItems:"center"}}>
      <img src={d.cover} alt="" style={{width:48,height:66,objectFit:"cover",borderRadius:8}}/>
      <div><p style={{margin:0,fontSize:13,fontWeight:600}}>{d.title}</p>{d.barcode&&<p style={{margin:"4px 0 0",fontSize:11,color:"var(--textdim)",fontFamily:"monospace"}}>📷 {d.barcode}</p>}</div>
    </div>}
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      <input value={d.title} onChange={e=>s("title",e.target.value)} placeholder="Titolo *" style={INP}/>
      {(d.type==="libro"||d.type==="fumetto")&&<input value={d.author||""} onChange={e=>s("author",e.target.value)} placeholder="Autore" style={INP}/>}
      {d.type==="gioco"&&<input value={d.designer||""} onChange={e=>s("designer",e.target.value)} placeholder="Designer" style={INP}/>}
      {(d.type==="libro"||d.type==="fumetto")&&<input value={d.publisher||""} onChange={e=>s("publisher",e.target.value)} placeholder="Editore" style={INP}/>}
      {d.type==="fumetto"&&<div style={{display:"flex",gap:8}}><input value={d.series||""} onChange={e=>s("series",e.target.value)} placeholder="Serie" style={{...INP,flex:2}}/><input value={d.volumeNumber||""} onChange={e=>s("volumeNumber",e.target.value)} placeholder="N°" style={{...INP,flex:1}} type="number"/><input value={d.totalVolumes||""} onChange={e=>s("totalVolumes",e.target.value)} placeholder="Tot." style={{...INP,flex:1}} type="number"/></div>}
      {d.type==="gioco"&&<div style={{display:"flex",gap:8}}><input value={d.minPlayers||""} onChange={e=>s("minPlayers",e.target.value)} placeholder="Min" style={{...INP,flex:1}}/><input value={d.maxPlayers||""} onChange={e=>s("maxPlayers",e.target.value)} placeholder="Max" style={{...INP,flex:1}}/><input value={d.playingTime||""} onChange={e=>s("playingTime",e.target.value)} placeholder="Min." style={{...INP,flex:1}}/></div>}
      <div style={{display:"flex",gap:8}}><input value={d.year||""} onChange={e=>s("year",e.target.value)} placeholder="Anno" style={{...INP,flex:1}}/><select value={d.genre} onChange={e=>s("genre",e.target.value)} style={{...INP,flex:1.5,cursor:"pointer"}}>{GEN[d.type].map(g=><option key={g} value={g}>{g}</option>)}</select></div>
      <textarea value={d.notes||""} onChange={e=>s("notes",e.target.value)} placeholder="Note…" rows={2} style={{...INP,resize:"vertical"}}/>
    </div>
    <div style={{display:"flex",gap:8,marginTop:14}}>
      <button onClick={()=>onSave(d)} disabled={!d.title.trim()} className="tap" style={{flex:1,padding:14,borderRadius:14,border:"none",background:d.title.trim()?"var(--green)":"var(--border)",color:d.title.trim()?"#0a0b0f":"var(--textdim)",fontWeight:800,cursor:d.title.trim()?"pointer":"not-allowed",fontSize:15}}>✓ Salva</button>
      <button onClick={onCancel} className="tap" style={{padding:"14px 18px",borderRadius:14,border:"1px solid var(--border)",background:"transparent",color:"var(--textdim)",cursor:"pointer",fontSize:15}}>✕</button>
    </div>
  </div>;
}

function Modal({item,onClose,onDelete,onUpdate}) {
  const [editing,setEditing]=useState(false);
  const [d,setD]=useState({...item});
  const s=(k,v)=>setD(p=>({...p,[k]:v}));
  const startY=useRef(0);
  const onTS=(e)=>{startY.current=e.touches[0].clientY;};
  const onTE=(e)=>{if(e.changedTouches[0].clientY-startY.current>70)onClose();};

  return <div style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={onClose}>
    <div className="slide-up" onTouchStart={onTS} onTouchEnd={onTE}
      style={{width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto",background:"var(--surface)",borderRadius:"22px 22px 0 0",paddingBottom:"calc(20px + var(--safe-bottom))"}}
      onClick={e=>e.stopPropagation()}>
      <div style={{display:"flex",justifyContent:"center",padding:"10px 0 4px"}}><div style={{width:36,height:4,borderRadius:2,background:"var(--border)"}}/></div>
      <div style={{padding:"4px 20px 20px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <span style={{fontSize:11,fontWeight:800,padding:"4px 10px",borderRadius:8,background:`${TC[item.type]}18`,color:TC[item.type],letterSpacing:0.5}}>{TI[item.type]} {TL[item.type]}</span>
          <button onClick={onClose} className="tap" style={{background:"var(--surface2)",border:"none",color:"var(--textdim)",cursor:"pointer",width:32,height:32,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>✕</button>
        </div>
        {item.cover&&<div style={{textAlign:"center",marginBottom:16}}><img src={item.cover} alt="" style={{maxHeight:200,borderRadius:14,boxShadow:"0 8px 40px rgba(0,0,0,0.6)"}}/></div>}
        {!editing?(<>
          <h2 style={{fontFamily:"'Playfair Display',serif",fontSize:22,fontWeight:800,margin:"0 0 4px"}}>{item.title}</h2>
          <p style={{margin:"0 0 14px",color:"var(--textdim)",fontSize:14}}>{item.author||item.designer||""}{item.year?` · ${item.year}`:""}</p>
          <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:16}}>
            {[[item.genre,"var(--accent)"],[item.series&&`${item.series}${item.volumeNumber?` #${item.volumeNumber}`:""}`,TC.fumetto],[item.totalVolumes&&`Tot. ${item.totalVolumes} vol.`,"var(--textdim)"],[item.minPlayers&&`👥 ${item.minPlayers}${item.maxPlayers?`–${item.maxPlayers}`:""}`,TC.libro],[item.playingTime&&`⏱ ${item.playingTime} min`,"var(--green)"],[item.rating&&parseFloat(item.rating)>0&&`⭐ ${parseFloat(item.rating).toFixed(1)}`,"var(--accent)"]].filter(([t])=>t).map(([t,c],i)=>(
              <span key={i} style={{padding:"4px 11px",borderRadius:20,fontSize:12,fontWeight:600,background:`${c}15`,color:c,border:`1px solid ${c}25`}}>{t}</span>
            ))}
          </div>
          {item.publisher&&<p style={{fontSize:13,color:"var(--textdim)",margin:"0 0 4px"}}>Editore: {item.publisher}</p>}
          {item.barcode&&<p style={{fontSize:11,color:"var(--textdim)",margin:"0 0 4px",fontFamily:"monospace"}}>📷 {item.barcode}</p>}
          {item.notes&&<div style={{marginTop:12,padding:12,background:"var(--surface2)",borderRadius:12,fontSize:13,lineHeight:1.6}}>{item.notes}</div>}
          <div style={{display:"flex",gap:10,marginTop:20}}>
            <button onClick={()=>{setD({...item});setEditing(true);}} className="tap" style={{flex:1,padding:14,borderRadius:14,border:`1.5px solid ${TC[item.type]}`,background:`${TC[item.type]}10`,color:TC[item.type],fontWeight:700,cursor:"pointer",fontSize:14}}>✏️ Modifica</button>
            <button onClick={()=>{if(window.confirm("Eliminare?"))onDelete(item.id);}} className="tap" style={{padding:"14px 18px",borderRadius:14,border:"1.5px solid rgba(245,91,91,0.3)",background:"rgba(245,91,91,0.08)",color:"var(--red)",fontWeight:700,cursor:"pointer",fontSize:14}}>🗑</button>
          </div>
        </>):(
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <input value={d.title} onChange={e=>s("title",e.target.value)} placeholder="Titolo" style={INP}/>
            {(d.type==="libro"||d.type==="fumetto")&&<input value={d.author||""} onChange={e=>s("author",e.target.value)} placeholder="Autore" style={INP}/>}
            {d.type==="gioco"&&<input value={d.designer||""} onChange={e=>s("designer",e.target.value)} placeholder="Designer" style={INP}/>}
            {(d.type==="libro"||d.type==="fumetto")&&<input value={d.publisher||""} onChange={e=>s("publisher",e.target.value)} placeholder="Editore" style={INP}/>}
            {d.type==="fumetto"&&<div style={{display:"flex",gap:8}}><input value={d.series||""} onChange={e=>s("series",e.target.value)} placeholder="Serie" style={{...INP,flex:2}}/><input value={d.volumeNumber||""} onChange={e=>s("volumeNumber",e.target.value)} placeholder="N°" style={{...INP,flex:1}} type="number"/><input value={d.totalVolumes||""} onChange={e=>s("totalVolumes",e.target.value)} placeholder="Tot." style={{...INP,flex:1}} type="number"/></div>}
            {d.type==="gioco"&&<div style={{display:"flex",gap:8}}><input value={d.minPlayers||""} onChange={e=>s("minPlayers",e.target.value)} placeholder="Min" style={{...INP,flex:1}}/><input value={d.maxPlayers||""} onChange={e=>s("maxPlayers",e.target.value)} placeholder="Max" style={{...INP,flex:1}}/><input value={d.playingTime||""} onChange={e=>s("playingTime",e.target.value)} placeholder="Min." style={{...INP,flex:1}}/></div>}
            <div style={{display:"flex",gap:8}}><input value={d.year||""} onChange={e=>s("year",e.target.value)} placeholder="Anno" style={{...INP,flex:1}}/><select value={d.genre} onChange={e=>s("genre",e.target.value)} style={{...INP,flex:1.5,cursor:"pointer"}}>{GEN[d.type].map(g=><option key={g} value={g}>{g}</option>)}</select></div>
            <textarea value={d.notes||""} onChange={e=>s("notes",e.target.value)} placeholder="Note…" rows={2} style={{...INP,resize:"vertical"}}/>
            <div style={{display:"flex",gap:8,marginTop:4}}>
              <button onClick={()=>{onUpdate(d);setEditing(false);}} className="tap" style={{flex:1,padding:14,borderRadius:14,border:"none",background:"var(--green)",color:"#0a0b0f",fontWeight:800,cursor:"pointer",fontSize:15}}>✓ Salva</button>
              <button onClick={()=>setEditing(false)} className="tap" style={{padding:"14px 18px",borderRadius:14,border:"1px solid var(--border)",background:"transparent",color:"var(--textdim)",cursor:"pointer",fontSize:15}}>✕</button>
            </div>
          </div>
        )}
      </div>
    </div>
  </div>;
}
