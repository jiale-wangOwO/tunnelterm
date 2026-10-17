'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const {WebSocketServer, WebSocket} = require('ws');

// Message types: 0=bytes, 1=write EOF, 2=destination connected.
// WebSocket preserves packet order; half-close is independent in each direction.
async function startBroker({destinationPort = 22, listenPort = 0} = {}) {
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new TypeError('TunnelTerm broker listenPort must be an integer from 0 to 65535');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const generation = crypto.randomUUID();
  const server = http.createServer((_req, res) => {res.writeHead(404); res.end();});
  const wss = new WebSocketServer({noServer: true, perMessageDeflate: false, maxPayload: 65537});
  const sockets = new Set();
  let stopped = false;
  let closing;
  function close() {
    return closing ??= (async () => {
      stopped = true;
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    })();
  }
  server.on('upgrade', (req, socket, head) => {
    const supplied = String(req.headers['x-tunnelterm-token'] || '');
    const suppliedBytes = Buffer.from(supplied);
    if (stopped || req.url !== '/ssh' || suppliedBytes.length !== token.length ||
        !crypto.timingSafeEqual(suppliedBytes, Buffer.from(token))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const tcp = net.createConnection({host: '127.0.0.1', port: destinationPort, allowHalfOpen: true});
    sockets.add(tcp);
    let inputEnded = false;
    let outputEnded = false;
    let sendTail = Promise.resolve();
    function sendPacket(packet) {
      return new Promise((resolve, reject) => {
        ws.send(packet, error => error ? reject(error) : resolve());
      });
    }
    function enqueueSend(action) {
      sendTail = sendTail.then(async () => {
        if (ws.readyState === WebSocket.OPEN) await action();
      }).catch(() => {tcp.destroy(); ws.terminate();});
    }
    const timer = setTimeout(() => {tcp.destroy(); ws.terminate();}, 5000);
    tcp.setNoDelay(true);
    tcp.pause();
    tcp.on('error', () => ws.terminate());
    ws.on('error', () => tcp.destroy());
    ws.on('close', () => tcp.destroy());
    ws.on('message', (packet, binary) => {
      if (!binary || !packet.length || packet.length > 65537) {ws.terminate(); return;}
      if (packet[0] === 0 && !inputEnded && packet.length > 1) {
        if (!tcp.write(packet.subarray(1))) ws.pause();
      } else if (packet[0] === 1 && packet.length === 1 && !inputEnded) {
        inputEnded = true;
        tcp.end();
      } else ws.terminate();
    });
    tcp.on('drain', () => ws.resume());
    tcp.on('connect', () => {
      clearTimeout(timer);
      enqueueSend(async () => {await sendPacket(Buffer.from([2])); tcp.resume();});
    });
    tcp.on('data', data => {
      tcp.pause();
      enqueueSend(async () => {
        for (let offset = 0; offset < data.length; offset += 65536) {
          await sendPacket(Buffer.concat([Buffer.from([0]), data.subarray(offset, offset + 65536)]));
        }
        if (!outputEnded) tcp.resume();
      });
    });
    tcp.on('end', () => {
      outputEnded = true;
      enqueueSend(async () => {
        await sendPacket(Buffer.from([1]));
        if (inputEnded) ws.close();
      });
    });
    tcp.on('close', hadError => {
      clearTimeout(timer);
      sockets.delete(tcp);
      if (hadError || !outputEnded) ws.terminate();
      else if (inputEnded) enqueueSend(() => ws.close());
    });
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = error => {server.removeListener('listening', onListening); reject(error);};
      const onListening = () => {server.removeListener('error', onError); resolve();};
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(listenPort, '127.0.0.1');
    });
  } catch (error) {
    // In particular, EADDRINUSE is not permission to close someone else's
    // listener or create another cloud mapping on a random fallback port.
    await close();
    throw error;
  }
  return {
    port: server.address().port, token, generation,
    close,
  };
}
module.exports = {startBroker};
