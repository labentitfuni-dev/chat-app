// 本番環境ではメモリ内DBを使用（再起動でリセット）
// 本格運用時はMongoDBやPostgreSQLに移行してください
const db = {
  users: [],
  messages: [],
};

module.exports = {
  get: (table) => ({
    find: (query) => ({
      value: () => db[table].find(obj =>
        Object.entries(query).every(([k, v]) => obj[k] === v)
      )
    }),
    filter: (fn) => ({
      sortBy: (key) => ({
        value: () => [...db[table].filter(fn)].sort((a, b) => a[key] > b[key] ? 1 : -1)
      }),
      each: (fn) => { db[table].filter(fn).forEach(fn); return { value: () => {} }; },
      value: () => db[table].filter(fn)
    }),
    push: (item) => ({ write: () => { db[table].push(item); } }),
    map: (fn) => ({ value: () => db[table].map(fn) }),
    value: () => db[table],
  }),
  get users() { return this.get('users'); },
  write: () => {},
  _data: db,
};

// シンプルなAPIに統一
module.exports = {
  getUsers: () => db.users,
  findUser: (query) => db.users.find(u => Object.entries(query).every(([k,v]) => u[k] === v)),
  addUser: (user) => { db.users.push(user); },
  getMessages: (userId1, userId2) => db.messages.filter(m =>
    (m.fromId === userId1 && m.toId === userId2) ||
    (m.fromId === userId2 && m.toId === userId1)
  ).sort((a, b) => a.createdAt > b.createdAt ? 1 : -1),
  addMessage: (msg) => { db.messages.push(msg); },
  markRead: (fromId, toId) => {
    db.messages.filter(m => m.fromId === fromId && m.toId === toId).forEach(m => { m.read = true; });
  },
};
