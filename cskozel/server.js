const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TILE = 48;
const MAP_W = 40, MAP_H = 30;
const SPEED = 220;
const PLAYER_RADIUS = 14;
const MAX_PLAYERS = 10;
const ROUNDS_TO_WIN = 10;
const BUY_TIME = 20;
const WIN_MONEY = 2700;
const LOSE_MONEY = 1400;

const WEAPONS = {
  pistol:  { name:'Пистолет',     price:0,    dmg:18, rate:260,  spread:0.030, range:800,  pellets:1 },
  p250:    { name:'P250',         price:350,  dmg:24, rate:170,  spread:0.025, range:900,  pellets:1 },
  deagle:  { name:'Desert Eagle', price:777,  dmg:58, rate:430,  spread:0.018, range:1300, pellets:1 },
  shotgun: { name:'Дробовик',     price:1050, dmg:15, rate:900,  spread:0.130, range:520,  pellets:6 },
  ak:      { name:'AK-47',        price:2700, dmg:34, rate:105,  spread:0.035, range:1500, pellets:1 },
  awp:     { name:'AWP',          price:4500, dmg:120,rate:1500, spread:0.006, range:2200, pellets:1 },
  armor:   { name:'Броня',        price:950,  type:'armor' },
};

/* ======================= КАРТА SANDBOOM ======================= */
function buildMap(){
  const g = Array.from({length: MAP_H}, () => Array(MAP_W).fill(0));
  const rect = (x,y,w,h) => {
    for (let j=y; j<y+h; j++)
      for (let i=x; i<x+w; i++)
        if (j>=0 && j<MAP_H && i>=0 && i<MAP_W) g[j][i] = 1;
  };
  // Внешние стены
  rect(0,0,MAP_W,1); rect(0,MAP_H-1,MAP_W,1);
  rect(0,0,1,MAP_H); rect(MAP_W-1,0,1,MAP_H);

  // Северная половина (зеркалим на юг)
  const north = [
    [4,3,4,1],[4,3,1,5],[7,3,1,5],[4,7,4,1],
    [16,3,8,1],[16,3,1,4],[23,3,1,4],[16,6,8,1],
    [28,3,4,1],[28,3,1,5],[31,3,1,5],[28,7,4,1],
    [8,11,4,1],[8,11,1,4],[8,14,4,1],
    [27,11,4,1],[30,11,1,4],[27,14,4,1],
  ];
  for (const [x,y,w,h] of north){
    rect(x,y,w,h);
    rect(x, MAP_H - y - h, w, h);   // зеркало
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

/* ======================= HTTP-СЕРВЕР (статика) ======================= */
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

/* ======================= ЛОББИ ======================= */
const lobbies = new Map();
let nextId = 1;

function makeCode(){
  let c;
  do { c = Math.random().toString(36).slice(2,6).toUpperCase(); } while (lobbies.has(c));
  return c;
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
  info(){ return { code:this.code, name:this.name, players:this.players.length, max:MAX_PLAYERS, locked: !!this.pass }; }
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
        id:p.id, n:p.name, tm:p.team,
        x: Math.round(p.x), y: Math.round(p.y), a:+p.ang.toFixed(2),
        hp:p.hp, ar:p.armor, money:p.money,
        w:p.weapon, wc:p.weaponColors[p.weapon] || null,
        c:p.charColor,
        al:p.alive, k:p.kills, d:p.deaths,
        bought:p.boughtThisRound,
      })),
      ev: this.events,
    };
  }
  addPlayer(ws, name, id){
    const p = {
      id, ws, name,
      team:null,
      x:0, y:0, ang:0,
      hp:100, armor:0, money:2700,
      weapon:'pistol', boughtThisRound:false,
      alive:false, kills:0, deaths:0,
      input:{u:0,d:0,l:0,r:0,a:0,sh:0},
      lastShot:0,
      charColor:null, weaponColors:{},
    };
    this.players.push(p);
    return p;
  }
  removePlayer(id){ this.players = this.players.filter(p => p.id !== id); }
}

