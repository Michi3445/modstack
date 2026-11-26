const ROOM = /^(?:[A-Za-z0-9_-]{1,128}~[A-Za-z0-9_-]{1,128}|g-[a-f0-9]{32})$/;
const FIELDS = new Set(['messageId', 'at', 'kind']);

// Listen to the small per-user inbox; message bodies still use the chat's own access rules.
module.exports = async function streamInbox(url, controller, onMessage) {
  let timer;
  function keepAlive(timeout) {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout);
    timer.unref();
  }

  const marks = new Map();
  function apply(event, payload) {
    if (typeof payload?.path !== 'string' || !payload.path.startsWith('/')) return;
    if (payload.path === '/' && event === 'put') marks.clear();
    const updates = event === 'patch' || payload.path === '/'
      ? Object.entries(payload.data || {}).map(([key, value]) => [payload.path.replace(/\/$/, '') + '/' + key, value])
      : [[payload.path, payload.data]];
    const changed = new Set();
    for (const [location, value] of updates) {
      const [id, field, extra] = location.slice(1).split('/');
      if (!ROOM.test(id) || extra !== undefined || (field !== undefined && !FIELDS.has(field))) continue;
      if (!field) {
        if (value && typeof value === 'object') marks.set(id, value);
        else marks.delete(id);
      } else {
        marks.set(id, { ...marks.get(id), [field]: value });
      }
      changed.add(id);
    }
    onMessage([...changed].map((id) => [id, marks.get(id)]));
  }

  try {
    let response;
    keepAlive(12000);
    for (let remaining = 4; remaining > 0; remaining--) {
      response = await fetch(url, {
        headers: { Accept: 'text/event-stream' }, redirect: 'manual', signal: controller.signal,
      });
      if (response.status !== 307 && response.status !== 308) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) return;
      url = new URL(location, url);
      if (url.protocol !== 'https:' || url.port || url.username || url.password ||
          !/^[a-z0-9.-]+\.(?:firebaseio\.com|firebasedatabase\.app)$/.test(url.hostname)) return;
    }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
      await response.body?.cancel();
      return;
    }
    keepAlive(120000);
    const decoder = new TextDecoder();
    let buffer = '', event = '', data = [], dataSize = 0;
    for await (const bytes of response.body) {
      keepAlive(120000);
      buffer += decoder.decode(bytes, { stream: true });
      if (buffer.length > 131072) throw new Error('Firebase event exceeds inbox limit');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
          dataSize += line.length;
          if (dataSize > 131072) throw new Error('Invalid Firebase event');
        } else if (!line) {
          if (event === 'auth_revoked' || event === 'cancel') return event;
          if (data.length && (event === 'put' || event === 'patch')) apply(event, JSON.parse(data.join('\n')));
          event = '';
          data = [];
          dataSize = 0;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
};
