"use strict";
const $ = id => document.getElementById(id);
const words = {
  es: {
    title:"Por Costa Rica · Localizador", heading:"¿Dónde en", punct:"?", intro:"Encontrá tu provincia, cantón, distrito y código postal con tu ubicación o tocando el mapa.",
    district:"Distrito", province:"Provincia", canton:"Cantón", postal:"Código postal", copy:"Copiar", copied:"Copiado",
    locate:"Usar mi ubicación", coords:"Ingresar coordenadas", latlon:"Latitud, longitud", find:"Buscar",
    map:"Mapa de distritos", center:"Consultar centro del mapa", tap:"Tocá un punto para consultarlo", selected:"Punto seleccionado",
    sources:"Fuentes del mapa", sourceText:"Los límites y nombres provienen del Instituto Geográfico Nacional (versión del 10 de abril de 2026). El código de cinco dígitos combina provincia, cantón y distrito. Podés consultarlo también en Correos de Costa Rica.",
    carto:"Cartografía regional de Natural Earth. Calles de OpenStreetMap. La consulta del distrito se hace en tu dispositivo.",
    close:"Cerrar", plus:"Acercar", minus:"Alejar", reset:"Ver Costa Rica", locating:"Buscando tu ubicación…", loading:"Consultando el punto…",
    denied:"No hay permiso de ubicación. Tocá el mapa o ingresá coordenadas.", unavailable:"No pudimos obtener tu ubicación. Tocá el mapa o ingresá coordenadas.",
    invalid:"Usá dos números separados por coma, por ejemplo 9.9333, -84.0833.", outside:"Este punto queda fuera de los distritos del mapa. Elegí otro punto.",
    failed:"No se pudo cargar la cartografía. Revisá tu conexión y volvé a seleccionar el punto.", border:"El punto está en un límite o muy cerca. Acercá el mapa y confirmá de qué lado está.",
    uncertain:"El margen de precisión de tu ubicación alcanza otro distrito. Acercá el mapa y tocá tu ubicación exacta.", copyFailed:"Seleccioná el código postal para copiarlo.",
    pacific:"Océano Pacífico", caribbean:"Mar Caribe", keyboard:"Mapa de Costa Rica. Usá las flechas para moverlo y Enter para consultar el centro."
  },
  en: {
    title:"Por Costa Rica · District finder", heading:"Where in", punct:"?", intro:"Find your province, canton, district and postal code using your location or a point on the map.",
    district:"District", province:"Province", canton:"Canton", postal:"Postal code", copy:"Copy", copied:"Copied",
    locate:"Use my location", coords:"Enter coordinates", latlon:"Latitude, longitude", find:"Find",
    map:"District map", center:"Look up map center", tap:"Select a point to look it up", selected:"Selected point",
    sources:"Map sources", sourceText:"District boundaries and names come from Costa Rica’s Instituto Geográfico Nacional (April 10, 2026 release). The five-digit code combines province, canton and district. You can also look it up with Correos de Costa Rica.",
    carto:"Regional cartography by Natural Earth. Street maps by OpenStreetMap. District lookup takes place on your device.",
    close:"Close", plus:"Zoom in", minus:"Zoom out", reset:"Show Costa Rica", locating:"Finding your location…", loading:"Looking up this point…",
    denied:"Location permission was declined. Choose a point on the map or enter coordinates.", unavailable:"Your location is unavailable. Choose a point on the map or enter coordinates.",
    invalid:"Enter two numbers separated by a comma, for example 9.9333, -84.0833.", outside:"This point is outside the mapped districts. Choose another point.",
    failed:"The map data could not load. Check your connection and select the point again.", border:"This point is on or near a district boundary. Zoom in and confirm which side it falls on.",
    uncertain:"Your location’s accuracy radius reaches a district boundary. Zoom in and select your exact location.", copyFailed:"Select the postal code to copy it.",
    pacific:"Pacific Ocean", caribbean:"Caribbean Sea", keyboard:"Map of Costa Rica. Use arrow keys to pan and Enter to look up the center."
  }
};
let saved;
try { saved = localStorage.getItem("porcr-language"); } catch {}
const preferred = (navigator.languages || [navigator.language]).map(s => s.slice(0,2).toLowerCase()).find(s => s in words);
let lang = ["en","es"].includes(saved) ? saved : preferred || "es";
let statusKey = "", point = null, result = null, ticket = 0, copied = false;
let pin, highlight, accuracyCircle;
const map = L.map("map",{zoomControl:false,zoomSnap:.1,zoomDelta:1,scrollWheelZoom:false,minZoom:5,maxZoom:19,preferCanvas:true,worldCopyJump:false});
map.attributionControl.setPrefix(false);
const palette = ["","#b6c599","#bbcb9e","#aec39a","#9dbb91","#cbd1a4","#b8caa8","#a2bf9d"];
const overview = L.layerGroup().addTo(map);
const labels = L.layerGroup().addTo(map);
const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'});
const dataCache = new Map();
function json(name) {
  if (!dataCache.has(name)) dataCache.set(name,fetch("map/"+name+".json").then(r=>{
    if (!r.ok) throw Error("map data");
    return r.json();
  }).catch(e=>{dataCache.delete(name);throw e;}));
  return dataCache.get(name);
}
function national() {
  map.fitBounds([[8.04,-85.96],[11.24,-82.51]],{padding:[18,18],animate:false});
}
function label(lat,lng,name,style) {
  const span = document.createElement("span"); span.textContent=name;
  L.marker([lat,lng],{interactive:false,keyboard:false,icon:L.divIcon({className:style,html:span,iconSize:[0,0]})}).addTo(labels);
}
function drawLabels() {
  labels.clearLayers();
  for(const [lat,lon,name] of [[10.59,-85.43,"Liberia"],[9.93,-84.08,"San José"],[10,-83.04,"Limón"],[9.28,-83.7,"San Isidro"],[10.35,-84.46,"Ciudad Quesada"]]) {
    L.circleMarker([lat,lon],{radius:3,color:"#f9f9e9",weight:1,fillColor:"#31563f",fillOpacity:1,interactive:false}).addTo(labels);
    label(lat+.085,lon,name,"place-label");
  }
  label(9.12,-85.25,words[lang].pacific,"water-label");label(10.91,-82.8,words[lang].caribbean,"water-label");
  label(11.28,-84.98,"NICARAGUA","neighbor-label");label(8.58,-82.62,"PANAMÁ","neighbor-label");
}
national();
function detailLevel() {
  if(map.getZoom()>=10){streets.addTo(map);map.removeLayer(labels);}
  else {map.removeLayer(streets);labels.addTo(map);}
  // Keep regional polygons beneath the street layer as a network fallback.
  if(map.hasLayer(streets)) streets.setZIndex(1);
  map.getPane("regional").style.zIndex=map.hasLayer(streets)?"190":"350";
}
map.createPane("regional");
map.on("zoomend",detailLevel);detailLevel();
Promise.all([json("neighbors"),json("overview")]).then(([neighbors,districts])=>{
  L.geoJSON(neighbors,{pane:"regional",interactive:false,style:{color:"#9fae99",weight:1,fillColor:"#e3e5cd",fillOpacity:1}}).addTo(overview);
  L.geoJSON(districts,{pane:"regional",interactive:false,style:f=>({color:"#819c7c",weight:.6,opacity:.55,fillColor:palette[f.properties.p],fillOpacity:1})}).addTo(overview);
}).catch(()=>setStatus("failed"));
function render() {
  const t=words[lang];
  document.documentElement.lang=lang;document.title=t.title;
  document.querySelectorAll("[data-t]").forEach(el=>el.textContent=t[el.dataset.t]);
  for(const code of ["es","en"]) $(code).setAttribute("aria-pressed",String(code===lang));
  for(const key of ["plus","minus","reset","close"]) {$(key).title=t[key];$(key).setAttribute("aria-label",t[key]);}
  $("map").setAttribute("aria-label",t.keyboard);
  $("status").textContent=t[statusKey]||"";$("intro").hidden=!!result;$("answer").hidden=!result;
  if(result){
    const [code,province,canton,district]=result;
    $("districtName").textContent=district;$("province").textContent=province;$("canton").textContent=canton;$("code").textContent=code;
  }
  $("copy").textContent=copied?t.copied:t.copy;
  $("mapHint").textContent=t[point?"selected":"tap"];
  $("readout").textContent=point?point.map(n=>n.toFixed(4)).join(", "):"";
}
function setStatus(key){statusKey=key;render();}
for(const code of ["en","es"]) $(code).onclick=()=>{
  lang=code;try {localStorage.setItem("porcr-language",code);} catch {}
  render();drawLabels();
};
function decode(ring) {
  const coords=[];let x=0,y=0;
  for(let i=0;i<ring.length;i+=2){x+=ring[i];y+=ring[i+1];coords.push([y/1e6,x/1e6]);}
  return coords;
}
// Ray crossing for containment, plus shortest distance to an edge in local metres.
function inspectRing(ring,lat,lon) {
  let inside=false, distance=Infinity;
  const east=111320*Math.cos(lat*Math.PI/180),north=110574;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [ay,ax]=ring[j],[by,bx]=ring[i];
    if((ay>lat)!==(by>lat)&&lon<(bx-ax)*(lat-ay)/(by-ay)+ax)inside=!inside;
    const x=(ax-lon)*east,y=(ay-lat)*north,dx=(bx-ax)*east,dy=(by-ay)*north;
    const t=Math.max(0,Math.min(1,-(x*dx+y*dy)/(dx*dx+dy*dy||1)));
    distance=Math.min(distance,(x+t*dx)**2+(y+t*dy)**2);
  }
  return {inside,distance:Math.sqrt(distance)};
}
async function lookup(lat,lon,accuracy=0,zoom=true) {
  const request=++ticket;point=[lat,lon];copied=false;result=null;
  for(const layer of [highlight,pin,accuracyCircle]) if(layer)map.removeLayer(layer);
  pin=L.marker(point,{keyboard:false,interactive:false,icon:L.divIcon({className:"",html:'<div class="pin"></div>',iconSize:[25,25],iconAnchor:[12,28]})}).addTo(map);
  if(accuracy>0) accuracyCircle=L.circle(point,{radius:accuracy,interactive:false,color:"#5472a7",fillOpacity:.08,weight:1}).addTo(map);
  setStatus("loading");
  try{
    const list=await json("index");
    const candidates=list.filter(d=>{const [w,s,e,n]=d[4];return lon>=w&&lon<=e&&lat>=s&&lat<=n;});
    const groups=await Promise.all(candidates.map(d=>json(d[0].slice(0,3))));
    if(request!==ticket)return;
    let near=false;
    for(const [i,d] of candidates.entries()){
      const polys=groups[i][d[0]].map(poly=>poly.map(decode));
      for(const poly of polys){
        const rings=poly.map(r=>inspectRing(r,lat,lon));
        if(rings.some(r=>r.distance<.2)){near=true;continue;}
        if(!rings[0].inside||rings.slice(1).some(r=>r.inside))continue;
        result=d;
        highlight=L.polygon(polys,{color:"#25614e",fillColor:"#86b58c",weight:2,fillOpacity:.16,interactive:false}).addTo(map);
        if(zoom)map.setView(point,Math.max(13,map.getZoom()),{animate:false});
        const distance=Math.min(...rings.map(r=>r.distance));
        setStatus(distance<accuracy?"uncertain":distance<5?"border":"");return;
      }
    }
    if(zoom && !map.getBounds().contains(point))map.setView(point,7);
    setStatus(near?"border":"outside");
  }catch{if(request===ticket)setStatus("failed");}
}
$("locate").onclick=()=>{
  const request=++ticket;
  if(!navigator.geolocation){setStatus("unavailable");return;}
  setStatus("locating");
  navigator.geolocation.getCurrentPosition(p=>{if(request===ticket)lookup(p.coords.latitude,p.coords.longitude,p.coords.accuracy);},
    e=>{if(request===ticket)setStatus(e.code===1?"denied":"unavailable");},{enableHighAccuracy:true,timeout:15000,maximumAge:30000});
};
$("pointForm").onsubmit=e=>{
  e.preventDefault();const match=$("point").value.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)$/);
  if(!match||Math.abs(+match[1])>90||Math.abs(+match[2])>180){setStatus("invalid");return;}
  lookup(+match[1],+match[2]);
};
$("copy").onclick=async()=>{try{await navigator.clipboard.writeText($("code").textContent);copied=true;render();}catch{setStatus("copyFailed");}};
map.on("click",e=>lookup(e.latlng.lat,e.latlng.lng));
const centerLookup=()=>{const p=map.getCenter();lookup(p.lat,p.lng);};
$("map").onkeydown=e=>{if(e.target!==$("map"))return;if(e.key.startsWith("Arrow"))$("center").hidden=false;if(e.key==="Enter"){e.preventDefault();centerLookup();}};
$("center").onclick=centerLookup;$("plus").onclick=()=>map.zoomIn();$("minus").onclick=()=>map.zoomOut();
$("reset").onclick=()=>{++ticket;result=null;point=null;for(const layer of [highlight,pin,accuracyCircle])if(layer)map.removeLayer(layer);national();setStatus("");};
$("sources").onclick=()=>$("info").showModal();$("close").onclick=()=>$("info").close();
drawLabels();render();
