// INPUT:  HTML review manifest with local artifacts and resolved native regions
// OUTPUT: static offline review document, stylesheet and navigation script
// POS:    Review UI only; declared prototype links never simulate app behavior
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export function reviewDocument(manifest) {
  const data = JSON.stringify(manifest).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'none'">
<title>${escape(manifest.packageName)} · SmallPen review</title><link rel="stylesheet" href="review.css">
<body><aside><h1>${escape(manifest.packageName)}</h1><p id="coverage"></p><input id="search" type="search" autocomplete="off" aria-label="Search pages" placeholder="Search pages"><div id="starts"></div><nav id="pages" aria-label="Pages"></nav></aside>
<main><header><button id="back" aria-label="Back">←</button><button id="forward" aria-label="Forward">→</button><div><h2 id="title"></h2><p id="version"></p></div><label><input id="show-hotspots" type="checkbox"> Hotspots</label></header>
<nav id="artifacts" aria-label="Page evidence"></nav><p id="status" role="status"></p><div id="stage"><div id="screen"><img id="preview" alt=""><div id="hotspots"></div><div id="overlay" hidden></div></div></div><footer><a href="manifest.json">Export manifest</a> · Declared prototype navigation only</footer></main>
<script id="review-data" type="application/json">${data}</script><script src="review.js"></script></body></html>`;
}

export const reviewStyle = `*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;color:#20232b;background:#f5f5f6;display:grid;grid-template-columns:270px 1fr;min-height:100vh}aside{padding:24px 16px;background:white;border-right:1px solid #ddd;height:100vh;overflow:auto;position:sticky;top:0}h1{font-size:18px;margin:0 0 12px}h2{font-size:16px;margin:0}p{line-height:1.5;color:#626772}#search{width:100%;padding:10px 12px;border:1px solid #ccc;border-radius:8px;margin:8px 0 16px}h3{font-size:12px;color:#626772;margin:20px 8px 8px}button{font:inherit;cursor:pointer;background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px 12px;min-height:36px}button:disabled{opacity:.4;cursor:default}aside button{display:block;text-align:left;width:100%;margin:4px 0;border-color:transparent}aside button.active{background:#eceef2;color:#111}small{display:block;color:#626772;margin-top:4px}main{min-width:0;padding:20px 28px}header{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header>div{flex:1;padding:0 8px}header p{margin:4px 0}#artifacts{display:flex;gap:16px;margin:16px 0;flex-wrap:wrap}a{color:#345e9b}#status{min-height:21px}#stage{padding:24px;background:#e8e9eb;overflow:auto;border-radius:10px}#screen{position:relative;margin:0 auto;max-width:100%;width:max-content}#preview{display:block;width:100%;height:auto;background:white}#hotspots{position:absolute;inset:0;pointer-events:none}#hotspots button{position:absolute;pointer-events:auto;border:1px solid transparent;background:transparent;min-height:0;padding:0;border-radius:0}#hotspots button:hover,#hotspots button:focus-visible,.show-hotspots #hotspots button{border:2px solid #457ce7;background:#457ce720}#overlay{position:absolute;inset:0;pointer-events:none}#overlay[hidden]{display:none}#overlay.backdrop{background:#00000066;pointer-events:auto}#overlay.catch{pointer-events:auto}#overlay .sheet{position:absolute;box-shadow:0 8px 24px #0003;pointer-events:auto}#overlay .sheet img{display:block;width:100%;height:100%}#overlay .sheet button{position:absolute;border:1px solid transparent;background:transparent;min-height:0;padding:0;border-radius:0}#overlay .sheet button:hover,.show-hotspots #overlay .sheet button{border:2px solid #457ce7;background:#457ce720}footer{margin-top:24px;color:#626772;font-size:12px}@media(max-width:720px){body{display:block}aside{position:static;height:auto;max-height:40vh;border-bottom:1px solid #ddd}main{padding:16px}#stage{padding:12px}}`;

export const reviewScript = `"use strict";
const data=JSON.parse(document.getElementById("review-data").textContent);
const byId=new Map(data.pages.map(page=>[page.id,page]));
const el=id=>document.getElementById(id);
let history=[],cursor=-1,timers=[],overlay=null;
const text=(tag,value)=>{const node=document.createElement(tag);node.textContent=value;return node};
const version=page=>[...new Set([page.platform,page.presentation].filter(Boolean))].join(" / ");
const initial=data.defaultPage||data.starts.find(start=>start.status==="resolved")?.page||data.pages[0].id;
el("coverage").textContent=data.coverage.pageCount+" pages · "+data.coverage.versionCount+" versions · "+data.coverage.resolvedLinks+"/"+data.coverage.linkCount+" links · "+data.coverage.unresolvedCount+" unresolved";
// What a link does, as the App's prototype plays it.
function act(link){
 if(link.action==="navigate")show(link.targetPage);
 else if(link.action==="prev-screen")move(-1);
 else if(link.action==="open-overlay")openOverlay(link);
 else if(link.action==="toggle-overlay")overlay&&overlay.page.id===link.targetPage?closeOverlay():openOverlay(link);
 else if(link.action==="close-overlay")closeOverlay();
 else if(link.action==="open-url")window.open(link.url,"_blank","noopener");
}
// One button per resolved link, placed over its element; the trigger
// decides which pointer event plays it.
function hotspot(link,page,holder){
 const button=document.createElement("button"),r=link.region;
 button.style.left=(r.x/page.width*100)+"%";button.style.top=(r.y/page.height*100)+"%";
 button.style.width=(r.width/page.width*100)+"%";button.style.height=(r.height/page.height*100)+"%";
 const to=link.targetPage?byId.get(link.targetPage).name:link.action==="prev-screen"?"Back":link.action==="close-overlay"?"Close overlay":link.url||link.action;
 button.title=link.name+" · "+link.trigger+" → "+to;button.setAttribute("aria-label",button.title);
 if(link.trigger==="after-delay"){timers.push(setTimeout(()=>act(link),link.delay||600));button.style.pointerEvents="none";}
 else if(link.trigger==="mouse-over"){
  // While hovering: the overlay stays while the pointer is on the element
  // or on the overlay itself.
  button.addEventListener("mouseenter",()=>{if(!overlay||overlay.link!==link)act(link)});
  button.addEventListener("mouseleave",event=>{if(overlay?.link===link&&!overlay.sheet.contains(event.relatedTarget))closeOverlay()});
  button.hoverLink=link;
 }
 else if(link.trigger==="mouse-enter")button.addEventListener("mouseenter",()=>act(link));
 else if(link.trigger==="mouse-leave")button.addEventListener("mouseleave",()=>act(link));
 else if(link.trigger==="mouse-press")button.addEventListener("pointerdown",()=>act(link));
 else button.addEventListener("click",()=>act(link));
 holder.append(button);
}
function closeOverlay(){el("overlay").replaceChildren();el("overlay").hidden=true;el("overlay").className="";overlay=null}
function openOverlay(link){
 const page=byId.get(link.targetPage),base=byId.get(history[cursor]);if(!page||!base)return;
 closeOverlay();
 const box=el("overlay"),sheet=document.createElement("div"),image=document.createElement("img");
 const w=page.width/base.width*100,h=page.height/base.height*100,place=link.overlay?.position||"center";
 // The box the overlay is placed in: an element (relative-to) or the page.
 const r=link.overlay?.relativeTo,bx=r?r.x/base.width*100:0,by=r?r.y/base.height*100:0,bw=r?r.width/base.width*100:100,bh=r?r.height/base.height*100:100;
 let x=bx+(bw-w)/2,y=by+(bh-h)/2;
 if(place.startsWith("top"))y=by;if(place.startsWith("bottom"))y=by+bh-h;
 if(place.endsWith("left"))x=bx;if(place.endsWith("right"))x=bx+bw-w;
 if(place==="manual"){x=bx+(link.overlay.x||0)/base.width*100;y=by+(link.overlay.y||0)/base.height*100}
 sheet.className="sheet";sheet.style.left=x+"%";sheet.style.top=y+"%";sheet.style.width=w+"%";sheet.style.height=h+"%";
 image.src=page.artifacts.image;image.alt=page.name;sheet.append(image);
 for(const inner of page.links.filter(item=>item.status==="resolved"))hotspot(inner,page,sheet);
 box.append(sheet);box.hidden=false;box.className=link.overlay?.backdrop?"backdrop":link.overlay?.closeOutside?"catch":"";
 box.onclick=event=>{if(event.target===box&&link.overlay?.closeOutside)closeOverlay()};
 if(link.trigger==="mouse-over")sheet.addEventListener("mouseleave",event=>{if(!(event.relatedTarget&&event.relatedTarget.hoverLink===link))closeOverlay()});
 overlay={link,page,sheet};
}
function show(id,remember=true){
 const page=byId.get(id);if(!page)return;
 for(const timer of timers)clearTimeout(timer);timers=[];closeOverlay();
 if(remember){history=history.slice(0,cursor+1);history.push(id);cursor=history.length-1}
 el("back").disabled=cursor<=0;el("forward").disabled=cursor>=history.length-1;
 el("title").textContent=page.name;el("version").textContent=version(page)+" · "+page.width+"×"+page.height+" · "+(page.selection.themes?.join(" + ")||"default themes");
 el("preview").src=page.artifacts.image;el("preview").alt=page.name+" / "+page.platform;
 el("screen").style.width=(page.viewport?.width||page.width)+"px";el("artifacts").replaceChildren();
 for(const [kind,path] of Object.entries(page.artifacts)){const a=text("a",kind);a.href=path;el("artifacts").append(a)}
 el("hotspots").replaceChildren();
 for(const link of page.links.filter(link=>link.status==="resolved"))hotspot(link,page,el("hotspots"));
 const unresolved=data.unresolved.filter(issue=>issue.page===id);
 el("status").textContent=unresolved.length?unresolved.length+" unresolved: "+[...new Set(unresolved.map(issue=>issue.reason))].join(", "):"";
 for(const button of el("pages").querySelectorAll("button"))button.classList.toggle("active",button.dataset.page===id);
 window.history.replaceState(null,"","#"+id);
}
function move(step){const next=cursor+step;if(next>=0&&next<history.length){cursor=next;show(history[cursor],false)}}
function list(){
 const query=el("search").value.toLocaleLowerCase();el("pages").replaceChildren();
 const groups=new Map();for(const page of data.pages){if(!(page.name+" "+version(page)).toLocaleLowerCase().includes(query))continue;const group=page.module||"Pages";if(!groups.has(group))groups.set(group,[]);groups.get(group).push(page)}
 for(const [group,pages] of groups){el("pages").append(text("h3",group));for(const page of pages){const button=text("button",page.name);button.append(text("small",version(page)));button.dataset.page=page.id;button.classList.toggle("active",history[cursor]===page.id);button.addEventListener("click",()=>show(page.id));el("pages").append(button)}}
}
const starts=data.starts.filter(start=>start.status==="resolved");if(starts.length){el("starts").append(text("h3","Prototype starts"));for(const start of starts){const button=text("button",start.name);button.addEventListener("click",()=>show(start.page));el("starts").append(button)}}
el("search").addEventListener("input",list);el("back").addEventListener("click",()=>move(-1));el("forward").addEventListener("click",()=>move(1));
el("show-hotspots").addEventListener("change",event=>document.body.classList.toggle("show-hotspots",event.target.checked));
list();show(byId.has(location.hash.slice(1))?location.hash.slice(1):initial);
`;
