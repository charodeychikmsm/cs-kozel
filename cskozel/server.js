const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TILE = 48;
const MAP_W = 40, MAP_H = 30;
const SPEED = 220;
const SPEED_CROUCH = 110;
const PLAYER_RADIUS = 14;
const PLAYER_RADIUS_CROUCH = 10;
const MAX_PLAYERS = 10;
const ROUNDS_TO_WIN = 10;
const BUY_TIME = 10;
const WIN_MONEY = 2700;
const LOSE_MONEY = 1400;
const ROUND_BONUS = 1000;
const GRAVITY = 1100;
const JUMP_V = 280;
const MAX_DROPS = 40;

const WEAPONS = {
  knife:   { name:'Нож',          price:0,    dmg:55, rate:400,  spread:0,     range:70,   pellets:1, slot:3, mag:0 },
  pistol:  { name:'Пистолет',     price:0,    dmg:18, rate:260,  spread:0.030, range:800,  pellets:1, slot:2, mag:12, reload:1500 },
  usp:     { name:'USP-S',        price:200,  dmg:22, rate:180,  spread:0.020, range:1000, pellets:1, slot:2, mag:12, reload:1800 },
  p250:    { name:'P250',         price:350,  dmg:24, rate:170,  spread:0.025, range:900,  pellets:1, slot:2, mag:13, reload:1500 },
  deagle:  { name:'Desert Eagle', price:777,  dmg:58, rate:430,  spread:0.018, range:1300, pellets:1, slot:2, mag:7,  reload:2200 },
  shotgun: { name:'Дробовик',     price:1050, dmg:15, rate:900,  spread:0.130, range:520,  pellets:6, slot:1, mag:8,  reload:2400 },
  galil:   { name:'Galil AR',     price:2000, dmg:30, rate:95,   spread:0.038, range:1400, pellets:1, slot:1, mag:35, reload:2400 },
  ak:      { name:'AK-47',        price:2700, dmg:34, rate:105,  spread:0.035, range:1500, pellets:1, slot:1, mag:30, reload:2500 },
  m4a4:    { name:'M4A4',         price:3100, dmg:33, rate:90,   spread:0.030, range:1500, pellets:1, slot:1, mag:30, reload:2400 },
  awp:     { name:'AWP',          price:4750, dmg:120,rate:1500, spread:0.006, range:2200, pellets:1, slot:1, mag:5,  reload:3500 },
  armor:   { name:'Броня',        price:950,  type:'armor' },
};
function defaultWeaponColor(w){
  if (w === 'awp') return '#2d5a3d';
  if (w === 'ak') return '#8b5a3c';
  if (w === 'm4a4') return '#3a4a5a';
  if (w === 'galil') return '#a08050';
  if (w === 'shotgun') return '#7a5a3a';
  if (w === 'deagle') return '#5a5a5a';
  return '#555555';
}

function buildMap(){
  const g = Array.from({length: MAP_H}, () => Array(MAP_W).fill(0));
  const rect = (x,y,w,h) => { for (let j=y;j<y+h;j++) for (let i=x;i<x+w;i++) if (j>=0&&j<MAP_H&&i>=0&&i<MAP_W) g[j][i]=1; };
  rect(0,0,MAP_W,1); rect(0,MAP_H-1,MAP_W,1); rect(0,0,1,MAP_H); rect(MAP_W-1,0,1,MAP_H);
  const north = [
    [4,3,4,1],[4,3,1,5],[7,3,1,5],[4,7,4,1],
    [16,3,8,1],[16,3,1,4],[23,3,1,4],[16,6,8,1],
    [28,3,4,1],[28,3,1,5],[31,3,1,5],[28,7,4,1],
    [8,11,4,1],[8,11,1,4],[8,14,4,1],
    [27,11,4,1],[30,11,1,4],[27,14,4,1],
    [12,10,1,3],[26,10,1,3],
    [10,8,1,1],[14,8,1,1],[24,8,1,1],[28,8,1,1],
    [5,6,2,1],[13,4,2,1],[24,4,2,1],[32,6,2,1],
    [15,12,3,1],[21,12,3,1],
    [19,13,2,1],[19,16,2,1],
    [18,14,1,3],[21,14,1,3],
    [10,15,1,1],[29,15,1,1],
    [12,14,1,1],[27,14,1,1],
  ];
  for (const [x,y,w,h] of north){ rect(x,y,w,h); rect(x, MAP_H-y-h, w, h); }
  return g;
}
const GRID = buildMap();

