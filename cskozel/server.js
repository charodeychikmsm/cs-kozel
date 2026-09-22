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
const GRAVITY = 900;
const JUMP_V = 280;

const WEAPONS = {
  knife:   { name:'Нож',          price:0,    dmg:55, rate:400,  spread:0,     range:70,   pellets:1, slot:3, melee:true },
  pistol:  { name:'Пистолет',     price:0,    dmg:18, rate:260,  spread:0.030, range:800,  pellets:1, slot:2 },
  usp:     { name:'USP-S',        price:200,  dmg:22, rate:180,  spread:0.020, range:1000, pellets:1, slot:2 },
  p250:    { name:'P250',         price:350,  dmg:24, rate:170,  spread:0.025, range:900,  pellets:1, slot:2 },
  deagle:  { name:'Desert Eagle', price:777,  dmg:58, rate:430,  spread:0.018, range:1300, pellets:1, slot:2 },
  shotgun: { name:'Дробовик',     price:1050, dmg:15, rate:900,  spread:0.130, range:520,  pellets:6, slot:1 },
  galil:   { name:'Galil AR',     price:2000, dmg:30, rate:95,   spread:0.038, range:1400, pellets:1, slot:1 },
  ak:      { name:'AK-47',        price:2700, dmg:34, rate:105,  spread:0.035, range:1500, pellets:1, slot:1 },
  m4a4:    { name:'M4A4',         price:3100, dmg:33, rate:90,   spread:0.030, range:1500, pellets:1, slot:1 },
  awp:     { name:'AWP',          price:4750, dmg:120,rate:1500, spread:0.006, range:2200, pellets:1, slot:1 },
  armor:   { name:'Броня',        price:950,  type:'armor' },
};

