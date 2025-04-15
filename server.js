/// Written by kenan238
/// Server recreation attempt for chess.ytdraws.win

import WebSocket, { WebSocketServer } from 'ws';
import { boardW, boardH, generateLegalMoves, moveCooldown, respawnTime } from './shared.js';
import { stdout } from 'process';

const wss = new WebSocketServer({ port: 2388 })
const teams = {};

const rnd = r => Math.floor(Math.random() * r)

const board = Array(boardH).fill(0)
  .map(_ => Array(boardW).fill([0, 0]));

const printBoard = () =>
{
  for (let y = 0; y < boardH; y++)
  {
    for (let x = 0; x < boardW; x++)
    {
      const p = getCell(x, y).piece;
      stdout.write(p === 0 ? '.' : p.toString());
    }
    stdout.write('\n')
  }
}

const updateCell = (team, piece, x, y, broadcast = false) =>
{
  board[y][x] = [team, piece];

  if (broadcast)
    wss.broadcast([ x, y, piece, team ])
}
const getCell = (x, y) =>
{
  const p = board[y][x];

  return {
    team: p[0],
    piece: p[1]
  };
}

const getClearRandomSpace = () =>
{
  let cell;
  let x = rnd(boardW), y = rnd(boardH)

  while ((cell = getCell(x, y)).piece !== 0)
  {
    x = rnd(boardW)
    y = rnd(boardH)
  }

  return [x, y]
}

const getLeaderBoard = () => Object.keys(teams).map( k =>
  {
    const plr = teams[k];
    // todo give the guys actual names
    return { 
      name: k.toString(), 
      kills: plr.kills ,
      teamId: parseInt(k),
    };
  })//.sort((a, b) => b.kills - a.kills);

const splitBoardAndTeams = () =>
{
  const t = [], b = [];
  for (let x = 0; x < boardW; x++)
  {
    const tl = [], bl = [];
    for (let y = 0; y < boardH; y++)
    {
      const c = getCell(x, y);
      bl.push(c.piece);
      tl.push(c.team);
    }
    b.push(bl);
    t.push(tl);
  }

  return {b, t};
};
const generateBoardBuffer = () =>
{
  const { b, t } = splitBoardAndTeams();

  return [...b.flat(Infinity), ...t.flat(Infinity)];
}

const isLegalMove = (sx, sy, nx, ny) =>
{
  const { b, t } = splitBoardAndTeams();
  const legalMoves = generateLegalMoves(sx, sy, b, t);
  
  return legalMoves.some(x => x[0] === nx && x[1] === ny);
}

wss.broadcast = msg => Object.keys(teams).forEach(k =>
  {
    const plyr = teams[k];
    plyr.ws.send(msg);
  })

const decoder = new TextDecoder();
const decodeText = (u8array, startPos = 0, endPos = Infinity) => decoder.decode(u8array).slice(startPos, endPos);

const readIntegersFromUint16 = u16array => 
{
  const dv = new DataView(u16array.buffer);
  let v = [];
  for (let i = 0; i < u16array.length; i += 2)
    v.push(dv.getUint16(i, true));

  return v;
}

function handlePacket(teamId, data)
{
  const plyr = teams[teamId];
 
  if (plyr.state === 'unverified')
  {
    const txt = decodeText(data).trim()
    if (txt.slice(0, 2) === '0.')
    {
      // captcha string, we cant verify much, so we just blindly ignore it
      plyr.state = 'verified';
      console.log(teamId, 'verified', teams)
    }
    return;
  }

  if (data.length === 0)
  {
    console.log(teamId, 'died')
    // neutralize pieces
    plyr.neutralizePieces(plyr);

    setTimeout(() =>
    {
      plyr.spawnKing();
    }, respawnTime - 100)
  }
  else if (data[0] === 247 && data[1] === 183)
  {
    // chat message
    const msg = decodeText(data, 2).toString();
    const bytes = [...msg].map(c => c.charCodeAt(0))
    console.log(teamId, msg)

    wss.broadcast([ 47095, teamId, ...bytes ])
  }
  else if (data.length === 8)
  {
    if ((Date.now() - plyr.lastPlaced) < moveCooldown)
    {
      console.log("be patient");
      return;
    }

    plyr.lastPlaced = Date.now();

    data = readIntegersFromUint16(data);
    console.log(teamId, 'move', data)
    const selectedX = data[0], selectedY = data[1];
    const newX = data[2], newY = data[3];

    if (!isLegalMove(selectedX, selectedY, newX, newY))
    {
      console.log('dumbass')
      return;
    }

    const startCell = getCell(selectedX, selectedY);
    const endCell = getCell(newX, newY);

    // cant capture self and cant control other's pieces
    if (startCell.team !== teamId || endCell.team === teamId)
    {
      console.log('genius');
      return;
    }

    console.log(startCell, endCell)
    if (endCell.piece === 0)
      updateCell(0, 0, selectedX, selectedY);
    updateCell(startCell.team, startCell.piece, newX, newY);

    // useless byte and end because serum is funky like that
    wss.broadcast([selectedX, selectedY, newX, newY, 300])

    if (endCell.piece !== 0 && endCell.piece !== 6)
      updateCell(startCell.team, endCell.piece, selectedX, selectedY, true)

    if (endCell.piece === 6 && endCell.team !== teamId)
      plyr.kills++;
  }
}

wss.on('error', console.error);

for (let i = 0; i < 300; i++)
{
  let [x, y] = getClearRandomSpace()

  // ! put random pieces
  updateCell(0, rnd(6), x, y, true)
}

setInterval(() => 
{
  // ! update leaderboard
  const lb = getLeaderBoard();
  const raw = lb.map(x => 
    [x.teamId, x.kills, x.name.length * 2, ...[...x.name].map(x => x.charCodeAt(0))])

  const buf = [48027, ...raw.flat(2)];
  wss.broadcast(buf);

  console.log('casual lb update')

  // printBoard();
}, 1000);

wss.on('connection', ws =>
{
  ws.oldSend = ws.send;
  ws.send = d =>
    ws.oldSend(new Uint16Array(d))

  const teamId = Math.floor(Math.random() * 10000)
  teams[teamId] = { 
    ws,
    state: 'unverified',
    kills: 0,
    lastPlaced: new Date(),
    getPieces: () =>
    {
      const p = [];
      for (let i = 0; i < board.length; i++)
      {
        const line = board[i];
        for (let j = 0; j < line.length; j++)
        {
          const c = getCell(j, i);
          if (c.team === teamId)
            p.push([c.piece, j, i]);
        }
      }

      return p;
    },
    spawnKing: () =>
    {
      const [spx, spy] = getClearRandomSpace();
      updateCell(teamId, 6, spx, spy, true);
    },
    neutralizePieces: (plyr) =>
    {
      plyr.getPieces().forEach(p => 
        {
          let [piece, x, y] = p;
  
          // delete kings too
          if (piece === 6)
            piece = 0;
  
          updateCell(0, piece, x, y);
        })

      wss.broadcast([ 64535, 12345, teamId ]);
    }
  };

  ws.on('close', () =>
  {
    console.log(teamId, "disconnected");
    teams[teamId].neutralizePieces(teams[teamId]);
    delete teams[teamId];
  })

  ws.on('message', data => handlePacket(teamId, new Uint8Array(data)));

  ws.send([teamId, ...generateBoardBuffer()]);
  teams[teamId].spawnKing();
});

wss.on('listening', () =>
{
  console.log('listening')
})