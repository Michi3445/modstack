const net = require('node:net');
const { randomUUID } = require('node:crypto');

const MAX_FRAME = 64 * 1024;
const HANDSHAKE = 0, FRAME = 1, CLOSE = 2, PING = 3, PONG = 4;
const applicationIdValid = (id) => typeof id === 'string' && /^\d{17,20}$/.test(id);

function write(socket, opcode, body) {
  const data = Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(opcode);
  header.writeUInt32LE(data.length, 4);
  socket.write(Buffer.concat([header, data]));
}

function createPresence({ connect = net.createConnection, pid = process.pid, reconnectMs = 15000 } = {}) {
  let id, activity, socket, timer, ready = false, last, serial = 0;
  function setActivity(connection, value) {
    write(connection, FRAME, { cmd: 'SET_ACTIVITY', args: { pid, activity: value }, nonce: randomUUID() });
  }
  function stop() {
    serial++;
    clearTimeout(timer);
    const previous = socket;
    socket = undefined;
    if (previous && !previous.destroyed) {
      if (ready && previous.writable) {
        setActivity(previous, null);
        previous.end();
        setTimeout(() => previous.destroy(), 1000).unref();
      } else previous.destroy();
    }
    ready = false;
    last = undefined;
  }
  function publish() {
    if (!ready || !socket?.writable) return;
    const payload = JSON.stringify(activity);
    if (payload === last) return;
    setActivity(socket, activity);
    last = payload;
  }
  function open(index = 0) {
    if (!id) return;
    const attempt = serial;
    const connection = socket = connect('\\\\.\\pipe\\discord-ipc-' + index);
    let received = Buffer.alloc(0);
    connection.setTimeout(1200);
    connection.once('connect', () => write(connection, HANDSHAKE, { v: 1, client_id: id }));
    connection.on('error', () => connection.destroy());
    connection.once('timeout', () => connection.destroy());
    connection.once('close', () => {
      if (attempt !== serial) return;
      const hadSession = ready;
      socket = undefined;
      ready = false;
      last = undefined;
      if (!hadSession && index < 9) open(index + 1);
      else timer = setTimeout(() => open(), reconnectMs).unref();
    });
    connection.on('data', (chunk) => {
      if (attempt !== serial) return;
      received = Buffer.concat([received, chunk]);
      while (received.length >= 8) {
        const opcode = received.readUInt32LE(0), length = received.readUInt32LE(4);
        if (length > MAX_FRAME) { connection.destroy(); return; }
        if (received.length < 8 + length) return;
        let data;
        try { data = JSON.parse(received.toString('utf8', 8, 8 + length)); }
        catch { connection.destroy(); return; }
        received = received.subarray(8 + length);
        if (opcode === CLOSE || !data || typeof data !== 'object') { connection.destroy(); return; }
        if (opcode === PING) write(connection, PONG, data);
        if (opcode === FRAME && data.cmd === 'DISPATCH' && data.evt === 'READY') {
          connection.setTimeout(0);
          ready = true;
          publish();
        }
      }
    });
  }
  return {
    update(nextId, nextActivity) {
      if (!applicationIdValid(nextId)) nextId = undefined;
      activity = nextActivity;
      if (nextId === id) { publish(); return; }
      stop();
      id = nextId;
      if (id) open();
    },
    stop() { id = undefined; stop(); },
  };
}

module.exports = { applicationIdValid, createPresence };