function buildMap(){
  const g = Array.from({length: MAP_H}, () => Array(MAP_W).fill(0));
  const rect = (x,y,w,h) => {
    for (let j=y; j<y+h; j++)
      for (let i=x; i<x+w; i++)
        if (j>=0 && j<MAP_H && i>=0 && i<MAP_W) g[j][i] = 1;
  };
  rect(0,0,MAP_W,1); rect(0,MAP_H-1,MAP_W,1);
  rect(0,0,1,MAP_H); rect(MAP_W-1,0,1,MAP_H);
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
  for (const [x,y,w,h] of north){
    rect(x,y,w,h);
    rect(x, MAP_H - y - h, w, h);
  }
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
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / 16);
  for (let i = 1; i < steps; i++){
    const t = i / steps;
    if (isWall(x1 + dx*t, y1 + dy*t)) return false;
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
function makeCode(){
  let c;
  do { c = Math.random().toString(36).slice(2,6).toUpperCase(); } while (lobbies.has(c));
  return c;
}

function getCurrentWeapon(p){
  if (p.currentSlot === 1) return p.slot1 || 'knife';
  if (p.currentSlot === 2) return p.slot2 || 'knife';
  return 'knife';
}

class Lobby {
  constructor(code, name, pass){
    this.code = code;
    this.name = name;
    this.pass = pass || '';
    this.players = [];
    this.phase = 'waiting';
    this.phaseTimer = 0;
    this.round = 0;
    this.score = {A:0, B:0};
    this.winner = null;
    this.events = [];
    this.matchOver = false;
  }
  realCount(){ return this.players.filter(p => !p.isBot).length; }
  info(){
    return { code:this.code, name:this.name, players:this.realCount(), max:MAX_PLAYERS, locked: !!this.pass };
  }
  stateMsg(){
    return {
      t:'state',
      phase: this.phase,
      timer: Math.ceil(this.phaseTimer),
      round: this.round,
      score: this.score,
      winner: this.winner,
      matchOver: this.matchOver,
      players: this.players.map(p => ({
        id:p.id, n:p.name, tm:p.team, bot: p.isBot ? 1 : 0,
        x: Math.round(p.x), y: Math.round(p.y),
        z: Math.round(p.z), a:+p.ang.toFixed(3),
        hp:p.hp, ar:p.armor, money:p.money,
        w: getCurrentWeapon(p),
        wc: p.weaponColors[getCurrentWeapon(p)] || null,
        s1: p.slot1, s2: p.slot2,
        cs: p.currentSlot,
        c: p.charColor,
        al:p.alive, k:p.kills, d:p.deaths,
        bought:p.boughtWeapon, boughtAr:p.boughtArmor,
        cr: p.crouch ? 1 : 0,
      })),
      ev: this.events,
    };
  }
  addPlayer(ws, name, id){
    const p = {
      id, ws, name, isBot:false,
      team:null,
      x:0, y:0, z:0, vz:0, ang:0,
      hp:100, armor:0, money:2700,
      slot1:null, slot2:'pistol', currentSlot:2,
      boughtWeapon:false, boughtArmor:false,
      crouch:false,
      alive:false, kills:0, deaths:0,
      input:{mx:0,my:0,a:0,sh:0,jump:0,cr:0,slot:0},
      lastShot:0,
      charColor:null, weaponColors:{},
    };
    this.players.push(p);
    return p;
  }
  removePlayer(id){ this.players = this.players.filter(p => p.id !== id); }

  ensureBot(){
    const real = this.realCount();
    const botExists = this.players.some(p => p.isBot);
    if (real === 1 && !botExists){
      const human = this.players.find(p => !p.isBot);
      const botTeam = human.team === 'A' ? 'B' : (human.team === 'B' ? 'A' : (Math.random() < 0.5 ? 'A' : 'B'));
      const bot = {
        id: 'bot_' + Math.random().toString(36).slice(2, 8),
        ws: null, isBot: true,
        name: 'BOT Vasya',
        team: botTeam,
        x: 0, y: 0, z: 0, vz: 0, ang: 0,
        hp: 100, armor: 0, money: 2700,
        slot1: null, slot2: 'pistol', currentSlot: 2,
        boughtWeapon: false, boughtArmor: false,
        crouch: false,
        alive: false, kills: 0, deaths: 0,
        input: {mx:0, my:0, a:0, sh:0, jump:0, cr:0, slot:0},
        lastShot: 0,
        charColor: null, weaponColors: {},
        aiNextThink: 0,
        aiAimError: 0,
      };
      this.players.push(bot);
      this.events.push({type:'bot_join', name: bot.name});
    } else if (real >= 2 && botExists){
      this.players = this.players.filter(p => !p.isBot);
      this.events.push({type:'bot_leave'});
    }
  }
}

function startRound(lobby){
  lobby.round++;
  lobby.phase = 'buy';
  lobby.phaseTimer = BUY_TIME;
  lobby.winner = null;

  const cA = lobby.players.filter(p => p.team === 'A').length;
  const cB = lobby.players.filter(p => p.team === 'B').length;
  let a = cA, b = cB;
  for (const p of lobby.players){
    if (p.team) continue;
    if (a <= b) { p.team = 'A'; a++; } else { p.team = 'B'; b++; }
  }

  let ai = 0, bi = 0;
  for (const p of lobby.players){
    p.hp = 100;
    p.alive = true;
    p.boughtWeapon = false;
    p.boughtArmor = false;
    p.slot1 = null;
    p.slot2 = 'pistol';
    p.currentSlot = 2;
    p.armor = 0;
    p.z = 0; p.vz = 0;
    p.crouch = false;
    p.lastShot = 0;
    p.input.sh = 0;
    p.input.mx = 0; p.input.my = 0;
    p.input.jump = 0; p.input.cr = 0; p.input.slot = 0;
    if (p.team === 'A'){
      p.x = (10 + (ai % 10)) * TILE;
      p.y = (MAP_H - 2.5) * TILE;
      p.ang = -Math.PI/2;
      ai++;
    } else {
      p.x = (10 + (bi % 10)) * TILE;
      p.y = 2.5 * TILE;
      p.ang = Math.PI/2;
      bi++;
    }
  }
  lobby.events = [];
}

function endRound(lobby, winner){
  if (lobby.phase === 'end') return;
  lobby.phase = 'end';
  lobby.phaseTimer = 5;
  lobby.winner = winner;
  if (winner === 'A' || winner === 'B'){
    lobby.score[winner]++;
    for (const p of lobby.players){
      if (p.team === winner) p.money = Math.min(p.money + WIN_MONEY, 16000);
      else                   p.money = Math.min(p.money + LOSE_MONEY, 16000);
    }
    if (lobby.score[winner] >= ROUNDS_TO_WIN) lobby.matchOver = true;
  }
  lobby.events.push({type:'roundend', winner});
}

function checkRoundEnd(lobby){
  if (lobby.phase !== 'live') return;
  const aliveA = lobby.players.filter(p => p.team === 'A' && p.alive).length;
  const aliveB = lobby.players.filter(p => p.team === 'B' && p.alive).length;
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
    type:'shot',
    x:shooter.x, y:shooter.y,
    ang:shooter.ang, len:tracerDist,
    color: shooter.team === 'A' ? '#88ccff' : '#ffcc88',
    weapon: weaponId,
    byId: shooter.id,
  });

  for (let i=0; i<weapon.pellets; i++){
    const sa = (Math.random() - 0.5) * weapon.spread * 2;
    const ca = Math.cos(sa), si = Math.sin(sa);
    const px = dx*ca - dy*si;
    const py = dx*si + dy*ca;
    let wallDist = weapon.range;
    for (let t=0; t<weapon.range; t+=6){
      if (isWall(shooter.x + px*t, shooter.y + py*t)){ wallDist = t; break; }
    }
    let hitPlayer = null, hitDist = wallDist;
    for (const other of lobby.players){
      if (other === shooter || !other.alive || other.team === shooter.team) continue;
      const d = rayCircle(shooter.x, shooter.y, px, py, other.x, other.y, getPlayerRadius(other));
      if (d !== null && d < hitDist){ hitDist = d; hitPlayer = other; }
    }
    if (hitPlayer){
      let dmg = weapon.dmg;
      if (hitPlayer.armor > 0){
        const absorbed = Math.min(hitPlayer.armor, dmg * 0.5);
        hitPlayer.armor -= absorbed;
        dmg -= absorbed;
      }
      hitPlayer.hp -= dmg;
      if (hitPlayer.hp <= 0){
        hitPlayer.hp = 0;
        hitPlayer.alive = false;
        hitPlayer.deaths++;
        shooter.kills++;
        lobby.events.push({
          type:'kill',
          killer: shooter.name, victim: hitPlayer.name,
          killerId: shooter.id, killerTeam: shooter.team
        });
      } else {
        lobby.events.push({type:'hit', x: shooter.x + px*hitDist, y: shooter.y + py*hitDist});
      }
    }
  }
  checkRoundEnd(lobby);
}