/* ======================= РАУНДЫ ======================= */
function startRound(lobby){
  lobby.round++;
  lobby.phase = 'buy';
  lobby.phaseTimer = BUY_TIME;
  lobby.winner = null;

  // Автораспределение без команды
  const countA = lobby.players.filter(p => p.team === 'A').length;
  const countB = lobby.players.filter(p => p.team === 'B').length;
  let a = countA, b = countB;
  for (const p of lobby.players){
    if (p.team) continue;
    if (a <= b) { p.team = 'A'; a++; }
    else        { p.team = 'B'; b++; }
  }

  // Респаун
  let ai = 0, bi = 0;
  for (const p of lobby.players){
    p.hp = 100;
    p.alive = true;
    p.boughtThisRound = false;
    p.weapon = 'pistol';
    p.armor = 0;
    p.lastShot = 0;
    p.input.sh = 0;
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

/* ======================= СТРЕЛЬБА ======================= */
function shoot(lobby, shooter, weapon){
  const dx = Math.cos(shooter.ang);
  const dy = Math.sin(shooter.ang);

  // Визуальный трассер
  let tracerDist = weapon.range;
  for (let t=0; t<weapon.range; t+=6){
    if (isWall(shooter.x + dx*t, shooter.y + dy*t)){ tracerDist = t; break; }
  }
  lobby.events.push({
    type:'shot',
    x:shooter.x, y:shooter.y,
    ang:shooter.ang, len:tracerDist,
    color: shooter.team === 'A' ? '#88ccff' : '#ffcc88'
  });

  // Урон по дробинкам
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
      const d = rayCircle(shooter.x, shooter.y, px, py, other.x, other.y, PLAYER_RADIUS);
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

/* ======================= ФИЗИКА ======================= */
function movePlayers(lobby, dt){
  for (const p of lobby.players){
    if (!p.alive) continue;
    let dx = 0, dy = 0;
    if (p.input.u) dy--;
    if (p.input.d) dy++;
    if (p.input.l) dx--;
    if (p.input.r) dx++;
    const len = Math.hypot(dx, dy);
    if (len > 0){
      dx /= len; dy /= len;
      const nx = p.x + dx * SPEED * dt;
      const ny = p.y + dy * SPEED * dt;
      if (!collide(nx, p.y, PLAYER_RADIUS)) p.x = nx;
      if (!collide(p.x, ny, PLAYER_RADIUS)) p.y = ny;
    }
    p.ang = p.input.a;
  }
}

function handleShooting(lobby){
  const now = Date.now();
  for (const p of lobby.players){
    if (!p.alive || !p.input.sh) continue;
    const w = WEAPONS[p.weapon] || WEAPONS.pistol;
    if (now - p.lastShot >= w.rate){
      p.lastShot = now;
      shoot(lobby, p, w);
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
    movePlayers(lobby, dt);
    if (lobby.phaseTimer <= 0){ lobby.phase = 'live'; lobby.phaseTimer = 0; }
    return;
  }
  if (lobby.phase === 'live'){
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

/* ======================= СЕТЬ ======================= */
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
      ws.send(JSON.stringify({t:'joined', code, id: playerId}));
      return;
    }

    if (msg.t === 'join'){
      const code = (msg.code || '').toUpperCase();
      const l = lobbies.get(code);
      if (!l){ ws.send(JSON.stringify({t:'error', msg:'Лобби не найдено'})); return; }
      if (l.pass && l.pass !== (msg.pass || '')){ ws.send(JSON.stringify({t:'error', msg:'Неверный пароль'})); return; }
      if (l.players.length >= MAX_PLAYERS){ ws.send(JSON.stringify({t:'error', msg:'Лобби заполнено'})); return; }
      lobby = l;
      player = lobby.addPlayer(ws, msg.name || 'Игрок', playerId);
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
      return;
    }

    if (msg.t === 'input'){
      player.input.u  = msg.u  | 0;
      player.input.d  = msg.d  | 0;
      player.input.l  = msg.l  | 0;
      player.input.r  = msg.r  | 0;
      player.input.a  = +msg.a || 0;
      player.input.sh = msg.sh | 0;
      return;
    }

    if (msg.t === 'buy'){
      if (lobby.phase !== 'buy' || !player.alive || player.boughtThisRound) return;
      const w = WEAPONS[msg.w];
      if (!w || player.money < w.price) return;
      player.money -= w.price;
      if (w.type === 'armor') player.armor = 100;
      else                    player.weapon = msg.w;
      player.boughtThisRound = true;
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
    if (lobby.players.length === 0){
      lobbies.delete(lobby.code);
    } else if (lobby.players.length < 2 && lobby.phase !== 'waiting'){
      lobby.phase = 'waiting';
      lobby.phaseTimer = 0;
      lobby.round = 0;
      lobby.score = {A:0, B:0};
      lobby.winner = null;
      lobby.matchOver = false;
    }
  });
});

/* ======================= ЦИКЛЫ ======================= */
setInterval(() => {
  const dt = 1/60;
  for (const lobby of lobbies.values()) gameTick(lobby, dt);
}, 1000/60);

setInterval(() => {
  for (const lobby of lobbies.values()){
    const data = JSON.stringify(lobby.stateMsg());
    for (const p of lobby.players){
      if (p.ws.readyState === 1) p.ws.send(data);
    }
    lobby.events = [];
  }
}, 1000/30);

server.listen(PORT, () => {
  console.log('CS:KOZEL server running on http://localhost:' + PORT);
});