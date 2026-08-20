
(function(){
  function start(){
  "use strict";
  window.addEventListener("error",function(ev){try{toast("页面出错："+(ev.message||ev.error||"未知"));}catch(e){}});
  var KEY="stomachDiary.entries.v1", INV="stomachDiary.inventory.v1", CFG="stomachDiary.config.v1", REM="stomachDiary.reminded.v1", WATER="stomachDiary.water.v1", WGT="stomachDiary.weight.v1", FOODLIST="stomachDiary.foodlist.v1";
  var entries=load(KEY), inventory=load(INV);
  var config=load(CFG);
  if(!config||typeof config!=="object"||Array.isArray(config))config={cupMl:250,waterGoal:1500,weightGoal:"",startWeight:"",remEnabled:false,times:["08:00","12:30","19:00"]};
  var water=load(WATER); if(!water||Array.isArray(water))water={}; migrateWater();
  var weight=load(WGT); if(!weight||Array.isArray(weight))weight={};
  var DEFAULT_FOODLIST={avoid:["冰饮/冰淇淋","辣椒/花椒","浓茶/咖啡","酒精","油炸食品","腌制/咸菜","柑橘类过酸水果","糯米/年糕","生蒜/生葱","碳酸饮料"],good:["小米粥","山药","南瓜","蒸鸡蛋","鱼肉/虾","猴头菇","软面条","常温酸奶","煮熟胡萝卜","秋葵"]};
  var foodlist;
  if(localStorage.getItem(FOODLIST)===null){foodlist=JSON.parse(JSON.stringify(DEFAULT_FOODLIST));save(FOODLIST,foodlist);}
  else{foodlist=load(FOODLIST); if(!foodlist||typeof foodlist!=="object"||Array.isArray(foodlist))foodlist={avoid:[],good:[]};
    if(!foodlist.avoid||!Array.isArray(foodlist.avoid))foodlist.avoid=[];
    if(!foodlist.good||!Array.isArray(foodlist.good))foodlist.good=[];}
  var pendingPhoto=null, invPhoto=null;
  var state={meal:"早餐",symptoms:[],src:"takeout",picked:[]};

  function todayKey(){var d=new Date();return d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();}
  function keyToInput(s){var p=(""+s).split("-");return p[0]+"-"+("0"+p[1]).slice(-2)+"-"+("0"+p[2]).slice(-2);}
  function inputToKey(s){var p=(""+s).split("-");return p[0]+"-"+(+p[1])+"-"+(+p[2]);}
  /* 旧版饮水按“杯数”存储，统一迁移为 ml（值<100 视为杯数 × 水杯容量） */
  function migrateWater(){var ch=false;Object.keys(water).forEach(function(k){var v=water[k];if(typeof v==="number"&&v>0&&v<100){water[k]=Math.round(v*(config.cupMl||250));ch=true;}});if(ch)save(WATER,water);}
  function load(k){try{var raw=localStorage.getItem(k);return raw!==null?JSON.parse(raw):[]}catch(e){return[]}}
  /* ---- IndexedDB 持久兜底：防 iOS 主屏 App 的 WKWebView 清空 localStorage 导致数据丢失 ---- */
  var IDB=(function(){
    var dbp=null;
    function open(){return new Promise(function(res,rej){
      if(dbp)return res(dbp);
      if(!window.indexedDB)return rej("no idb");
      try{var req=indexedDB.open("stomachDiaryDB",1);
        req.onupgradeneeded=function(){var db=req.result;if(!db.objectStoreNames.contains("kv"))db.createObjectStore("kv");};
        req.onsuccess=function(){dbp=req.result;res(dbp);};
        req.onerror=function(){rej(req.error);};
      }catch(e){rej(e);}
    });}
    function put(k,v){open().then(function(db){try{var tx=db.transaction("kv","readwrite");tx.objectStore("kv").put(v,k);}catch(e){}}).catch(function(){});}
    function get(k){return new Promise(function(res){open().then(function(db){try{var tx=db.transaction("kv","readonly");var r=tx.objectStore("kv").get(k);r.onsuccess=function(){res(r.result);};r.onerror=function(){res(undefined);};}catch(e){res(undefined);}}).catch(function(){res(undefined);});});}
    return {put:put,get:get};
  })();
  function save(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){toast("⚠️ 本地存储不可用，已改用本地数据库保存");}if(IDB&&IDB.put)IDB.put(k,v);schedulePush();if(!inSync)scheduleSync();}
  /* ---- 启动恢复：localStorage 被清空时从 IndexedDB 还原 ---- */
  function bootstrapStorage(){
    var keys=[KEY,INV,CFG,WATER,WGT,REM,FOODLIST];
    keys.forEach(function(k){
      var present=false;
      try{present=localStorage.getItem(k)!==null;}catch(e){present=false;}
      if(!present){IDB.get(k).then(function(v){if(v!==undefined){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}restoreRender();}});}
    });
  }
  function restoreRender(){
    try{
      entries=load(KEY); inventory=load(INV);
      config=load(CFG); if(!config||typeof config!=="object"||Array.isArray(config))config={cupMl:250,waterGoal:1500,weightGoal:"",startWeight:"",remEnabled:false,times:["08:00","12:30","19:00"]};
      water=load(WATER); if(!water||Array.isArray(water))water={}; migrateWater();
      weight=load(WGT); if(!weight||Array.isArray(weight))weight={};
      foodlist=load(FOODLIST); if(!foodlist||typeof foodlist!=="object"||Array.isArray(foodlist))foodlist={avoid:[],good:[]};
      if(!foodlist.avoid||!Array.isArray(foodlist.avoid))foodlist.avoid=[];
      if(!foodlist.good||!Array.isArray(foodlist.good))foodlist.good=[];
    }catch(e){}
    var active=document.querySelector(".view.active");
    var v=active?active.id.replace("v-",""):"record";
    if(v==="stats")renderStats();
    else if(v==="fridge")renderInventory();
    else if(v==="care")renderCare();
    else if(v==="weight")renderWeightView();
    else {renderWater();renderWeight();}
    renderFoodLists();
  }
  /* ---- 云端同步（腾讯云 CloudBase：数据永久、跨设备、换手机不丢）---- */
  var CLOUD_ENV=""; // ← 部署前填入你自己的 CloudBase 环境ID（留空则禁用云端同步，纯本地）
  var cloudReady=false, cloudApp=null, cloudDb=null, pushTimer=null;

  /* ---- 跨设备同步（GitHub 私有 Gist：免费、永久、电脑↔手机一致）---- */
  var GIST_TOKEN="__GIST_TOKEN__"; // ← 部署时填入你自己的「仅 gist 权限」token
  var GIST_ID="__GIST_ID__";        // ← 部署时填入同步用的私有 Gist ID
  var GIST_FILE="shushi-ji-data.json";
  var syncBusy=false, inSync=false, syncTimer=null;
  function gistEnabled(){return !!GIST_TOKEN && GIST_TOKEN.indexOf("__")!==0 && !!GIST_ID && GIST_ID.indexOf("__")!==0;}
  function gistHeaders(extra){var h={"Authorization":"token "+GIST_TOKEN,"User-Agent":"shushi","Accept":"application/vnd.github+json"};if(extra)h["Content-Type"]="application/json";return h;}
  function gistPayload(){return {app:"舒食纪",v:1,entries:entries,inventory:inventory,weight:weight,config:config,ts:Date.now()};}
  function setSync(s){var el=document.getElementById("syncStat");if(!el)return;
    if(s==="sync"){el.textContent="☁️ 同步中…";el.className="sync-stat s-syncing";}
    else if(s==="ok"){el.textContent="☁️ 已同步";el.className="sync-stat s-ok";}
    else if(s==="err"){el.textContent="☁️ 同步失败";el.className="sync-stat s-err";}
    else{el.textContent="";el.className="sync-stat";}}
  function applyRemote(remote){
    if(!remote||!remote.entries)return;
    inSync=true;
    var have={};entries.forEach(function(x){have[x.id]=x;});
    remote.entries.forEach(function(x){var cur=have[x.id];
      if(!cur)entries.push(x);
      else if(x.ts&&cur.ts&&x.ts>cur.ts){var i=entries.indexOf(cur);if(i>=0)entries[i]=x;}});
    var ih={};inventory.forEach(function(x){ih[x.id]=1;});
    (remote.inventory||[]).forEach(function(x){if(!ih[x.id])inventory.push(x);});
    if(remote.weight)Object.keys(remote.weight).forEach(function(k){var rw=remote.weight[k],lw=weight[k];
      if(!lw)weight[k]=rw;else if((rw._t||0)>(lw._t||0))weight[k]=rw;});
    if(remote.config)for(var key in remote.config){if(remote.config.hasOwnProperty(key)&&remote.config[key]!==""&&remote.config[key]!=null)config[key]=remote.config[key];}
    entries.sort(function(a,b){return b.ts-a.ts;});
    save(KEY,entries);save(INV,inventory);save(WGT,weight);save(CFG,config);
    inSync=false;restoreRender();
  }
  function syncPush(){
    if(!gistEnabled())return Promise.resolve();
    syncBusy=true;setSync("sync");
    return fetch("https://api.github.com/gists/"+GIST_ID,{method:"PATCH",headers:gistHeaders(true),
      body:JSON.stringify({files:{[GIST_FILE]:{content:JSON.stringify(gistPayload())}}})})
      .then(function(r){if(!r.ok)throw new Error("push "+r.status);syncBusy=false;setSync("ok");})
      .catch(function(e){syncBusy=false;setSync("err");console.warn("sync push failed",e);});
  }
  function syncFull(){ // 先拉后推，保证两边合并一致
    if(!gistEnabled()||syncBusy)return;
    syncBusy=true;setSync("sync");
    fetch("https://api.github.com/gists/"+GIST_ID,{headers:gistHeaders()})
      .then(function(r){if(!r.ok)throw new Error("pull "+r.status);return r.json();})
      .then(function(g){var fn=g.files&&g.files[GIST_FILE];if(fn&&fn.content){try{applyRemote(JSON.parse(fn.content));}catch(e){}}
        return syncPush();})
      .then(function(){syncBusy=false;setSync("ok");})
      .catch(function(e){syncBusy=false;setSync("err");console.warn("sync full failed",e);});
  }
  function scheduleSync(){if(!gistEnabled()||inSync)return;setSync("sync");clearTimeout(syncTimer);syncTimer=setTimeout(syncFull,1500);}
  function doInitCloud(){
    try{
      cloudApp=cloudbase.init({env:CLOUD_ENV});
      cloudApp.auth().signInAnonymously().then(function(){cloudDb=cloudApp.database();cloudReady=true;cloudPull();}).catch(function(){});
    }catch(e){}
  }
  function initCloud(){
    if(!CLOUD_ENV)return;
    if(typeof cloudbase==="undefined"){var t=setInterval(function(){if(typeof cloudbase!=="undefined"){clearInterval(t);doInitCloud();}},300);setTimeout(function(){clearInterval(t);},8000);return;}
    doInitCloud();
  }
  function schedulePush(){if(!cloudReady)return;clearTimeout(pushTimer);pushTimer=setTimeout(cloudPush,800);}
  function cloudPush(){
    if(!cloudReady)return;
    var data={app:"舒食纪",v:1,entries:entries,inventory:inventory,weight:weight,config:config};
    cloudDb.collection("stomach_diary").doc("me").set(data).catch(function(){});
  }
  function cloudPull(){
    if(!cloudReady)return;
    cloudDb.collection("stomach_diary").doc("me").get().then(function(res){
      var d=res.data&&res.data[0];if(!d)return;
      try{
        if(!entries.length&&d.entries)entries=d.entries;
        if(!inventory.length&&d.inventory)inventory=d.inventory;
        if(!Object.keys(weight).length&&d.weight)weight=d.weight;
        if((!config||!config.times)&&d.config)config=d.config;
        save(KEY,entries);save(INV,inventory);save(WGT,weight);save(CFG,config);
        restoreRender();
      }catch(e){}
    }).catch(function(){});
  }
  function $(s){return document.querySelector(s)}
  function toast(m){var t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(function(){t.classList.remove("show")},2200)}

  /* ---- nav ---- */
  document.querySelectorAll(".nav button").forEach(function(b){
    b.onclick=function(){
      document.querySelectorAll(".nav button").forEach(function(x){x.classList.remove("on")});
      b.classList.add("on");
      var v=b.dataset.view;
      document.querySelectorAll(".view").forEach(function(x){x.classList.remove("active")});
      $("#v-"+v).classList.add("active");
      $("#fab").classList.toggle("show", v==="fridge");
      if(v==="stats")renderStats();
      if(v==="fridge")renderInventory();
      if(v==="care")renderCare();
      if(v==="weight")renderWeightView();
      if(v==="record"){showRec("weight");}
    }
  });
  $("#fab").onclick=function(){$("#invName").focus()};
  if($("#syncBtn"))$("#syncBtn").onclick=function(){if(!gistEnabled()){toast("同步未开启：需在代码中填入 gist token");return;}syncFull();};
  document.querySelectorAll(".seg-mini .seg").forEach(function(s){s.addEventListener("click",function(){
    document.querySelectorAll(".seg-mini .seg").forEach(function(x){x.classList.remove("on")});
    s.classList.add("on");wgRangeSel=+s.dataset.r;drawWeightChart();
  });});

  /* ---- camera helper ---- */
  function bindCam(boxId,inputId,setter){
    var inputEl=document.getElementById(inputId);
    if(/Android/i.test(navigator.userAgent)) inputEl.setAttribute("capture","environment");
    inputEl.onchange=function(e){
      var f=e.target.files&&e.target.files[0];if(!f)return;
      compressImage(f,function(url){setter(url);showPhoto(boxId,url)});
    };
  }
  function showPhoto(boxId,url){
    var box=document.getElementById(boxId);
    box.querySelector(".ico").style.display="none";box.querySelector(".t").style.display="none";box.querySelector(".s").style.display="none";
    var old=box.querySelector("img");if(old)old.remove();
    var img=document.createElement("img");img.src=url;box.appendChild(img);
    var re=document.createElement("button");re.type="button";re.className="re";re.textContent="✕";
    re.onclick=function(ev){ev.preventDefault();ev.stopPropagation();setter(null);img.remove();re.remove();
      box.querySelector(".ico").style.display="";box.querySelector(".t").style.display="";box.querySelector(".s").style.display="";};
    box.appendChild(re);
  }
  function compressImage(file,cb){
    var r=new FileReader();
    r.onload=function(){var img=new Image();img.onload=function(){
      var max=900,sc=Math.min(1,max/Math.max(img.width,img.height));
      var w=Math.round(img.width*sc),h=Math.round(img.height*sc);
      var c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(img,0,0,w,h);
      cb(c.toDataURL("image/jpeg",0.72));};img.src=r.result;};
    r.readAsDataURL(file);
  }
  bindCam("camBox","fileInput",function(u){pendingPhoto=u});
  bindCam("invCam","invFile",function(u){invPhoto=u});

  /* ---- meal / sliders / chips (record) ---- */
  document.querySelectorAll("#mealSegs .seg").forEach(function(s){s.addEventListener("click",function(){
    document.querySelectorAll("#mealSegs .seg").forEach(function(x){x.classList.remove("on")});
    s.classList.add("on");state.meal=s.dataset.meal;});});
  function bindSlider(id,badgeId){
    var el=$(id),badge=$(badgeId);
    function upd(){badge.textContent=el.value;}
    el.addEventListener("input",upd);el.addEventListener("change",upd);upd();
  }
  bindSlider("#stomach","#stomachV");bindSlider("#belch","#belchV");
  document.querySelectorAll("#symChips .chip").forEach(function(c){c.addEventListener("click",function(){
    c.classList.toggle("on");var s=c.dataset.sym;
    if(c.classList.contains("on")){if(state.symptoms.indexOf(s)<0)state.symptoms.push(s)}
    else state.symptoms=state.symptoms.filter(function(x){return x!==s});});});

  /* ---- 饮食来源：外卖 / 冰箱食材联动 ---- */
  function renderFridgePick(){
    var box=$("#fridgePickChips");
    var fresh=inventory.filter(function(i){return !i.need;});
    if(!fresh.length){box.innerHTML="";$("#fridgePickHint").textContent="冰箱里还没有现成食材，可先去「冰箱」页添加。";return;}
    $("#fridgePickHint").textContent="勾选这顿实际用到的食材，保存后会自动扣 1 份库存。";
    box.innerHTML=fresh.map(function(i){
      var on=state.picked.indexOf(i.id)>=0?" on":"";
      var q=i.qty?("（"+i.qty+i.unit+"）"):"";
      return '<div class="chip'+on+'" data-pick="'+i.id+'">'+i.name+q+'</div>';
    }).join("");
    box.querySelectorAll(".chip").forEach(function(c){c.onclick=function(){
      var id=c.dataset.pick;var idx=state.picked.indexOf(id);
      if(idx>=0)state.picked.splice(idx,1);else state.picked.push(id);
      c.classList.toggle("on");
    }});
  }
  document.querySelectorAll("#srcSegs .seg").forEach(function(s){s.addEventListener("click",function(){
    document.querySelectorAll("#srcSegs .seg").forEach(function(x){x.classList.remove("on")});
    s.classList.add("on");state.src=s.dataset.src;
    if(state.src==="fridge"){renderFridgePick();$("#fridgePickWrap").style.display="block";}
    else{$("#fridgePickWrap").style.display="none";state.picked=[];}
  })});


  /* ---- save FOOD (独立保存) ---- */
  function resetFood(){
    $("#fileInput").value="";pendingPhoto=null;
    var box=$("#camBox"),img=box.querySelector("img");if(img)img.remove();var re=box.querySelector(".re");if(re)re.remove();
    box.querySelector(".ico").style.display="";box.querySelector(".t").style.display="";box.querySelector(".s").style.display="";
    $("#foodName").value="";$("#foodNote").value="";$("#foodQty").value="";$("#foodUnit").selectedIndex=0;
    state.src="takeout";state.picked=[];
    document.querySelectorAll("#srcSegs .seg").forEach(function(x){x.classList.toggle("on",x.dataset.src==="takeout")});
    $("#fridgePickWrap").style.display="none";
  }
  $("#saveFoodBtn").addEventListener("click",function(){
    var food=($("#foodName").value||"").trim();
    if(!food && !pendingPhoto){toast("先拍张照或写点吃了什么吧～");return}
    var consumed=[];
    if(state.src==="fridge" && state.picked.length){
      state.picked.forEach(function(id){
        var it=inventory.find(function(x){return x.id===id;});if(!it)return;
        var n=parseFloat(it.qty);
        if(!isNaN(n)){n=n-1;if(n<=0){inventory=inventory.filter(function(x){return x.id!==id});}
          else{it.qty=(""+Math.round(n*10)/10);}}
        else{inventory=inventory.filter(function(x){return x.id!==id});}
        consumed.push(it.name);
      });
      save(INV,inventory);renderInventory();
    }
    var qtyRaw=parseFloat($("#foodQty").value);
    var qty=(!isNaN(qtyRaw)&&qtyRaw>0)?(Math.round(qtyRaw*10)/10):0;
    var qtyUnit=qty?($("#foodUnit").value||"份"):"";
    entries.unshift({id:Date.now()+"_"+Math.random().toString(36).slice(2,7),ts:Date.now(),meal:state.meal,
      food:food,foodNote:($("#foodNote").value||"").trim(),photo:pendingPhoto,qty:qty,qtyUnit:qtyUnit,
      stomach:0,belch:0,symptoms:[],feelingNote:"",source:state.src,consumed:consumed});
    save(KEY,entries);resetFood();
    toast(state.src==="fridge"&&consumed.length?("🍽️ 已记录（消耗："+consumed.join("、")+"）"):("🍽️ 饮食已保存，也记一下不适吧～"));
  });

  /* ---- save FEELING (独立保存) ---- */
  function resetFeel(){
    $("#stomach").value=0;$("#belch").value=0;$("#stomachV").textContent="0";$("#belchV").textContent="0";
    document.querySelectorAll("#symChips .chip").forEach(function(x){x.classList.remove("on")});state.symptoms=[];
    $("#feelingNote").value="";$("#triggerFood").value="";$("#reliefFood").value="";
  }
  function saveFeel(){
    var s=+$("#stomach").value,b=+$("#belch").value;
    var note=($("#feelingNote").value||"").trim();
    var trig=($("#triggerFood").value||"").trim();
    var relief=($("#reliefFood").value||"").trim();
    if(s===0 && b===0 && !state.symptoms.length && !note && !trig && !relief){toast("先给胃的感受打个分，或选点症状吧～");return}
    entries.unshift({id:Date.now()+"_"+Math.random().toString(36).slice(2,7),ts:Date.now(),meal:"不适",
      food:"（仅记录不适）",foodNote:"",photo:null,
      stomach:s,belch:b,symptoms:state.symptoms.slice(),feelingNote:note,
      triggerFood:trig,reliefFood:relief});
    save(KEY,entries);resetFeel();toast("🤢 不适已保存 ✅ 去「养胃」看看适合的菜～");
  }
  $("#saveFeelBtn").addEventListener("click",saveFeel);
  /* 键盘「完成/换行」键直接保存——iOS 键盘弹出时会挡住底部按钮，这个快捷键绕开遮挡 */
  ["#feelingNote","#triggerFood","#reliefFood"].forEach(function(sel){
    $(sel).addEventListener("keydown",function(ev){
      if(ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();$(sel).blur();saveFeel();}
    });
  });

  /* ---- WATER（按 ml 直加）---- */
  function renderWater(){
    var ml=water[todayKey()]||0;
    $("#waterMl").textContent=ml;
    var goal=config.waterGoal||0;
    $("#waterGoalTxt").textContent= goal? ("目标 "+goal+" ml") : "未设目标";
    var pct= goal? Math.min(100, Math.round(ml/goal*100)) : 0;
    $("#waterFill").style.width=(goal? pct : 0)+"%";
    $("#waterCupInfo").textContent= goal && ml>=goal? "今天已达标 🎉 之后少量多次即可" : "点上方容量快捷记录，或「＋自定义」填任意 ml。";
  }
  function addWater(ml){
    if(!(ml>0))return;
    var k=todayKey();water[k]=(water[k]||0)+ml;save(WATER,water);renderWater();renderStats();
    toast("💧 +"+ml+" ml");
  }
  document.querySelectorAll("#waterQuick .wchip").forEach(function(b){
    b.addEventListener("click",function(){addWater(parseInt(b.getAttribute("data-ml"),10));});
  });
  $("#waterMinus").addEventListener("click",function(){
    var k=todayKey(),cur=water[k]||0;
    if(cur<=0){toast("今天还没记饮水");return;}
    water[k]=Math.max(0,cur-100);save(WATER,water);renderWater();renderStats();toast("💧 －100 ml");
  });
  $("#waterCustom").addEventListener("click",function(){
    var w=$("#waterCustomWrap");var open=(w.style.display==="none");w.style.display=open?"flex":"none";
    if(open)$("#waterCustomVal").focus();
  });
  $("#waterCustomAdd").addEventListener("click",function(){
    var v=parseInt($("#waterCustomVal").value,10);
    if(isNaN(v)||v<=0){toast("请输入大于 0 的 ml");return;}
    addWater(v);$("#waterCustomVal").value="";$("#waterCustomWrap").style.display="none";
  });
  /* ---- 记录页子页签：饮食 / 不适 / 饮水 一次只看一屏 ---- */
  function showRec(p){
    document.querySelectorAll(".rec-card").forEach(function(c){c.style.display=(c.getAttribute("data-rec")===p)?"":"none";});
    document.querySelectorAll("#recTabs .stab").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-rec")===p);});
    if(p==="weight")renderWeight();
    if(p==="water")renderWater();
  }
  document.querySelectorAll("#recTabs .stab").forEach(function(b){
    b.addEventListener("click",function(){showRec(b.getAttribute("data-rec"));});
  });
  var selWDate=todayKey();

  /* ---- WEIGHT ---- */
  function setWeight(period,val){
    var k=selWDate;if(!weight[k])weight[k]={};
    weight[k][period]=val;weight[k]._t=Date.now();save(WGT,weight);renderWeight();renderWeightGoal();renderWeightStats();
    toast((selWDate===todayKey()?"":selWDate.slice(5)+" ")+(period==="m"?"🌅 早体重已记录":"🌙 晚体重已记录"));
  }
  $("#wMorningBtn").addEventListener("click",function(){
    var v=parseFloat($("#wMorning").value);
    if(isNaN(v)||v<20||v>200){toast("请输入 20–200 之间的体重");return;}
    setWeight("m",Math.round(v*10)/10);
  });
  $("#wEveningBtn").addEventListener("click",function(){
    var v=parseFloat($("#wEvening").value);
    if(isNaN(v)||v<20||v>200){toast("请输入 20–200 之间的体重");return;}
    setWeight("e",Math.round(v*10)/10);
  });
  if($("#wDate"))$("#wDate").addEventListener("change",function(){selWDate=this.value?inputToKey(this.value):todayKey();renderWeight();});
  function renderWeight(){
    if($("#wDate"))$("#wDate").value=keyToInput(selWDate);
    var k=selWDate;var w=weight[k]||{};
    $("#wMorning").value=(w.m!=null)?w.m:"";
    $("#wEvening").value=(w.e!=null)?w.e:"";
    $("#wMorningBtn").textContent=(w.m!=null)?"更新早体重":"记录早体重";
    $("#wEveningBtn").textContent=(w.e!=null)?"更新晚体重":"记录晚体重";
    var isT=(selWDate===todayKey());
    var amL=isT?"今早":selWDate.slice(5)+" 早";
    var pmL=isT?"今晚":selWDate.slice(5)+" 晚";
    var info=[];
    if(w.m!=null)info.push(amL+" "+w.m+" kg ✓");
    if(w.e!=null)info.push(pmL+" "+w.e+" kg ✓");
    var pair=lastWeightPair();
    if(pair){
      var diff=Math.round((pair.e-pair.m)*10)/10;
      var ev=evalMeta(diff);
      info.push("代谢（"+pair.eDate.slice(5)+"晚→"+pair.mDate.slice(5)+"早）：差 "+(diff>=0?"+":"")+diff+"kg · "+ev.label);
    }
    $("#wTodayInfo").textContent=info.length?info.join("　"):"选好日期后，早晚各填一次体重；连续两天都记「晚→早」，就能看到代谢评估～";
    renderDayEval(w);
  }
  function evalDay(gain){
    if(gain<=0.4) return {cls:"ok",emoji:"🍽️",label:"当天吃得很少",desc:"当天体重几乎没涨（甚至更轻），说明吃得少、肠胃负担轻。",act:"晚餐正常吃：蛋白质（鱼/鸡胸/虾/蛋/豆腐）+ 蔬菜 + 适量主食，八分饱，别饿着自己。"};
    if(gain<=1.0) return {cls:"ok",emoji:"🍲",label:"当天吃得适中",desc:"当天体重小涨 "+gain+"kg，属正常食物与水分波动。",act:"晚餐七分饱：蛋白质（鱼/鸡胸/虾/蛋）+ 大量蔬菜，主食减半，清淡少油。"};
    if(gain<=1.8) return {cls:"warn",emoji:"🥗",label:"当天吃得偏多",desc:"当天体重涨了 "+gain+"kg，比平时多，可能是吃得多或偏咸、水分滞留。",act:"晚餐清淡减半：以蔬菜为主（绿叶菜/瓜类），配少量优质蛋白（1个蛋/几片鸡胸/鱼），主食极少或不吃，不喝甜饮。"};
    return {cls:"bad",emoji:"🚫",label:"当天吃得较多",desc:"当天体重涨了 "+gain+"kg，明显偏多，晚上再吃容易超标。",act:"建议不吃晚饭；若饿只吃蔬菜（黄瓜/番茄/绿叶菜）或极少量蛋白（1个蛋/几片白切鸡），禁主食、水果、甜点、酒。"};
  }
  function renderDayEval(w){
    var box=$("#wDayEval");
    var dlab=selWDate.slice(5);
    if(w.m==null && w.e==null){box.innerHTML="";return;}
    if(w.m==null){
      box.innerHTML='<div class="dayeval tip">已选 '+dlab+'。先在上方记录「🌅 早体重」，再记录「🌙 晚体重」，记齐早晚后会自动对比、给出当天进食评估。</div>';
      return;
    }
    if(w.e==null){
      box.innerHTML='<div class="dayeval tip">已记 '+dlab+' 早体重 '+w.m+'kg。再记录一次「🌙 晚体重」，系统会对比给出当天进食评估。</div>';
      return;
    }
    var gain=Math.round((w.e-w.m)*10)/10;
    var ev=evalDay(gain);
    box.innerHTML='<div class="dayeval '+ev.cls+'"><div class="de-h">🍽️ 当天吃多吃少（早 '+w.m+' → 晚 '+w.e+' = '+(gain>=0?"+":"")+gain+' kg）</div>'+
      '<div class="de-badge">'+ev.emoji+' '+ev.label+'</div>'+
      '<div class="de-desc">'+ev.desc+'</div>'+
      '<div class="de-act">🍳 当晚怎么吃：'+ev.act+'</div>'+
      '<div style="font-size:11px;color:var(--sub);margin-top:6px">这是「'+dlab+'」的早晚对比，用来决定当晚吃什么；与下方「夜间代谢」（前晚 → 今早）是两码事。</div></div>';
  }
  function latestWeight(){
    var keys=Object.keys(weight).sort(function(a,b){return new Date(b)-new Date(a);});
    for(var i=0;i<keys.length;i++){var w=weight[keys[i]];if(w.m!=null)return {k:keys[i],v:w.m};if(w.e!=null)return {k:keys[i],v:w.e};}
    return null;
  }
  function latestMorning(){
    var keys=Object.keys(weight).sort(function(a,b){return new Date(b)-new Date(a);});
    for(var i=0;i<keys.length;i++){var w=weight[keys[i]];if(w.m!=null)return {k:keys[i],v:w.m};}
    return null;
  }
  function lastWeightPair(){
    var keys=Object.keys(weight).sort(function(a,b){return new Date(a)-new Date(b);});
    var last=null;
    for(var i=0;i<keys.length-1;i++){
      var e=weight[keys[i]]&&weight[keys[i]].e;
      var m=weight[keys[i+1]]&&weight[keys[i+1]].m;
      if(e!=null && m!=null) last={eDate:keys[i],mDate:keys[i+1],e:e,m:m};
    }
    return last;
  }
  function evalMeta(diff){
    if(diff<0) return {emoji:"⚠️",label:"数据异常",desc:"今早比昨晚还重，多为测量误差、晚饭后未排便、或晚餐偏咸导致水钠滞留。建议固定清晨排便后、空腹、穿同样衣物再量。"};
    if(diff<0.3) return {emoji:"🐢",label:"代谢偏低",desc:"夜间体重下降 <0.3kg，偏少。可能与晚餐偏咸/饮酒致水滞留、睡前饮水过多、或近期活动量不足有关。可连续观察几天，长期偏低建议留意作息与运动。"};
    if(diff<=0.8) return {emoji:"✅",label:"代谢正常",desc:"夜间体重下降 0.3–0.8kg，属正常范围，基础代谢与水分代谢平稳。保持规律作息即可。"};
    if(diff<=1.3) return {emoji:"🔥",label:"代谢良好",desc:"夜间体重下降 0.8–1.3kg，代谢活跃、水分周转正常，对控重和胃肠轻盈都有好处。"};
    return {emoji:"💧",label:"下降偏多",desc:"夜间体重下降 >1.3kg，多为水分流失。留意是否晚餐过少、饮水不足或出汗偏多；若常伴口渴/头晕，注意补水、别过度节食。"};
  }

  function renderWeightGoal(){
    var lm=latestMorning();
    var goal=parseFloat(config.weightGoal);
    var sk=Object.keys(weight).sort(function(a,b){return new Date(a)-new Date(b);});
    var earliestM=null;
    for(var i=0;i<sk.length;i++){var w=weight[sk[i]];if(w.m!=null){earliestM=w.m;break;}}
    var startW=(config.startWeight&&config.startWeight>0)?config.startWeight:(earliestM!=null?earliestM:null);
    $("#stCurW").textContent=lm?lm.v:"—";
    $("#stStartW").textContent=startW!=null?startW:"—";
    if(lm&&goal>0&&startW!=null){
      var cur=lm.v;
      var need=Math.max(0,startW-goal);
      var lost=Math.max(0,startW-cur);
      var remain=Math.max(0,cur-goal);
      var pct= need>0? Math.round(Math.max(0,Math.min(100,lost/need*100))):100;
      $("#stLostW").textContent=Math.round(lost*10)/10;
      $("#stDiffW").textContent=Math.round(remain*10)/10;
      $("#wGoalFill").style.width=(cur<=goal?100:pct)+"%";
      $("#stWGoalPct").textContent= cur<=goal? "🎉 已达成目标体重！" : ("减重进度 "+pct+"%（已减 "+Math.round(lost*10)/10+"kg / 共需减 "+Math.round(need*10)/10+"kg）");
      $("#stWGoalNote").textContent= cur>goal
        ? ("起始 "+startW+"kg → 当前(早) "+cur+"kg，目标 "+goal+"kg，还需减约 "+Math.round(remain*10)/10+"kg。")
        : ("当前(早) "+cur+"kg 已≤目标 "+goal+"kg，保持即可。");
    } else {
      $("#stLostW").textContent="—";$("#stDiffW").textContent="—";$("#wGoalFill").style.width="0%";$("#stWGoalPct").textContent="";
      if(!lm)$("#stWGoalNote").textContent="进度只按「早体重」计算：请先记录早体重（在「⚙ 设置」填起始/目标体重效果更好）。";
      else if(startW==null)$("#stWGoalNote").textContent="还没有早体重作为起点，先记几次早体重吧。";
      else $("#stWGoalNote").textContent="在「⚙ 设置」里填「体重目标」和「起始体重」，这里就会显示减肥进度条。";
    }
    drawWeightChart();
  }
  var wgRangeSel=14;
  function drawWeightChart(){
    var goal=parseFloat(config.weightGoal)||null;
    var now=new Date();now.setHours(0,0,0,0);var N=wgRangeSel;
    var days=[];for(var i=N-1;i>=0;i--){var d=new Date(now);d.setDate(d.getDate()-i);days.push(d);}
    var data=days.map(function(d){var k=d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();var w=weight[k];return {k:k,m:(w&&w.m!=null)?w.m:null,e:(w&&w.e!=null)?w.e:null};});
    var mPts=data.filter(function(p){return p.m!=null;});
    var ePts=data.filter(function(p){return p.e!=null;});
    var box=$("#weightChart");
    if(!mPts.length&&!ePts.length){box.innerHTML='<p class="note" style="margin:0">还没有体重记录，去上面记几次早/晚体重，这里就会画出你的趋势曲线。</p>';$("#wgGoalLegend").style.display="none";$("#wgChartNote").textContent="";return;}
    var vals=[];mPts.forEach(function(p){vals.push(p.m);});ePts.forEach(function(p){vals.push(p.e);});
    var min=Math.min.apply(null,vals),max=Math.max.apply(null,vals);
    if(goal!=null){min=Math.min(min,goal);max=Math.max(max,goal);}
    var pad=(max-min)*0.18||1;min-=pad;max+=pad;
    var W=320,H=170,pl=30,pr=10,pt=12,pb=22,x0=pl,x1=W-pr,y0=pt,y1=H-pb;
    function X(i){return x0+(x1-x0)*i/(data.length-1);}
    function Y(v){return y1-(y1-y0)*((v-min)/(max-min));}
    var svg='<svg viewBox="0 0 '+W+' '+H+'" width="100%" style="display:block">';
    [min,(min+max)/2,max].forEach(function(g){var yy=Y(g);svg+='<line x1="'+x0+'" y1="'+yy.toFixed(1)+'" x2="'+x1+'" y2="'+yy.toFixed(1)+'" stroke="#eef3f0"/><text x="'+(x0-4)+'" y="'+(yy+3).toFixed(1)+'" font-size="8" fill="#9aa8a2" text-anchor="end">'+g.toFixed(1)+'</text>';});
    if(goal!=null){var gy=Y(goal);svg+='<line x1="'+x0+'" y1="'+gy.toFixed(1)+'" x2="'+x1+'" y2="'+gy.toFixed(1)+'" stroke="#e08a3c" stroke-dasharray="4 3"/><text x="'+x1+'" y="'+(gy-3).toFixed(1)+'" font-size="8" fill="#e08a3c" text-anchor="end">目标 '+goal+'</text>';}
    // 晚体重：空心橙点（仅参考）
    data.forEach(function(p,i){if(p.e==null)return;svg+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(p.e).toFixed(1)+'" r="3" fill="#fff" stroke="#e08a3c" stroke-width="1.6"/>';});
    // 早体重：实线绿点（官方趋势）
    var dpath="",s=false;data.forEach(function(p,i){if(p.m==null)return;dpath+=(s?"L":"M")+X(i).toFixed(1)+" "+Y(p.m).toFixed(1)+" ";s=true;});
    svg+='<path d="'+dpath+'" fill="none" stroke="#2f9e7f" stroke-width="2.4" stroke-linejoin="round"/>';
    data.forEach(function(p,i){if(p.m==null)return;svg+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(p.m).toFixed(1)+'" r="2.8" fill="#2f9e7f"/>';});
    svg+='</svg>';box.innerHTML=svg;
    var lastM=mPts.length?mPts[mPts.length-1].m:null;
    var txt="";
    if(lastM!=null){txt+="最近早体重 "+lastM+" kg";if(goal!=null)txt+="，距目标还差 "+Math.max(0,Math.round((lastM-goal)*10)/10)+" kg";}
    else txt="最近仅有晚体重记录（进度按早体重计算，建议补记早体重）";
    txt+="（共 "+mPts.length+" 个早体重点"+(ePts.length?("、"+ePts.length+" 个晚体重点"):"")+"）";
    $("#wgChartNote").textContent=txt;
    if(goal!=null)$("#wgGoalLegend").style.display="";else $("#wgGoalLegend").style.display="none";
  }
  function renderBadges(){
    var days={};entries.forEach(function(e){var d=new Date(e.ts);days[d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate()]=1;});
    var dayArr=Object.keys(days);
    $("#stDays").textContent=dayArr.length;
    function k(d){return d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();}
    var streak=0;var cur=new Date();cur.setHours(0,0,0,0);
    if(!days[k(cur)])cur.setDate(cur.getDate()-1);
    while(days[k(cur)]){streak++;cur.setDate(cur.getDate()-1);}
    $("#stStreak").textContent=streak;
    var mealCount=entries.filter(function(e){return e.food&&e.food!=="（仅记录不适）";}).length;
    var bdefs=[
      {icon:"🌱",name:"初次记录",ok:dayArr.length>=1},
      {icon:"🔥",name:"连续 3 天",ok:streak>=3},
      {icon:"✨",name:"连续 7 天",ok:streak>=7},
      {icon:"🏆",name:"连续 30 天",ok:streak>=30},
      {icon:"🍽️",name:"记录 50 餐",ok:mealCount>=50},
      {icon:"💯",name:"记录 100 条",ok:entries.length>=100}
    ];
    $("#badges").innerHTML=bdefs.map(function(b){return '<span class="badge-chip '+(b.ok?"on":"")+'">'+b.icon+" "+b.name+'</span>';}).join("");
  }
  function renderFoodSym(){
    var box=$("#foodSym");
    var byDay={};
    entries.forEach(function(e){
      var dn=new Date(e.ts);var k=dn.getFullYear()+"-"+(dn.getMonth()+1)+"-"+dn.getDate();
      if(!byDay[k])byDay[k]={foods:{},bad:false};
      var bd=byDay[k];
      if(e.symptoms&&e.symptoms.length)bd.bad=true;
      if(e.food&&e.food!=="（仅记录不适）")bd.foods[e.food]=1;
      if(e.consumed&&e.consumed.length)e.consumed.forEach(function(c){bd.foods[c]=1;});
    });
    var stat={};
    Object.keys(byDay).forEach(function(k){var bd=byDay[k];Object.keys(bd.foods).forEach(function(f){
      if(!stat[f])stat[f]={total:0,bad:0};stat[f].total++;if(bd.bad)stat[f].bad++;});});
    var arr=Object.keys(stat).filter(function(f){return stat[f].total>=2;})
      .map(function(f){return {f:f,t:stat[f].total,b:stat[f].bad,r:stat[f].bad/stat[f].total};})
      .sort(function(a,b){return b.r-a.r||b.b-a.b;});
    if(!arr.length){box.innerHTML='<p class="note" style="margin:0">记录至少 2 天、且其间有「饮食」和「不适」后，这里会自动列出<b>最易引发你不适的食物</b>。提示：吃完不舒服记得在「记录」里打症状分～</p>';return;}
    box.innerHTML=arr.slice(0,5).map(function(x){
      var pct=Math.round(x.r*100);
      var col= pct>=70?"var(--danger)":pct>=40?"var(--warn)":"var(--brand)";
      return '<div class="fsym-row"><div class="fsym-top"><span>'+x.f+'</span><span class="fsym-pct" style="color:'+col+'">'+pct+'%</span></div>'+
        '<div class="fsym-bar"><div style="width:'+pct+'%;background:'+col+'"></div></div>'+
        '<div class="fsym-sub">在 '+x.t+' 个含此食物的日子中，有 '+x.b+' 天出现不适</div></div>';
    }).join("")+
    '<p class="note" style="margin:10px 0 0">⚠️ 仅基于你自己的记录统计，相关性≠因果关系，仅供参考，别单凭它禁食某类食物。</p>';
  }
  function renderWeightView(){ selWDate=todayKey(); if($("#wDate"))$("#wDate").value=keyToInput(selWDate); renderWeight(); renderWeightGoal(); renderWeightStats(); }

  /* ---- inventory (冰箱) ---- */
  var CAT_ICON={蔬菜:"🥬",肉蛋:"🥚",主食:"🍚",水果:"🍎",调料:"🧂",乳制品:"🥛",其他:"📦"};
  // 各分类建议食用期限（天），未设保质期时按此估算
  var CAT_SHELF={蔬菜:5,肉蛋:4,主食:30,水果:7,乳制品:7,调料:180,其他:14};
  function fridgeStatus(it){
    var today=Date.now();
    var added=it.addedTs||today;
    var limit=CAT_SHELF[it.cat]||14;
    var deadline;
    if(it.expiry){var p=it.expiry.split("-");deadline=new Date(+p[0],+p[1]-1,+p[2]);deadline.setHours(0,0,0,0);}
    else{deadline=new Date(added);deadline.setDate(deadline.getDate()+limit);}
    var daysLeft=Math.round((deadline-today)/86400000);
    var daysIn=Math.round((today-added)/86400000);
    var st;if(daysLeft<0)st={key:"exp",txt:"已超期",cls:"exp"};else if(daysLeft<=2)st={key:"soon",txt:"尽快食用",cls:"soon"};else st={key:"fresh",txt:"新鲜",cls:"fresh"};
    return {daysLeft:daysLeft,daysIn:daysIn,st:st};
  }
  function renderInventory(){
    var box=$("#fridgeView");
    $("#frTotal").textContent=inventory.length;
    var cats={};inventory.forEach(function(i){(cats[i.cat]=cats[i.cat]||[]).push(i);});
    $("#frCat").textContent=Object.keys(cats).length;
    var soon=inventory.filter(function(i){return !i.need && fridgeStatus(i).st.key!=="fresh";}).length;
    $("#frBuy").textContent=inventory.filter(function(i){return i.need;}).length;
    if(!inventory.length){
      box.innerHTML='<div class="empty"><div class="e">🧊</div>冰箱还是空的，添加你买回来的食材吧～</div>';
      $("#expireRecoCard").style.display="none";return;
    }
    var order=["蔬菜","肉蛋","主食","水果","乳制品","调料","其他"];
    var html="";
    order.forEach(function(cat){
      var arr=cats[cat];if(!arr||!arr.length)return;
      html+='<div class="cat-h"><span>'+CAT_ICON[cat]+' '+cat+'</span><span class="c-cnt">'+arr.length+'</span></div><div class="shelf">';
      arr.forEach(function(i){
        var ph=i.photo?'<img class="b-ic" style="object-fit:cover;border-radius:8px" src="'+i.photo+'">':'<div class="b-ic">'+CAT_ICON[cat]+'</div>';
        if(i.need){
          html+='<div class="fbox need">'+ph+'<div class="b-nm">'+i.name+'</div><div class="b-meta">待购买'+(i.cat?(" · "+i.cat):"")+'</div>'+
            '<span class="b-badge need">需采购</span>'+
            '<div class="b-ops"><button class="bought" data-buy="'+i.id+'">✓ 已买</button>'+
            '<button class="del2" data-del="'+i.id+'">🗑️</button></div></div>';
          return;
        }
        var st=fridgeStatus(i);
        var meta=(i.qty?(i.qty+" "+i.unit+" · "):"")+"已放 "+st.daysIn+"天";
        var expTxt=i.expiry?(" · 保质至"+i.expiry.slice(5)):"";
        html+='<div class="fbox">'+ph+'<div class="b-nm">'+i.name+'</div><div class="b-meta">'+meta+expTxt+'</div>'+
          '<span class="b-badge '+st.st.cls+'">'+st.st.txt+(st.st.key!=="fresh"?(" "+st.daysLeft+"天"):"")+'</span>'+
          '<div class="b-ops"><div class="q"><button data-id="'+i.id+'" data-d="-1">−</button><span>'+i.qty+'</span><button data-id="'+i.id+'" data-d="1">＋</button></div>'+
          '<button class="del2" data-del="'+i.id+'">🗑️</button></div></div>';
      });
      html+='</div>';
    });
    box.innerHTML=html;
    box.querySelectorAll(".b-ops button[data-d]").forEach(function(b){b.onclick=function(){
      var it=inventory.find(function(x){return x.id===b.dataset.id});if(!it)return;
      var d=+b.dataset.d;var n=parseFloat(it.qty);
      if(!isNaN(n)){n=Math.max(0,n+d);it.qty=(""+n);}
      else{it.qty=it.qty+(d>0?"+1":"");}
      save(INV,inventory);renderInventory();
    }});
    box.querySelectorAll(".del2").forEach(function(b){b.onclick=function(){
      if(confirm("从冰箱移除该食材？")){inventory=inventory.filter(function(x){return x.id!==b.dataset.del});save(INV,inventory);renderInventory();}
    }});
    box.querySelectorAll(".bought").forEach(function(b){b.onclick=function(){
      var it=inventory.find(function(x){return x.id===b.dataset.buy});if(!it)return;
      it.need=false;it.addedTs=Date.now();if(!it.qty)it.qty="1";if(!it.unit)it.unit="个";
      save(INV,inventory);toast("已放入冰箱 ✓");renderInventory();
      if(document.getElementById("v-care").classList.contains("active"))renderCare();
    }});
    renderExpireReco();
  }
  function renderExpireReco(){
    var soonItems=inventory.filter(function(i){return !i.need && fridgeStatus(i).st.key!=="fresh";});
    var card=$("#expireRecoCard");
    if(!soonItems.length){card.style.display="none";return;}
    card.style.display="block";
    var html="";
    soonItems.forEach(function(i){
      var st=fridgeStatus(i);
      var dish=RECIPES.find(function(r){return r.ing.indexOf(i.name)>=0 && (r.lv==="safe"||r.lv==="caution");});
      var title=dish?dish.name:("尽快吃完「"+i.name+"」");
      var desc=dish?("做法：用"+i.name+"做"+dish.name+"，温和好消化。"):("建议这两天优先消耗，避免浪费；可清蒸、煮粥或快炒，少油少辣。");
      html+='<div class="reco-row"><div class="rr-t">'+CAT_ICON[i.cat]+' '+title+' <span class="b-badge '+st.st.cls+'">'+st.st.txt+'</span></div><div class="rr-d">'+desc+'</div></div>';
    });
    $("#expireReco").innerHTML=html;
  }
  var invNeed=0;
  $("#imFresh").onclick=function(){invNeed=0;this.classList.add("on");$("#imBuy").classList.remove("on");$("#invAdd").textContent="➕ 加入冰箱";};
  $("#imBuy").onclick=function(){invNeed=1;this.classList.add("on");$("#imFresh").classList.remove("on");$("#invAdd").textContent="➕ 加入采购清单";};
  $("#invAdd").onclick=function(){
    var name=($("#invName").value||"").trim();
    if(!name){toast("先填食材名称");return;}
    var expiry=invNeed? "" : ($("#invExpiry").value||"");
    inventory.unshift({id:Date.now()+"_"+Math.random().toString(36).slice(2,7),name:name,
      qty:invNeed? "" : ($("#invQty").value||"1").trim(),unit:invNeed? "" : $("#invUnit").value,cat:$("#invCat").value,
      photo:invPhoto,addedTs:invNeed?0:Date.now(),expiry:expiry,need:invNeed});
    save(INV,inventory);
    $("#invName").value="";$("#invQty").value="";$("#invExpiry").value="";invPhoto=null;
    var box=$("#invCam"),img=box.querySelector("img");if(img)img.remove();var re=box.querySelector(".re");if(re)re.remove();
    box.querySelector(".ico").style.display="";box.querySelector(".t").style.display="";box.querySelector(".s").style.display="";
    toast(invNeed? "已加入采购清单 🛒" : "已加入冰箱 🧊");renderInventory();
  };

  /* ---- knowledge base + recommendation (养胃) ---- */
  var PANTRY=["米","面条","油","盐","姜","水","鸡蛋","葱","蒜"];
  var FOODS={
    "小米":{lv:"safe",why:"易消化，养胃"},"山药":{lv:"safe",why:"健脾养胃"},"南瓜":{lv:"safe",why:"温和少刺激"},
    "馒头":{lv:"safe",why:"发酵面食好消化"},"面条":{lv:"safe",why:"清汤面好消化"},"白米饭":{lv:"safe",why:"温和主食"},
    "土豆":{lv:"safe",why:"蒸煮后温和"},"胡萝卜":{lv:"safe",why:"富含果胶护胃"},"菠菜":{lv:"safe",why:"焯水后温和"},
    "西兰花":{lv:"safe",why:"清淡蔬菜"},"鱼肉":{lv:"safe",why:"优质蛋白易吸收"},"鸡肉":{lv:"safe",why:"去皮蒸煮温和"},
    "鸡蛋":{lv:"safe",why:"优质蛋白"},"香蕉":{lv:"safe",why:"熟香蕉护胃"},"苹果":{lv:"safe",why:"蒸熟更温和"},
    "藕粉":{lv:"safe",why:"传统养胃"},"木瓜":{lv:"safe",why:"温和水果"},
    "牛奶":{lv:"caution",why:"部分人易胀气，建议温饮"},"豆浆":{lv:"caution",why:"豆类产气，少量"},"燕麦":{lv:"caution",why:"粗粮，适量"},
    "韭菜":{lv:"caution",why:"粗纤维多，胃病发作期慎吃"},"竹笋":{lv:"caution",why:"粗纤维，慎吃"},"柑橘":{lv:"caution",why:"偏酸，反酸者慎"},
    "红薯":{lv:"caution",why:"易产气"},"糯米":{lv:"caution",why:"难消化"},
    "辣椒":{lv:"avoid",why:"直接刺激胃黏膜"},"花椒":{lv:"avoid",why:"刺激性香料"},"酒精":{lv:"avoid",why:"损伤胃黏膜"},
    "浓茶":{lv:"avoid",why:"咖啡因刺激"},"咖啡":{lv:"avoid",why:"促胃酸"},"碳酸饮料":{lv:"avoid",why:"胀气反酸"},
    "油炸食品":{lv:"avoid",why:"难消化加重负担"},"肥肉":{lv:"avoid",why:"油腻难消化"},"生大蒜":{lv:"avoid",why:"辛辣刺激"},
    "生洋葱":{lv:"avoid",why:"易胀气刺激"},"番茄":{lv:"avoid",why:"酸性，反酸者避"},"薄荷":{lv:"avoid",why:"松弛贲门致反酸"},
    "巧克力":{lv:"avoid",why:"促反酸"},"柠檬":{lv:"avoid",why:"过酸"}
  };
  var RECIPES=[
    {name:"小米山药粥",ing:["小米","山药"],lv:"safe"},
    {name:"南瓜小米粥",ing:["小米","南瓜"],lv:"safe"},
    {name:"清蒸鱼片",ing:["鱼肉","姜"],lv:"safe"},
    {name:"蒸蛋羹",ing:["鸡蛋"],lv:"safe"},
    {name:"白灼青菜",ing:["西兰花","油","盐"],lv:"safe"},
    {name:"蒸土豆泥",ing:["土豆"],lv:"safe"},
    {name:"清汤面",ing:["面条","菠菜"],lv:"safe"},
    {name:"山药排骨汤(去油)",ing:["山药","鸡肉","姜"],lv:"safe"},
    {name:"馒头配蒸蛋",ing:["馒头","鸡蛋"],lv:"safe"},
    {name:"香蕉燕麦杯",ing:["香蕉","燕麦","牛奶"],lv:"caution"},
    {name:"木瓜牛奶",ing:["木瓜","牛奶"],lv:"caution"}
  ];
  function todayEntries(){
    var now=new Date();now.setHours(0,0,0,0);var key=now.getTime();
    return entries.filter(function(e){var d=new Date(e.ts);d.setHours(0,0,0,0);return d.getTime()===key;});
  }
  function getCondition(){
    var t=todayEntries().filter(function(e){return e.stomach>0||e.belch>0||(e.symptoms&&e.symptoms.length);});
    var s=0,b=0;
    if(t.length){t.forEach(function(e){s+=e.stomach;b+=e.belch});s=Math.round(s/t.length);b=Math.round(b/t.length);}
    var score=Math.max(s,b);
    if(score>=6)return{key:"bad",emoji:"😣",label:"不适日",desc:"今天胃部信号偏强，建议只吃最温和的食物，避开一切刺激。"};
    if(score>=3)return{key:"mid",emoji:"😐",label:"一般日",desc:"胃部略有不适，以温和食物为主，谨慎食材少量尝试。"};
    if(t.length)return{key:"good",emoji:"😊",label:"舒适日",desc:"胃部状态不错，可正常清淡饮食，偶尔少量谨慎食材。"};
    return{key:"none",emoji:"🍽️",label:"未记录",desc:"今天还没记录胃的感受，先去「记录」打一下分，推荐会更准。"};
  }
  function renderCare(){
    var cond=getCondition();
    $("#condT").textContent=cond.label;$("#condD").textContent=cond.desc;
    $("#condBox").querySelector(".emoji").textContent=cond.emoji;
    var allow = (cond.key==="bad")?["safe"]:["safe","caution"];
    var freshNames=inventory.filter(function(i){return !i.need;}).map(function(i){return i.name;});
    var avail={};PANTRY.concat(freshNames).forEach(function(n){avail[n]=1;});
    function cov(r){return r.ing.filter(function(x){return avail[x];}).length/r.ing.length;}
    var pool=RECIPES.filter(function(r){return allow.indexOf(r.lv)>=0 && cov(r)>0;});
    pool.sort(function(a,b){return cov(b)-cov(a) || (a.lv===b.lv?0:(a.lv==="safe"?-1:1));});
    var used={};var meals=["早餐","午餐","晚餐","加餐"];var html="";
    meals.forEach(function(m){
      var pick=pool.find(function(r){return !used[r.name];});
      if(pick){used[pick.name]=1;
        var ingTxt=pick.ing.map(function(x){return avail[x]?x:x+"*";}).join("、");
        var tag=pick.lv==="safe"?'<span class="safe">温和</span>':'<span class="cau">谨慎</span>';
        html+='<div class="meal"><div class="mh"><span>'+m+'</span><span class="badge">'+(cov(pick)>=1?'冰箱现成':'需采购')+'</span></div>'+
          '<div class="dish">🥣 '+pick.name+' '+tag+'</div><div class="ing">食材：'+ingTxt+'（带*为常备/需买）</div></div>';
      }else{
        html+='<div class="meal"><div class="mh"><span>'+m+'</span><span class="badge">自由搭配</span></div>'+
          '<div class="dish">🥣 清淡温和餐</div><div class="ing">用冰箱里的温和食材（粥/蒸菜/水煮）随意搭配，少油少辣。</div></div>';
      }
    });
    $("#recoPlan").innerHTML=html;
    var safeInFridge=inventory.filter(function(i){var f=FOODS[i.name];return !i.need && (!f||f.lv==="safe");}).map(function(i){return i.name;});
    $("#safeList").innerHTML = safeInFridge.length
      ? safeInFridge.map(function(n){return '<span>'+n+'</span>';}).join("")
      : '<span style="background:#f3f6f4;color:#9aa8a2">冰箱里还没有标记为温和的食材，添加后这里会自动出现</span>';
    var avoids=Object.keys(FOODS).filter(function(k){return FOODS[k].lv==="avoid";});
    $("#warnList").innerHTML=avoids.map(function(k){return '<span>'+k+'</span>';}).join("");
    var inFridgeAvoid=inventory.filter(function(i){return !i.need && FOODS[i.name]&&FOODS[i.name].lv==="avoid";}).map(function(i){return i.name;});
    $("#warnNote").textContent = inFridgeAvoid.length
      ? "⚠️ 你冰箱里现在有："+inFridgeAvoid.join("、")+" —— 今天胃不太舒服的话，先别碰这些。"
      : "放心，你冰箱里目前没有高刺激食材。";
    // 近7天胃痛趋势
    var now=new Date();now.setHours(0,0,0,0);var days=[];
    for(var i=6;i>=0;i--){var d=new Date(now);d.setDate(d.getDate()-i);days.push(d);}
    var map={};
    entries.forEach(function(e){var dt=new Date(e.ts);var k=dt.getFullYear()+"-"+(dt.getMonth()+1)+"-"+dt.getDate();(map[k]=map[k]||[]).push(e);});
    var pts=days.map(function(d){var k=d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();var arr=map[k]||[];
      return{p:arr.length?arr.reduce(function(a,b){return a+b.stomach},0)/arr.length:null};});
    drawChart("careChart",pts,true);
    renderFoodLists();
  }

  /* ---- 养胃常驻清单：不建议吃 / 养胃建议吃 ---- */
  function renderFoodLists(){
    var a=foodlist.avoid, g=foodlist.good;
    var ab=$("#avoidList"), gb=$("#goodList");
    if(!ab||!gb)return;
    ab.innerHTML = a.length? a.map(function(n,i){return '<span class="chip" data-k="avoid" data-i="'+i+'">'+n+' ✕</span>';}).join("") : '<span class="note" style="margin:0">还没有，下面添加，或留空也行～</span>';
    gb.innerHTML = g.length? g.map(function(n,i){return '<span class="chip" data-k="good" data-i="'+i+'">'+n+' ✕</span>';}).join("") : '<span class="note" style="margin:0">还没有，下面添加，或留空也行～</span>';
    ab.querySelectorAll(".chip").forEach(function(c){c.onclick=function(){removeFood(c.dataset.k,+c.dataset.i);};});
    gb.querySelectorAll(".chip").forEach(function(c){c.onclick=function(){removeFood(c.dataset.k,+c.dataset.i);};});
  }
  function addFood(k){
    var inp=(k==="avoid")?$("#avoidInput"):$("#goodInput");
    var v=(inp.value||"").trim(); if(!v)return;
    if(foodlist[k].indexOf(v)>=0){toast("清单里已有「"+v+"」");return;}
    foodlist[k].push(v); inp.value=""; save(FOODLIST,foodlist); renderFoodLists();
    if(k==="avoid")$("#avoidInput").focus(); else $("#goodInput").focus();
  }
  function removeFood(k,i){
    if(i<0||i>=foodlist[k].length)return;
    foodlist[k].splice(i,1); save(FOODLIST,foodlist); renderFoodLists();
  }
  $("#avoidAdd").onclick=function(){addFood("avoid");};
  $("#goodAdd").onclick=function(){addFood("good");};
  if($("#avoidInput"))$("#avoidInput").addEventListener("keydown",function(e){if(e.key==="Enter")addFood("avoid");});
  if($("#goodInput"))$("#goodInput").addEventListener("keydown",function(e){if(e.key==="Enter")addFood("good");});

  /* ---- history (折叠进统计) ---- */
  function renderHistory(){
    var box=$("#historyList");
    if(!entries.length){box.innerHTML='<div class="empty"><div class="e">🍽️</div>还没有记录，去「记录」拍下第一餐吧～</div>';return;}
    var groups={};
    entries.forEach(function(e){var d=new Date(e.ts);var k=d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();(groups[k]=groups[k]||[]).push(e);});
    var keys=Object.keys(groups).sort(function(a,b){return a<b?1:-1});
    var html="";
    keys.forEach(function(k){
      var arr=groups[k];var first=new Date(arr[0].ts);
      var wk=["周日","周一","周二","周三","周四","周五","周六"][first.getDay()];
      var wc=water[k]||0;
      var wtag= wc? ('<span class="tag" style="background:#e6f4ef;color:#2f9e7f">💧 '+wc+' ml</span>') : '';
      html+='<div class="day"><div class="dh"><span>'+first.getMonth()+1+'月'+first.getDate()+'日 · '+wk+'</span><span>'+wtag+'<span class="tag">'+arr.length+' 条</span></span></div>';
      arr.forEach(function(e){
        var photo=e.photo?'<img class="ph" src="'+e.photo+'">':'<div class="ph">'+((e.meal==="不适")?"🤢":"🍽️")+'</div>';
        var sx='';
        if(e.stomach>0)sx+='<span class="pain">胃痛 '+e.stomach+'</span>';
        if(e.belch>0)sx+='<span class="br">嗳气 '+e.belch+'</span>';
        e.symptoms.forEach(function(s){sx+='<span>'+s+'</span>'});
        if(e.triggerFood)sx+='<span style="color:#d96a5b;background:#fbeae7">触发：'+e.triggerFood+'</span>';
        if(e.reliefFood)sx+='<span style="color:#1f7d63;background:#e6f4ef">缓解：'+e.reliefFood+'</span>';
        var note=e.foodNote||e.feelingNote?('<div class="fd">'+(e.foodNote||'')+(e.feelingNote?(' ｜ '+e.feelingNote):'')+'</div>'):'<div class="fd" style="color:#b9c5bf">无备注</div>';
        var qtyText=(e.qty&&e.qtyUnit)?('<span class="qty">'+e.qty+e.qtyUnit+'</span>'):'';
        html+='<div class="item">'+photo+'<div class="body"><div class="tt"><span>'+(e.food||'（未命名）')+'</span>'+qtyText+'<span class="mt">'+e.meal+'</span></div>'+note+'<div class="sx">'+sx+'</div></div><button class="del" data-id="'+e.id+'">🗑️</button></div>';
      });
      html+='</div>';
    });
    box.innerHTML=html;
    box.querySelectorAll(".del").forEach(function(b){b.onclick=function(){
      if(confirm("删除这条记录？")){entries=entries.filter(function(x){return x.id!==b.dataset.id});save(KEY,entries);renderHistory();toast("已删除");}}});
  }

  /* ---- stats ---- */
  function renderStats(){
    $("#stCount").textContent=entries.length;
    var avgP=0,avgB=0;
    if(entries.length){avgP=entries.reduce(function(a,b){return a+b.stomach},0)/entries.length;avgB=entries.reduce(function(a,b){return a+b.belch},0)/entries.length;}
    $("#stAvgPain").textContent=avgP.toFixed(1);$("#stAvgBelch").textContent=avgB.toFixed(1);

    // 打卡成就
    renderBadges();
    // 饮食结构
    renderMealStruct();
    // 食物-不适关联
    renderFoodSym();
    // 饮食建议
    renderDietAdvice();

    // 14天趋势
    var now=new Date();now.setHours(0,0,0,0);var days=[];
    for(var i=13;i>=0;i--){var d=new Date(now);d.setDate(d.getDate()-i);days.push(d);}
    var map={};
    entries.forEach(function(e){var dt=new Date(e.ts);var k=dt.getFullYear()+"-"+(dt.getMonth()+1)+"-"+dt.getDate();(map[k]=map[k]||[]).push(e);});
    var pts=days.map(function(d){var k=d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();var arr=map[k]||[];
      return{p:arr.length?arr.reduce(function(a,b){return a+b.stomach},0)/arr.length:null,b:arr.length?arr.reduce(function(a,b){return a+b.belch},0)/arr.length:null};});
    drawChart("chart",pts,false);

    // 饮水
    var wdays=[];for(var j=13;j>=0;j--){var dd=new Date(now);dd.setDate(dd.getDate()-j);wdays.push(dd.getFullYear()+"-"+(dd.getMonth()+1)+"-"+dd.getDate());}
    var wToday=water[todayKey()]||0;var wSum=0,wCnt=0;
    wdays.forEach(function(k){if(water[k]){wSum+=water[k];wCnt++;}});
    $("#stWaterToday").textContent=wToday;
    $("#stWaterAvg").textContent=wCnt?Math.round(wSum/wCnt):0;
    $("#stWaterNote").textContent="今日 "+wToday+" ml"+(config.waterGoal?(" ／ 目标 "+config.waterGoal+" ml"):"")+"。多喝水对胃黏膜有保护作用，但胃胀时少量多次更舒服。";

    // 高频症状
    var freq={};entries.forEach(function(e){e.symptoms.forEach(function(s){freq[s]=(freq[s]||0)+1});});
    var sorted=Object.keys(freq).sort(function(a,b){return freq[b]-freq[a]});
    $("#symFreq").innerHTML=sorted.length?sorted.map(function(s){return '<div class="chip on" style="cursor:default">'+s+' · '+freq[s]+'</div>';}).join(""):'<span class="note">暂无数据，先去记录几条吧～</span>';

    renderHistory();
  }
  function renderMealStruct(){
    var meals=["早餐","午餐","晚餐","加餐"];
    var stat={};meals.forEach(function(m){stat[m]={c:0,sp:0,sb:0};});
    entries.forEach(function(e){
      if(meals.indexOf(e.meal)<0)return;
      var s=stat[e.meal];s.c++;s.sp+=e.stomach;s.sb+=e.belch;
    });
    var maxPain=0;meals.forEach(function(m){if(stat[m].c)maxPain=Math.max(maxPain,stat[m].sp/stat[m].c);});
    var html="";
    meals.forEach(function(m){
      var s=stat[m];if(!s.c)return;
      var ap=(s.sp/s.c),ab=(s.sb/s.c);
      var pct=maxPain?Math.round(ap/maxPain*100):0;
      html+='<div class="bar-row"><div class="bl"><span>'+m+'（'+s.c+'次）</span><b>胃痛 '+ap.toFixed(1)+' · 嗳气 '+ab.toFixed(1)+'</b></div>'+
        '<div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div></div>';
    });
    $("#mealStruct").innerHTML=html||'<span class="note">还没有饮食记录，先去记几餐吧～</span>';
  }
  function renderDietAdvice(){
    var adv=[];
    // 午餐后不适偏高
    var lunch=entries.filter(function(e){return e.meal==="午餐";});
    if(lunch.length>=3){
      var lp=lunch.reduce(function(a,b){return a+b.stomach},0)/lunch.length;
      if(lp>=3)adv.push("🍱 你<b>午餐后胃痛平均分较高（"+lp.toFixed(1)+"）</b>，建议午餐清淡、七分饱、细嚼慢咽，饭后散步 10 分钟。");
    }
    // 反酸/烧心
    var freq={};entries.forEach(function(e){e.symptoms.forEach(function(s){freq[s]=(freq[s]||0)+1});});
    if((freq["反酸"]||0)>=3||(freq["烧心"]||0)>=3)adv.push("🔥 你常记录<b>反酸/烧心</b>，建议避开咖啡、碳酸饮料、辛辣与油腻，睡前 3 小时不再进食，枕头可稍垫高。");
    if((freq["腹胀"]||0)>=3)adv.push("🎈 你常记录<b>腹胀</b>，豆类、红薯、乳制品等易产气食物适量；进餐时少说话、避免边吃边喝大量水。");
    // 饮水
    var wSum=0,wCnt=0;var now=new Date();now.setHours(0,0,0,0);
    for(var j=13;j>=0;j--){var dd=new Date(now);dd.setDate(dd.getDate()-j);var k=dd.getFullYear()+"-"+(dd.getMonth()+1)+"-"+dd.getDate();if(water[k]){wSum+=water[k];wCnt++;}}
    var wAvg=wCnt?wSum/wCnt:0;var goalMl=config.waterGoal||0;
    if(goalMl>0 && wAvg<goalMl*0.6)adv.push("💧 你近期日均约 "+Math.round(wAvg)+" ml，低于目标 "+goalMl+" ml，建议少量多次补水，有助于稀释胃酸、保护胃黏膜。");
    // 不适日多
    var bad=todayEntries().length?getCondition().key:"";
    if(!adv.length){
      adv.push("🌿 目前记录里没发现明显的高风险模式，继续保持记录。规律、温和、少刺激的饮食，就是最好的养胃方式。");
    }
    $("#dietAdvice").innerHTML=adv.map(function(a){return '<p class="note" style="margin:0 0 8px">'+a+'</p>';}).join("");
  }
  function renderWeightStats(){
    var pair=lastWeightPair();
    var box=$("#wMetaBox");
    if(!pair){box.innerHTML='<p class="note" style="margin:0">还没有成对的「昨晚→今早」体重记录。连续两天都记早晚体重后，这里会自动生成代谢评估。</p>';$("#wRecent").innerHTML="";return;}
    var diff=Math.round((pair.e-pair.m)*10)/10;
    var ev=evalMeta(diff);
    box.innerHTML='<div class="cond" style="margin-bottom:12px"><div class="emoji">'+ev.emoji+'</div><div><div class="ct">代谢评估：'+ev.label+'</div>'+
      '<div class="cd">「'+pair.eDate.slice(5)+' 晚 '+pair.e+'kg」 → 「'+pair.mDate.slice(5)+' 早 '+pair.m+'kg」<br>夜间体重差 '+(diff>=0?"+":"")+diff+' kg</div></div></div>'+
      '<p class="note" style="margin:0">'+ev.desc+'</p>';
    var keys=Object.keys(weight).sort(function(a,b){return new Date(a)-new Date(b);});
    var rows=[];
    for(var i=0;i<keys.length-1 && rows.length<7;i++){
      var e=weight[keys[i]]&&weight[keys[i]].e, m=weight[keys[i+1]]&&weight[keys[i+1]].m;
      if(e!=null&&m!=null){
        var d=Math.round((e-m)*10)/10;
        rows.unshift('<div style="display:flex;justify-content:space-between;font-size:13px;padding:7px 0;border-bottom:1px solid var(--line)"><span>'+keys[i].slice(5)+'晚 → '+keys[i+1].slice(5)+'早</span><span style="font-weight:700">差 '+(d>=0?"+":"")+d+' kg</span></div>');
      }
    }
    $("#wRecent").innerHTML= rows.length?('<div style="margin-top:12px"><div style="font-size:13px;color:var(--sub);font-weight:700;margin-bottom:2px">近期夜间体重差</div>'+rows.join("")+'</div>'):"";
  }
  function drawChart(targetId,pts,single){
    var W=320,H=140,pl=24,pr=8,pt=12,pb=20,x0=pl,x1=W-pr,y0=pt,y1=H-pb;
    function X(i){return x0+(x1-x0)*i/(pts.length-1)}function Y(v){return y1-(y1-y0)*(v/10)}
    var svg='<svg viewBox="0 0 '+W+' '+H+'" width="100%" style="display:block">';
    [0,5,10].forEach(function(g){var yy=Y(g);svg+='<line x1="'+x0+'" y1="'+yy+'" x2="'+x1+'" y2="'+yy+'" stroke="#eef3f0"/><text x="'+(x0-4)+'" y="'+(yy+3)+'" font-size="8" fill="#9aa8a2" text-anchor="end">'+g+'</text>';});
    function path(key,c){var d="",s=false;pts.forEach(function(p,i){var v=p[key];if(v===null)return;d+=(s?"L":"M")+X(i).toFixed(1)+" "+Y(v).toFixed(1)+" ";s=true;});return d?('<path d="'+d+'" fill="none" stroke="'+c+'" stroke-width="2.2" stroke-linejoin="round"/>'):"";}
    function dots(key,c){var s="";pts.forEach(function(p,i){var v=p[key];if(v===null)return;s+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(v).toFixed(1)+'" r="2.6" fill="'+c+'"/>';});return s;}
    if(single){svg+=path("p","#d96a5b")+dots("p","#d96a5b");}
    else{svg+=path("p","#d96a5b")+dots("p","#d96a5b")+path("b","#e08a3c")+dots("b","#e08a3c");}
    svg+='</svg>';
    $("#"+targetId).innerHTML=svg;
  }

  /* ---- export / import / clear ---- */
  $("#exportBtn").onclick=function(){
    if(!entries.length && !inventory.length && !Object.keys(weight).length){toast("还没有可导出的数据");return;}
    var data={app:"舒食纪",v:1,entries:entries,inventory:inventory,weight:weight,config:config};
    var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
    var name="舒食纪_备份_"+new Date().toISOString().slice(0,10)+".json";
    var file=new File([blob],name,{type:"application/json"});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      navigator.share({files:[file],title:name}).then(function(){}).catch(function(){});
    }else{
      var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;a.click();
      setTimeout(function(){URL.revokeObjectURL(a.href);},3000);
      toast("已导出，可在「下载」里存到文件→iCloud");
    }
  };
  $("#importBtn").onclick=function(){$("#importFile").click()};
  $("#importFile").onchange=function(e){var f=e.target.files&&e.target.files[0];if(!f)return;
    var r=new FileReader();r.onload=function(){try{var data=JSON.parse(r.result);
      var arr=data.entries||[];var have={};entries.forEach(function(x){have[x.id]=1});var added=0;
      arr.forEach(function(x){if(!have[x.id]){entries.push(x);have[x.id]=1;added++;}});
      if(data.inventory){data.inventory.forEach(function(x){if(!inventory.find(function(y){return y.id===x.id}))inventory.push(x);});}
      if(data.weight){Object.keys(data.weight).forEach(function(k){var w=data.weight[k];if(w&&(w.m!=null||w.e!=null))weight[k]=w;});}
      if(data.config){for(var key in data.config){if(data.config.hasOwnProperty(key))config[key]=data.config[key];}}
      entries.sort(function(a,b){return b.ts-a.ts});save(KEY,entries);save(INV,inventory);save(WGT,weight);save(CFG,config);toast("已导入 "+added+" 条新记录");renderHistory();
    }catch(err){toast("文件格式不对，导入失败");}};r.readAsText(f);e.target.value="";};
  $("#clearBtn").onclick=function(){
    if(confirm("确定清空全部数据？此操作不可撤销，建议先点「导出」备份。")){entries=[];save(KEY,entries);renderStats();toast("已清空");}
  };

  /* ---- settings / reminders ---- */
  function renderTimes(){
    var box=$("#timeList");box.innerHTML="";
    config.times.forEach(function(t,i){
      var row=document.createElement("div");row.className="time-row";
      row.innerHTML='<input type="time" value="'+t+'"><button class="x" data-i="'+i+'">✕</button>';
      row.querySelector("input").onchange=function(){config.times[i]=this.value;save(CFG,config);};
      row.querySelector(".x").onclick=function(){config.times.splice(i,1);save(CFG,config);renderTimes();};
      box.appendChild(row);
    });
  }
  $("#gearBtn").onclick=function(){
    $("#remEnabled").checked=config.remEnabled;
    $("#waterGoal").value=config.waterGoal||"";
    $("#weightGoal").value=config.weightGoal||"";
    $("#startWeight").value=config.startWeight||"";
    renderTimes();$("#mask").classList.add("show");
  };
  $("#closeSheet").onclick=function(){$("#mask").classList.remove("show")};
  $("#mask").onclick=function(e){if(e.target===$("#mask"))$("#mask").classList.remove("show")};
  $("#remEnabled").onchange=function(){config.remEnabled=this.checked;save(CFG,config);toast(this.checked?"提醒已开启":"提醒已关闭");};
  $("#addTime").onclick=function(){config.times.push("18:00");save(CFG,config);renderTimes();};
  $("#waterGoal").addEventListener("change",function(){var v=parseInt(this.value,10);config.waterGoal=(isNaN(v)||v<=0)?"":v;save(CFG,config);renderWater();});
  $("#weightGoal").addEventListener("change",function(){var v=parseFloat(this.value);config.weightGoal=(isNaN(v)||v<=0)?"":Math.round(v*10)/10;save(CFG,config);toast("体重目标已保存");});
  $("#startWeight").addEventListener("change",function(){var v=parseFloat(this.value);config.startWeight=(isNaN(v)||v<=0)?"":Math.round(v*10)/10;save(CFG,config);toast("起始体重已保存");});
  $("#notifBtn").onclick=function(){
    if(!("Notification" in window)){toast("当前浏览器不支持通知");return;}
    Notification.requestPermission().then(function(p){toast(p==="granted"?"已允许通知 ✅":"未允许通知");});
  };
  function checkReminder(){
    if(!config.remEnabled)return;
    var now=new Date();var hm=("0"+now.getHours()).slice(-2)+":"+("0"+now.getMinutes()).slice(-2);
    var todayKey=now.getFullYear()+"-"+(now.getMonth()+1)+"-"+now.getDate();
    var reminded=load(REM)||{};var fired=false;
    config.times.forEach(function(t){
      if(t<=hm && !reminded[todayKey+"_"+t]){reminded[todayKey+"_"+t]=1;fired=true;}
    });
    save(REM,reminded);
    if(fired){
      $("#reminderBanner").style.display="flex";
      if("Notification" in window && Notification.permission==="granted"){
        try{new Notification("舒食纪提醒",{body:"该记录今天的饮食和胃的感受啦～",icon:"icon-192.png"});}catch(e){}
      }
    }
  }
  $("#reminderGo").onclick=function(){$("#reminderBanner").style.display="none";document.querySelector('.nav button[data-view="record"]').click();};

  /* ---- PWA ---- */
  function showInstallTip(){
    var ua=navigator.userAgent,tip=$("#installTip");
    if(/iPhone|iPad|iPod/i.test(ua))tip.innerHTML="📲 加到主屏幕：点右上角 <b>分享 ⤴</b> → <b>“添加到主屏幕”</b>，之后像 App 一样从桌面打开。";
    else if(/Android/i.test(ua))tip.innerHTML="📲 加到主屏幕：点浏览器右上角 <b>⋮ 菜单</b> → <b>“安装应用 / 添加到主屏幕”</b>。";
    else tip.innerHTML="📲 手机打开本页面后，用浏览器「添加到主屏幕 / 安装」，即可像 App 一样放在桌面使用。";
    tip.style.display="block";
  }
  if(!window.matchMedia||!window.matchMedia("(display-mode: standalone)").matches)showInstallTip();
  if("serviceWorker" in navigator)window.addEventListener("load",function(){
    navigator.serviceWorker.register("sw.js").then(function(reg){
      if(reg&&reg.update)reg.update();
      if(reg&&reg.installing)reg.installing.addEventListener("statechange",function(){
        if(this.state==="installed"&&navigator.serviceWorker.controller&&confirm("发现新版本，立即刷新以使用最新功能？"))window.location.reload();
      });
    }).catch(function(){});
    navigator.serviceWorker.addEventListener("controllerchange",function(){
      if(sessionStorage.getItem("sw_reloaded"))return;
      sessionStorage.setItem("sw_reloaded","1");
      window.location.reload();
    });
  });

  // init
  renderWater();
  renderWeight();
  showRec("weight");
  renderFoodLists();
  checkReminder();
  bootstrapStorage();
  initCloud();
  if(gistEnabled()){setSync("sync");setTimeout(syncFull,1000);}else setSync("off");
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