/* ===================== AI БОТА ===================== */
function botBuy(bot, lobby){
  if (bot.boughtWeapon && bot.boughtArmor) return;
  // Приоритет: если мало денег — только броня
  if (!bot.boughtArmor && bot.money >= 950 && bot.money < 2000){
    bot.money -= 950;
    bot.armor = 100;
    bot.boughtArmor = true;
    return;
  }
  if (!bot.boughtWeapon){
    let choice = null;
    if (bot.money >= 4750) choice = 'awp';
    else if (bot.money >= 3100) choice = 'm4a4';
    else if (bot.money >= 2700) choice = 'ak';
    else if (bot.money >= 2000) choice = 'galil';
    else if (bot.money >= 1050) choice = 'shotgun';
    else if (bot.money >= 777) choice = 'deagle';
    else if (bot.money >= 350) choice = 'p250';
    else if (bot.money >= 200) choice = 'usp';
    if (choice){
      bot.money -= WEAPONS[choice].price;
      bot.slot1 = choice;
      bot.currentSlot = 1;
      bot.boughtWeapon = true;
    }
  }
  if (!bot.boughtArmor && bot.money >= 950){
    bot.money -= 950;
    bot.armor = 100;
    bot.boughtArmor = true;
  }
}

function botThink(lobby, bot, dt){
  if (!bot.alive) return;

  // Покупка в фазе buy
  if (lobby.phase === 'buy') botBuy(bot, lobby);

  // Поиск ближайшего врага
  let target = null, tDist = Infinity;
  for (const p of lobby.players){
    if (p === bot || p.isBot) continue;
    if (!p.alive || p.team === bot.team) continue;
    const d = Math.hypot(p.x - bot.x, p.y - bot.y);
    if (d < tDist){ tDist = d; target = p; }
  }
  if (!target){
    bot.input.mx = 0; bot.input.my = 0; bot.input.sh = 0;
    return;
  }

  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const aimAng = Math.atan2(dy, dx);
  const canSee = hasLOS(bot.x, bot.y, target.x, target.y);

  // Плавный доворот
  let diff = aimAng - bot.ang;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  bot.ang += diff * Math.min(1, dt * 8);

  // Немного разброса прицела
  const aimed = Math.abs(diff) < 0.15;

  if (canSee && tDist < 1500){
    // Стрелять
    bot.input.sh = aimed ? 1 : 0;
    // Иногда стреляет даже при небольшом отклонении
    if (Math.abs(diff) < 0.4 && tDist < 800) bot.input.sh = 1;
    // Останавливается при стрельбе
    bot.input.mx = 0; bot.input.my = 0;
  } else {
    bot.input.sh = 0;
    // Идёт к цели
    const len = tDist || 1;
    bot.input.mx = dx / len;
    bot.input.my = dy / len;
    // Простое избегание стен
    const nx = bot.x + bot.input.mx * 20;
    const ny = bot.y + bot.input.my * 20;
    if (collide(nx, bot.y, PLAYER_RADIUS)){
      bot.input.mx = 0;
      bot.input.my = dy > 0 ? 1 : -1;
    }
    if (collide(bot.x, ny, PLAYER_RADIUS)){
      bot.input.my = 0;
      bot.input.mx = dx > 0 ? 1 : -1;
    }
  }
}

