function botThink(lobby, bot, dt){
  if (!bot.alive) return;

  if (lobby.phase === 'buy') botBuy(bot, lobby);

  // Инициализация полей бота
  if (bot.lastSeenAt === undefined) bot.lastSeenAt = 0;
  if (bot.aimWobble === undefined) bot.aimWobble = 0;
  if (bot.nextShotAt === undefined) bot.nextShotAt = 0;

  let target = null, tDist = Infinity;
  for (const p of lobby.players){
    if (p === bot || p.isBot) continue;
    if (!p.alive || p.team === bot.team) continue;
    const d = Math.hypot(p.x - bot.x, p.y - bot.y);
    if (d < tDist){ tDist = d; target = p; }
  }
  if (!target){
    bot.input.mx = 0; bot.input.my = 0; bot.input.sh = 0;
    bot.lastSeenAt = 0;
    return;
  }

  const dx = target.x - bot.x;
  const dy = target.y - bot.y;
  const canSee = hasLOS(bot.x, bot.y, target.x, target.y);

  // Реакция с задержкой
  if (canSee && tDist < 1500){
    if (!bot.lastSeenAt) bot.lastSeenAt = Date.now();
  } else {
    bot.lastSeenAt = 0;
  }
  const reactMs = 600;  // было мгновенно, стало 600мс
  const reactOK = bot.lastSeenAt && (Date.now() - bot.lastSeenAt > reactMs);

  // Плавающая ошибка прицела
  bot.aimWobble += (Math.random() - 0.5) * 0.35 * dt;
  bot.aimWobble = Math.max(-0.25, Math.min(0.25, bot.aimWobble));

  // Целимся медленнее
  const aimAng = Math.atan2(dy, dx) + bot.aimWobble;
  let diff = aimAng - bot.ang;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  bot.ang += diff * Math.min(1, dt * 3.5);  // было dt*8, стало dt*3.5

  const aimed = Math.abs(diff) < 0.20;

  if (canSee && tDist < 1400 && reactOK){
    // Проверка времени между выстрелами (не спамит)
    if (Date.now() > bot.nextShotAt){
      if (aimed && Math.random() > 0.20){  // 20% промах
        bot.input.sh = 1;
        bot.nextShotAt = Date.now() + 250;
      } else {
        bot.input.sh = 0;
      }
    } else {
      bot.input.sh = 0;
    }
    // Останавливается только если близко
    if (tDist < 400){
      bot.input.mx = 0; bot.input.my = 0;
    } else {
      const len = tDist || 1;
      bot.input.mx = dx / len * 0.6;
      bot.input.my = dy / len * 0.6;
    }
  } else {
    bot.input.sh = 0;
    const len = tDist || 1;
    bot.input.mx = dx / len;
    bot.input.my = dy / len;
    const nx = bot.x + bot.input.mx * 20;
    const ny = bot.y + bot.input.my * 20;
    if (collide(nx, bot.y, PLAYER_RADIUS)){ bot.input.mx = 0; bot.input.my = dy > 0 ? 1 : -1; }
    if (collide(bot.x, ny, PLAYER_RADIUS)){ bot.input.my = 0; bot.input.mx = dx > 0 ? 1 : -1; }
  }
}