function isWall(x,y){
  const tx = Math.floor(x/TILE), ty = Math.floor(y/TILE);
  if (tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return true;
  return GRID[ty][tx] === 1;
}
function collide(x,y,r){
  const minX = Math.floor((x-r)/TILE), maxX = Math.floor((x+r)/TILE);
  const minY = Math.floor((y-r)/TILE), maxY = Math.floor((y+r)/TILE);
  for (let ty=minY; ty<=maxY; ty++)
    for (let tx=minX; tx<=maxX; tx++){
      if (ty<0||ty>=MAP_H||tx<0||tx>=MAP_W) return true;
      if (GRID[ty][tx] === 1) return true;
    }
  return false;
}
function hasLOS(x1, y1, x2, y2){
  const dx = x2-x1, dy = y2-y1;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 16);
  for (let i = 1; i < steps; i++){
    const t = i/steps;
    if (isWall(x1+dx*t, y1+dy*t)) return false;
  }
  return true;
}
function rayCircle(ox,oy,dx,dy,cx,cy,r){
  const fx = ox-cx, fy = oy-cy;
  const a = dx*dx + dy*dy;
  const b = 2*(fx*dx + fy*dy);
  const c = fx*fx + fy*fy - r*r;
  const d = b*b - 4*a*c;
  if (d < 0) return null;
  const sq = Math.sqrt(d);
  const t1 = (-b-sq)/(2*a), t2 = (-b+sq)/(2*a);
  if (t1 >= 0) return t1;
  if (t2 >= 0) return t2;
  return null;
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const publicDir = path.join(__dirname, 'public');
  const fullPath = path.normalize(path.join(publicDir, urlPath));
  if (!fullPath.startsWith(publicDir)){ res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(fullPath, (err, data) => {
    if (err){ res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(fullPath).toLowerCase();
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.json':'application/json','.ico':'image/x-icon'};
    res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

const lobbies = new Map();
let nextId = 1;
const makeCode = () => { let c; do { c = Math.random().toString(36).slice(2,6).toUpperCase(); } while (lobbies.has(c)); return c; };
const getCurrentWeapon = p => p.currentSlot === 1 ? (p.slot1 || 'knife') : p.currentSlot === 2 ? (p.slot2 || 'knife') : 'knife';
const makeDropId = () => 'd_' + Math.random().toString(36).slice(2, 8);

class Lobby {
  constructor(code, name, pass){
    this.code = code; this.name = name; this.pass = pass || '';
    this.players = []; this.phase = 'waiting'; this.phaseTimer = 0;
    this.round = 0; this.score = {A:0, B:0}; this.winner = null;
    this.events = []; this.matchOver = false;
    this.droppedWeapons = [];
  }
  realCount(){ return this.players.filter(p => !p.isBot).length; }
  info(){ return { code:this.code, name:this.name, players:this.realCount(), max:MAX_PLAYERS, locked:!!this.pass }; }
  stateMsg(){
    const now = Date.now();
    return {
      t:'state', phase:this.phase, timer:Math.ceil(this.phaseTimer), round:this.round,
      score:this.score, winner:this.winner, matchOver:this.matchOver,
      drops: this.droppedWeapons.map(d => ({
        id:d.id, w:d.w, x:Math.round(d.x), y:Math.round(d.y), mag:d.mag|0, color:d.color
      })),
      players: this.players.map(p => {
        const w = WEAPONS[getCurrentWeapon(p)];
        const magField = p.currentSlot === 1 ? 'mag1' : p.currentSlot === 2 ? 'mag2' : null;
        const mag = magField ? p[magField] : 0;
        return {
          id:p.id, n:p.name, tm:p.team, bot:p.isBot?1:0,
          x:Math.round(p.x), y:Math.round(p.y), z:Math.round(p.z), a:+p.ang.toFixed(3),
          hp:p.hp, ar:p.armor, money:p.money,
          w:getCurrentWeapon(p), wc:p.weaponColors[getCurrentWeapon(p)]||null,
          s1:p.slot1, s2:p.slot2, cs:p.currentSlot,
          c:p.charColor, al:p.alive, k:p.kills, d:p.deaths,
          bought:p.boughtWeapon, boughtAr:p.boughtArmor, cr:p.crouch?1:0,
          mag, magMax:(w&&w.mag)||0, reloading:p.reloading?1:0,
          reloadT: p.reloading ? Math.max(0, p.reloadEndAt - now) : 0,
          reloadTotal: p.reloading ? (p.reloadTotal||2000) : 0,
        };
      }),
      ev:this.events,
    };
  }
  addPlayer(ws, name, id){
    const p = {
      id, ws, name, isBot:false, team:null,
      x:0, y:0, z:0, vz:0, ang:0,
      hp:100, armor:0, money:2700,
      slot1:null, slot2:'pistol', currentSlot:2,
      mag1:0, mag2:12,
      reloading:false, reloadEndAt:0, reloadTotal:0, reloadSlot:0, reloadWeapon:null,
      survived:false,
      boughtWeapon:false, boughtArmor:false, crouch:false,
      alive:false, kills:0, deaths:0,
      input:{mx:0,my:0,a:0,sh:0,jump:0,cr:0,reload:0},
      lastShot:0, charColor:null, weaponColors:{},
    };
    this.players.push(p); return p;
  }
  removePlayer(id){ this.players = this.players.filter(p => p.id !== id); }
  ensureBot(){
    const real = this.realCount();
    const hasBot = this.players.some(p => p.isBot);
    if (real === 1 && !hasBot){
      const human = this.players.find(p => !p.isBot);
      const botTeam = human.team === 'A' ? 'B' : human.team === 'B' ? 'A' : (Math.random()<0.5?'A':'B');
      const bot = {
        id:'bot_'+Math.random().toString(36).slice(2,8), ws:null, isBot:true,
        name:'BOT Vasya', team:botTeam,
        x:0, y:0, z:0, vz:0, ang:0, hp:100, armor:0, money:2700,
        slot1:null, slot2:'pistol', currentSlot:2,
        mag1:0, mag2:12, reloading:false, reloadEndAt:0, reloadTotal:0, reloadSlot:0, reloadWeapon:null,
        survived:false,
        boughtWeapon:false, boughtArmor:false, crouch:false,
        alive:false, kills:0, deaths:0,
        input:{mx:0,my:0,a:0,sh:0,jump:0,cr:0,reload:0},
        lastShot:0, charColor:null, weaponColors:{},
        aiNextThink:0, aiAimError:0, lastSeenAt:0, aimWobble:0, nextShotAt:0,
      };
      this.players.push(bot);
      this.events.push({type:'bot_join', name: bot.name});
    } else if (real >= 2 && hasBot){
      this.players = this.players.filter(p => !p.isBot);
      this.events.push({type:'bot_leave'});
    }
  }
}

function dropWeapon(lobby, w, x, y, mag, color){
  if (!w || w === 'knife') return;
  if (lobby.droppedWeapons.length >= MAX_DROPS){
    lobby.droppedWeapons.shift();
  }
  lobby.droppedWeapons.push({
    id: makeDropId(),
    w, x, y, mag: mag|0, color: color || defaultWeaponColor(w),
  });
  lobby.events.push({type:'drop', x, y});
}
function dropAllOnDeath(lobby, player){
  if (player.slot1){
    const col = player.weaponColors[player.slot1] || defaultWeaponColor(player.slot1);
    dropWeapon(lobby, player.slot1, player.x + (Math.random()-0.5)*16, player.y + (Math.random()-0.5)*16, player.mag1, col);
  }
  if (player.slot2 && player.slot2 !== 'pistol'){
    const col = player.weaponColors[player.slot2] || defaultWeaponColor(player.slot2);
    dropWeapon(lobby, player.slot2, player.x + (Math.random()-0.5)*16, player.y + (Math.random()-0.5)*16, player.mag2, col);
  }
}

function startRound(lobby){
  lobby.round++;
  lobby.phase = 'buy';
  lobby.phaseTimer = BUY_TIME;
  lobby.winner = null;
  lobby.droppedWeapons = [];  // очищаем поле в начале раунда

  const cA = lobby.players.filter(p => p.team==='A').length;
  const cB = lobby.players.filter(p => p.team==='B').length;
  let a=cA, b=cB;
  for (const p of lobby.players){ if (p.team) continue; if (a<=b){p.team='A';a++;} else {p.team='B';b++;} }

  let ai=0, bi=0;
  for (const p of lobby.players){
    p.hp = 100; p.alive = true;
    p.boughtWeapon = false; p.boughtArmor = false;
    p.crouch = false; p.z = 0; p.vz = 0;
    p.lastShot = 0; p.reloading = false; p.reloadEndAt = 0; p.reloadTotal = 0;
    p.input.sh = 0; p.input.mx = 0; p.input.my = 0;
    p.input.jump = 0; p.input.cr = 0; p.input.reload = 0;

    if (!p.survived){
      p.slot1 = null; p.slot2 = 'pistol'; p.currentSlot = 2;
      p.armor = 0;
    }
    const w1 = p.slot1 ? WEAPONS[p.slot1] : null;
    const w2 = p.slot2 ? WEAPONS[p.slot2] : null;
    p.mag1 = w1 ? w1.mag : 0;
    p.mag2 = w2 ? w2.mag : 0;

    if (p.team === 'A'){
      p.x = (10 + (ai%10)) * TILE; p.y = (MAP_H-2.5)*TILE; p.ang = -Math.PI/2; ai++;
    } else {
      p.x = (10 + (bi%10)) * TILE; p.y = 2.5*TILE; p.ang = Math.PI/2; bi++;
    }
  }
  lobby.events = [];
}

function endRound(lobby, winner){
  if (lobby.phase === 'end') return;
  lobby.phase = 'end';
  lobby.phaseTimer = 5;
  lobby.winner = winner;

  for (const p of lobby.players){
    p.survived = p.alive;
    if (winner === 'A' || winner === 'B'){
      if (p.team === winner) p.money = Math.min(p.money + WIN_MONEY + ROUND_BONUS, 16000);
      else                   p.money = Math.min(p.money + LOSE_MONEY + ROUND_BONUS, 16000);
    } else {
      p.money = Math.min(p.money + ROUND_BONUS, 16000);
    }
  }
  if (winner === 'A' || winner === 'B'){
    lobby.score[winner]++;
    if (lobby.score[winner] >= ROUNDS_TO_WIN) lobby.matchOver = true;
  }
  lobby.events.push({type:'roundend', winner});
}

function checkRoundEnd(lobby){
  if (lobby.phase !== 'live') return;
  const aliveA = lobby.players.filter(p => p.team==='A' && p.alive).length;
  const aliveB = lobby.players.filter(p => p.team==='B' && p.alive).length;
  if (aliveA === 0 && aliveB === 0) endRound(lobby, 'draw');
  else if (aliveA === 0) endRound(lobby, 'B');
  else if (aliveB === 0) endRound(lobby, 'A');
}

function getPlayerRadius(p){ return p.crouch ? PLAYER_RADIUS_CROUCH : PLAYER_RADIUS; }

function shoot(lobby, shooter, weaponId){
  const weapon = WEAPONS[weaponId] || WEAPONS.pistol;
  const dx = Math.cos(shooter.ang);
  const dy = Math.sin(shooter.ang);

  let tracerDist = weapon.range;
  for (let t=0; t<weapon.range; t+=6){
    if (isWall(shooter.x + dx*t, shooter.y + dy*t)){ tracerDist = t; break; }
  }
  lobby.events.push({
    type:'shot', x:shooter.x, y:shooter.y, ang:shooter.ang, len:tracerDist,
    color: shooter.team==='A' ? '#88ccff' : '#ffcc88',
    weapon:weaponId, byId:shooter.id,
  });

  for (let i=0; i<weapon.pellets; i++){
    const sa = (Math.random()-0.5)*weapon.spread*2;
    const ca = Math.cos(sa), si = Math.sin(sa);
    const px = dx*ca - dy*si;
    const py = dx*si + dy*ca;
    let wallDist = weapon.range, hitWall = false;
    for (let t=0; t<weapon.range; t+=6){
      if (isWall(shooter.x + px*t, shooter.y + py*t)){ wallDist = t; hitWall = true; break; }
    }
    let hitPlayer = null, hitDist = wallDist;
    for (const other of lobby.players){
      if (other === shooter || !other.alive || other.team === shooter.team) continue;
      const d = rayCircle(shooter.x, shooter.y, px, py, other.x, other.y, getPlayerRadius(other) + 4);
      if (d !== null && d < hitDist){ hitDist = d; hitPlayer = other; }
    }
    if (hitPlayer){
      let dmg = weapon.dmg;
      if (hitPlayer.armor > 0){
        const absorbed = Math.min(hitPlayer.armor, dmg*0.5);
        hitPlayer.armor -= absorbed; dmg -= absorbed;
      }
      hitPlayer.hp -= dmg;
      if (hitPlayer.hp <= 0){
        hitPlayer.hp = 0; hitPlayer.alive = false; hitPlayer.deaths++; shooter.kills++;
        // Дропаем оружие убитого
        dropAllOnDeath(lobby, hitPlayer);
        lobby.events.push({type:'kill', killer:shooter.name, victim:hitPlayer.name, killerId:shooter.id, killerTeam:shooter.team, weapon:weaponId});
      } else {
        lobby.events.push({type:'hit', x:shooter.x + px*hitDist, y:shooter.y + py*hitDist});
      }
    } else if (hitWall){
      const hx = shooter.x + px * wallDist;
      const hy = shooter.y + py * wallDist;
      const hz = 25 + Math.random() * 50;
      lobby.events.push({type:'impact', x:hx, y:hy, z:hz});
    }
  }
  checkRoundEnd(lobby);
}

function botBuy(bot, lobby){
  if (bot.boughtWeapon && bot.boughtArmor) return;
  if (!bot.boughtArmor && bot.money >= 950 && bot.money < 2000){
    bot.money -= 950; bot.armor = 100; bot.boughtArmor = true; return;
  }
  if (!bot.boughtWeapon){
    let c = null;
    if (bot.money >= 4750) c = 'awp';
    else if (bot.money >= 3100) c = 'm4a4';
    else if (bot.money >= 2700) c = 'ak';
    else if (bot.money >= 2000) c = 'galil';
    else if (bot.money >= 1050) c = 'shotgun';
    else if (bot.money >= 777) c = 'deagle';
    else if (bot.money >= 350) c = 'p250';
    else if (bot.money >= 200) c = 'usp';
    if (c){ bot.money -= WEAPONS[c].price; bot.slot1 = c; bot.mag1 = WEAPONS[c].mag; bot.currentSlot = 1; bot.boughtWeapon = true; }
  }
  if (!bot.boughtArmor && bot.money >= 950){ bot.money -= 950; bot.armor = 100; bot.boughtArmor = true; }
}

function botThink(lobby, bot, dt){
  if (!bot.alive) return;
  if (lobby.phase === 'buy') botBuy(bot, lobby);

  if (bot.lastSeenAt === undefined) bot.lastSeenAt = 0;
  if (bot.aimWobble === undefined) bot.aimWobble = 0;
  if (bot.nextShotAt === undefined) bot.nextShotAt = 0;

  const wid = getCurrentWeapon(bot);
  const w = WEAPONS[wid];
  const magField = bot.currentSlot === 1 ? 'mag1' : bot.currentSlot === 2 ? 'mag2' : null;
  if (magField && w && w.mag && bot[magField] <= 0 && !bot.reloading){
    bot.reloading = true;
    bot.reloadEndAt = Date.now() + w.reload;
    bot.reloadTotal = w.reload;
    bot.reloadSlot = bot.currentSlot;
    bot.reloadWeapon = wid;
  }

  let target = null, tDist = Infinity;
  for (const p of lobby.players){
    if (p === bot || p.isBot || !p.alive || p.team === bot.team) continue;
    const d = Math.hypot(p.x - bot.x, p.y - bot.y);
    if (d < tDist){ tDist = d; target = p; }
  }
  if (!target){ bot.input.mx = 0; bot.input.my = 0; bot.input.sh = 0; bot.lastSeenAt = 0; return; }

  const dx = target.x - bot.x, dy = target.y - bot.y;
  const canSee = hasLOS(bot.x, bot.y, target.x, target.y);
  if (canSee && tDist < 1500){ if (!bot.lastSeenAt) bot.lastSeenAt = Date.now(); }
  else bot.lastSeenAt = 0;
  const reactOK = bot.lastSeenAt && (Date.now() - bot.lastSeenAt > 700);

  bot.aimWobble += (Math.random()-0.5) * 0.35 * dt;
  bot.aimWobble = Math.max(-0.25, Math.min(0.25, bot.aimWobble));
  const aimAng = Math.atan2(dy, dx) + bot.aimWobble;
  let diff = aimAng - bot.ang;
  while (diff > Math.PI) diff -= Math.PI*2;
  while (diff < -Math.PI) diff += Math.PI*2;
  bot.ang += diff * Math.min(1, dt*3.5);
  const aimed = Math.abs(diff) < 0.20;

  if (canSee && tDist < 1400 && reactOK && !bot.reloading){
    if (Date.now() > bot.nextShotAt){
      if (aimed && Math.random() > 0.22){ bot.input.sh = 1; bot.nextShotAt = Date.now() + 280; }
      else bot.input.sh = 0;
    } else bot.input.sh = 0;
    if (tDist < 400){ bot.input.mx = 0; bot.input.my = 0; }
    else { const l = tDist||1; bot.input.mx = dx/l*0.6; bot.input.my = dy/l*0.6; }
  } else {
    bot.input.sh = 0;
    const l = tDist || 1;
    bot.input.mx = dx/l; bot.input.my = dy/l;
    const nx = bot.x + bot.input.mx*20, ny = bot.y + bot.input.my*20;
    if (collide(nx, bot.y, PLAYER_RADIUS)){ bot.input.mx = 0; bot.input.my = dy>0?1:-1; }
    if (collide(bot.x, ny, PLAYER_RADIUS)){ bot.input.my = 0; bot.input.mx = dx>0?1:-1; }
  }
}

function movePlayers(lobby, dt){
  for (const p of lobby.players){
    if (!p.alive) continue;
    p.crouch = p.input.cr ? true : false;
    if (p.input.jump && p.z <= 0){ p.vz = JUMP_V; p.z = 0.01; }
    p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;
    if (p.z <= 0){ p.z = 0; p.vz = 0; }
    if (p.z > 200){ p.z = 200; p.vz = 0; }

    let mx = p.input.mx||0, my = p.input.my||0;
    const len = Math.hypot(mx, my);
    if (len > 0.01){
      mx /= len; my /= len;
      const spd = p.crouch ? SPEED_CROUCH : SPEED;
      const r = getPlayerRadius(p);
      const nx = p.x + mx*spd*dt, ny = p.y + my*spd*dt;
      if (!collide(nx, p.y, r)) p.x = nx;
      if (!collide(p.x, ny, r)) p.y = ny;
    }
    if (!p.isBot) p.ang = p.input.a || 0;

    if (p.reloading && Date.now() >= p.reloadEndAt){
      const w = WEAPONS[p.reloadWeapon];
      if (w && w.mag){
        if (p.reloadSlot === 1 && p.slot1 === p.reloadWeapon) p.mag1 = w.mag;
        else if (p.reloadSlot === 2 && p.slot2 === p.reloadWeapon) p.mag2 = w.mag;
      }
      p.reloading = false;
      p.reloadEndAt = 0;
      p.reloadTotal = 0;
    }
  }
}

function handleShooting(lobby){
  const now = Date.now();
  for (const p of lobby.players){
    if (!p.alive || !p.input.sh) continue;
    if (p.reloading) continue;
    const wid = getCurrentWeapon(p);
    const w = WEAPONS[wid] || WEAPONS.pistol;
    const magField = p.currentSlot === 1 ? 'mag1' : p.currentSlot === 2 ? 'mag2' : null;
    if (magField && w.mag && p[magField] <= 0) continue;
    if (now - p.lastShot >= w.rate){
      p.lastShot = now;
      if (magField && w.mag) p[magField]--;
      shoot(lobby, p, wid);
    }
  }
}

function gameTick(lobby, dt){
  if (lobby.phase === 'waiting'){
    const a = lobby.players.filter(p => p.team==='A').length;
    const b = lobby.players.filter(p => p.team==='B').length;
    if (lobby.players.length >= 2 && a >= 1 && b >= 1){
      lobby.score = {A:0, B:0};
      lobby.round = 0;
      lobby.matchOver = false;
      for (const p of lobby.players){ p.kills = 0; p.deaths = 0; p.survived = false; }
      startRound(lobby);
    }
    return;
  }
  if (lobby.phase === 'buy'){
    lobby.phaseTimer -= dt;
    for (const bot of lobby.players.filter(p => p.isBot)) botThink(lobby, bot, dt);
    movePlayers(lobby, dt);
    if (lobby.phaseTimer <= 0){ lobby.phase = 'live'; lobby.phaseTimer = 0; }
    return;
  }
  if (lobby.phase === 'live'){
    for (const bot of lobby.players.filter(p => p.isBot)) botThink(lobby, bot, dt);
    movePlayers(lobby, dt);
    handleShooting(lobby);
    return;
  }
  if (lobby.phase === 'end'){
    lobby.phaseTimer -= dt;
    movePlayers(lobby, dt);
    if (lobby.phaseTimer <= 0){
      if (lobby.matchOver){ /* ждём */ } else startRound(lobby);
    }
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = nextId++;
  let lobby = null, player = null;

  ws.send(JSON.stringify({t:'init', id:playerId, grid:GRID, mw:MAP_W, mh:MAP_H, tile:TILE}));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'list'){
      ws.send(JSON.stringify({t:'lobbies', list:[...lobbies.values()].map(l => l.info())}));
      return;
    }
    if (msg.t === 'create'){
      const code = makeCode();
      lobby = new Lobby(code, msg.name||'Игрок', msg.pass||'');
      lobbies.set(code, lobby);
      player = lobby.addPlayer(ws, msg.name||'Игрок', playerId);
      lobby.ensureBot();
      ws.send(JSON.stringify({t:'joined', code, id:playerId}));
      return;
    }
    if (msg.t === 'join'){
      const code = (msg.code||'').toUpperCase();
      const l = lobbies.get(code);
      if (!l){ ws.send(JSON.stringify({t:'error', msg:'Лобби не найдено'})); return; }
      if (l.pass && l.pass !== (msg.pass||'')){ ws.send(JSON.stringify({t:'error', msg:'Неверный пароль'})); return; }
      if (l.realCount() >= MAX_PLAYERS){ ws.send(JSON.stringify({t:'error', msg:'Лобби заполнено'})); return; }
      lobby = l;
      player = lobby.addPlayer(ws, msg.name||'Игрок', playerId);
      lobby.ensureBot();
      ws.send(JSON.stringify({t:'joined', code, id:playerId}));
      return;
    }
    if (!lobby || !player) return;

    if (msg.t === 'team'){
      if (lobby.phase !== 'waiting') return;
      if (msg.team !== 'A' && msg.team !== 'B') return;
      const cnt = lobby.players.filter(p => p.team === msg.team).length;
      if (cnt >= Math.ceil(MAX_PLAYERS/2) && player.team !== msg.team) return;
      player.team = msg.team;
      const bot = lobby.players.find(p => p.isBot);
      if (bot) bot.team = msg.team === 'A' ? 'B' : 'A';
      return;
    }
    if (msg.t === 'input'){
      player.input.mx = Math.max(-1, Math.min(1, +msg.mx||0));
      player.input.my = Math.max(-1, Math.min(1, +msg.my||0));
      player.input.a  = +msg.a || 0;
      player.input.sh = msg.sh | 0;
      player.input.jump = msg.jump | 0;
      player.input.cr = msg.cr | 0;
      if (msg.sw){
        const s = msg.sw | 0;
        if (s === 1 && player.slot1){ player.currentSlot = 1; player.reloading = false; }
        else if (s === 2 && player.slot2){ player.currentSlot = 2; player.reloading = false; }
        else if (s === 3){ player.currentSlot = 3; player.reloading = false; }
        player.lastShot = 0;
      }
      return;
    }
    if (msg.t === 'reload'){
      if (!player.alive || player.reloading) return;
      const wid = getCurrentWeapon(player);
      const w = WEAPONS[wid];
      if (!w || !w.mag || w.mag <= 0) return;
      const magField = player.currentSlot === 1 ? 'mag1' : player.currentSlot === 2 ? 'mag2' : null;
      if (!magField) return;
      if (player[magField] >= w.mag) return;
      player.reloading = true;
      player.reloadEndAt = Date.now() + w.reload;
      player.reloadTotal = w.reload;
      player.reloadSlot = player.currentSlot;
      player.reloadWeapon = wid;
      return;
    }
    if (msg.t === 'buy'){
      if (lobby.phase !== 'buy' || !player.alive) return;
      const w = WEAPONS[msg.w];
      if (!w || player.money < w.price) return;
      if (w.type === 'armor'){
        if (player.boughtArmor) return;
        player.money -= w.price; player.armor = 100; player.boughtArmor = true;
      } else {
        if (player.boughtWeapon) return;
        player.money -= w.price;
        if (w.slot === 1){ player.slot1 = msg.w; player.mag1 = w.mag; player.currentSlot = 1; }
        else { player.slot2 = msg.w; player.mag2 = w.mag; player.currentSlot = 2; }
        player.boughtWeapon = true;
        player.reloading = false;
      }
      return;
    }
    // ВЫКИНУТЬ текущее оружие
    if (msg.t === 'drop'){
      if (!player.alive) return;
      const cur = getCurrentWeapon(player);
      if (cur === 'knife') return;
      if (player.currentSlot === 1 && player.slot1){
        const col = player.weaponColors[player.slot1] || defaultWeaponColor(player.slot1);
        dropWeapon(lobby, player.slot1, player.x, player.y, player.mag1, col);
        player.slot1 = null; player.mag1 = 0;
        player.currentSlot = player.slot2 ? 2 : 3;
        player.reloading = false;
      } else if (player.currentSlot === 2 && player.slot2){
        const col = player.weaponColors[player.slot2] || defaultWeaponColor(player.slot2);
        dropWeapon(lobby, player.slot2, player.x, player.y, player.mag2, col);
        player.slot2 = null; player.mag2 = 0;
        player.currentSlot = player.slot1 ? 1 : 3;
        player.reloading = false;
      }
      return;
    }
    // ПОДОБРАТЬ оружие с земли
    if (msg.t === 'pickup'){
      if (!player.alive) return;
      const idx = lobby.droppedWeapons.findIndex(d => d.id === msg.id);
      if (idx < 0) return;
      const drop = lobby.droppedWeapons[idx];
      const dist = Math.hypot(drop.x - player.x, drop.y - player.y);
      if (dist > 60) return;
      const wInfo = WEAPONS[drop.w];
      if (!wInfo || wInfo.type === 'armor') return;
      lobby.droppedWeapons.splice(idx, 1);
      const magVal = drop.mag || wInfo.mag || 0;
      const col = drop.color;
      if (wInfo.slot === 1){
        // Меняем основное оружие
        if (player.slot1){
          const oldCol = player.weaponColors[player.slot1] || defaultWeaponColor(player.slot1);
          dropWeapon(lobby, player.slot1, player.x, player.y, player.mag1, oldCol);
        }
        player.slot1 = drop.w;
        player.mag1 = magVal;
        player.currentSlot = 1;
        if (col) player.weaponColors[drop.w] = col;
      } else {
        // Меняем пистолет
        if (player.slot2){
          const oldCol = player.weaponColors[player.slot2] || defaultWeaponColor(player.slot2);
          dropWeapon(lobby, player.slot2, player.x, player.y, player.mag2, oldCol);
        }
        player.slot2 = drop.w;
        player.mag2 = magVal;
        player.currentSlot = 2;
        if (col) player.weaponColors[drop.w] = col;
      }
      player.reloading = false;
      return;
    }
    if (msg.t === 'cosmetic'){
      if (msg.charColor === null || typeof msg.charColor === 'string') player.charColor = msg.charColor;
      if (msg.weaponColors && typeof msg.weaponColors === 'object') player.weaponColors = msg.weaponColors;
      return;
    }
  });

  ws.on('close', () => {
    if (!lobby) return;
    lobby.removePlayer(playerId);
    if (lobby.realCount() === 0){
      lobbies.delete(lobby.code);
    } else {
      lobby.ensureBot();
      if (lobby.realCount() < 2 && lobby.phase !== 'waiting'){
        lobby.phase = 'waiting'; lobby.phaseTimer = 0; lobby.round = 0;
        lobby.score = {A:0, B:0}; lobby.winner = null; lobby.matchOver = false;
        lobby.droppedWeapons = [];
      }
    }
  });
});

setInterval(() => { const dt = 1/60; for (const l of lobbies.values()) gameTick(l, dt); }, 1000/60);
setInterval(() => {
  for (const lobby of lobbies.values()){
    const data = JSON.stringify(lobby.stateMsg());
    for (const p of lobby.players) if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    lobby.events = [];
  }
}, 1000/30);

server.listen(PORT, () => console.log('CS:KOZEL running on port ' + PORT));