function movePlayers(lobby, dt){
  for (const p of lobby.players){
    if (!p.alive) continue;
    p.crouch = p.input.cr ? true : false;
    if (p.input.jump && p.z <= 0){
      p.vz = JUMP_V;
      p.z = 0.01;
    }
    p.vz -= GRAVITY * dt;
    p.z += p.vz * dt;
    if (p.z <= 0){ p.z = 0; p.vz = 0; }

    let mx = p.input.mx || 0;
    let my = p.input.my || 0;
    const len = Math.hypot(mx, my);
    if (len > 0.01){
      mx /= len; my /= len;
      const spd = p.crouch ? SPEED_CROUCH : SPEED;
      const r = getPlayerRadius(p);
      const nx = p.x + mx * spd * dt;
      const ny = p.y + my * spd * dt;
      if (!collide(nx, p.y, r)) p.x = nx;
      if (!collide(p.x, ny, r)) p.y = ny;
    }
    // у бота угол уже свой, у игрока — из input
    if (!p.isBot) p.ang = p.input.a || 0;
  }
}

function handleShooting(lobby){
  const now = Date.now();
  for (const p of lobby.players){
    if (!p.alive || !p.input.sh) continue;
    const wid = getCurrentWeapon(p);
    const w = WEAPONS[wid] || WEAPONS.pistol;
    if (now - p.lastShot >= w.rate){
      p.lastShot = now;
      shoot(lobby, p, wid);
    }
  }
}

function gameTick(lobby, dt){
  if (lobby.phase === 'waiting'){
    const a = lobby.players.filter(p => p.team === 'A').length;
    const b = lobby.players.filter(p => p.team === 'B').length;
    if (lobby.players.length >= 2 && a >= 1 && b >= 1){
      lobby.score = {A:0, B:0};
      lobby.round = 0;
      lobby.matchOver = false;
      for (const p of lobby.players){ p.kills = 0; p.deaths = 0; }
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
    if (lobby.phaseTimer <= 0) startRound(lobby);
  }
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = nextId++;
  let lobby = null, player = null;

  ws.send(JSON.stringify({
    t:'init', id: playerId,
    grid: GRID, mw: MAP_W, mh: MAP_H, tile: TILE
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'list'){
      const list = [...lobbies.values()].map(l => l.info());
      ws.send(JSON.stringify({t:'lobbies', list}));
      return;
    }
    if (msg.t === 'create'){
      const code = makeCode();
      lobby = new Lobby(code, msg.name || 'Игрок', msg.pass || '');
      lobbies.set(code, lobby);
      player = lobby.addPlayer(ws, msg.name || 'Игрок', playerId);
      lobby.ensureBot();
      ws.send(JSON.stringify({t:'joined', code, id: playerId}));
      return;
    }
    if (msg.t === 'join'){
      const code = (msg.code || '').toUpperCase();
      const l = lobbies.get(code);
      if (!l){ ws.send(JSON.stringify({t:'error', msg:'Лобби не найдено'})); return; }
      if (l.pass && l.pass !== (msg.pass || '')){ ws.send(JSON.stringify({t:'error', msg:'Неверный пароль'})); return; }
      if (l.realCount() >= MAX_PLAYERS){ ws.send(JSON.stringify({t:'error', msg:'Лобби заполнено'})); return; }
      lobby = l;
      player = lobby.addPlayer(ws, msg.name || 'Игрок', playerId);
      lobby.ensureBot();
      ws.send(JSON.stringify({t:'joined', code, id: playerId}));
      return;
    }
    if (!lobby || !player) return;

    if (msg.t === 'team'){
      if (lobby.phase !== 'waiting') return;
      if (msg.team !== 'A' && msg.team !== 'B') return;
      const cnt = lobby.players.filter(p => p.team === msg.team).length;
      const maxPer = Math.ceil(MAX_PLAYERS / 2);
      if (cnt >= maxPer && player.team !== msg.team) return;
      player.team = msg.team;
      // Бот ставится в противоположную команду
      const bot = lobby.players.find(p => p.isBot);
      if (bot) bot.team = msg.team === 'A' ? 'B' : 'A';
      return;
    }
    if (msg.t === 'input'){
      player.input.mx = Math.max(-1, Math.min(1, +msg.mx || 0));
      player.input.my = Math.max(-1, Math.min(1, +msg.my || 0));
      player.input.a  = +msg.a || 0;
      player.input.sh = msg.sh | 0;
      player.input.jump = msg.jump | 0;
      player.input.cr = msg.cr | 0;
      if (msg.sw){
        const s = msg.sw | 0;
        if (s === 1 && player.slot1){ player.currentSlot = 1; }
        else if (s === 2 && player.slot2){ player.currentSlot = 2; }
        else if (s === 3){ player.currentSlot = 3; }
        player.lastShot = 0;
      }
      return;
    }
    if (msg.t === 'buy'){
      if (lobby.phase !== 'buy' || !player.alive) return;
      const w = WEAPONS[msg.w];
      if (!w || player.money < w.price) return;
      if (w.type === 'armor'){
        if (player.boughtArmor) return;
        player.money -= w.price;
        player.armor = 100;
        player.boughtArmor = true;
      } else {
        if (player.boughtWeapon) return;
        player.money -= w.price;
        if (w.slot === 1){
          player.slot1 = msg.w;
          player.currentSlot = 1;
        } else {
          player.slot2 = msg.w;
          player.currentSlot = 2;
        }
        player.boughtWeapon = true;
      }
      return;
    }
    if (msg.t === 'cosmetic'){
      if (msg.charColor === null || typeof msg.charColor === 'string')
        player.charColor = msg.charColor;
      if (msg.weaponColors && typeof msg.weaponColors === 'object')
        player.weaponColors = msg.weaponColors;
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
        lobby.phase = 'waiting';
        lobby.phaseTimer = 0;
        lobby.round = 0;
        lobby.score = {A:0, B:0};
        lobby.winner = null;
        lobby.matchOver = false;
      }
    }
  });
});

setInterval(() => {
  const dt = 1/60;
  for (const lobby of lobbies.values()) gameTick(lobby, dt);
}, 1000/60);

setInterval(() => {
  for (const lobby of lobbies.values()){
    const data = JSON.stringify(lobby.stateMsg());
    for (const p of lobby.players){
      if (p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
    lobby.events = [];
  }
}, 1000/30);

server.listen(PORT, () => {
  console.log('CS:KOZEL FPS server running on http://localhost:' + PORT);
});
